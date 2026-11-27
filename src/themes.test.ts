import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_THEMES, exportTheme, hex6, parseThemes, uniqueName } from "./themes.ts";

test("built-in themes are complete", () => {
  for (const t of BUILTIN_THEMES) {
    assert.ok(t.palette.length === 0 || t.palette.length === 16, t.name);
    assert.ok(/^#[0-9a-f]{6}$/i.test(t.background) && /^#[0-9a-f]{6}$/i.test(t.foreground), t.name);
  }
});

test("export then import gives the same theme", () => {
  const d = BUILTIN_THEMES.find((t) => t.name === "Dracula")!;
  const [back] = parseThemes(exportTheme(d));
  assert.deepEqual(back, d);
});

test("app colours survive export and import, and bad ones are dropped", () => {
  const c = BUILTIN_THEMES.find((t) => t.name === "Catppuccin Mocha")!;
  const [back] = parseThemes(exportTheme(c));
  assert.deepEqual(back, c);
  const [bad] = parseThemes(JSON.stringify({ name: "x", background: "#000000", foreground: "#ffffff", ui: { panel: "#123456", text: "red", evil: "#000000" } }));
  assert.deepEqual(bad.ui, { panel: "#123456" });
});

test("every built-in theme has a unique name and valid app colours", () => {
  const names = new Set(BUILTIN_THEMES.map((t) => t.name.toLowerCase()));
  assert.equal(names.size, BUILTIN_THEMES.length);
  for (const t of BUILTIN_THEMES) for (const v of Object.values(t.ui ?? {})) assert.match(v, /^#[0-9a-f]{6}$/i, t.name);
});

test("reads a Windows Terminal scheme and a settings file", () => {
  const scheme = {
    name: "WT", background: "#0C0C0C", foreground: "#CCCCCC", cursorColor: "#FFF", selectionBackground: "#333333",
    black: "#000000", red: "#110000", green: "#001100", yellow: "#111100", blue: "#000011", purple: "#110011", cyan: "#001111", white: "#111111",
    brightBlack: "#222222", brightRed: "#220000", brightGreen: "#002200", brightYellow: "#222200", brightBlue: "#000022", brightPurple: "#220022", brightCyan: "#002222", brightWhite: "#ffffff",
  };
  const [t] = parseThemes(JSON.stringify(scheme));
  assert.equal(t.name, "WT");
  assert.equal(t.background, "#0c0c0c");
  assert.equal(t.cursor, "#ffffff");
  assert.equal(t.palette[5], "#110011", "purple is magenta");
  const all = parseThemes(JSON.stringify({ profiles: {}, schemes: [scheme, { ...scheme, name: "Two" }] }));
  assert.deepEqual(all.map((x) => x.name), ["WT", "Two"]);
});

test("rejects files without usable colours", () => {
  assert.throws(() => parseThemes("not json"));
  assert.throws(() => parseThemes(JSON.stringify({ name: "x", background: "red", foreground: "#fff" })));
  const [partial] = parseThemes(JSON.stringify({ background: "#000", foreground: "#fff", red: "#f00" }));
  assert.deepEqual(partial.palette, [], "an incomplete palette is ignored");
  assert.equal(partial.name, "Imported theme");
});

test("helpers", () => {
  assert.equal(hex6("#AbC"), "#aabbcc");
  assert.equal(uniqueName("Nord", ["nord", "Nord 2"]), "Nord 3");
  assert.equal(uniqueName("Mine", ["Nord"]), "Mine");
});
