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
  /** Prepare the UI (open a panel or page, ...) before showing the step. */
  before?: () => void | Promise<void>;
  /** "click": the step moves on when the user clicks the highlighted part. */
  action?: "click";
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
export function markSeen() {
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

/** A tour is running (main.ts keeps app shortcuts out of its way). */
export function tourRunning() {
  return active !== null;
}

/**
 * Show steps one by one. The highlighted part of the app stays usable: the
 * dimming only covers everything around it, and dialogs and menus it opens
 * appear above the tour. Steps with `action: "click"` move on by themselves
 * when you click the highlighted part. Resolves when finished or skipped.
 */
export function runTour(steps: TourStep[], heading: string): Promise<void> {
  active?.();
  if (!steps.length) return Promise.resolve();
  return new Promise((resolve) => {
    let i = 0;
    let target: HTMLElement | null = null;
    // Four blockers around the hole (or one covering everything).
    const blocks = [0, 1, 2, 3].map(() => h("div", { class: "tour-block" }));
    const ring = h("div", { class: "tour-ring" });
    const card = h("div", { class: "tour-card", role: "dialog", "aria-live": "polite" });
    document.body.append(...blocks, ring, card);

    const finish = () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("click", onClick, true);
      window.clearInterval(timer);
      [...blocks, ring, card].forEach((x) => x.remove());
      active = null;
      markSeen();
      resolve();
    };
    active = finish;

    const typing = () => {
      const a = document.activeElement as HTMLElement | null;
      return !!a && !card.contains(a) && (a.matches("input, textarea, select, [contenteditable]") || !!a.closest(".xterm"));
    };
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".modal-backdrop")) return; // a dialog the tour opened has the keyboard
      if (e.key === "Escape") (e.preventDefault(), finish());
      else if (typing()) return; // never steal keys from a terminal or a text box
      else if (e.key === "ArrowRight" || (e.key === "Enter" && card.contains(document.activeElement))) (e.preventDefault(), go(1));
      else if (e.key === "ArrowLeft") (e.preventDefault(), go(-1));
    };
    // Interactive steps: doing the thing moves the tour on.
    const onClick = (e: MouseEvent) => {
      const step = steps[i];
      if (step.action !== "click" || !target || !target.contains(e.target as Node)) return;
      const here = i;
      window.setTimeout(() => i === here && go(1), 450);
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("click", onClick, true);

    function setBlock(b: HTMLElement, x: number, y: number, w: number, hgt: number) {
      Object.assign(b.style, { left: `${x}px`, top: `${y}px`, width: `${Math.max(0, w)}px`, height: `${Math.max(0, hgt)}px` });
    }

    let lastKey = "";
    function onResize() {
      lastKey = "";
      place();
    }
    function place() {
      const step = steps[i];
      target = step.target ? (document.querySelector(step.target) as HTMLElement | null) : null;
      const r = target && target.offsetParent !== null ? target.getBoundingClientRect() : null;
      const W = window.innerWidth;
      const H = window.innerHeight;
      const key = r ? `${i}:${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}` : `${i}:none:${W}x${H}`;
      if (key === lastKey) return;
      lastKey = key;
      if (r && r.width) {
        const pad = 6;
        const x0 = Math.max(0, r.left - pad), y0 = Math.max(0, r.top - pad), x1 = Math.min(W, r.right + pad), y1 = Math.min(H, r.bottom + pad);
        setBlock(blocks[0], 0, 0, W, y0); // above
        setBlock(blocks[1], 0, y1, W, H - y1); // below
        setBlock(blocks[2], 0, y0, x0, y1 - y0); // left
        setBlock(blocks[3], x1, y0, W - x1, y1 - y0); // right
        Object.assign(ring.style, { display: "block", left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
        ring.classList.toggle("pulse", step.action === "click");
        const c = card.getBoundingClientRect();
        let x = r.right + 16;
        let y = r.top;
        if (x + c.width > W - 12) {
          x = Math.min(Math.max(12, r.left), W - c.width - 12);
          y = r.bottom + 16;
          if (y + c.height > H - 12) y = r.top - c.height - 16;
        }
        y = Math.min(Math.max(12, y), H - c.height - 12);
        Object.assign(card.style, { left: `${x}px`, top: `${y}px`, visibility: "visible" });
      } else {
        setBlock(blocks[0], 0, 0, W, H);
        [1, 2, 3].forEach((k) => setBlock(blocks[k], 0, 0, 0, 0));
        ring.style.display = "none";
        const c = card.getBoundingClientRect();
        Object.assign(card.style, { left: `${(W - c.width) / 2}px`, top: `${(H - c.height) / 2}px`, visibility: "visible" });
      }
    }
    // Follow the layout while the user explores (panels opening, tabs moving).
    const timer = window.setInterval(place, 250);

    async function show() {
      const step = steps[i];
      card.style.visibility = "hidden";
      try {
        await step.before?.();
      } catch {
        /* a missing element just means a centred card */
      }
      const last = i === steps.length - 1;
      card.replaceChildren(
        h("div", { class: "tour-kicker" }, `${heading} · ${i + 1} of ${steps.length}`),
        h("h3", {}, step.title),
        h("p", {}, step.text),
        ...(step.action === "click" ? [h("p", { class: "tour-try" }, "Try it: click the highlighted part. The tour carries on by itself.")] : []),
        h(
          "div",
          { class: "tour-actions" },
          h("button", { class: "tour-skip", onclick: finish }, last ? "Close" : "Skip tour"),
          h("span", { class: "tour-spacer" }),
          i > 0 ? h("button", { onclick: () => go(-1) }, "Back") : null,
          h("button", { class: "primary", onclick: () => (last ? finish() : go(1)) }, last ? "Finish" : "Next"),
        ),
      );
      lastKey = "";
      // Let the UI settle (panels and pages opening) before measuring.
      window.setTimeout(place, 80);
      window.setTimeout(place, 300);
      (card.querySelector("button.primary") as HTMLElement | null)?.focus();
    }
    function go(d: number) {
      const n = i + d;
      if (n < 0) return;
      if (n >= steps.length) return finish();
      i = n;
      void show();
    }
    window.addEventListener("resize", onResize);
    void show();
  });
}

export { APP_VERSION };
export const FIRST_SEEN = FIRST_TOUR_VERSION;
