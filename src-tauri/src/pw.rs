//! PipeWire, on Linux: what native/capture.swift does with Core Audio on macOS. One connection, on a thread of its
//! own, keeps a picture of the graph (the apps' output streams, the microphones, the outputs, and which are the
//! defaults) and makes OnKey's capture node: one node with three input ports, [music L, music R, mic], linked to the
//! followed app's output streams and to the microphone. One node runs in one graph cycle, so the music and your
//! voice arrive sample-aligned, as from macOS's aggregate device (a mic on another clock is resampled by PipeWire to
//! fit, as Core Audio's drift compensation does). Nothing is linked to the app's streams but OnKey's own input: what
//! you hear isn't touched.
//!
//! An app's streams come and go (a browser makes a new one for each video, a player one for each song): the links
//! follow them while the capture runs, as capture.swift re-points its tap.
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use pipewire as pw;
use pw::spa;

/// The rate OnKey's capture and meter ask for (PipeWire resamples to it if the graph runs at another).
pub const RATE: u32 = 48_000;

/// A node in the graph, as far as OnKey needs it (its properties).
#[derive(Debug, Clone, Default)]
pub struct Node {
    pub id: u32,
    /// media.class: "Stream/Output/Audio" (an app playing), "Audio/Source" (a mic), "Audio/Sink" (an output)
    pub class: String,
    /// node.name: a device's stable name ("alsa_input.pci-0000_00_1f.3-…"), kept as its uid
    pub name: String,
    /// node.description: what people call it ("Built-in Audio Headset Microphone")
    pub description: String,
    /// the app a stream is from: application.name, application.process.binary, a sandboxed app's id
    pub app_name: String,
    pub binary: String,
    pub app_id: String,
    pub pid: Option<u32>,
    pub running: bool,
    /// node.latency ("1024/48000"): the quantum it asks for
    pub latency: Option<(u32, u32)>,
}

impl Node {
    /// A Bluetooth device (headphones' mic, or their output).
    pub fn bluetooth(&self) -> bool {
        self.name.starts_with("bluez_")
    }
}

#[derive(Debug, Clone)]
struct Port {
    node: u32,
    output: bool,
    channel: String,
    monitor: bool,
}

#[derive(Default)]
struct Graph {
    nodes: BTreeMap<u32, Node>,
    ports: BTreeMap<u32, Port>,
    /// the default output and input (node names), as WirePlumber keeps them
    default_sink: String,
    default_source: String,
    /// the first look at the graph is done
    ready: bool,
}

static GRAPH: Mutex<Graph> = Mutex::new(Graph { nodes: BTreeMap::new(), ports: BTreeMap::new(), default_sink: String::new(),
                                                default_source: String::new(), ready: false });

/// The app whose sound to capture: its process (its streams, and those of the processes it started, are its own)
/// and the names it may give its streams (lower case), for apps whose process can't be told (a sandboxed one).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct App {
    pub pid: Option<u32>,
    pub names: Vec<String>,
}

/// Is `pid`, or a process it descends from, `ancestor`?
pub fn descends(pid: u32, ancestor: u32) -> bool {
    let mut p = pid;
    for _ in 0..64 {
        if p == ancestor {
            return true;
        }
        if p <= 1 {
            return false;
        }
        // /proc/<pid>/stat: "pid (comm) state ppid …", comm may hold spaces and parentheses
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{p}/stat")) else { return false };
        let Some(ppid) = stat.rsplit_once(')').and_then(|(_, rest)| rest.split_whitespace().nth(1)).and_then(|s| s.parse().ok()) else { return false };
        p = ppid;
    }
    false
}

/// Whether a node is one of OnKey's own (its capture node, its window's sound): never captured as music.
fn ours(n: &Node) -> bool {
    n.pid.is_some_and(|p| descends(p, std::process::id())) || n.name.starts_with("onkey-")
}

