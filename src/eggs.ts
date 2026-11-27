// Small extras.
import { FISH, GOLD, paintFish, swimBy } from "./screensaver";
import { play } from "./sound";
import { h, modal, toast } from "./ui";

const FLAG = ["#cc0001", "#ffffff", "#010066", "#ffcc00"];

export interface Day {
  greeting: string;
  tints?: string[];
}

/** A greeting for a few days of the year. */
export function specialDay(d = new Date()): Day | null {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  if (m === 1 && day === 1) return { greeting: "Happy New Year!", tints: ["#f5c542", "#ec4899", "#22c55e", "#5aa9e6"] };
  if (m === 8 && day === 31) return { greeting: "Selamat Hari Merdeka!", tints: FLAG };
  if (m === 9 && day === 16) return { greeting: "Selamat Hari Malaysia!", tints: FLAG };
  if (m === 11 && day === 23) return { greeting: "Happy birthday, Siakap Terminal!", tints: ["#f5c542"] };
  if (m === 4 && day === 1) return { greeting: "Something smells fishy today." };
  if (day === 13 && d.getDay() === 5) return { greeting: "Friday the 13th. Mind your sudo." };
  return null;
}

const SEQ = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];

export function installEggs(accent: () => string) {
  let pos = 0;
  window.addEventListener(
    "keydown",
    (e) => {
      const t = e.target as HTMLElement | null;
      // Never while typing in a terminal or a field.
      if (t?.closest?.(".xterm, input, textarea, select, [contenteditable]")) {
        pos = 0;
        return;
      }
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      pos = k === SEQ[pos] ? pos + 1 : k === SEQ[0] ? 1 : 0;
      if (pos === SEQ.length) {
        pos = 0;
        play("chime");
        swimBy(accent(), { giant: true });
        toast("The golden siakap has appeared. Make a wish.", "ok", 4000);
      }
    },
    true,
  );
}

let lastSearch = "";
/** Settings search for the fish itself. Returns true when it was one. */
export function searchEgg(q: string, accent: string): boolean {
  const hit = /^(siakap|ikan|fish|barramundi)$/.test(q);
  if (hit && q !== lastSearch) {
    play("splash");
    swimBy(accent);
  }
  lastSearch = q;
  return hit;
}

let versionClicks = 0;
let versionTimer = 0;
/** Clicking the version number in About a few times. */
export function versionClicked(version: string) {
  versionClicks++;
  window.clearTimeout(versionTimer);
  versionTimer = window.setTimeout(() => (versionClicks = 0), 2000);
  if (versionClicks < 7) return;
  versionClicks = 0;
  showCredits(version);
}

export function showCredits(version: string) {
  play("chime");
  void modal<void>(
    "Behind the scenes",
    (close) => {
      const tank = h("canvas", { class: "egg-tank" }) as HTMLCanvasElement;
      const dpr = devicePixelRatio || 1;
      tank.width = 420 * dpr;
      tank.height = 150 * dpr;
      const g = tank.getContext("2d")!;
      const fish = Array.from({ length: 6 }, (_, i) => ({
        px: Math.round((2 + Math.random() * 3) * dpr),
        x: Math.random() * tank.width,
        y: 10 * dpr + Math.random() * 100 * dpr,
        v: (30 + Math.random() * 50) * dpr,
        dir: (Math.random() < 0.5 ? 1 : -1) as 1 | -1,
        gold: i === 0,
      }));
      let last = performance.now();
      const frame = (now: number) => {
        if (!tank.isConnected && now - last > 1000) return;
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        const grd = g.createLinearGradient(0, 0, 0, tank.height);
        grd.addColorStop(0, "#0d3b66");
        grd.addColorStop(1, "#04121f");
        g.fillStyle = grd;
        g.fillRect(0, 0, tank.width, tank.height);
        g.fillStyle = "#c2a878";
        g.fillRect(0, tank.height - 8 * dpr, tank.width, 8 * dpr);
        for (const f of fish) {
          const w = FISH[0].length * f.px;
          f.x += f.dir * f.v * dt;
          if (f.x > tank.width + 10) f.dir = -1;
          if (f.x < -w - 10) f.dir = 1;
          paintFish(g, f.x, f.y + Math.sin(now / 400 + f.v) * f.px, f.px, f.dir, null, Math.sin(now / 90 + f.v) > 0 ? 1 : 0, f.gold ? GOLD : undefined);
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      const ok = h("button", { class: "primary", onclick: () => close() }, "Terima kasih");
      return {
        body: h(
          "div",
          { class: "egg-credits" },
          tank,
          h("p", {}, h("strong", {}, `Siakap Terminal ${version}`), " is made by Shaqqiem, with Rust, Tauri and xterm.js."),
          h("p", { class: "muted" }, "The siakap (barramundi) is a fish that is happy in both fresh and salt water. A terminal that is happy on Windows and on your servers seemed like a fair match."),
          h("p", { class: "muted small" }, "You clicked the version number seven times. There are a few more of these around."),
        ),
        actions: [ok],
        focus: ok,
      };
    },
    { dismissValue: undefined },
  );
}
