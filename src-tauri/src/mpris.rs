//! Desktop music players on Linux, through MPRIS (the D-Bus interface that Feishin, Supersonic, Spotify, browsers and
//! most players publish): what's playing and where, and playback control. What spotify.rs and music.rs do with
//! AppleScript on macOS, for any player, with no permission to ask for.
//!
//! A player is known by its bus name ("org.mpris.MediaPlayer2.Feishin"), which is also what OnKey calls its bundle
//! elsewhere: the app whose sound is captured (pw.rs finds its streams by its process and its names). Songs are kept
//! under "mpris:" and a hash of their artist and title, so the same song from your server is the same song whichever
//! player plays it.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use dbus::arg::{PropMap, RefArg};
use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;
use dbus::blocking::Connection;

use crate::source::{Source, State, Track};

/// Track ids: "mpris:" and a hash of the song's artist and title.
pub const ID_PREFIX: &str = "mpris:";
/// Every player's bus name starts with this.
pub const BUS_PREFIX: &str = "org.mpris.MediaPlayer2.";
const PATH: &str = "/org/mpris/MediaPlayer2";
const PLAYER: &str = "org.mpris.MediaPlayer2.Player";
/// How long a player has to answer (they take well under a millisecond).
const TIMEOUT: Duration = Duration::from_millis(400);
/// The settings key of the player chosen in Settings (`key` of its bus name); none: whichever plays.
pub const SETTING: &str = "mpris_player";

static CONN: Mutex<Option<Connection>> = Mutex::new(None);

/// `f` with the session bus (connected now if not); a call that fails drops the connection, to connect afresh.
fn bus<R>(f: impl FnOnce(&Connection) -> Result<R, dbus::Error>) -> Option<R> {
    let mut c = CONN.lock().unwrap_or_else(|e| e.into_inner());
    if c.is_none() {
        *c = Connection::new_session().ok();
    }
    let r = f(c.as_ref()?);
    if let Err(e) = &r {
        // a player that quit, or didn't answer: not the bus's fault
        if !matches!(e.name(), Some("org.freedesktop.DBus.Error.ServiceUnknown" | "org.freedesktop.DBus.Error.NoReply"
                                    | "org.freedesktop.DBus.Error.UnknownMethod" | "org.freedesktop.DBus.Error.UnknownProperty"
                                    | "org.freedesktop.DBus.Error.InvalidArgs" | "org.freedesktop.DBus.Error.NotSupported")) {
            *c = None;
        }
    }
    r.ok()
}

/// Strings that live as long as OnKey (bus names and player names, a handful), as the rest of OnKey takes its
/// apps' names.
fn intern(s: &str) -> &'static str {
    static ALL: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
    let mut all = ALL.lock().unwrap();
    if let Some(k) = all.iter().find(|k| **k == s) {
        return k;
    }
    let k: &'static str = Box::leak(s.to_string().into_boxed_str());
    all.push(k);
    k
}

/// A player on the bus.
#[derive(Debug, Clone)]
pub struct Player {
    pub bus: &'static str,
    /// what it calls itself ("Feishin", "Brave")
    pub identity: &'static str,
    /// its desktop entry ("feishin", "com.brave.Browser"), if it says
    pub desktop: String,
    /// the process that owns its bus name (for a sandboxed app, the sandbox's proxy)
    pub pid: Option<u32>,
}

impl Player {
    /// The name kept for it in Settings: its bus name without the prefix and a browser's instance number
    /// ("brave.instance2" → "brave"), the same each time it starts.
    pub fn key(&self) -> &str {
        key(self.bus)
    }
}

pub fn key(bus: &str) -> &str {
    let k = bus.strip_prefix(BUS_PREFIX).unwrap_or(bus);
    k.split(".instance").next().unwrap_or(k)
}

/// What players said about themselves, asked again after a while (one restarted keeps its name, not its process).
static INFO: Mutex<Option<(Instant, HashMap<String, Player>)>> = Mutex::new(None);

