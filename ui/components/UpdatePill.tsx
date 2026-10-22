"use client";
// A quiet "Update available — Restart to update" in the corner once a new OnKey is downloaded (updater.rs).
// Never in mini mode; pressed mid-song, OnKey restarts once the song is over. Not pressed: it's installed on quit.
import { useState } from "react";
import { restartToUpdate, useUpdate } from "@/lib/update";

export default function UpdatePill() {
  const [u, setU] = useUpdate();
  const [hidden, setHidden] = useState(false);
  if (!u || u.state !== "ready" || hidden) return null;
  const restart = async () => setU(await restartToUpdate());
  return (
    <div id="update-pill" role="status"
         className="in-[.mini]:hidden fixed bottom-3 left-3 z-40 flex items-center gap-2 rounded-full border border-white/10 bg-black/60 py-1 pl-3 pr-1 text-xs text-ink-200 shadow-lg backdrop-blur animate-rise"
         title={`OnKey ${u.available} is ready. If you don’t restart now, it’s installed when you quit.`}>
      <span className="h-1.5 w-1.5 rounded-full bg-accent-400" />
      {u.waiting
        ? <span className="pr-2">Updating after this song…</span>
        : <>
            <span>Update available</span>
            <button onClick={restart} className="rounded-full bg-white/8 px-2.5 py-1 font-medium text-ink-100 transition hover:bg-white/14">
              Restart to update
            </button>
            <button onClick={() => setHidden(true)} aria-label="Later" title="Later (it’s installed when you quit)"
                    className="rounded-full px-1.5 py-1 text-ink-400 transition hover:text-white">×</button>
          </>}
    </div>
  );
}