/// Whether a node is a stream `app` plays (see `App`).
fn belongs(n: &Node, app: &App) -> bool {
    if n.class != "Stream/Output/Audio" || ours(n) {
        return false;
    }
    if let (Some(p), Some(a)) = (n.pid, app.pid) {
        if descends(p, a) {
            return true;
        }
    }
    // "Brave", "brave", "com.brave.Browser", "Feishin": the whole name, or its first word ("Brave input")
    let fields = [&n.app_name, &n.binary, &n.app_id];
    app.names.iter().filter(|w| !w.is_empty()).any(|w| fields.iter().any(|f| {
        let f = f.to_lowercase();
        f == *w || f.split(|c: char| c.is_whitespace()).next() == Some(w.as_str())
    }))
}

// ---------------------------------------------------------------- the connection's thread

enum Cmd {
    Capture { app: App, mic: Option<String>, on_frames: fn(&[f32]), reply: mpsc::Sender<bool> },
    StopCapture,
    Meter { mic: Option<String>, reply: mpsc::Sender<bool> },
    StopMeter,
}

static TX: Mutex<Option<pw::channel::Sender<Cmd>>> = Mutex::new(None);

/// Connected to PipeWire (connecting now if not): false if it isn't running.
fn connected() -> bool {
    let mut tx = TX.lock().unwrap();
    if tx.is_some() {
        return true;
    }
    let (ready_tx, ready_rx) = mpsc::channel();
    let (cmd_tx, cmd_rx) = pw::channel::channel::<Cmd>();
    let spawned = std::thread::Builder::new().name("onkey-pipewire".into()).spawn(move || {
        if let Err(e) = run(cmd_rx, &ready_tx) {
            crate::engine::log(&format!("PipeWire: {e}"));
            let _ = ready_tx.send(false);
        }
        // the connection ended (PipeWire restarted): the next call connects again
        *TX.lock().unwrap() = None;
        *GRAPH.lock().unwrap() = Graph::default();
    });
    if spawned.is_err() || !ready_rx.recv_timeout(Duration::from_secs(3)).unwrap_or(false) {
        return false;
    }
    *tx = Some(cmd_tx);
    true
}

fn send(cmd: Cmd) -> bool {
    connected() && TX.lock().unwrap().as_ref().is_some_and(|t| t.send(cmd).is_ok())
}

/// A look at the graph (after the first one is complete).
fn graph<R>(f: impl FnOnce(&Graph) -> R) -> R {
    connected();
    f(&GRAPH.lock().unwrap())
}

/// The connection's own objects, on its thread.
struct Loop {
    core: pw::core::CoreRc,
    registry: pw::registry::RegistryRc,
    /// proxies bound to see each node's properties and state, and the default devices, kept while they're there
    nodes: HashMap<u32, (pw::node::Node, pw::node::NodeListener)>,
    metadata: Option<(pw::metadata::Metadata, pw::metadata::MetadataListener)>,
    capture: Option<CaptureNode>,
    meter: Option<(pw::stream::StreamRc, pw::stream::StreamListener<()>)>,
}

struct CaptureNode {
    stream: pw::stream::StreamRc,
    _listener: pw::stream::StreamListener<()>,
    app: App,
    mic: Option<String>,
    /// (output port, OnKey's input port) → the link between them
    links: HashMap<(u32, u32), pw::link::Link>,
}

