"use client";
// Settings: every switch is something you allow. "Let OnKey control" Spotify, Apple Music (on by default) and YouTube in
// your browser (opt-in): all three off is listening only (settings.rs `listen_only`; there's no switch of its own). Then
// "Use Shazam to name new songs" (on by default; off, nothing is sent to Apple), "Show lyrics" (on by default; off, LRCLIB
// isn't asked) and the microphone. On Linux the music app is a desktop player (MPRIS): which one to follow, and whether
// OnKey may control it, instead of the apps and Shazam. (The output timing check, components/TimingCheck.tsx, is retired: see
// timing::CHECK_RETIRED.)
import Link from "next/link";
import { useEffect, useState } from "react";
import { Logo, Nav } from "@/components/Nav";
import { reportProblem } from "@/components/ReportProblem";
import { checkForUpdate, restartToUpdate, setAutoUpdate, useUpdate } from "@/lib/update";
import { allowControl, getMics, getPlayers, getSettings, onLinux, openLink, setMic, setPlayer, setSetting, setupControl, setYouTube, type Mics, type Players, type Settings } from "@/lib/session";

/** Linux: the desktop player to follow (whichever plays, or one chosen), and whether OnKey may control it. */
function PlayerPicker({ control, onControl }: { control: boolean; onControl: (on: boolean) => void }) {
  const [p, setP] = useState<Players | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => getPlayers().then(v => { if (alive) setP(v); }).catch(() => {});
    load();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, 3000);   // players come and go
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!p) return null;
  const missing = p.chosen != null && !p.players.some(x => x.key === p.chosen);
  const pick = async (key: string) => { await setPlayer(key === "" ? null : key); setP(await getPlayers()); };
  return (
    <>
      <h2 className="mt-6 mb-2 px-1 text-sm font-medium text-ink-200">Music player</h2>
      <section className="glass overflow-hidden rounded-3xl">
        <div className="flex items-start justify-between gap-6 border-b border-white/6 px-5 py-4">
          <div className="min-w-0">
            <label htmlFor="set-player" className="text-sm font-medium text-ink-100">Follow</label>
            <p className="mt-1 text-xs text-ink-400">
              Any player that says what it plays (MPRIS): Feishin, Supersonic, Spotify, a browser. Automatic follows the one
              playing, one whose sound is on this computer first.{missing ? " The one you chose isn’t open." : ""}
            </p>
          </div>
          <select id="set-player" value={p.chosen ?? ""} onChange={e => pick(e.target.value)}
                  className="mt-0.5 max-w-56 shrink-0 rounded-lg border border-white/8 bg-white/4 px-2.5 py-1.5 text-sm text-ink-100 outline-none focus:border-accent-400">
            <option value="">Automatic</option>
            {p.players.map(x => <option key={x.key} value={x.key}>{x.name}</option>)}
            {missing && <option value={p.chosen!}>{p.chosen} (not open)</option>}
          </select>
        </div>
        <Row id="set-mpris" title="Let OnKey control it" on={control} onChange={onControl}
             sub="Play, pause, start over and skip to the singing from OnKey. Off, OnKey still reads what’s playing and where, and touches nothing." />
      </section>
    </>
  );
}

/** Which microphone OnKey listens to: automatic (the Mac's input, as chosen in System Settings → Sound) or one
 *  picked here. Setup's mic check and your takes use the same one. */
