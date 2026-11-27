// Colour themes: built-ins, import (Siakap and Windows Terminal formats) and
// export. Pure functions, no DOM (unit-tested in themes.test.ts).
import type { ITheme } from "@xterm/xterm";
import type { Settings, TerminalTheme } from "./api";

export const ANSI_NAMES = [
  "Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White",
  "Bright black", "Bright red", "Bright green", "Bright yellow", "Bright blue", "Bright magenta", "Bright cyan", "Bright white",
] as const;
const XTERM_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;
// Windows Terminal calls magenta "purple".
const WT_KEYS = [
  "black", "red", "green", "yellow", "blue", "purple", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightPurple", "brightCyan", "brightWhite",
] as const;

/** xterm.js's own colours, shown when a theme has no palette. */
export const DEFAULT_PALETTE = [
  "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
];

const t = (name: string, background: string, foreground: string, cursor: string, selection: string, palette: string[], accent = "", ui?: Record<string, string>): TerminalTheme => ({
  name, background, foreground, cursor, selection, palette, accent, ...(ui ? { ui } : {}),
});

/** App colour names a theme can set (see skin.ts). */
export const UI_KEYS = ["bg", "panel", "surface", "hover", "line", "text", "muted", "accentText", "ok", "warn", "err"] as const;
export type UiKey = (typeof UI_KEYS)[number];
export function cleanUi(o: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (o && typeof o === "object") for (const k of UI_KEYS) { const v = (o as Record<string, unknown>)[k]; if (isHex(v)) out[k] = hex6(v); }
  return out;
}