/// The players there now. Not OnKey's own window (WebKit publishes a player for a page's media), and not
/// playerctld (a stand-in for whichever other player was used last).
pub fn players() -> Vec<Player> {
    let Some(names) = bus(|c| {
        let p = c.with_proxy("org.freedesktop.DBus", "/org/freedesktop/DBus", TIMEOUT);
        p.method_call::<(Vec<String>,), _, _, _>("org.freedesktop.DBus", "ListNames", ()).map(|r| r.0)
    }) else { return Vec::new() };
    let mut names: Vec<String> = names.into_iter().filter(|n| n.starts_with(BUS_PREFIX) && !n.ends_with(".playerctld")).collect();
    names.sort();
    let mut info = INFO.lock().unwrap();
    if info.as_ref().map_or(true, |(at, _)| at.elapsed() > Duration::from_secs(5)) {
        *info = Some((Instant::now(), HashMap::new()));
    }
    let known = &mut info.as_mut().unwrap().1;
    let me = std::process::id();
    names.into_iter().filter_map(|n| {
        if !known.contains_key(&n) {
            let pid = bus(|c| c.with_proxy("org.freedesktop.DBus", "/org/freedesktop/DBus", TIMEOUT)
                .method_call::<(u32,), _, _, _>("org.freedesktop.DBus", "GetConnectionUnixProcessID", (n.as_str(),)).map(|r| r.0));
            let (identity, desktop) = bus(|c| {
                let p = c.with_proxy(n.as_str(), PATH, TIMEOUT);
                let id = p.get::<String>("org.mpris.MediaPlayer2", "Identity").unwrap_or_default();
                Ok((id, p.get::<String>("org.mpris.MediaPlayer2", "DesktopEntry").unwrap_or_default()))
            }).unwrap_or_default();
            let bus = intern(&n);
            let identity = intern(if identity.is_empty() { key(bus) } else { &identity });
            known.insert(n.clone(), Player { bus, identity, desktop, pid });
        }
        known.get(&n).cloned()
    }).filter(|p| !p.pid.is_some_and(|pid| crate::pw::descends(pid, me))).collect()
}

/// The player with this bus name, if it's there.
pub fn player(bus: &str) -> Option<Player> {
    players().into_iter().find(|p| p.bus == bus)
}

/// The player chosen in Settings (its `key`), if one was.
pub fn chosen() -> Option<String> {
    crate::settings::get_str(SETTING).filter(|k| !k.is_empty())
}

/// Whose sound is `bus`'s (pw.rs): its process and the names its streams may have.
pub fn app(bus: &str) -> crate::pw::App {
    let p = player(bus);
    let mut names = vec![key(bus).to_lowercase()];
    if let Some(p) = &p {
        names.push(p.identity.to_lowercase());
        names.push(p.desktop.to_lowercase());
    }
    names.retain(|n| !n.is_empty());
    names.dedup();
    crate::pw::App { pid: p.and_then(|p| p.pid), names }
}

/// What people call the player (`Identity`), for the window; "your music player" if it isn't there.
pub fn name(bus: &str) -> &'static str {
    player(bus).map_or("your music player", |p| p.identity)
}