function MicPicker() {
  const [m, setM] = useState<Mics | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => getMics().then(v => { if (alive) setM(v); }).catch(() => {});
    load();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, 3000);   // a mic plugged in or out shows up
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!m) return null;
  const missing = m.preferred != null && !m.devices.some(d => d.uid === m.preferred);
  const pick = async (uid: string) => { await setMic(uid === "" ? null : uid); setM(await getMics()); };
  return (
    <>
      <h2 className="mt-8 mb-2 px-1 text-sm font-medium text-ink-200">Microphone</h2>
      <section className="glass overflow-hidden rounded-3xl">
        <div className="flex items-start justify-between gap-6 px-5 py-4">
          <div className="min-w-0">
            <label htmlFor="set-mic" className="text-sm font-medium text-ink-100">Listen to</label>
            <p className="mt-1 text-xs text-ink-400">
              {m.chosen ? <>Now: {m.chosen.name}.</> : <span className="text-amber-200">No microphone is connected.</span>}{" "}
              {missing ? `The one you chose isn’t connected, so OnKey uses the ${onLinux() ? "computer" : "Mac"}’s own input until it is. ` : ""}
              {onLinux()
                ? "Automatic uses your computer’s input (Settings → Sound), but not Bluetooth headphones’ mic while it has its own, so the music stays at full quality in them."
                : "Automatic uses your Mac’s input (System Settings → Sound), but not Bluetooth headphones’ mic while the Mac has its own, so the music stays at full quality in them."}
            </p>
          </div>
          <select id="set-mic" value={m.preferred ?? ""} onChange={e => pick(e.target.value)}
                  className="mt-0.5 max-w-56 shrink-0 rounded-lg border border-white/8 bg-white/4 px-2.5 py-1.5 text-sm text-ink-100 outline-none focus:border-accent-400">
            <option value="">Automatic</option>
            {m.devices.map(d => <option key={d.uid} value={d.uid}>{d.name}</option>)}
            {missing && <option value={m.preferred!}>Not connected</option>}
          </select>
        </div>
      </section>
    </>
  );
}

/** Updates: this version, "Check for updates automatically" (on), and "Check now". */
function Updates() {
  const [u, setU] = useUpdate();
  const [busy, setBusy] = useState(false);
  if (!u) return null;
  const check = async () => { setBusy(true); try { setU(await checkForUpdate()); } finally { setBusy(false); } };
  const line = !u.supported ? (onLinux() ? "OnKey for Linux doesn’t update itself: build a newer version from source." : "Development build: it doesn’t update itself.")
    : u.waiting ? `OnKey ${u.available} is installed when this song is over, then OnKey restarts.`
    : u.state === "ready" ? `OnKey ${u.available} is ready. Restart to update, or it’s installed when you quit.`
    : u.state === "downloading" ? `Downloading OnKey ${u.available}…`
    : u.state === "checking" ? "Checking…"
    : u.state === "current" ? "You have the latest version."
    : u.state === "error" ? "Couldn’t check for updates just now."
    : "";
  return (
    <>
      <div className="flex items-start justify-between gap-6 border-b border-white/6 px-5 py-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink-100">OnKey {u.version}</div>
          {line && <p className="mt-1 text-xs text-ink-400">{line}</p>}
        </div>
        {u.supported && (u.state === "ready" && !u.waiting
          ? <button onClick={async () => setU(await restartToUpdate())}
                    className="shrink-0 rounded-lg bg-accent-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-accent-400">Restart to update</button>
          : <button onClick={check} disabled={busy || u.state === "checking" || u.state === "downloading" || u.waiting}
                    className="shrink-0 rounded-lg border border-white/8 bg-white/4 px-3 py-1.5 text-sm text-ink-100 transition hover:bg-white/8 disabled:opacity-40">Check now</button>)}
      </div>
      {u.supported && (
        <Row id="set-auto-update" title="Check for updates automatically" on={u.auto} onChange={async on => setU(await setAutoUpdate(on))}
             sub="Once a day OnKey asks GitHub for a newer version and downloads it in the background. It never interrupts a song: it’s installed when you restart or quit." />
      )}
    </>
  );
}

