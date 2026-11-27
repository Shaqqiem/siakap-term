// Screensaver: pixel-art siakap (barramundi) swimming across the screen after
// a few idle minutes. Any key, click or mouse movement brings the app back;
// that first key press is swallowed so it never reaches a terminal.
import type { Settings } from "./api";
import { accentOf } from "./skin";

/** 22×10 sprite, facing right. B back, S silver, L belly, F fin, T tail, E eye, P pupil. */
export const FISH = [
  "........F.F.F.F.......",
  ".......FFFFFFFFF......",
  "T.....BBBBBBBBBBBB....",
  "TT..BBBBBBBBBBBBBBBB..",
  "TTTBBSSSSSSSSSSSSEPB..",
  "TTTSSSSSSSSSSSSSSSSSS.",
  "TTTLLLLLLLLLLLLLLLLS..",
  "TT..LLLLLLLLLLLLLLL...",
  "T.....LLFFLLLLFFL.....",
  ".........F....F.......",
];

const COLOURS: Record<string, string> = {
  B: "#4f6274",
  S: "#b9c6d2",
  L: "#e6ecf1",
  F: "#6d7f91",
  T: "#7d8d9c",
  E: "#ffb02e",
  P: "#1b1b1b",
};

/** Draw one siakap with its top-left corner at (x, y). */
export const GOLD: Record<string, string> = { B: "#b8860b", S: "#f5c542", L: "#fff1a8", F: "#d4a017", T: "#c99a2e", E: "#1b1b1b", P: "#ffffff" };

export function paintFish(g: CanvasRenderingContext2D, x: number, y: number, px: number, dir: 1 | -1, tint: string | null, wag = 0, colours: Record<string, string> = COLOURS) {
  FISH.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      const k = row[rx];
      if (k === ".") continue;
      let col = colours[k];
      if (tint && (k === "B" || k === "F")) col = tint;
      const tail = k === "T" ? wag : 0;
      const sx = dir === 1 ? rx : row.length - 1 - rx;
      g.fillStyle = col;
      g.fillRect(Math.round(x + sx * px), Math.round(y + ry * px + tail * px * 0.5), px, px);
    }
  });
}

/** The rail button's icon: a little pixel siakap in the accent colour. */
export function fishIcon(accent: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const px = Math.max(1, Math.round(devicePixelRatio));
  c.width = FISH[0].length * px;
  c.height = FISH.length * px;
  c.className = "fish-icon";
  paintFish(c.getContext("2d")!, 0, 0, px, 1, accent);
  return c;
}

/**
 * A school of siakap swims across the app once (the rail's siakap button).
 * Purely decorative: it doesn't take clicks or keys, and each click adds a
 * new school on top while one is still going.
 */
