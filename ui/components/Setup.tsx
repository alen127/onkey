"use client";
// First-run setup: what OnKey does, the two permissions it needs (the microphone, and system audio recording to
// hear the music app), letting it follow Spotify and Apple Music (recommended; or listen only), a quick "say
// something" mic check, then off you go. Shown by itself until finished; reopened from the "Setup" link on the
// waiting screen. On Linux there's nothing to allow (PipeWire lets OnKey hear the mic and your player) and the music
// app is whichever desktop player you use (MPRIS): those two steps say so, and list the players found.
import { useCallback, useEffect, useRef, useState } from "react";
import { getMics, getPlayers, onLinux, setupControl, setupDone, setupLevel, setupMeter, setupOpenSettings, setupRequest, setupStatus, type AppPerm, type AskAnswer, type Perm, type Players, type SetupStatus } from "@/lib/session";

const STEPS = ["Welcome", "Permissions", "Music apps", "Mic check", "Ready"] as const;

export default function Setup({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [st, setSt] = useState<SetupStatus | null>(null);
  const [audioOk, setAudioOk] = useState(false);        // the tap was allowed when we asked (status may say "unknown")

  const refresh = useCallback(() => { setupStatus().then(setSt).catch(() => {}); }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 1500);              // pick up changes made in System Settings
    addEventListener("focus", refresh);
    return () => { clearInterval(t); removeEventListener("focus", refresh); };
  }, [refresh]);

  const finish = async () => { await setupDone(true); onClose(); };
  const audio: Perm = audioOk && st?.audio !== "denied" ? "granted" : st?.audio ?? "unknown";
  const both = st?.mic === "granted" && audio === "granted";

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink-950/90 px-6">
      <div className="glass w-full max-w-lg animate-rise rounded-3xl px-8 pt-7 pb-6 shadow-2xl shadow-black/50" role="dialog" aria-label="Set up OnKey">
        <ol className="mb-6 flex items-center gap-2" aria-label="Setup steps">
          {STEPS.map((s, i) => (
            <li key={s} className="flex flex-1 flex-col gap-1.5">
              <span className={`h-1 rounded-full transition-colors ${i <= step ? "bg-accent-400" : "bg-white/8"}`} />
              <span className={`text-[11px] ${i === step ? "text-ink-200" : "text-ink-500"}`}>{s}</span>
            </li>
          ))}
        </ol>

        {step === 0 && <Welcome macosOk={st?.macos_ok ?? true} onNext={() => setStep(1)} onLater={onClose} />}
        {step === 1 && st && onLinux() && <LinuxPermissions onNext={() => setStep(2)} />}
        {step === 1 && st && !onLinux() && (
          <Permissions mic={st.mic} audio={audio} onAudioAllowed={() => setAudioOk(true)} refresh={refresh}
                       onNext={() => setStep(2)} canContinue={both} />
        )}
        {step === 1 && !st && <div className="h-40 rounded-2xl shimmer" />}
        {step === 2 && (onLinux() ? <LinuxPlayers onNext={() => setStep(3)} />
          : <MusicApps st={st} refresh={refresh} onNext={() => setStep(3)} />)}
        {step === 3 && <MicCheck micOk={st?.mic === "granted"} onNext={() => setStep(4)} onBack={() => setStep(1)} />}
        {step === 4 && <Ready onFinish={finish} />}
      </div>
    </div>
  );
}

function Primary({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
            className="rounded-xl bg-accent-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-40">
      {children}
    </button>
  );
}