fn run(cmds: pw::channel::Receiver<Cmd>, ready: &mpsc::Sender<bool>) -> Result<(), pw::Error> {
    pw::init();
    let mainloop = pw::main_loop::MainLoopRc::new(None)?;
    let context = pw::context::ContextRc::new(&mainloop, None)?;
    let core = context.connect_rc(None)?;
    let registry = core.get_registry_rc()?;
    let lp = Rc::new(RefCell::new(Loop { core: core.clone(), registry: registry.clone(), nodes: HashMap::new(), metadata: None,
                                          capture: None, meter: None }));

    // PipeWire went away (restarted, or the session ended): this connection is over
    let ml = mainloop.downgrade();
    let _core_listener = core.add_listener_local()
        .error(move |id, _seq, res, message| {
            if id == pw::core::PW_ID_CORE {
                crate::engine::log(&format!("PipeWire: connection error {res}: {message}"));
                if let Some(m) = ml.upgrade() {
                    m.quit();
                }
            }
        })
        .register();

    let weak = Rc::downgrade(&lp);
    let weak_remove = weak.clone();
    let _registry_listener = registry.add_listener_local()
        .global(move |g| {
            let Some(lp) = weak.upgrade() else { return };
            let props = g.props;
            let get = |k: &str| props.and_then(|p| p.get(k)).unwrap_or("").to_string();
            match g.type_ {
                pw::types::ObjectType::Node => {
                    GRAPH.lock().unwrap().nodes.insert(g.id, Node { id: g.id, class: get("media.class"), name: get("node.name"),
                                                                     description: get("node.description"), ..Default::default() });
                    let Ok(node) = lp.borrow().registry.bind::<pw::node::Node, _>(g) else { return };
                    let w = Rc::downgrade(&lp);
                    let id = g.id;
                    let listener = node.add_listener_local()
                        .info(move |info| {
                            node_info(id, info);
                            if let Some(lp) = w.upgrade() {
                                relink(&mut lp.borrow_mut());
                            }
                        })
                        .register();
                    lp.borrow_mut().nodes.insert(g.id, (node, listener));
                }
                pw::types::ObjectType::Port => {
                    let Some(node) = get("node.id").parse().ok() else { return };
                    GRAPH.lock().unwrap().ports.insert(g.id, Port { node, output: get("port.direction") == "out",
                                                                     channel: get("audio.channel"), monitor: get("port.monitor") == "true" });
                }
                pw::types::ObjectType::Metadata if get("metadata.name") == "default" => {
                    let Ok(md) = lp.borrow().registry.bind::<pw::metadata::Metadata, _>(g) else { return };
                    let w = Rc::downgrade(&lp);
                    let listener = md.add_listener_local()
                        .property(move |_subject, key, _type, value| {
                            // {"name": "alsa_output.…"}
                            let name = || value.and_then(|v| serde_json::from_str::<serde_json::Value>(v).ok())
                                .and_then(|v| v["name"].as_str().map(String::from)).unwrap_or_default();
                            match key {
                                Some("default.audio.sink") => GRAPH.lock().unwrap().default_sink = name(),
                                Some("default.audio.source") => GRAPH.lock().unwrap().default_source = name(),
                                _ => return 0,
                            }
                            if let Some(lp) = w.upgrade() {
                                relink(&mut lp.borrow_mut());
                            }
                            0
                        })
                        .register();
                    lp.borrow_mut().metadata = Some((md, listener));
                }
                _ => return,
            }
            relink(&mut lp.borrow_mut());
        })
        .global_remove(move |id| {
            let Some(lp) = weak_remove.upgrade() else { return };
            {
                let mut g = GRAPH.lock().unwrap();
                g.nodes.remove(&id);
                g.ports.remove(&id);
            }
            let mut l = lp.borrow_mut();
            l.nodes.remove(&id);
            if let Some(c) = l.capture.as_mut() {
                c.links.retain(|(o, i), _| *o != id && *i != id);
            }
            relink(&mut l);
        })
        .register();

    // the first look at the whole graph: done when PipeWire answers this sync
    let pending = core.sync(0)?;
    let ready = ready.clone();
    let _done_listener = core.add_listener_local()
        .done(move |id, seq| {
            if id == pw::core::PW_ID_CORE && seq == pending {
                GRAPH.lock().unwrap().ready = true;
                let _ = ready.send(true);
            }
        })
        .register();

    let w = Rc::downgrade(&lp);
    let _cmds = cmds.attach(mainloop.loop_(), move |cmd| {
        let Some(lp) = w.upgrade() else { return };
        match cmd {
            Cmd::Capture { app, mic, on_frames, reply } => {
                lp.borrow_mut().capture = None;
                let made = capture_node(&lp.borrow().core, app, mic, on_frames);
                if let Err(e) = &made {
                    crate::engine::log(&format!("PipeWire: couldn't make the capture node: {e}"));
                }
                let ok = made.is_ok();
                lp.borrow_mut().capture = made.ok();
                relink(&mut lp.borrow_mut());
                let _ = reply.send(ok);
            }
            Cmd::StopCapture => lp.borrow_mut().capture = None,
            Cmd::Meter { mic, reply } => {
                lp.borrow_mut().meter = None;
                let made = meter_stream(&lp.borrow().core, mic.as_deref());
                if let Err(e) = &made {
                    crate::engine::log(&format!("PipeWire: couldn't start the mic meter: {e}"));
                }
                let ok = made.is_ok();
                lp.borrow_mut().meter = made.ok();
                let _ = reply.send(ok);
            }
            Cmd::StopMeter => lp.borrow_mut().meter = None,
        }
    });

    mainloop.run();
    // (the streams and links go with the connection)
    let mut l = lp.borrow_mut();
    l.capture = None;
    l.meter = None;
    l.nodes.clear();
    l.metadata = None;
    Ok(())
}