let swims = 0;
export function swimBy(accent: string, opts: { giant?: boolean } = {}) {
  swims++;
  const giant = opts.giant || swims % 25 === 0;
  const c = document.createElement("canvas");
  c.className = "swim-by";
  document.body.append(c);
  const dpr = devicePixelRatio;
  c.width = Math.floor(window.innerWidth * dpr);
  c.height = Math.floor(window.innerHeight * dpr);
  const g = c.getContext("2d")!;
  const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
  const midY = c.height * (0.25 + Math.random() * 0.5);
  const school = Array.from({ length: giant ? 6 : 7 + Math.floor(Math.random() * 6) }, (_, i) => {
    const big = giant && i === 0;
    const px = Math.round((big ? 16 : 2 + Math.random() * 5) * dpr);
    const w = FISH[0].length * px;
    return {
      px,
      lead: big ? 0 : (giant ? 0.25 : 0.13) * i * c.width * Math.random(),
      y: big ? c.height / 2 - 5 * px : midY + (Math.random() - 0.5) * c.height * 0.45,
      speed: big ? 150 * dpr : (260 + px * 40) * (0.85 + Math.random() * 0.3),
      phase: Math.random() * Math.PI * 2,
      tint: !big && i % 3 === 0 ? accent : null,
      gold: big || Math.random() < 0.04,
      w,
      x: 0,
    };
  });
  for (const f of school) f.x = dir === 1 ? -f.w - f.lead : c.width + f.lead;
  const bubbles: { x: number; y: number; r: number; v: number }[] = [];
  const sparkles: { x: number; y: number; life: number }[] = [];
  let last = performance.now();
  const start = last;
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now / 1000;
    g.clearRect(0, 0, c.width, c.height);
    let visible = false;
    for (const f of school) {
      f.x += dir * f.speed * dt;
      if ((dir === 1 && f.x < c.width) || (dir === -1 && f.x > -f.w)) visible = true;
      const y = f.y + Math.sin(t * 3 + f.phase) * f.px * 3;
      g.globalAlpha = 0.95;
      paintFish(g, f.x, y, f.px, dir, f.gold ? null : f.tint, Math.sin(t * 14 + f.phase) > 0 ? 1 : 0, f.gold ? GOLD : COLOURS);
      if (f.gold && Math.random() < dt * 8) sparkles.push({ x: f.x + Math.random() * f.w, y: y + Math.random() * 10 * f.px, life: 1 });
      if (Math.random() < dt * 2.5) bubbles.push({ x: dir === 1 ? f.x + f.w : f.x, y: y + 4 * f.px, r: Math.max(2, f.px * 0.6), v: (30 + Math.random() * 40) * dpr });
    }
    g.globalAlpha = 0.6;
    g.strokeStyle = "#cfe8ff";
    g.lineWidth = Math.max(1, dpr);
    for (const b of bubbles) {
      b.y -= b.v * dt;
      g.beginPath();
      g.arc(b.x + Math.sin(b.y / 15) * 3 * dpr, b.y, b.r, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = "#ffe680";
    for (const sp of sparkles) {
      sp.life -= dt * 1.6;
      if (sp.life <= 0) continue;
      g.globalAlpha = sp.life;
      const r = 3 * dpr * sp.life;
      g.fillRect(sp.x - r, sp.y - r / 4, r * 2, r / 2);
      g.fillRect(sp.x - r / 4, sp.y - r, r / 2, r * 2);
    }
    g.globalAlpha = 1;
    if (visible && now - start < 30000) requestAnimationFrame(frame);
    else c.remove();
  };
  requestAnimationFrame(frame);
}

interface Fish {
  x: number;
  y: number;
  px: number; // pixel size
  speed: number;
  dir: 1 | -1;
  phase: number;
  tint: string | null;
  gold?: boolean;
}
interface Bubble {
  x: number;
  y: number;
  r: number;
  v: number;
}

export class Screensaver {
  private minutes = 0;
  private lastInput = Date.now();
  private el: HTMLCanvasElement | null = null;
  private raf = 0;
  private fish: Fish[] = [];
  private bubbles: Bubble[] = [];
  private s: Settings | null = null;
  /** Return true when the screensaver may start (app unlocked, nothing modal). */
  canStart: () => boolean = () => true;

  constructor() {
    const poke = () => {
      this.lastInput = Date.now();
    };
    for (const ev of ["keydown", "mousedown", "wheel", "touchstart"]) window.addEventListener(ev, poke, { capture: true, passive: true });
    let mx = -1;
    let my = -1;
    window.addEventListener(
      "mousemove",
      (e) => {
        // Ignore tiny jitter; a real move counts as activity.
        if (Math.abs(e.clientX - mx) + Math.abs(e.clientY - my) > 4) poke();
        mx = e.clientX;
        my = e.clientY;
      },
      { capture: true, passive: true },
    );
    window.setInterval(() => {
      if (!this.el && this.minutes > 0 && Date.now() - this.lastInput >= this.minutes * 60_000 && this.canStart()) this.start();
    }, 5000);
  }

  configure(minutes: number, s: Settings) {
    this.minutes = minutes;
    this.s = s;
  }

  get running() {
    return !!this.el;
  }

  start() {
    if (this.el) return;
    const c = document.createElement("canvas");
    c.className = "screensaver";
    document.body.append(c);
    this.el = c;
    const fit = () => {
      c.width = Math.floor(window.innerWidth * devicePixelRatio);
      c.height = Math.floor(window.innerHeight * devicePixelRatio);
    };
    fit();
    window.addEventListener("resize", fit);
    const accent = this.s ? accentOf(this.s) : "#5aa9e6";
    this.fish = Array.from({ length: 9 }, (_, i) => this.newFish(c, i % 3 === 0 ? accent : null, true));
    this.bubbles = [];
    // Swallow the key/click that wakes the app.
    const stop = (e: Event) => {
      if (e instanceof MouseEvent && e.type === "mousemove" && Math.abs(e.movementX) + Math.abs(e.movementY) < 3) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      window.removeEventListener("resize", fit);
      for (const ev of ["keydown", "mousedown", "mousemove", "wheel"]) window.removeEventListener(ev, stop, true);
      this.stop();
    };
    // Give the mouse a moment to settle so the screensaver doesn't vanish at once.
    window.setTimeout(() => {
      for (const ev of ["keydown", "mousedown", "mousemove", "wheel"]) window.addEventListener(ev, stop, { capture: true });
    }, 600);
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.draw(c, dt, now / 1000);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.el?.remove();
    this.el = null;
    this.lastInput = Date.now();
  }

  private newFish(c: HTMLCanvasElement, tint: string | null, anywhere = false): Fish {
    const px = Math.round((2 + Math.random() * 6) * devicePixelRatio);
    const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    const w = FISH[0].length * px;
    return {
      px,
      dir,
      x: anywhere ? Math.random() * c.width : dir === 1 ? -w - Math.random() * c.width * 0.5 : c.width + Math.random() * c.width * 0.5,
      y: 40 * devicePixelRatio + Math.random() * (c.height - 120 * devicePixelRatio),
      speed: (18 + px * 9) * (0.7 + Math.random() * 0.6),
      phase: Math.random() * Math.PI * 2,
      tint,
      gold: Math.random() < 1 / 30,
    };
  }

  private draw(c: HTMLCanvasElement, dt: number, t: number) {
    const g = c.getContext("2d")!;
    const s = this.s;
    const bg = s?.background ?? "#0b1018";
    // Deep-water gradient from the theme's background.
    const grad = g.createLinearGradient(0, 0, 0, c.height);
    grad.addColorStop(0, bg);
    grad.addColorStop(1, "#02060c");
    g.globalAlpha = 1;
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    // Light rays.
    g.globalAlpha = 0.05;
    g.fillStyle = "#9fd3ff";
    for (let i = 0; i < 4; i++) {
      const x = ((i * 0.27 + t * 0.01) % 1) * c.width;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + 120 * devicePixelRatio, 0);
      g.lineTo(x - 80 * devicePixelRatio, c.height);
      g.lineTo(x - 200 * devicePixelRatio, c.height);
      g.fill();
    }
    g.globalAlpha = 1;
    // Fish, small (far) first.
    this.fish.sort((a, b) => a.px - b.px);
    for (const f of this.fish) {
      f.x += f.dir * f.speed * dt;
      const w = FISH[0].length * f.px;
      if ((f.dir === 1 && f.x > c.width + 20) || (f.dir === -1 && f.x < -w - 20)) Object.assign(f, this.newFish(c, f.tint));
      const y = f.y + Math.sin(t * 1.6 + f.phase) * f.px * 2;
      const wag = Math.sin(t * 8 + f.phase) > 0 ? 1 : 0;
      g.globalAlpha = 0.55 + Math.min(0.45, f.px / (16 * devicePixelRatio));
      paintFish(g, f.x, y, f.px, f.dir, f.gold ? null : f.tint, wag, f.gold ? GOLD : COLOURS);
      // Now and then a bubble from the mouth.
      if (Math.random() < dt * 0.6) {
        const mouthX = f.dir === 1 ? f.x + w : f.x;
        this.bubbles.push({ x: mouthX, y: y + 4 * f.px, r: Math.max(2, f.px * 0.6), v: 20 + Math.random() * 30 });
      }
    }
    g.globalAlpha = 0.5;
    g.strokeStyle = "#cfe8ff";
    g.lineWidth = Math.max(1, devicePixelRatio);
    this.bubbles = this.bubbles.filter((b) => (b.y -= b.v * dt * devicePixelRatio) > -10);
    for (const b of this.bubbles) {
      g.beginPath();
      g.arc(b.x + Math.sin(b.y / 20) * 3, b.y, b.r, 0, Math.PI * 2);
      g.stroke();
    }
    // Caption.
    g.globalAlpha = 0.45;
    g.fillStyle = "#e6ecf1";
    g.font = `${12 * devicePixelRatio}px ${getComputedStyle(document.body).fontFamily}`;
    g.textAlign = "center";
    g.fillText("Siakap Terminal  ·  move the mouse or press a key to come back", c.width / 2, c.height - 18 * devicePixelRatio);
    g.globalAlpha = 1;
  }
}
