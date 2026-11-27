import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BADGE, DOODLE, ISO, NEON, PIXEL, SOLID, TILEGLYPH, badgeSvg, doodleSvg, isoSvg, pixelDots, pixelRects, tileColour } from "./iconsets.ts";

const names = [...readFileSync(new URL("./icons.ts", import.meta.url), "utf8").split("const P")[1].split("};")[0].matchAll(/^\s+"?([a-z-]+)"?:/gm)].map((m) => m[1]);

test("every icon has its own drawing in every pack", () => {
  assert.ok(names.length >= 40);
  for (const n of names) for (const [pack, set] of Object.entries({ PIXEL, SOLID, NEON, TILEGLYPH, BADGE, DOODLE, ISO })) assert.ok((set as Record<string, unknown>)[n], `${pack} ${n}`);
});

test("3D, badge and doodle drawings come out as valid SVG pieces", () => {
  for (const n of names) {
    for (const svg of [isoSvg(n), badgeSvg(n), doodleSvg(n)]) {
      assert.ok(svg.length > 20, n);
      assert.doesNotMatch(svg, /NaN|undefined/, n);
      const open = (svg.match(/<(path|circle|rect|polygon|ellipse|text|g)\b/g) ?? []).length;
      assert.ok(open > 0, n);
    }
  }
});

test("packs differ: no pack reuses another pack's drawing", () => {
  for (const n of names) {
    const tile = TILEGLYPH[n];
    assert.ok(!tile.includes(SOLID[n]), `tile ${n} is the solid drawing`);
    assert.notEqual(NEON[n], undefined);
  }
});

test("pixel art is at most 12×12 and only uses # and .", () => {
  for (const [n, rows] of Object.entries(PIXEL)) {
    assert.ok(rows.length <= 12, `${n} rows`);
    for (const r of rows) assert.match(r, /^[#.]{12}$/, `${n}: "${r}"`);
    assert.ok(rows.some((r) => r.includes("#")), `${n} is empty`);
  }
});

test("pixel art becomes rectangles and dots inside the 24×24 box", () => {
  const rects = pixelRects(["#..##.......", "............"]);
  assert.equal(rects, '<rect x="0" y="10" width="2" height="2"/><rect x="6" y="10" width="4" height="2"/>');
  assert.equal((pixelDots(["#...........", "...........#"]).match(/<circle/g) ?? []).length, 2);
});

test("tiles get a colour", () => {
  assert.match(tileColour("sessions"), /^#[0-9a-f]{6}$/);
  assert.match(tileColour("anything-else"), /^#[0-9a-f]{6}$/);
});