/// A node's properties and state, as it says them.
fn node_info(id: u32, info: &pw::node::NodeInfoRef) {
    let mut g = GRAPH.lock().unwrap();
    let Some(n) = g.nodes.get_mut(&id) else { return };
    if info.change_mask().contains(pw::node::NodeChangeMask::STATE) {
        n.running = matches!(info.state(), pw::node::NodeState::Running);
    }
    if let Some(p) = info.props().filter(|_| info.change_mask().contains(pw::node::NodeChangeMask::PROPS)) {
        let get = |k: &str| p.get(k).unwrap_or("").to_string();
        n.class = get("media.class");
        n.name = get("node.name");
        n.description = [get("node.description"), get("node.nick"), get("node.name")].into_iter().find(|s| !s.is_empty()).unwrap_or_default();
        n.app_name = get("application.name");
        n.binary = get("application.process.binary");
        n.app_id = [get("pipewire.access.portal.app_id"), get("application.id")].into_iter().find(|s| !s.is_empty()).unwrap_or_default();
        n.pid = p.get("application.process.id").and_then(|s| s.parse().ok());
        n.latency = p.get("node.latency").and_then(|l| l.split_once('/')).and_then(|(a, b)| Some((a.parse().ok()?, b.parse().ok()?)));
    }
}

/// Raw float audio: `channels` at `RATE`, in `positions` (SPA_AUDIO_CHANNEL_*), as a format parameter.
fn format_param(channels: u32, positions: &[u32]) -> Vec<u8> {
    let mut info = spa::param::audio::AudioInfoRaw::new();
    info.set_format(spa::param::audio::AudioFormat::F32LE);
    info.set_rate(RATE);
    info.set_channels(channels);
    let mut pos = [0u32; spa::sys::SPA_AUDIO_MAX_CHANNELS as usize];
    pos[..positions.len()].copy_from_slice(positions);
    info.set_position(pos);
    let obj = spa::pod::Object {
        type_: spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
        id: spa::param::ParamType::EnumFormat.as_raw(),
        properties: info.into(),
    };
    spa::pod::serialize::PodSerializer::serialize(std::io::Cursor::new(Vec::new()), &spa::pod::Value::Object(obj))
        .map(|(c, _)| c.into_inner()).unwrap_or_default()
}

/// The interleaved float samples in a stream's next buffer, given to `f`.
fn with_samples(stream: &pw::stream::Stream, f: impl FnOnce(&[f32])) {
    let Some(mut buffer) = stream.dequeue_buffer() else { return };
    let datas = buffer.datas_mut();
    let Some(d) = datas.first_mut() else { return };
    let (offset, size) = (d.chunk().offset() as usize, d.chunk().size() as usize);
    if let Some(bytes) = d.data() {
        let end = (offset + size).min(bytes.len());
        let bytes = &bytes[offset.min(end)..end];
        // (the buffers are mapped memory, aligned for floats)
        let (head, samples, _) = unsafe { bytes.align_to::<f32>() };
        if head.is_empty() {
            f(samples);
        }
    }
}