export const BUILTIN_THEMES: TerminalTheme[] = [
  t("Siakap Dark", "#11151c", "#d8dee9", "#88c0d0", "#3b4252", []),
  t("Campbell", "#0c0c0c", "#cccccc", "#ffffff", "#3a3a3a", [
    "#0c0c0c", "#c50f1f", "#13a10e", "#c19c00", "#0037da", "#881798", "#3a96dd", "#cccccc",
    "#767676", "#e74856", "#16c60c", "#f9f1a5", "#3b78ff", "#b4009e", "#61d6d6", "#f2f2f2",
  ], "#3b78ff"),
  t("One Half Dark", "#282c34", "#dcdfe4", "#a3b3cc", "#474e5d", [
    "#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#dcdfe4",
    "#5a6374", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#dcdfe4",
  ], "#61afef"),
  t("Dracula", "#282a36", "#f8f8f2", "#f8f8f2", "#44475a", [
    "#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
    "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff",
  ], "#bd93f9"),
  t("Nord", "#2e3440", "#d8dee9", "#d8dee9", "#434c5e", [
    "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
    "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4",
  ], "#88c0d0"),
  t("Gruvbox Dark", "#282828", "#ebdbb2", "#ebdbb2", "#504945", [
    "#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984",
    "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2",
  ], "#fabd2f"),
  t("Tokyo Night", "#1a1b26", "#c0caf5", "#c0caf5", "#33467c", [
    "#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
    "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5",
  ], "#7aa2f7"),
  t("Solarized Dark", "#002b36", "#839496", "#93a1a1", "#073642", [
    "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
    "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
  ], "#268bd2"),
  t("Solarized Light", "#fdf6e3", "#657b83", "#586e75", "#eee8d5", [
    "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
    "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
  ], "#268bd2"),
  // Pink, purple, green and gold.
  t("Orchid", "#1a1025", "#f4e9ff", "#f5c542", "#4b2a66", [
    "#24152f", "#ff4f8b", "#4ade80", "#f5c542", "#a78bfa", "#f472b6", "#5eead4", "#e9d5ff",
    "#5b3a78", "#ff7aa8", "#86efac", "#ffd866", "#c4b5fd", "#f9a8d4", "#99f6e4", "#ffffff",
  ], "#ec4899"),
  t("Orchid Light", "#fdf4ff", "#3b0764", "#c026d3", "#f5d0fe", [
    "#3b0764", "#be185d", "#15803d", "#a16207", "#7c3aed", "#c026d3", "#0f766e", "#6b21a8",
    "#581c87", "#db2777", "#16a34a", "#ca8a04", "#8b5cf6", "#d946ef", "#0d9488", "#86198f",
  ], "#db2777"),
  t("Black", "#000000", "#e6e6e6", "#ffffff", "#444444", []),
  t("Classic green", "#0a0f0a", "#33ff66", "#33ff66", "#1e4d2b", [], "#33cc66"),
  t("Light", "#fafafa", "#1f2328", "#0969da", "#c8ddf5", [
    "#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781",
    "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f",
  ]),
  // ---- more themes (0.8.1)
  t("Catppuccin Mocha", "#1e1e2e", "#cdd6f4", "#f5e0dc", "#585b70", [
    "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",
    "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8",
  ], "#cba6f7", { bg: "#1e1e2e", panel: "#181825", surface: "#313244", hover: "#45475a", line: "#313244", text: "#cdd6f4", muted: "#a6adc8", accentText: "#11111b" }),
  t("Catppuccin Latte", "#eff1f5", "#4c4f69", "#dc8a78", "#acb0be", [
    "#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#acb0be",
    "#6c6f85", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#bcc0cc",
  ], "#8839ef", { bg: "#eff1f5", panel: "#e6e9ef", surface: "#ccd0da", hover: "#bcc0cc", line: "#ccd0da", text: "#4c4f69", muted: "#6c6f85", accentText: "#eff1f5" }),
  t("Rosé Pine", "#191724", "#e0def4", "#524f67", "#403d52", [
    "#26233a", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4",
    "#6e6a86", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4",
  ], "#c4a7e7", { bg: "#191724", panel: "#1f1d2e", surface: "#26233a", hover: "#2a2837", line: "#26233a", text: "#e0def4", muted: "#908caa", accentText: "#191724" }),
  t("Rosé Pine Dawn", "#faf4ed", "#575279", "#9893a5", "#dfdad9", [
    "#f2e9e1", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279",
    "#9893a5", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279",
  ], "#907aa9", { bg: "#faf4ed", panel: "#fffaf3", surface: "#f2e9e1", hover: "#f4ede8", line: "#dfdad9", text: "#575279", muted: "#797593", accentText: "#faf4ed" }),
  t("Monokai", "#272822", "#f8f8f2", "#f8f8f0", "#49483e", [
    "#272822", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2",
    "#75715e", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5",
  ], "#a6e22e"),
  t("Ayu Dark", "#0b0e14", "#bfbdb6", "#e6b450", "#273747", [
    "#11151c", "#ea6c73", "#7fd962", "#f9af4f", "#53bdfa", "#cda1fa", "#90e1c6", "#c7c7c7",
    "#686868", "#f07178", "#aad94c", "#ffb454", "#59c2ff", "#d2a6ff", "#95e6cb", "#ffffff",
  ], "#e6b450"),
  t("Ayu Light", "#f8f9fa", "#5c6166", "#ffaa33", "#d1e4f4", [
    "#000000", "#ea6c6d", "#6cbf43", "#eca944", "#3199e1", "#9e75c7", "#46ba94", "#bababa",
    "#686868", "#f07171", "#86b300", "#f2ae49", "#399ee6", "#a37acc", "#4cbf99", "#d1d1d1",
  ], "#ff9940"),
  t("Everforest", "#2d353b", "#d3c6aa", "#d3c6aa", "#475258", [
    "#475258", "#e67e80", "#a7c080", "#dbbc7f", "#7fbbb3", "#d699b6", "#83c092", "#d3c6aa",
    "#475258", "#e67e80", "#a7c080", "#dbbc7f", "#7fbbb3", "#d699b6", "#83c092", "#d3c6aa",
  ], "#a7c080", { bg: "#2d353b", panel: "#272e33", surface: "#343f44", hover: "#3d484d", line: "#3d484d", text: "#d3c6aa", muted: "#859289", accentText: "#2d353b" }),
  t("Kanagawa", "#1f1f28", "#dcd7ba", "#c8c093", "#2d4f67", [
    "#16161d", "#c34043", "#76946a", "#c0a36e", "#7e9cd8", "#957fb8", "#6a9589", "#c8c093",
    "#727169", "#e82424", "#98bb6c", "#e6c384", "#7fb4ca", "#938aa9", "#7aa89f", "#dcd7ba",
  ], "#7e9cd8", { bg: "#1f1f28", panel: "#16161d", surface: "#2a2a37", hover: "#363646", line: "#2a2a37", text: "#dcd7ba", muted: "#727169", accentText: "#16161d" }),
  t("Night Owl", "#011627", "#d6deeb", "#80a4c2", "#1d3b53", [
    "#011627", "#ef5350", "#22da6e", "#addb67", "#82aaff", "#c792ea", "#21c7a8", "#ffffff",
    "#575656", "#ef5350", "#22da6e", "#ffeb95", "#82aaff", "#c792ea", "#7fdbca", "#ffffff",
  ], "#82aaff"),
  t("Synthwave", "#262335", "#f2f0ff", "#ff7edb", "#463465", [
    "#262335", "#fe4450", "#72f1b8", "#fede5d", "#03edf9", "#ff7edb", "#03edf9", "#ffffff",
    "#614d85", "#fe4450", "#72f1b8", "#f97e72", "#03edf9", "#ff7edb", "#03edf9", "#ffffff",
  ], "#ff7edb", { bg: "#262335", panel: "#1f1a2e", surface: "#34294f", hover: "#3d3060", line: "#463465", text: "#f2f0ff", muted: "#b6a8d8", accentText: "#1f1a2e" }),
  t("Palenight", "#292d3e", "#bfc7d5", "#ffcc00", "#3c435e", [
    "#292d3e", "#f07178", "#c3e88d", "#ffcb6b", "#82aaff", "#c792ea", "#89ddff", "#d0d0d0",
    "#434758", "#ff8b92", "#ddffa7", "#ffe585", "#9cc4ff", "#e1acff", "#a3f7ff", "#ffffff",
  ], "#c792ea"),
  t("Iceberg", "#161821", "#c6c8d1", "#c6c8d1", "#272c42", [
    "#1e2132", "#e27878", "#b4be82", "#e2a478", "#84a0c6", "#a093c7", "#89b8c2", "#c6c8d1",
    "#6b7089", "#e98989", "#c0ca8e", "#e9b189", "#91acd1", "#ada0d3", "#95c4ce", "#d2d4de",
  ], "#84a0c6"),
  t("Horizon", "#1c1e26", "#e0e0e0", "#e95378", "#2e303e", [
    "#16161c", "#e95678", "#29d398", "#fab795", "#26bbd9", "#ee64ac", "#59e1e3", "#d5d8da",
    "#5b5858", "#ec6a88", "#3fdaa4", "#fbc3a7", "#3fc4de", "#f075b5", "#6be4e6", "#d5d8da",
  ], "#e95678"),
  t("Oxocarbon", "#161616", "#f2f4f8", "#f2f4f8", "#393939", [
    "#262626", "#ee5396", "#42be65", "#ffe97b", "#33b1ff", "#ff7eb6", "#3ddbd9", "#dde1e6",
    "#393939", "#ee5396", "#42be65", "#ffe97b", "#33b1ff", "#ff7eb6", "#3ddbd9", "#ffffff",
  ], "#78a9ff"),
  t("Material Ocean", "#0f111a", "#a6accd", "#ffcc00", "#1f2233", [
    "#546e7a", "#ff5370", "#c3e88d", "#ffcb6b", "#82aaff", "#c792ea", "#89ddff", "#ffffff",
    "#546e7a", "#ff5370", "#c3e88d", "#ffcb6b", "#82aaff", "#c792ea", "#89ddff", "#ffffff",
  ], "#84ffff"),
  // Siakap originals, with their own app colours.
  t("Laut Dalam", "#071a2b", "#cfe8f5", "#ffb02e", "#12405e", [
    "#0b2a40", "#ff6b6b", "#2ee6a6", "#ffd166", "#4cc9f0", "#b388eb", "#48e5c2", "#cfe8f5",
    "#3d6680", "#ff8787", "#6bf2c0", "#ffe08a", "#7ad7f7", "#cbaaf2", "#7af0d6", "#ffffff",
  ], "#4cc9f0", { bg: "#061525", panel: "#04101d", surface: "#0c2840", hover: "#12344f", line: "#12344f", text: "#d6ecf7", muted: "#7fa3bb", accentText: "#03121f" }),
  t("Teh Tarik", "#2b1d14", "#f3e3cf", "#e7a76c", "#5a3b26", [
    "#3a281c", "#e0685a", "#9fbf6f", "#e7b25d", "#7fa6c9", "#c98fb0", "#7fc2b0", "#f3e3cf",
    "#6e5241", "#f08070", "#b5d68a", "#f5c979", "#9bbfdf", "#dea8c6", "#9ad8c7", "#fff6ea",
  ], "#e7a76c", { bg: "#2b1d14", panel: "#22170f", surface: "#3a281c", hover: "#47321f", line: "#47321f", text: "#f3e3cf", muted: "#bfa58c", accentText: "#2b1d14" }),
  t("Pandan", "#102018", "#dcf2e4", "#8ee6a0", "#24503a", [
    "#18301f", "#ef6f6c", "#8ee6a0", "#e8d77a", "#6fb7e0", "#c79ae0", "#6fd9c4", "#dcf2e4",
    "#4a6b56", "#ff8a86", "#aaf2b8", "#f2e49a", "#8fcbec", "#d8b4ec", "#8fe6d4", "#f4fff7",
  ], "#5fd38a", { bg: "#0e1c15", panel: "#0a1610", surface: "#183021", hover: "#1f3b2a", line: "#1f3b2a", text: "#dcf2e4", muted: "#8fb39c", accentText: "#06130b" }),
  t("Batik", "#1a1430", "#f1e6d0", "#e3b23c", "#3d2f63", [
    "#241c40", "#c94b4b", "#6fa86b", "#e3b23c", "#5b7fd6", "#a35bb5", "#4fa3a5", "#f1e6d0",
    "#5a4f7d", "#e06666", "#8cc788", "#f0c95e", "#7d9ae6", "#c07fd0", "#6fc0c2", "#fff8ea",
  ], "#e3b23c", { bg: "#1a1430", panel: "#130f25", surface: "#2a2149", hover: "#33295a", line: "#33295a", text: "#f1e6d0", muted: "#a99cc6", accentText: "#1a1430" }),
  t("Sunset", "#1f1326", "#ffe6d5", "#ff9e64", "#4a2742", [
    "#2a1a33", "#ff5e7e", "#9be07b", "#ffb86b", "#7aa2f7", "#ff79c6", "#7dcfff", "#ffe6d5",
    "#6b4a70", "#ff7a93", "#b4ec97", "#ffcb8f", "#95b6fa", "#ff94d4", "#9ad9ff", "#fff4ec",
  ], "#ff9e64", { bg: "#1f1326", panel: "#170e1d", surface: "#2e1d38", hover: "#3a2546", line: "#3a2546", text: "#ffe6d5", muted: "#c9a3b6", accentText: "#1f1326" }),
  t("Paper", "#fbfaf7", "#2b2b2b", "#2b2b2b", "#e6e1d6", [
    "#2b2b2b", "#c0392b", "#2e7d32", "#b7791f", "#1e5aa8", "#8e44ad", "#0f7c7c", "#d9d6cf",
    "#6b6b6b", "#e74c3c", "#43a047", "#d69e2e", "#3a7bd5", "#a55fc0", "#179c9c", "#fbfaf7",
  ], "#1e5aa8", { bg: "#fbfaf7", panel: "#f3f1ec", surface: "#e9e5dc", hover: "#e4dfd4", line: "#e2ddd2", text: "#2b2b2b", muted: "#6b6b6b", accentText: "#ffffff" }),
  t("High Contrast", "#000000", "#ffffff", "#ffff00", "#0b5fa5", [
    "#000000", "#ff4040", "#00ff66", "#ffff00", "#3b8eff", "#ff4dff", "#00ffff", "#ffffff",
    "#808080", "#ff8080", "#80ff99", "#ffff80", "#80b5ff", "#ff99ff", "#80ffff", "#ffffff",
  ], "#ffff00", { bg: "#000000", panel: "#000000", surface: "#111111", hover: "#222222", line: "#ffffff", text: "#ffffff", muted: "#d0d0d0", accentText: "#000000" }),
];

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export const isHex = (c: unknown): c is string => typeof c === "string" && HEX.test(c);

