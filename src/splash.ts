// Welcome splash when Siakap starts: the logo, a pixel siakap swimming past,
// a greeting and the version. Click or any key skips it. Turned on/off in
// Settings; the choice and theme colours are kept on this PC so they apply
// before the vault is unlocked.
import { version as APP_VERSION } from "../package.json";
import type { Settings } from "./api";
import { FISH, paintFish } from "./screensaver";
import { specialDay } from "./eggs";
import { applySkin, drawIcon, setGlass } from "./skin";
import { h } from "./ui";

/** Theme colours remembered from the last session (not secret). */
export function storedLook(): Partial<Settings> | null {
  try {
    const raw = JSON.parse(localStorage.getItem("siakap.skin") ?? "null");
    if (!raw || typeof raw !== "object") return null;
    const ui = ["standard", "glass", "material", "fluent", "dot", "retro", "minimal"].includes(raw.ui) ? raw.ui : "standard";
    const anim = ["fluid", "bouncy", "slide", "subtle", "off"].includes(raw.anim) ? raw.anim : "fluid";
    return { background: raw.bg, foreground: raw.fg, accent: raw.accent ?? "", palette: Array.isArray(raw.palette) ? raw.palette : [], appSkin: raw.appSkin !== false, uiStyle: ui, animations: anim, glassTransparency: Number.isFinite(raw.gt) ? raw.gt : 42, glassBlur: Number.isFinite(raw.gb) ? raw.gb : 30, glassTerminal: Number.isFinite(raw.gx) ? raw.gx : 30 };
  } catch {
    return null;
  }
}

export function splashEnabled(): boolean {
  try {
    return localStorage.getItem("siakap.splash") !== "0";
  } catch {
    return true;
  }
}

/** Apply the remembered theme to the lock screen and splash before unlock. */
export function preloadLook() {
  const look = storedLook();
  if (look?.background) applySkin(look as Settings);
  const root = document.documentElement;
  root.dataset.ui = look?.uiStyle ?? "standard";
  root.dataset.anim = look?.animations ?? "fluid";
  setGlass(look?.glassTransparency ?? 42, look?.glassBlur ?? 30, look?.glassTerminal ?? 30);
}

function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? "Working late" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
}

export function showSplash(): Promise<void> {
  if (!splashEnabled() || matchMedia("(prefers-reduced-motion: reduce)").matches) return Promise.resolve();
  return new Promise((resolve) => {
    const look = (storedLook() ?? {}) as Settings;
    const day = specialDay();
    const logo = drawIcon({ background: look.background ?? "#11151c", foreground: look.foreground ?? "#d8dee9", accent: look.accent ?? "", palette: look.palette ?? [] } as Settings, 192);
    logo.className = "splash-logo";
    const sea = document.createElement("canvas");
    sea.className = "splash-sea";
    const el = h(
      "div",
      { class: "splash", role: "presentation" },
      sea,
      h("div", { class: "splash-center" }, logo, h("div", { class: "splash-title" }, "Siakap Terminal"), h("div", { class: "splash-sub" }, day ? day.greeting : `${greeting()}. Welcome back.`)),
      h("div", { class: "splash-version" }, `Version ${APP_VERSION}`),
    );
    document.body.append(el);
    // One fish swims across under the title.
    const dpr = devicePixelRatio || 1;
    sea.width = Math.floor(innerWidth * dpr);
    sea.height = Math.floor(140 * dpr);
    const g = sea.getContext("2d")!;
    const px = Math.round(5 * dpr);
    const w = FISH[0].length * px;
    const colours: Record<string, string> = { B: "#4f6274", S: "#b9c6d2", L: "#e6ecf1", F: "#6d7f91", T: "#7d8d9c", E: "#ffb02e", P: "#1b1b1b" };
    let x = -w;
    let raf = 0;
    const start = performance.now();
    const frame = (now: number) => {
      const t = (now - start) / 1000;
      x = -w + (sea.width + w + ((day?.tints?.length ?? 1) - 1) * (w + 6 * px)) * Math.min(1, t / 2.2);
      g.clearRect(0, 0, sea.width, sea.height);
      const y = sea.height / 2 - 5 * px + Math.sin(t * 5) * px;
      const tints = day?.tints;
      if (tints) {
        // A little parade, one fish per colour.
        tints.forEach((c, i) => paintFish(g, x - i * (w + 6 * px), y + Math.sin(t * 5 + i) * px, px, 1, c, Math.sin(t * 12 + i) > 0 ? 1 : 0));
      } else
        FISH.forEach((row, ry) => {
          for (let rx = 0; rx < row.length; rx++) {
            const k = row[rx];
            if (k === ".") continue;
            g.fillStyle = colours[k];
            g.fillRect(Math.round(x + rx * px), Math.round(y + ry * px), px, px);
          }
        });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    let done = false;
    const close = () => {
      if (done) return;
      done = true;
      el.classList.add("leaving");
      window.removeEventListener("keydown", close, true);
      window.setTimeout(() => {
        cancelAnimationFrame(raf);
        el.remove();
        resolve();
      }, 380);
    };
    el.addEventListener("click", close);
    window.addEventListener("keydown", close, true);
    window.setTimeout(close, 2100);
  });
}
