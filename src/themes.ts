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

const t = (name: string, background: string, foreground: string, cursor: string, selection: string, palette: string[], accent = ""): TerminalTheme => ({
  name, background, foreground, cursor, selection, palette, accent,
});

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
  return { name: s.themeName || "Custom", background: s.background, foreground: s.foreground, cursor: s.cursor, selection: s.selection, palette: s.palette ?? [], accent: s.accent ?? "" };
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