function Quiet({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return <button onClick={onClick} className="text-sm text-ink-400 transition hover:text-ink-100">{children}</button>;
}

function Welcome({ macosOk, onNext, onLater }: { macosOk: boolean; onNext: () => void; onLater: () => void }) {
  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight">Welcome to OnKey</h2>
      <p className="mt-2 text-ink-300">Learn to sing the songs you love, with the music you already play.</p>
      <ul className="mt-5 space-y-3 text-sm leading-relaxed text-ink-200">
        <Point icon="M9 18V6l11-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z">
          Play a song in your music app, as you always do. OnKey listens to the music playing on your {onLinux() ? "computer" : "Mac"} and follows along by itself.
        </Point>
        <Point icon="M3 14c2.5 0 2.5-6 5-6s2.5 8 5 8 2.5-10 5-10 2 4 3 4">
          The first time a song plays, OnKey learns the singer’s melody. From then on you see every note coming, and where you’re sharp or flat.
        </Point>
        <Point icon="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z">
          {onLinux()
            ? "OnKey never saves the music it listens to. Your singing recordings stay on this computer so you can hear your takes back. Your player says what’s playing: nothing about the music is sent anywhere to name it."
            : "OnKey never saves the music it listens to. Your singing recordings stay on this Mac so you can hear your takes back. To name a new song, listening mode sends Apple’s Shazam a short fingerprint of the music app’s sound (not the audio)."}
        </Point>
      </ul>
      {!macosOk && (
        <p className="mt-5 rounded-xl bg-close/10 px-4 py-3 text-sm text-close">
          OnKey needs macOS 14.2 or later to hear other apps. Update macOS in System Settings → General → Software Update.
        </p>
      )}
      <div className="mt-7 flex items-center justify-between">
        <Quiet onClick={onLater}>Set up later</Quiet>
        <Primary onClick={onNext} disabled={!macosOk}>Get started</Primary>
      </div>
    </>
  );
}

function Point({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent-500/12 text-accent-300">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={icon} /></svg>
      </span>
      <span>{children}</span>
    </li>
  );
}

function Permissions({ mic, audio, onAudioAllowed, refresh, onNext, canContinue }: {
  mic: Perm; audio: Perm; onAudioAllowed: () => void; refresh: () => void; onNext: () => void; canContinue: boolean;
}) {
  const [asking, setAsking] = useState<"" | "mic" | "audio">("");
  const ask = async (what: "mic" | "audio") => {
    setAsking(what);
    try {
      const ok = await setupRequest(what);
      if (what === "audio" && ok) onAudioAllowed();
    } finally { setAsking(""); refresh(); }
  };
  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight">Two permissions</h2>
      <p className="mt-2 text-sm text-ink-300">macOS asks once for each. You can change them later in System Settings → Privacy &amp; Security.</p>
      <div className="mt-5 space-y-3">
        <PermRow title="Microphone" why="To hear you sing." state={mic} busy={asking === "mic"}
                 onAsk={() => ask("mic")} onSettings={() => setupOpenSettings("mic")}
                 settingsHint="Turn on OnKey under Microphone." />
        <PermRow title="System audio recording" why="To hear the music playing on your Mac, so OnKey can learn the melody. OnKey never saves the music or sends it; to name a song it doesn't know, a short fingerprint of it (not the audio) can go to Apple's Shazam."
                 state={audio} busy={asking === "audio"} onAsk={() => ask("audio")} onSettings={() => setupOpenSettings("audio")}
                 settingsHint="Open Screen & System Audio Recording and turn on OnKey under System Audio Recording Only." />
      </div>
      <p className="mt-4 text-xs leading-relaxed text-ink-500">
        If macOS asks to quit and reopen OnKey after you allow something, do. Setup carries on where you left off.
      </p>
      <div className="mt-6 flex items-center justify-between">
        <Quiet onClick={onNext}>{canContinue ? "" : "Skip for now"}</Quiet>
        <Primary onClick={onNext} disabled={!canContinue}>Continue</Primary>
      </div>
    </>
  );
}

/** Linux asks no permission for the mic or for hearing other apps (PipeWire). */
function LinuxPermissions({ onNext }: { onNext: () => void }) {
  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight">Nothing to allow</h2>
      <p className="mt-2 text-sm text-ink-300">
        On Linux OnKey hears your microphone and your music player through PipeWire, without asking. It listens only to
        the player it follows, and never saves or sends the music.
      </p>
      <div className="mt-6 flex justify-end"><Primary onClick={onNext}>Continue</Primary></div>
    </>
  );
}

/** Linux: the music app is a desktop player that says what it plays over MPRIS (Feishin, Supersonic, Spotify, a
 *  browser…). OnKey follows the one playing, or the one chosen in Settings, and may control it: play, pause, seek. */
