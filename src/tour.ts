// Guided walkthrough. A new installation gets the full tour; after an update
// only the steps added since the last version the user saw ("What's new").
// The last seen version is remembered on this PC.
import { version as APP_VERSION } from "../package.json";
import { h } from "./ui";

const SEEN_KEY = "siakap.tour.seenVersion";
/** Versions before the tour existed: treat as already seen up to here. */
const FIRST_TOUR_VERSION = "0.2.0";

export interface TourStep {
  /** Version that introduced what this step shows. */
  since: string;
  title: string;
  text: string;
  /** CSS selector to spotlight; centred card when omitted. */
  target?: string;
  /** Prepare the UI (open a panel, ...) before showing the step. */
  before?: () => void;
  /** Intro/outro cards: only shown in the full tour. */
  frame?: boolean;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}
function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, APP_VERSION);
  } catch {
    /* ignore */
  }
}

/** Which tour to show at start-up, if any. */
export function pendingTour(newInstall: boolean): "full" | "whatsNew" | null {
  if (newInstall) return "full";
  const seen = readSeen() ?? FIRST_TOUR_VERSION;
  return compareVersions(APP_VERSION, seen) > 0 ? "whatsNew" : null;
}

export function stepsSince(all: TourStep[], seen: string): TourStep[] {
  return all.filter((s) => compareVersions(s.since, seen) > 0);
}

let active: (() => void) | null = null;

/** Show steps one by one with a spotlight. Resolves when finished or skipped. */
export function runTour(steps: TourStep[], heading: string): Promise<void> {
  active?.();
  if (!steps.length) return Promise.resolve();
  return new Promise((resolve) => {
    let i = 0;
    const shade = h("div", { class: "tour-shade" });
    const spot = h("div", { class: "tour-spot" });
    const card = h("div", { class: "tour-card", role: "dialog", "aria-live": "polite" });
    document.body.append(shade, spot, card);

    const finish = () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", place);
      shade.remove();
      spot.remove();
      card.remove();
      active = null;
      markSeen();
      resolve();
    };
    active = finish;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") (e.preventDefault(), finish());
      else if (e.key === "ArrowRight" || e.key === "Enter") (e.preventDefault(), go(1));
      else if (e.key === "ArrowLeft") (e.preventDefault(), go(-1));
    };
    window.addEventListener("keydown", onKey, true);

    function place() {
      const step = steps[i];
      const el = step.target ? (document.querySelector(step.target) as HTMLElement | null) : null;
      const r = el && el.offsetParent !== null ? el.getBoundingClientRect() : null;
      card.style.visibility = "hidden";
      if (r && r.width) {
        const pad = 6;
        Object.assign(spot.style, { display: "block", left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
        shade.classList.add("clear");
        requestAnimationFrame(() => {
          const c = card.getBoundingClientRect();
          // Prefer the right side, then below, then above.
          let x = r.right + 16;
          let y = r.top;
          if (x + c.width > window.innerWidth - 12) {
            x = Math.min(Math.max(12, r.left), window.innerWidth - c.width - 12);
            y = r.bottom + 16;
            if (y + c.height > window.innerHeight - 12) y = r.top - c.height - 16;
          }
          y = Math.min(Math.max(12, y), window.innerHeight - c.height - 12);
          Object.assign(card.style, { left: `${x}px`, top: `${y}px`, visibility: "visible" });
        });
      } else {
        spot.style.display = "none";
        shade.classList.remove("clear");
        requestAnimationFrame(() => {
          const c = card.getBoundingClientRect();
          Object.assign(card.style, { left: `${(window.innerWidth - c.width) / 2}px`, top: `${(window.innerHeight - c.height) / 2}px`, visibility: "visible" });
        });
      }
    }

    function show() {
      const step = steps[i];
      try {
        step.before?.();
      } catch {
        /* a missing element just means a centred card */
      }
      const last = i === steps.length - 1;
      card.replaceChildren(
        h("div", { class: "tour-kicker" }, `${heading} · ${i + 1} of ${steps.length}`),
        h("h3", {}, step.title),
        h("p", {}, step.text),
        h(
          "div",
          { class: "tour-actions" },
          h("button", { class: "tour-skip", onclick: finish }, last ? "Close" : "Skip tour"),
          h("span", { class: "tour-spacer" }),
          i > 0 ? h("button", { onclick: () => go(-1) }, "Back") : null,
          h("button", { class: "primary", onclick: () => (last ? finish() : go(1)) }, last ? "Finish" : "Next"),
        ),
      );
      // Let the UI settle (panels opening) before measuring.
      setTimeout(place, 60);
      (card.querySelector("button.primary") as HTMLElement | null)?.focus();
    }
    function go(d: number) {
      const n = i + d;
      if (n < 0) return;
      if (n >= steps.length) return finish();
      i = n;
      show();
    }
    window.addEventListener("resize", place);
    show();
  });
}

export { APP_VERSION };
export const FIRST_SEEN = FIRST_TOUR_VERSION;
