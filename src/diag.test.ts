import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, diagEvents, record, redact } from "./diag.ts";

test("redact hides names, addresses and the home folder", () => {
  const raw = "ssh admin@db.example.com 10.1.2.3 fe80::1ff:fe23:4567:890a at 12:30:45 C:\\Users\\Aminah\\AppData /home/bob/x core::fs db-2 mail me@x.org";
  const out = redact(raw, { words: ["db.example.com", "admin", "db"] });
  assert.ok(!out.includes("db.example.com"));
  assert.ok(!out.includes("10.1.2.3"));
  assert.ok(!out.includes("fe80"));
  assert.ok(!out.includes("Aminah"));
  assert.ok(!out.includes("/home/bob"));
  assert.ok(!out.includes("me@x.org"));
  assert.ok(out.includes("12:30:45"), out);
  assert.ok(out.includes("core::fs"), out);
  assert.ok(out.includes("db-2"), out); // only whole names
});

test("record trims, de-duplicates and strips control characters", () => {
  record("error", "boom\x1b[31m");
  record("error", "boom\x1b[31m");
  const evs = diagEvents();
  assert.equal(evs.filter((e) => e.text.startsWith("boom")).length, 1);
  assert.ok(!evs[evs.length - 1].text.includes("\x1b"));
  record("info", "x".repeat(5000));
  assert.equal(diagEvents()[diagEvents().length - 1].text.length, 1000);
});

test("report has the description, facts, events and settings", () => {
  const r = buildReport("It froze", { app: "0.7.3", settings: { fontSize: 14 }, crashes: ["panic at x"] }, [{ t: Date.now(), kind: "error", text: "term_open_ssh failed: refused" }]);
  for (const s of ["It froze", "app: 0.7.3", "term_open_ssh failed", "panic at x", '"fontSize": 14', "Not included"]) assert.ok(r.includes(s), s);
});