function LinuxPlayers({ onNext }: { onNext: () => void }) {
  const [p, setP] = useState<Players | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => getPlayers().then(v => { if (alive) setP(v); }).catch(() => {});
    load();
    const t = setInterval(load, 2000);                 // a player opened meanwhile shows up
    return () => { alive = false; clearInterval(t); };
  }, []);
  const choose = async (allow: boolean) => { await setupControl(allow); onNext(); };
  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight">Your music player</h2>
      <p className="mt-3 text-sm text-ink-300">
        OnKey follows the player that’s playing: it says what the song is and where it’s at (MPRIS), so lyrics and notes are
        in the right place from the first second. OnKey can also play, pause and seek in it.
      </p>
      <div className="mt-5 space-y-2">
        {p?.players.length ? p.players.map(pl => (
          <div key={pl.key} className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/3 px-4 py-3">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-good/20 text-good" aria-hidden>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            </span>
            <span className="flex-1 font-medium text-ink-100">{pl.name}</span>
            {p.following === pl.key && <span className="text-xs text-ink-400">Playing</span>}
          </div>
        )) : (
          <p className="rounded-2xl border border-white/8 bg-white/3 px-4 py-3 text-sm text-ink-400">
            No player found yet. Open yours (Feishin, Supersonic, Spotify, or a browser) and it shows up here.
          </p>
        )}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-ink-500">
        Listen only: OnKey still reads what’s playing, but never plays, pauses or seeks. Choose one player to follow in
        Settings, if you use several.
      </p>
      <div className="mt-6 flex items-center justify-between">
        <Quiet onClick={() => choose(false)}>Listen only</Quiet>
        <Primary onClick={() => choose(true)}>Allow</Primary>
      </div>
    </>
  );
}