/// What a player says: playing or not, its song, and where in it (None: nothing loaded).
pub fn status(bus: &str) -> Option<State> {
    let (playing, meta, position) = bus_call(bus, |p| {
        let st = p.get::<String>(PLAYER, "PlaybackStatus")?;
        let meta = p.get::<PropMap>(PLAYER, "Metadata")?;
        // (a player that can't say where it is: the song's start, and listening's clock places it)
        let pos = p.get::<i64>(PLAYER, "Position").unwrap_or(0);
        Ok((st == "Playing", meta, pos))
    })?;
    let text = |k: &str| meta.get(k).and_then(|v| v.0.as_str()).unwrap_or("").trim().to_string();
    let name = text("xesam:title");
    if name.is_empty() {
        return None;
    }
    let artist = meta.get("xesam:artist").map(|v| match v.0.as_iter() {
        Some(it) => it.filter_map(|a| a.as_str().map(str::to_string)).collect::<Vec<_>>().join(", "),
        None => v.0.as_str().unwrap_or("").to_string(),
    }).unwrap_or_default();
    let micros = |v: &dbus::arg::Variant<Box<dyn RefArg>>| v.0.as_i64().or_else(|| v.0.as_u64().map(|u| u as i64)).or_else(|| v.0.as_f64().map(|f| f as i64));
    let duration = meta.get("mpris:length").and_then(micros).unwrap_or(0) as f64 / 1e6;
    // a podcast episode or an ad (Spotify says so in its track ids) is never learned: source::is_song
    let trackid = meta.get("mpris:trackid").and_then(|v| v.0.as_str()).unwrap_or("").to_string();
    let id = if ["/episode/", "/ad/", "/chapter/", ":episode:", ":ad:"].iter().any(|k| trackid.contains(k)) {
        track_id(&artist, &name).replacen(ID_PREFIX, NOT_SONG_PREFIX, 1)
    } else {
        track_id(&artist, &name)
    };
    // the cover from Apple's public iTunes Search, as for Apple Music (the player's own cover address can carry
    // your server's login)
    let cover = crate::music::cover_cached(&id, &artist, &name);
    Some(State {
        playing,
        track: Track { art: cover.as_ref().map(|c| c.art.clone()), link: cover.and_then(|c| c.link), id, name, artist,
                       album: text("xesam:album"), duration },
        position: (position as f64 / 1e6).max(0.0),
        source: Source::Mpris,
    })
}

fn bus_call<R>(bus_name: &str, f: impl FnOnce(&dbus::blocking::Proxy<'_, &Connection>) -> Result<R, dbus::Error>) -> Option<R> {
    bus(|c| f(&c.with_proxy(bus_name, PATH, TIMEOUT)))
}

/// A song's id: its artist and title, lower case, hashed (FNV-1a, 64 bits).
pub fn track_id(artist: &str, name: &str) -> String {
    let key = format!("{}\n{}", artist.trim().to_lowercase(), name.trim().to_lowercase());
    let h = key.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3));
    format!("{ID_PREFIX}{h:016x}")
}

/// Track ids of what isn't a song (a podcast episode, an ad): "mpris:episode:" and the hash.
pub const NOT_SONG_PREFIX: &str = "mpris:episode:";

/// A browser's player (its sound is anything: videos, calls, a talk), by its names.
fn browser(p: &Player) -> bool {
    let names = format!("{} {} {}", p.identity, p.desktop, key(p.bus)).to_lowercase();
    ["brave", "chrom", "firefox", "edge", "vivaldi", "opera", "epiphany", "librewolf", "zen", "browser"].iter().any(|b| names.contains(b))
}

/// What the player followed plays may not be a song: it's a browser (as a YouTube video on macOS: youtube.rs
/// `might_not_be_song`), so its first minute is checked for talk when no lyrics are found (engine.rs).
pub fn might_not_be_song(track_id: &str) -> bool {
    track_id.starts_with(ID_PREFIX) && followed().and_then(player).is_some_and(|p| browser(&p))
}

/// The players that may be followed: the one chosen in Settings, else all of them.
fn candidates() -> Vec<Player> {
    let chosen = chosen();
    players().into_iter().filter(|p| chosen.as_deref().map_or(true, |c| p.key() == c)).collect()
}

/// The player playing now (`prefer`, the one followed so far, while it still plays), for listening mode: of those
/// MPRIS says are playing, one whose sound is on this computer first (a phone's player relayed over Bluetooth, or
/// Spotify playing on another device, says it plays too).
pub fn sounding(prefer: Option<&str>) -> Option<&'static str> {
    let playing: Vec<Player> = candidates().into_iter()
        .filter(|p| bus_call(p.bus, |x| x.get::<String>(PLAYER, "PlaybackStatus")).is_some_and(|s| s == "Playing")).collect();
    let rank = |p: &Player| {
        let (any, running) = crate::pw::streams(&app(p.bus));
        (running as u8) * 2 + any as u8
    };
    let best = playing.iter().map(rank).max()?;
    playing.iter().filter(|p| rank(p) == best).find(|p| Some(p.bus) == prefer).or_else(|| playing.iter().find(|p| rank(p) == best)).map(|p| p.bus)
}