/** Expand #abc to #aabbcc (colour inputs need 6 digits). */
export function hex6(c: string): string {
  if (!isHex(c)) return "#000000";
  return c.length === 4 ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`.toLowerCase() : c.toLowerCase();
}

/** The theme stored in settings. */
export function currentTheme(s: Settings): TerminalTheme {
  return { name: s.themeName || "Custom", background: s.background, foreground: s.foreground, cursor: s.cursor, selection: s.selection, palette: s.palette ?? [], accent: s.accent ?? "", ui: { ...(s.uiColors ?? {}) } };
}

/** Settings with `theme` applied. */
export function withTheme(s: Settings, theme: TerminalTheme): Settings {
  return {
    ...s,
    themeName: theme.name,
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor || theme.foreground,
    selection: theme.selection || s.selection,
    palette: theme.palette.length === 16 ? [...theme.palette] : [],
    accent: theme.accent,
    uiColors: { ...(theme.ui ?? {}) },
  };
}

/** xterm.js theme object. */
export function xtermTheme(s: Settings): ITheme {
  const out: ITheme = { background: s.background, foreground: s.foreground, cursor: s.cursor, cursorAccent: s.background, selectionBackground: s.selection };
  const pal = s.palette ?? [];
  if (pal.length === 16) XTERM_KEYS.forEach((k, i) => ((out as Record<string, string>)[k] = pal[i]));
  return out;
}

export class ThemeError extends Error {}

/**
 * Read a theme file: Siakap's own format, a Windows Terminal colour scheme
 * (`{"name", "background", "foreground", "black", ..., "brightWhite"}`), or a
 * Windows Terminal settings file with a "schemes" list (every scheme is read).
 */
export function parseThemes(text: string): TerminalTheme[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ThemeError("That file isn't valid JSON.");
  }
  const one = (o: Record<string, unknown>): TerminalTheme | null => {
    if (!o || typeof o !== "object" || !isHex(o.background) || !isHex(o.foreground)) return null;
    const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 60) : "Imported theme";
    let palette: string[] = [];
    if (Array.isArray(o.palette) && o.palette.length === 16 && o.palette.every(isHex)) palette = (o.palette as string[]).map(hex6);
    else if (WT_KEYS.every((k) => isHex(o[k]))) palette = WT_KEYS.map((k) => hex6(o[k] as string));
    else if (XTERM_KEYS.every((k) => isHex(o[k]))) palette = XTERM_KEYS.map((k) => hex6(o[k] as string));
    const pick = (...keys: string[]) => keys.map((k) => o[k]).find(isHex) as string | undefined;
    return {
      name,
      background: hex6(o.background as string),
      foreground: hex6(o.foreground as string),
      cursor: hex6(pick("cursor", "cursorColor") ?? (o.foreground as string)),
      selection: hex6(pick("selection", "selectionBackground") ?? "#444444"),
      palette,
      accent: isHex(o.accent) ? hex6(o.accent) : "",
      ...(Object.keys(cleanUi(o.ui ?? o.siakapUi)).length ? { ui: cleanUi(o.ui ?? o.siakapUi) } : {}),
    };
  };
  const list: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).schemes)
      ? ((data as Record<string, unknown>).schemes as unknown[])
      : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).themes)
        ? ((data as Record<string, unknown>).themes as unknown[])
        : [data];
  const out = list.slice(0, 100).map((x) => one(x as Record<string, unknown>)).filter((x): x is TerminalTheme => !!x);
  if (!out.length) throw new ThemeError("No colour theme was found in that file. Siakap reads its own theme files and Windows Terminal colour schemes.");
  return out;
}

/** A theme file Siakap (and, for the colours, Windows Terminal) can read back. */
export function exportTheme(theme: TerminalTheme): string {
  const pal = theme.palette.length === 16 ? theme.palette : DEFAULT_PALETTE;
  const wt: Record<string, string> = {};
  WT_KEYS.forEach((k, i) => (wt[k] = pal[i]));
  return JSON.stringify(
    {
      name: theme.name,
      background: theme.background,
      foreground: theme.foreground,
      cursorColor: theme.cursor,
      selectionBackground: theme.selection,
      ...wt,
      accent: theme.accent || undefined,
      ui: theme.ui && Object.keys(theme.ui).length ? theme.ui : undefined,
      siakapTheme: 1,
    },
    null,
    2,
  );
}

/** Name not used by a built-in or saved theme ("Name", "Name 2", ...). */
export function uniqueName(name: string, taken: string[]): string {
  const used = new Set(taken.map((x) => x.toLowerCase()));
  const base = name.trim().slice(0, 56) || "My theme";
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!used.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}
