// The app's own colours ("skin") and window icon, derived from the terminal
// theme, so a theme changes the whole app, not just the terminals.
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Settings } from "./api";
import { DEFAULT_PALETTE } from "./themes";

type RGB = [number, number, number];

const hex = (c: string): RGB | null => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c?.trim() ?? "");
  if (!m) return null;
  const v = m[1].length === 3 ? m[1].split("").map((x) => x + x).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as RGB;
};
const toHex = (c: RGB) => "#" + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const lum = (c: RGB) => {
  const f = (x: number) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** The accent colour: the theme's own, else its blue, else Siakap blue. */
export function accentOf(s: Settings): string {
  if (hex(s.accent)) return s.accent;
  const pal = s.palette?.length === 16 ? s.palette : null;
  return pal && hex(pal[12]) ? pal[12] : "#5aa9e6";
}

const VARS = ["--bg", "--bg2", "--bg3", "--hover", "--line", "--fg", "--muted", "--accent", "--accent-fg", "--ok", "--warn", "--err"];

/** CSS variables for the app, from the terminal colours. */
export function skinVars(s: Settings): Record<string, string> | null {
  const bg = hex(s.background);
  const fg = hex(s.foreground);
  if (!bg || !fg) return null;
  const light = lum(bg) > 0.4;
  const black: RGB = [0, 0, 0];
  const white: RGB = [255, 255, 255];
  // Panels sit a little darker (dark themes) or lighter (light themes) than the terminal.
  const base = light ? mix(bg, white, 0.35) : mix(bg, black, 0.18);
  let text = fg;
  if (contrast(text, base) < 7) text = light ? mix(fg, black, 0.5) : mix(fg, white, 0.5);
  const accent = hex(accentOf(s))!;
  const pal = (s.palette?.length === 16 ? s.palette : DEFAULT_PALETTE).map((c) => hex(c)!);
  const status = (i: number, fallback: string) => {
    const c = pal[i] ?? hex(fallback)!;
    return contrast(c, base) >= 2.2 ? toHex(c) : fallback;
  };
  return {
    "--bg": toHex(base),
    "--bg2": toHex(mix(base, text, light ? 0.03 : 0.035)),
    "--bg3": toHex(mix(base, text, light ? 0.07 : 0.08)),
    "--hover": toHex(mix(base, text, light ? 0.1 : 0.12)),
    "--line": toHex(mix(base, text, light ? 0.14 : 0.14)),
    "--fg": toHex(text),
    "--muted": toHex(mix(text, base, 0.42)),
    "--accent": toHex(accent),
    "--accent-fg": contrast(accent, black) > contrast(accent, white) ? "#07131d" : "#ffffff",
    "--ok": status(light ? 2 : 10, "#3fb950"),
    "--warn": status(light ? 3 : 11, "#d29922"),
    "--err": status(light ? 1 : 9, "#f85149"),
  };
}

/** Apply (or remove) the skin on the document. */
export function applySkin(s: Settings) {
  const root = document.documentElement;
  const vars = s.appSkin !== false ? skinVars(s) : null;
  for (const v of VARS) root.style.removeProperty(v);
  const light = !!vars && lum(hex(vars["--bg"])!) > 0.4;
  root.style.colorScheme = light ? "light" : "dark";
  root.classList.toggle("skin-light", light);
  if (vars) for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  else if (hex(s.accent)) root.style.setProperty("--accent", s.accent);
}

/** The Siakap icon (prompt, cursor and a dot) drawn in the theme's colours. */
export function drawIcon(s: Settings, size = 256): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const u = size / 64;
  const bg = s.background || "#11151c";
  const accent = accentOf(s);
  const fg = s.foreground || "#d8dee9";
  const r = 14 * u;
  const rect = (x: number, y: number, w: number, h: number, rad: number) => {
    g.beginPath();
    g.moveTo(x + rad, y);
    g.arcTo(x + w, y, x + w, y + h, rad);
    g.arcTo(x + w, y + h, x, y + h, rad);
    g.arcTo(x, y + h, x, y, rad);
    g.arcTo(x, y, x + w, y, rad);
    g.closePath();
  };
  rect(3 * u, 3 * u, 58 * u, 58 * u, r);
  g.fillStyle = bg;
  g.fill();
  g.lineWidth = 3.5 * u;
  g.strokeStyle = accent;
  g.stroke();
  g.lineCap = "round";
  g.lineJoin = "round";
  g.lineWidth = 6 * u;
  g.beginPath();
  g.moveTo(17 * u, 21 * u);
  g.lineTo(29 * u, 32 * u);
  g.lineTo(17 * u, 43 * u);
  g.stroke();
  g.strokeStyle = fg;
  g.beginPath();
  g.moveTo(33 * u, 43 * u);
  g.lineTo(48 * u, 43 * u);
  g.stroke();
  g.fillStyle = accent;
  g.save();
  g.translate(44 * u, 23 * u);
  g.rotate(Math.PI / 4);
  g.fillRect(-3.2 * u, -3.2 * u, 6.4 * u, 6.4 * u);
  g.restore();
  return c;
}

let lastIcon = "";
/** Set the window (taskbar) icon to match the theme. */
export async function applyIcon(s: Settings) {
  const key = s.themeIcon === false ? "default" : `${s.background}|${s.foreground}|${accentOf(s)}`;
  if (key === lastIcon) return;
  lastIcon = key;
  if (s.themeIcon === false) return; // the default icon stays until the next start
  const blob = await new Promise<Blob | null>((res) => drawIcon(s).toBlob(res, "image/png"));
  if (!blob) return;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await getCurrentWindow()
    .setIcon(bytes)
    .catch(() => {});
}

/** Glass style: how see-through the glass is (percent) and how much it blurs (px). */
export function setGlass(transparency: number, blur: number) {
  const root = document.documentElement.style;
  root.setProperty("--g-opacity", `${100 - Math.min(90, Math.max(0, transparency))}%`);
  root.setProperty("--g-blur-px", `${Math.min(60, Math.max(0, blur))}px`);
}