/// OnKey's capture node: [music L, music R, mic] in, linked by `relink` (nothing connects it by itself).
fn capture_node(core: &pw::core::CoreRc, app: App, mic: Option<String>, on_frames: fn(&[f32])) -> Result<CaptureNode, pw::Error> {
    let props = pw::properties::properties! {
        *pw::keys::MEDIA_TYPE => "Audio",
        *pw::keys::MEDIA_CATEGORY => "Capture",
        *pw::keys::MEDIA_ROLE => "Music",
        *pw::keys::NODE_NAME => "onkey-capture",
        *pw::keys::NODE_DESCRIPTION => "OnKey (music and microphone)",
        *pw::keys::APP_NAME => "OnKey",
        "node.autoconnect" => "false",
        "node.dont-reconnect" => "true",
        "stream.dont-remix" => "true",
        "audio.channels" => "3",
        "audio.position" => "FL,FR,AUX0",
    };
    let stream = pw::stream::StreamRc::new(core.clone(), "onkey-capture", props)?;
    let listener = stream.add_local_listener_with_user_data(())
        .process(move |stream, _| with_samples(stream, |s| on_frames(&s[..s.len() - s.len() % 3])))
        .register()?;
    let values = format_param(3, &[spa::sys::SPA_AUDIO_CHANNEL_FL, spa::sys::SPA_AUDIO_CHANNEL_FR, spa::sys::SPA_AUDIO_CHANNEL_AUX0]);
    let mut params = [spa::pod::Pod::from_bytes(&values).ok_or(pw::Error::CreationFailed)?];
    stream.connect(spa::utils::Direction::Input, None,
                   pw::stream::StreamFlags::MAP_BUFFERS | pw::stream::StreamFlags::RT_PROCESS, &mut params)?;
    Ok(CaptureNode { stream, _listener: listener, app, mic, links: HashMap::new() })
}

/// The links the capture node should have now: each of the app's streams to the music ports, the mic to the mic
/// port. Made when missing, dropped when not wanted any more (a stream gone, another mic).
fn relink(l: &mut Loop) {
    let Some(c) = l.capture.as_mut() else { return };
    let me = c.stream.node_id();
    let want = {
        let g = GRAPH.lock().unwrap();
        wanted(&g, me, &c.app, c.mic.as_deref())
    };
    c.links.retain(|k, _| want.iter().any(|(w, _)| w == k));
    for ((out, inp), (out_node, in_node)) in want {
        if c.links.contains_key(&(out, inp)) {
            continue;
        }
        let made = l.core.create_object::<pw::link::Link>("link-factory", &pw::properties::properties! {
            "link.output.node" => out_node.to_string(),
            "link.output.port" => out.to_string(),
            "link.input.node" => in_node.to_string(),
            "link.input.port" => inp.to_string(),
            "object.linger" => "false",
        });
        match made {
            Ok(link) => {
                c.links.insert((out, inp), link);
            }
            Err(e) => crate::engine::log(&format!("PipeWire: couldn't link port {out} to {inp}: {e}")),
        }
    }
}

/// (output port, input port) → (output node, input node), for the capture node `me` (see `relink`).
fn wanted(g: &Graph, me: u32, app: &App, mic: Option<&str>) -> Vec<((u32, u32), (u32, u32))> {
    let ins: HashMap<&str, u32> = g.ports.iter().filter(|(_, p)| p.node == me && !p.output).map(|(id, p)| (p.channel.as_str(), *id)).collect();
    let (Some(&fl), Some(&fr), Some(&aux)) = (ins.get("FL"), ins.get("FR"), ins.get("AUX0")) else { return Vec::new() };
    let outs = |node: u32| g.ports.iter().filter(move |(_, p)| p.node == node && p.output && !p.monitor);
    let mut want = Vec::new();
    for n in g.nodes.values().filter(|n| belongs(n, app)) {
        let ports: Vec<(u32, &Port)> = outs(n.id).map(|(id, p)| (*id, p)).collect();
        for (id, p) in &ports {
            match p.channel.as_str() {
                "FL" => want.push(((*id, fl), (n.id, me))),
                "FR" => want.push(((*id, fr), (n.id, me))),
                // a mono stream into both
                _ if ports.len() == 1 => want.extend([((*id, fl), (n.id, me)), ((*id, fr), (n.id, me))]),
                _ => {}
            }
        }
    }
    let mic = mic.map(String::from).unwrap_or_else(|| g.default_source.clone());
    if let Some(m) = g.nodes.values().find(|n| n.name == mic && n.class.starts_with("Audio/Source")) {
        // one channel of it: a headset's mono, else the left of a stereo pair
        let ports: Vec<(&u32, &Port)> = outs(m.id).collect();
        let pick = ports.iter().find(|(_, p)| p.channel == "MONO").or_else(|| ports.iter().find(|(_, p)| p.channel == "FL")).or(ports.first());
        if let Some((id, _)) = pick {
            want.push(((**id, aux), (m.id, me)));
        }
    }
    want
}

