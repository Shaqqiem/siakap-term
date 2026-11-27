import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PIXEL, SOLID, pixelDots, pixelRects, tileColour } from "./iconsets.ts";

const names = [...readFileSync(new URL("./icons.ts", import.meta.url), "utf8").split("const P")[1].split("};")[0].matchAll(/^\s+"?([a-z-]+)"?:/gm)].map((m) => m[1]);

test("every icon has its own pixel and solid drawing", () => {
  assert.ok(names.length >= 40);
  for (const n of names) {
    assert.ok(PIXEL[n], `pixel ${n}`);
    assert.ok(SOLID[n], `solid ${n}`);
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