function Row({ id, title, sub, on, onChange, badge, warn, disabled }: {
  id: string; title: string; sub: string; on: boolean; onChange: (on: boolean) => void; badge?: string; warn?: boolean; disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-white/6 px-5 py-4 last:border-0">
      <div className="min-w-0">
        <label htmlFor={id} className="flex items-center gap-2 text-sm font-medium text-ink-100">
          {title}
          {badge && <span className={`rounded-full px-1.5 py-px text-[10px] font-normal ${warn ? "bg-amber-400/12 text-amber-200" : "bg-white/6 text-ink-300"}`}>{badge}</span>}
        </label>
        <p className="mt-1 text-xs text-ink-400">{sub}</p>
      </div>
      <button id={id} role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}
              className={`relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition disabled:opacity-40 ${on ? "bg-accent-500" : "bg-white/12"}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => { getSettings().then(setS).catch(() => setS(null)); }, []);
  // listening only: Spotify, Apple Music and YouTube all off (settings.rs `listen_only`)
  const listenOnly = !!s?.listen_only;
  const change = async (key: Exclude<keyof Settings, "small_mac" | "listen_only" | "platform">, on: boolean) => {
    if (key === "youtube") await setYouTube(on);
    else if (key === "keep_models" || key === "battery_30fps" || key === "voice_breaks" || key === "shazam" || key === "show_lyrics" || key === "control_mpris") await setSetting(key, on);
    else if ((key === "control_spotify" || key === "control_music") && !on && s && !s.listening) {
      // the older way (following the apps by asking them, which controls both): turning one off moves to listening,
      // with the other app still allowed, as the old "Listen only" switch's way out did
      await setupControl(true);
      await setSetting(key, false);
    }
    else if (on && key !== "listening") await allowControl(key);
    else await setSetting(key, on);
    setS(await getSettings());
  };

  return (
    <div className="min-h-dvh bg-[radial-gradient(1200px_500px_at_50%_-10%,rgba(124,108,246,.10),transparent)]">
      <header data-tauri-drag-region className="app-header flex items-center gap-5 px-6 pt-4 pb-3"><Logo /><Nav /></header>
      <main className="mx-auto max-w-2xl px-6 pb-16">
        <h1 className="mt-6 text-3xl font-semibold tracking-tight">Settings</h1>
        {s && s.platform === "linux" && <PlayerPicker control={s.control_mpris !== false} onControl={on => change("control_mpris", on)} />}
        {!s ? <div className="glass mt-6 h-40 rounded-3xl shimmer" /> : s.platform === "linux" ? (
          <>
            <h2 className="mt-8 mb-2 px-1 text-sm font-medium text-ink-200">Lyrics</h2>
            <section className="glass overflow-hidden rounded-3xl">
              <Row id="set-show-lyrics" title="Show lyrics" on={s.show_lyrics !== false} onChange={on => change("show_lyrics", on)}
                   sub="Lyrics come from LRCLIB, a free community lyrics database. When off, OnKey doesn’t ask LRCLIB for any, and you sing to the notes alone: the pitch guide and your score work as usual." />
            </section>
          </>
        ) : (
          <>
            <h2 className="mt-6 mb-2 px-1 text-sm font-medium text-ink-200">Let OnKey control</h2>
            <p className="mb-3 px-1 text-xs text-ink-400">
              {s.listening
                ? "On by default: OnKey reads what’s playing and where (exact, instant positions), and can play, pause, seek and start songs. Nothing else. macOS asks once for each."
                : "OnKey follows Spotify and Apple Music by asking them, so it controls them already."}
            </p>
            <section className="glass overflow-hidden rounded-3xl">
              <Row id="set-spotify" title="Spotify" on={!s.listening || s.control_spotify} onChange={on => change("control_spotify", on)}
                   sub="Start, pause and skip songs in Spotify from OnKey." />
              <Row id="set-music" title="Apple Music" on={!s.listening || s.control_music} onChange={on => change("control_music", on)}
                   sub="The same for the Music app (songs in your library)." />
              <Row id="set-youtube" title="YouTube in your browser" badge="Bigger permission" warn on={s.youtube} onChange={on => change("youtube", on)}
                   sub="Lets OnKey read and control the YouTube tab in Chrome, Brave, Edge or Safari. Needs “Allow JavaScript from Apple Events” turned on in the browser." />
            </section>
            {s.listening && (
              <p role="status" className="mt-3 px-1 text-xs text-ink-400">
                {listenOnly
                  ? <>OnKey is listening only: it follows songs by their sound, and doesn’t touch any app. Positions are a little
                      less exact, and it can’t start or restart songs. Turning an app off here doesn’t take back macOS’s
                      permission: that’s in System Settings → Privacy &amp; Security → Automation.</>
                  : "With all of these off, OnKey follows songs by their sound alone."}
              </p>
            )}
            <section className="glass mt-8 overflow-hidden rounded-3xl">
              <Row id="set-shazam" title="Use Shazam to name new songs" on={s.shazam !== false} onChange={on => change("shazam", on)}
                   sub="Songs you’ve sung before are recognised on this Mac. New songs from Spotify and Apple Music are named by the app itself while OnKey may control it; Shazam names the rest from a short fingerprint of the sound (not the audio). When off, nothing is sent to Apple and only songs already learned on this Mac are recognised there." />
              {s.listening && !s.control_spotify && !s.control_music && s.shazam === false && (
                <p role="status" className="bg-amber-400/8 px-5 py-3 text-xs text-amber-200">
                  With Spotify and Apple Music off, new songs can only be learned with Shazam on. Songs already learned still work.
                </p>
              )}
            </section>
            <h2 className="mt-8 mb-2 px-1 text-sm font-medium text-ink-200">Lyrics</h2>
            <section className="glass overflow-hidden rounded-3xl">
              <Row id="set-show-lyrics" title="Show lyrics" on={s.show_lyrics !== false} onChange={on => change("show_lyrics", on)}
                   sub="Lyrics come from LRCLIB, a free community lyrics database. When off, OnKey doesn’t ask LRCLIB for any, and you sing to the notes alone: the pitch guide and your score work as usual." />
            </section>
          </>
        )}
        <MicPicker />
        {s && (
          <>
            <h2 className="mt-8 mb-2 px-1 text-sm font-medium text-ink-200">Your voice</h2>
            <section className="glass overflow-hidden rounded-3xl">
              <Row id="set-voice-breaks" title="Remind me to rest my voice" on={s.voice_breaks !== false} onChange={on => change("voice_breaks", on)}
                   sub="After about 35 minutes of singing, a quiet reminder to take a break. A 20-minute pause from singing starts the count again." />
            </section>
            <h2 className="mt-8 mb-2 px-1 text-sm font-medium text-ink-200">Performance</h2>
            <section className="glass overflow-hidden rounded-3xl">
              <Row id="set-battery-30" title="Save battery while singing" on={s.battery_30fps !== false} onChange={on => change("battery_30fps", on)}
                   sub="On battery, the notes are drawn 30 times a second instead of 60: half the drawing work for your Mac, still smooth." />
              {!s.small_mac && <Row id="set-keep-models" title="Keep learning models ready" on={!!s.keep_models} onChange={on => change("keep_models", on)}
                   sub="Faster learning of new songs, but uses about 1.5 GB more memory, also while you sing songs OnKey already knows. Off, they’re loaded when a new song is learned and let go after. On by default on Macs with 32 GB or more." />}
            </section>
          </>
        )}
        <h2 className="mt-8 mb-2 px-1 text-sm font-medium text-ink-200">About</h2>
        <section className="glass overflow-hidden rounded-3xl">
          <Updates />
          <button onClick={() => reportProblem()} className="flex w-full items-center justify-between gap-6 border-b border-white/6 px-5 py-4 text-left text-sm text-ink-100 hover:bg-white/4">
            <span>
              Report a problem
              <span className="mt-1 block text-xs text-ink-400">Save OnKey’s logs and timings as a zip to attach to a GitHub issue. You see what’s in it first; no lyrics or audio, nothing uploaded.</span>
            </span>
            <span aria-hidden className="text-ink-400">›</span>
          </button>
          <button onClick={() => void openLink("https://discord.gg/afHvqTNS6r")}
                  className="flex w-full items-center justify-between gap-6 border-b border-white/6 px-5 py-4 text-left text-sm text-ink-100 hover:bg-white/4">
            <span>
              Join OnKey’s Discord
              <span className="mt-1 block text-xs text-ink-400">Ask questions, report a song that’s out of step, and suggest ideas.</span>
            </span>
            <span aria-hidden className="text-ink-400">↗</span>
          </button>
          <div className="flex items-center gap-3 border-b border-white/6 px-5 py-4 text-sm text-ink-100">
            <img src="/dsmurrell.png" alt="" width={20} height={20} className="rounded" />
            <span>
              Made by <a href="https://dsmurrell.com" onClick={e => { e.preventDefault(); void openLink("https://dsmurrell.com"); }}
                         className="underline-offset-2 hover:underline">Daniel Murrell</a>
              <span className="mt-1 block text-xs italic text-ink-500">Saving shower singers from themselves since 2026</span>
            </span>
          </div>
          <Link href="/licences" className="flex items-center justify-between gap-6 px-5 py-4 text-sm text-ink-100 hover:bg-white/4">
            <span>
              Open-source licences
              <span className="mt-1 block text-xs text-ink-400">The models, data, fonts and libraries OnKey is built on, and their licences.</span>
            </span>
            <span aria-hidden className="text-ink-400">›</span>
          </Link>
        </section>
        <p className="mt-3 px-1 text-xs text-ink-400">
          For personal practice at home. What OnKey learns stays on this {onLinux() ? "computer" : "Mac"}: please keep it to yourself, and don’t post
          takes or screen recordings with the music in them.
        </p>
      </main>
    </div>
  );
}