// ---------------------------------------------------------------- the mic meter (setup's "say something")

/// The meter's latest level (dBFS, as f32 bits) and how many blocks reached it.
static METER_DB: AtomicU32 = AtomicU32::new(0xC2F0_0000);       // -120.0
static METER_BLOCKS: AtomicUsize = AtomicUsize::new(0);

fn meter_stream(core: &pw::core::CoreRc, mic: Option<&str>) -> Result<(pw::stream::StreamRc, pw::stream::StreamListener<()>), pw::Error> {
    let mut props = pw::properties::properties! {
        *pw::keys::MEDIA_TYPE => "Audio",
        *pw::keys::MEDIA_CATEGORY => "Capture",
        *pw::keys::MEDIA_ROLE => "Communication",
        *pw::keys::NODE_NAME => "onkey-mic-check",
        *pw::keys::NODE_DESCRIPTION => "OnKey (mic check)",
        *pw::keys::APP_NAME => "OnKey",
    };
    if let Some(m) = mic {
        props.insert("target.object", m);
    }
    let stream = pw::stream::StreamRc::new(core.clone(), "onkey-mic-check", props)?;
    METER_BLOCKS.store(0, Ordering::Relaxed);
    METER_DB.store((-120f32).to_bits(), Ordering::Relaxed);
    let listener = stream.add_local_listener_with_user_data(())
        .process(|stream, _| with_samples(stream, |s| {
            if s.is_empty() {
                return;
            }
            let ms = s.iter().map(|v| v * v).sum::<f32>() / s.len() as f32;
            METER_DB.store((10.0 * (ms + 1e-12).log10()).max(-120.0).to_bits(), Ordering::Relaxed);
            METER_BLOCKS.fetch_add(1, Ordering::Relaxed);
        }))
        .register()?;
    let values = format_param(1, &[spa::sys::SPA_AUDIO_CHANNEL_MONO]);
    let mut params = [spa::pod::Pod::from_bytes(&values).ok_or(pw::Error::CreationFailed)?];
    stream.connect(spa::utils::Direction::Input, None,
                   pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS | pw::stream::StreamFlags::RT_PROCESS, &mut params)?;
    Ok((stream, listener))
}

// ---------------------------------------------------------------- what the rest of OnKey asks

/// Start capturing `app`'s streams and the mic `mic` (a node name; None: the default input), each block of
/// interleaved [L, R, mic] frames at `RATE` given to `on_frames` on PipeWire's real-time thread. False if PipeWire
/// isn't there or wouldn't make the node.
pub fn capture(app: App, mic: Option<String>, on_frames: fn(&[f32])) -> bool {
    let (tx, rx) = mpsc::channel();
    send(Cmd::Capture { app, mic, on_frames, reply: tx }) && rx.recv_timeout(Duration::from_secs(3)).unwrap_or(false)
}

pub fn stop_capture() {
    if TX.lock().unwrap().is_some() {
        send(Cmd::StopCapture);
    }
}

/// Whether `app` has any output stream now (playing or not), and whether one is running.
pub fn streams(app: &App) -> (bool, bool) {
    graph(|g| {
        let mine: Vec<&Node> = g.nodes.values().filter(|n| belongs(n, app)).collect();
        (!mine.is_empty(), mine.iter().any(|n| n.running))
    })
}

/// The microphones (input devices), and the default one's name.
pub fn sources() -> (Vec<Node>, String) {
    graph(|g| (g.nodes.values().filter(|n| n.class == "Audio/Source" && !ours(n)).cloned().collect(), g.default_source.clone()))
}

/// The default output device, if known.
pub fn default_sink() -> Option<Node> {
    graph(|g| g.nodes.values().find(|n| n.name == g.default_sink && n.class == "Audio/Sink").cloned())
}