function PermRow({ title, why, state, busy, onAsk, onSettings, settingsHint }: {
  title: string; why: string; state: Perm; busy: boolean; onAsk: () => void; onSettings: () => void; settingsHint: string;
}) {
  const granted = state === "granted";
  const blocked = state === "denied" || state === "restricted";
  return (
    <div className={`rounded-2xl border px-4 py-3.5 transition-colors ${granted ? "border-good/25 bg-good/5" : "border-white/8 bg-white/3"}`}>
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${granted ? "bg-good/20 text-good" : blocked ? "bg-off/15 text-off" : "bg-white/8 text-ink-400"}`} aria-hidden>
          {granted ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
          ) : blocked ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          ) : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-ink-100">{title}</span>
            {granted ? <span className="text-xs font-medium text-good">Allowed</span>
              : blocked ? (
                <button onClick={onSettings} className="rounded-lg bg-white/8 px-3 py-1.5 text-xs font-medium text-ink-100 transition hover:bg-white/12">Open System Settings</button>
              ) : (
                <button onClick={onAsk} disabled={busy}
                        className="rounded-lg bg-accent-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-400 disabled:opacity-50">
                  {busy ? "Asking…" : "Allow"}
                </button>
              )}
          </div>
          <p className="mt-1 text-sm text-ink-400">{why}</p>
          {blocked && <p className="mt-1.5 text-xs text-off/80">{state === "restricted" ? "Your Mac's settings don't allow this. Ask whoever manages it." : settingsHint}</p>}
        </div>
      </div>
    </div>
  );
}

/** Let OnKey follow (and control) Spotify and Apple Music: exact, instant positions. Allow is the main action; it has
 *  macOS ask for each app that's running (the others ask the first time OnKey talks to them). "Listen only" turns
 *  control off: songs are followed by their sound. */
function MusicApps({ st, refresh, onNext }: { st: SetupStatus | null; refresh: () => void; onNext: () => void }) {
  const [chose, setChose] = useState<"" | "asking" | "allowed">("");
  const [asked, setAsked] = useState<SetupStatus["asked"]>(undefined);
  const [slow, setSlow] = useState(false);           // asking has taken a while: offer to carry on
  const allowRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; allowRef.current?.focus(); return () => { alive.current = false; }; }, []);
  const allow = async () => {
    setChose("asking");
    setSlow(false);
    // macOS's question waits for you (OnKey waits up to 40 s per app); after 6 s you may carry on, and after 90 s
    // setup stops waiting by itself: an app not answered for is asked the first time OnKey talks to it
    const slowTimer = setTimeout(() => { if (alive.current) setSlow(true); }, 6000);
    const gaveUp = new Promise<"timeout">(r => setTimeout(() => r("timeout"), 90_000));
    try {
      const r = await Promise.race([setupControl(true), gaveUp]);
      if (alive.current) setAsked(r === "timeout" ? { spotify: "waiting", music: "waiting" } : r?.asked);
    } catch {
      if (alive.current) setAsked({ spotify: "waiting", music: "waiting" });
    } finally {
      clearTimeout(slowTimer);
      if (alive.current) { setChose(c => c === "asking" ? "allowed" : c); refresh(); }
    }
  };
  const carryOn = () => { setAsked({ spotify: "waiting", music: "waiting" }); setChose("allowed"); };
  const listenOnly = async () => { await setupControl(false); refresh(); onNext(); };
  // macOS's own answer when it has one; else what asking said (no answer yet, or the app isn't open)
  const shown = (now?: AppPerm, ask?: AskAnswer): AskAnswer | undefined =>
    now === "granted" || now === "denied" || now === "not_installed" || !ask || ask === "not_asked" ? now : ask;
  const apps: [string, AskAnswer | undefined][] = [["Spotify", shown(st?.control?.spotify, asked?.spotify)],
                                                   ["Apple Music", shown(st?.control?.music, asked?.music)]];
  const waiting = chose === "allowed" && apps.some(([, p]) => p === "waiting");
  return (
    <>
      <div className="flex items-center gap-2">
        <h2 className="text-2xl font-semibold tracking-tight">Let OnKey follow Spotify and Apple Music</h2>
      </div>
      <span className="mt-2 inline-block rounded-full bg-accent-500/14 px-2 py-0.5 text-[11px] font-medium text-accent-300">Recommended</span>
      <p className="mt-3 text-sm text-ink-300">
        So lyrics and notes are in the right place from the first second, and OnKey can play and restart songs for you.
      </p>
      <p className="mt-2 text-xs leading-relaxed text-ink-500">
        It can read what’s playing and where, and play, pause and seek. Nothing else. macOS asks once for each app.
      </p>
      <div className="mt-5 space-y-2">
        {apps.filter(([, p]) => p !== "not_installed").map(([app, p]) => <AppRow key={app} app={app} state={p} />)}
      </div>
      {chose === "asking" && slow && (
        <p className="mt-4 text-xs leading-relaxed text-ink-400" role="status">
          Waiting for macOS. If it’s asking about Spotify or Apple Music (its question can open behind this window), answer it.
          No question? Carry on: macOS asks the first time you play a song there.
        </p>
      )}
      {waiting && (
        <p className="mt-4 text-xs leading-relaxed text-ink-400" role="status">
          macOS hasn’t had an answer yet. If its question is showing, answer it; otherwise it asks the first time you play a song there.
        </p>
      )}
      <div className="mt-6 flex items-center justify-between">
        <Quiet onClick={listenOnly}>{chose === "allowed" ? "" : "Listen only"}</Quiet>
        {chose === "allowed"
          ? <Primary onClick={onNext}>Continue</Primary>
          : chose === "asking" && slow
          ? <Primary onClick={carryOn}>Carry on</Primary>
          : <button ref={allowRef} onClick={allow} disabled={chose === "asking"}
                    className="rounded-xl bg-accent-500 px-5 py-2.5 text-sm font-semibold text-white outline-none transition hover:bg-accent-400 focus-visible:ring-2 focus-visible:ring-accent-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-900 disabled:opacity-50">
              {chose === "asking" ? "Asking…" : "Allow"}
            </button>}
      </div>
    </>
  );
}

function AppRow({ app, state }: { app: string; state?: AskAnswer }) {
  const granted = state === "granted";
  const denied = state === "denied";
  const label = granted ? "Allowed" : denied ? "Not allowed" : state === "not_running" ? "macOS asks when you first play a song in it"
    : state === "waiting" ? "No answer yet" : state === "ask" ? "Not asked yet" : "";
  return (
    <div className={`flex items-center gap-3 rounded-2xl border px-4 py-3 transition-colors ${granted ? "border-good/25 bg-good/5" : "border-white/8 bg-white/3"}`}>
      <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full ${granted ? "bg-good/20 text-good" : denied ? "bg-off/15 text-off" : "bg-white/8 text-ink-400"}`} aria-hidden>
        {granted ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
          : denied ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      </span>
      <span className="flex-1 font-medium text-ink-100">{app}</span>
      {denied
        ? <button onClick={() => setupOpenSettings("automation")} className="rounded-lg bg-white/8 px-3 py-1.5 text-xs font-medium text-ink-100 transition hover:bg-white/12">Open System Settings</button>
        : <span className={`text-xs ${granted ? "font-medium text-good" : "text-ink-400"}`}>{label}</span>}
    </div>
  );
}