/// The player OnKey follows: listening's (the one playing sound), else the one playing, else the first there.
fn followed() -> Option<&'static str> {
    static LAST: Mutex<Option<&'static str>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap();
    let now = crate::listen::want_bundle().filter(|b| b.starts_with(BUS_PREFIX))
        .or_else(|| sounding(*last))
        .or_else(|| last.filter(|b| candidates().iter().any(|p| p.bus == *b)))
        .or_else(|| candidates().first().map(|p| p.bus));
    *last = now;
    now
}

/// The bus name of the player followed (what's captured), or the prefix when there's none yet.
pub fn bundle() -> &'static str {
    followed().unwrap_or(BUS_PREFIX)
}

/// What the player followed is playing and where.
pub fn state() -> Option<State> {
    status(followed()?)
}

/// "restart", "next", "previous", "playpause", "pause" or "play".
pub fn control(action: &str) {
    let Some(b) = followed() else { return };
    let method = match action {
        "restart" => return seek(0.0),
        "next" => "Next",
        "previous" => "Previous",
        "playpause" => "PlayPause",
        "pause" => "Pause",
        "play" => "Play",
        _ => return,
    };
    bus_call(b, |p| p.method_call::<(), _, _, _>(PLAYER, method, ()));
}

/// Jump to a position in the current track (seconds): SetPosition on the track's id; Seek by the difference for a
/// player that has none.
pub fn seek(seconds: f64) {
    let Some(b) = followed() else { return };
    let to = (seconds.max(0.0) * 1e6) as i64;
    bus_call(b, |p| {
        let meta = p.get::<PropMap>(PLAYER, "Metadata")?;
        match meta.get("mpris:trackid").and_then(|v| v.0.as_str()).and_then(|t| dbus::Path::new(t.to_string()).ok()) {
            Some(track) => p.method_call::<(), _, _, _>(PLAYER, "SetPosition", (track, to)),
            None => {
                let now = p.get::<i64>(PLAYER, "Position").unwrap_or(0);
                p.method_call::<(), _, _, _>(PLAYER, "Seek", (to - now,))
            }
        }
    });
}

/// Start a song: MPRIS has no way to ask a player for a song by name, so it's left to you (logged once).
pub fn play_track(id: &str) {
    static SAID: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !SAID.swap(true, std::sync::atomic::Ordering::Relaxed) {
        crate::engine::log(&format!("can't ask a player to play {id}: start the song in your player"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live, by hand: the players on the session bus and what each says.
    ///   cargo test --lib mpris::tests::live_players -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_players() {
        for p in players() {
            eprintln!("{} ({}, desktop {:?}, pid {:?}): {:?}", p.bus, p.identity, p.desktop, p.pid, status(p.bus));
            eprintln!("  its sound: {:?}, streams (any, running): {:?}", app(p.bus), crate::pw::streams(&app(p.bus)));
        }
        eprintln!("sounding: {:?}", sounding(None));
    }

    #[test]
    fn a_song_is_the_same_song_whichever_player_plays_it() {
        assert_eq!(track_id("Oasis", "Wonderwall"), track_id(" oasis", "WONDERWALL "));
        assert_ne!(track_id("Oasis", "Wonderwall"), track_id("Ryan Adams", "Wonderwall"));
        assert!(track_id("Oasis", "Wonderwall").starts_with(ID_PREFIX));
        assert_eq!(Source::of_id(&track_id("Oasis", "Wonderwall")), Source::Mpris);
        let episode = track_id("Oasis", "Wonderwall").replacen(ID_PREFIX, NOT_SONG_PREFIX, 1);
        assert!(!crate::source::is_song(&episode) && Source::of_id(&episode) == Source::Mpris);
    }

    #[test]
    fn a_browsers_instance_number_isnt_part_of_its_name() {
        assert_eq!(key("org.mpris.MediaPlayer2.brave.instance2"), "brave");
        assert_eq!(key("org.mpris.MediaPlayer2.firefox.instance_1_23"), "firefox");
        assert_eq!(key("org.mpris.MediaPlayer2.Feishin"), "Feishin");
    }
}