/// Start or stop the mic meter on `mic` (a node name; None: the default input). True if it's running afterwards.
pub fn meter(on: bool, mic: Option<String>) -> bool {
    if !on {
        if TX.lock().unwrap().is_some() {
            send(Cmd::StopMeter);
        }
        METER_DB.store((-120f32).to_bits(), Ordering::Relaxed);
        return false;
    }
    let (tx, rx) = mpsc::channel();
    send(Cmd::Meter { mic, reply: tx }) && rx.recv_timeout(Duration::from_secs(3)).unwrap_or(false)
}

/// The meter's latest level (dBFS; -120 when it isn't running) and how many blocks of audio have reached it.
pub fn meter_level() -> (f32, usize) {
    (f32::from_bits(METER_DB.load(Ordering::Relaxed)), METER_BLOCKS.load(Ordering::Relaxed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(id: u32, app_name: &str, binary: &str, app_id: &str, pid: Option<u32>) -> Node {
        Node { id, class: "Stream/Output/Audio".into(), app_name: app_name.into(), binary: binary.into(), app_id: app_id.into(), pid, ..Default::default() }
    }

    #[test]
    fn an_apps_streams_are_found_by_its_process_or_its_names() {
        let feishin = App { pid: Some(1), names: vec!["feishin".into()] };
        // its own process, or one it started (pid 1 is everyone's ancestor)
        assert!(belongs(&stream(1, "mpv", "mpv", "", Some(1)), &feishin));
        // a sandboxed browser: its process can't be told, its names can
        let brave = App { pid: Some(999_999_999), names: vec!["brave".into(), "com.brave.browser".into()] };
        assert!(belongs(&stream(2, "Brave", "brave", "", Some(5)), &brave));
        assert!(belongs(&stream(3, "Brave input", "", "", None), &brave));
        assert!(belongs(&stream(4, "", "", "com.brave.Browser", None), &brave));
        assert!(!belongs(&stream(5, "Firefox", "firefox", "", Some(5)), &brave));
        // only an app's output streams
        let mic = Node { class: "Stream/Input/Audio".into(), ..stream(6, "Brave", "brave", "", None) };
        assert!(!belongs(&mic, &brave));
        // never OnKey's own sound (its window plays takes back)
        assert!(!belongs(&stream(7, "OnKey", "onkey", "", Some(std::process::id())), &App { pid: Some(std::process::id()), names: vec!["onkey".into()] }));
    }

    #[test]
    fn the_capture_node_is_linked_to_the_apps_channels_and_one_mic_channel() {
        let mut g = Graph::default();
        let me = 10;
        g.nodes.insert(20, stream(20, "Feishin", "feishin", "", None));
        g.nodes.insert(21, stream(21, "mono app", "", "", None));
        g.nodes.insert(30, Node { id: 30, class: "Audio/Source".into(), name: "mic".into(), ..Default::default() });
        g.default_source = "mic".into();
        let port = |node, output, channel: &str| Port { node, output, channel: channel.into(), monitor: false };
        for (id, p) in [(100, port(me, false, "FL")), (101, port(me, false, "FR")), (102, port(me, false, "AUX0")),
                        (200, port(20, true, "FL")), (201, port(20, true, "FR")), (210, port(21, true, "MONO")),
                        (300, port(30, true, "FL")), (301, port(30, true, "FR"))] {
            g.ports.insert(id, p);
        }
        let app = App { pid: None, names: vec!["feishin".into()] };
        let mut w: Vec<(u32, u32)> = wanted(&g, me, &app, None).into_iter().map(|(k, _)| k).collect();
        w.sort();
        assert_eq!(w, vec![(200, 100), (201, 101), (300, 102)]);
        let mono = App { pid: None, names: vec!["mono".into()] };
        let mut w: Vec<(u32, u32)> = wanted(&g, me, &mono, Some("mic")).into_iter().map(|(k, _)| k).collect();
        w.sort();
        assert_eq!(w, vec![(210, 100), (210, 101), (300, 102)]);
        // no such mic: the music alone
        assert_eq!(wanted(&g, me, &app, Some("gone")).len(), 2);
        // before the node's own ports are there: nothing
        assert!(wanted(&g, 11, &app, None).is_empty());
    }
}