function MicCheck({ micOk, onNext, onBack }: { micOk: boolean; onNext: () => void; onBack: () => void }) {
  const [db, setDb] = useState(-120);
  const [heard, setHeard] = useState(false);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  // the microphone being listened to: the same one your takes use (null: none connected)
  const [device, setDevice] = useState<string | null | undefined>(undefined);
  const loudSince = useRef<number | null>(null);
  const floor = useRef(0);
  useEffect(() => {
    if (!micOk) return;
    let alive = true, raf = 0;
    floor.current = 0;
    getMics().then(m => { if (alive && m) setDevice(m.chosen?.name ?? null); }).catch(() => {});
    // the meter couldn't start, or stopped answering: say so ("No microphone") rather than leave the bar stuck
    const fail = () => { if (alive) { setRunning(false); setFailed(true); } };
    setupMeter(true).then(ok => {
      if (!alive) return;
      setRunning(ok);
      setFailed(!ok);
      const tick = async () => {
        let v: number;
        try { v = await setupLevel(); } catch { fail(); return; }
        if (!alive) return;
        setDb(v);
        const now = performance.now();
        // the room's own level, followed slowly upwards and at once downwards: a voice is clearly above it
        if (v > -119) floor.current = floor.current === 0 ? v : Math.min(v, floor.current + 0.05);
        const voice = v > -40 || (floor.current !== 0 && v > floor.current + 15);
        if (voice) { loudSince.current ??= now; if (now - loudSince.current > 300) setHeard(true); }
        else loudSince.current = null;
        raf = window.setTimeout(tick, 60);
      };
      tick();
    }, fail);
    return () => { alive = false; clearTimeout(raf); void setupMeter(false).catch(() => {}); };
  }, [micOk]);
  // -80 to -10 dBFS: a quiet room already moves the bar a little, so you can see the mic is live
  const pct = Math.max(0, Math.min(1, (db + 80) / 70));
  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight">Can OnKey hear you?</h2>
      <p className="mt-2 text-sm text-ink-300">
        {!micOk ? "OnKey needs the microphone first: go back to allow it."
          : device === null ? `No microphone is connected. Connect one, or choose one in ${onLinux() ? "Settings" : "System Settings"} → Sound → Input.`
          : "Say something, or sing a note."}
      </p>
      {micOk && device && <p className="mt-1 text-xs text-ink-500">Listening to {device}. You can choose another in Settings.</p>}
      <div className="mt-6 flex items-center gap-4">
        <div className="h-3 flex-1 overflow-hidden rounded-full bg-white/6" role="meter" aria-label="Microphone level" aria-valuemin={-80} aria-valuemax={-10} aria-valuenow={Math.round(db)}>
          <div className={`h-full rounded-full transition-[width] duration-75 ${heard ? "bg-good" : "bg-accent-400"}`} style={{ width: `${pct * 100}%` }} />
        </div>
        <span className={`w-28 text-right text-sm font-medium ${heard ? "text-good" : "text-ink-500"}`}>
          {heard ? "Heard you" : running ? "Listening…" : !micOk ? "Not allowed" : !failed && device !== null ? "Starting…" : "No microphone"}
        </span>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-ink-500">
        Headphones give the steadiest scores. Laptop speakers work too: OnKey takes the music out of what the mic hears.
      </p>
      <div className="mt-7 flex items-center justify-between">
        <Quiet onClick={onNext}>{heard ? "" : "Skip"}</Quiet>
        {micOk ? <Primary onClick={onNext} disabled={!heard}>Continue</Primary>
          : <Primary onClick={onBack}>Back to permissions</Primary>}
      </div>
    </>
  );
}

function Ready({ onFinish }: { onFinish: () => void }) {
  return (
    <>
      <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-good/15 text-good">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      </div>
      <h2 className="text-center text-2xl font-semibold tracking-tight">You're set</h2>
      <p className="mx-auto mt-2 max-w-sm text-center text-ink-300">
        Play a song in your music app and start singing. The first play of each song teaches OnKey the melody.
      </p>
      <p className="mx-auto mt-3 max-w-sm text-center text-sm text-ink-400">
        Sing at a comfortable volume: OnKey scores your pitch, not how loud you are. Rest when your voice tires, and stop
        if your throat hurts.
      </p>
      <div className="mt-7 flex justify-center">
        <Primary onClick={onFinish}>Start singing</Primary>
      </div>
    </>
  );
}
