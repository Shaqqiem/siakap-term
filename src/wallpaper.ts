// Wallpapers for the app and the terminal, the see-through window, and the
// interface font. Each style has its own defaults ("style"):
//   app:      Glass → your desktop through the window (Windows), others → plain
//   terminal: Glass → shows the app wallpaper; Material, Fluent, Dot matrix and
//             Retro → their own pattern; Standard and Minimal → solid
import { api, type Settings, type UiStyle } from "./api";

export type AppWall = "solid" | "mesh" | "color" | "image" | "desktop";
export type TermWall = "solid" | "pattern" | "color" | "image" | "through";

const isWindows = /Windows/i.test(navigator.userAgent);

export function resolveApp(s: Pick<Settings, "wallpaper" | "uiStyle">): AppWall {
  const w = s.wallpaper ?? "style";
  if (w !== "style") return w as AppWall;
  return (s.uiStyle ?? "standard") === "glass" ? (isWindows ? "desktop" : "mesh") : "solid";
}

export function resolveTerm(s: Pick<Settings, "termWallpaper" | "uiStyle">): TermWall {
  const w = s.termWallpaper ?? "style";
  if (w !== "style") return w as TermWall;
  const ui: UiStyle = s.uiStyle ?? "standard";
  if (ui === "glass") return "through";
  return ui === "standard" || ui === "minimal" ? "solid" : "pattern";
}

/** Data URLs of the pictures, loaded once and again after a new pick. */
const images: Record<"app" | "term", { url: string | null; loaded: boolean }> = {
  app: { url: null, loaded: false },
  term: { url: null, loaded: false },
};

/** Forget a cached picture (after picking or removing one). */
export function wallpaperChanged(target: "app" | "term") {
  images[target].loaded = false;
}

async function image(target: "app" | "term"): Promise<string | null> {
  const c = images[target];
  if (!c.loaded) {
    c.url = await api.wallpaperGet(target).catch(() => null);
    c.loaded = true;
  }
  return c.url;
}

let backdrop = "";
let applied = { app: "", term: "" };

export async function applyWallpaper(s: Settings) {
  const root = document.documentElement;
  const st = root.style;
  const app = resolveApp(s);
  const term = resolveTerm(s);
  root.dataset.wall = app;
  root.dataset.twall = term;
  st.setProperty("--wall-color", s.wallpaperColor || "#1b2233");
  st.setProperty("--wall-dim", String(Math.min(90, s.wallpaperDim ?? 30) / 100));
  st.setProperty("--wall-blur", `${Math.min(60, s.wallpaperBlur ?? 0)}px`);
  st.setProperty("--twall-color", s.termWallpaperColor || "#101820");
  st.setProperty("--twall-blur", `${Math.min(60, s.termWallpaperBlur ?? 0)}px`);
  st.setProperty("--t-opacity", `${100 - Math.min(90, Math.max(0, s.glassTerminal ?? 30))}%`);

  // Pictures are only read when used.
  const appImg = app === "image" ? await image("app") : null;
  const termImg = term === "image" ? await image("term") : null;
  if (appImg !== null && applied.app !== appImg) st.setProperty("--wall-img", `url("${appImg}")`);
  if (termImg !== null && applied.term !== termImg) st.setProperty("--twall-img", `url("${termImg}")`);
  applied = { app: appImg ?? applied.app, term: termImg ?? applied.term };
  root.classList.toggle("wall-missing", app === "image" && !appImg);
  root.classList.toggle("twall-missing", term === "image" && !termImg);

  // The window itself becomes see-through only for the desktop wallpaper.
  const want = app === "desktop" ? (s.desktopEffect === "clear" ? "clear" : "acrylic") : "none";
  if (want !== backdrop) {
    backdrop = want;
    api.windowBackdrop(want).catch(() => {});
  }

  // Interface font: the user's choice, else the style's own.
  const font = (s.uiFont ?? "").replace(/["\\;{}<>]/g, "").trim();
  if (font) {
    document.body.style.setProperty("--ui-font", `"${font}", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif`);
    root.dataset.uifont = "custom";
  } else {
    document.body.style.removeProperty("--ui-font");
    delete root.dataset.uifont;
  }
}

/** Before the vault opens (lock screen, splash): never see-through. */
export function resetBackdrop() {
  if (backdrop !== "none") {
    backdrop = "none";
    api.windowBackdrop("none").catch(() => {});
  }
  document.documentElement.dataset.wall = "solid";
}
