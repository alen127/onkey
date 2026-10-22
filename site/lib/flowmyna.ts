// Visit paths for Flow Myna (the developer's process-mining tool), the website only, never the app.
//
// Flow Myna's script (fm.js) runs cookieless: it stores nothing in the browser, and a visit is stitched together on
// Flow Myna's side from a daily-rotating salted hash. Its autocapture records every page ("Viewed /docs/faq/"); the
// server adds source, device and country. Clicks are recorded only on links it counts as calls to action, so every
// way out carries `data-track` with one of a small, fixed set of names ("Clickout: Download for Mac", "GitHub",
// "Discord", "Windows issue", "Daniel's site", "Email"): without it, a Download click is never recorded.
// The events here add what autocapture can't see: how far down the long landing page a visit read, which questions
// it opened, a phone sending itself the link, and which troubleshooting topics were read. Each at most once per
// page view, so going back over a page shows as a loop, not a pile of repeats.

import { FLOWMYNA_TRACKER_ID } from "./site";

type Props = Record<string, string | number | boolean>;
type FM = { capture: (name: string, props?: Props) => void; register?: (props: Props) => void };

/** Our events, as named in Flow Myna's process map (a small, fixed set: each is a node). */
export const FM_EVENTS = {
  sawHow: "Saw How it works",
  sawPrivacy: "Saw Privacy",
  sawQuestions: "Saw Questions",
  reachedGet: "Reached Get OnKey",
  openedQuestion: "Opened a question",
  sentToMac: "Sent link to Mac",
  readTopic: "Read a troubleshooting topic",
} as const;

/** Only the real site is tracked: never localhost, a LAN address or a preview deployment. */
export const isLiveSite = () => typeof window !== "undefined" && /(^|\.)singonkey\.app$/.test(location.hostname);

const fmApi = () => (window as unknown as { FlowMyna?: FM }).FlowMyna;

let sent = new Set<string>();

/** A new page view: every event may be sent again once. */
export function newPageView() {
  sent = new Set();
}

/** Send `event` once per page view (`key` widens that, e.g. per question). Never throws, never blocks. */
export function fm(event: string, props?: Props, key = event) {
  if (!FLOWMYNA_TRACKER_ID || !isLiveSite() || sent.has(key)) return;
  sent.add(key);
  try { fmApi()?.capture(event, props); } catch {}
}

/** Label the visit (held in memory by fm.js, sent with each batch): is it on a Mac? */
export function labelVisit() {
  if (!FLOWMYNA_TRACKER_ID || !isLiveSite()) return;
  const ua = navigator.userAgent;
  const mac = /Macintosh/i.test(ua) && navigator.maxTouchPoints <= 1;
  try { fmApi()?.register?.({ on_a_mac: mac }); } catch {}
}
