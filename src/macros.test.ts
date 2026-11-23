// Run with `npm test` (Node's built-in test runner, no extra dependencies).
// Mirrors the Rust tests in core/src/macros.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, placeholders, render, validateInput, MAX_INPUT_LEN } from "./macros.ts";

test("parses lines, waits, types and comments", () => {
  const s = "# comment\r\nuname -a\r\n# @wait 500\n#@type y\n#   @type   two  \nls\n\n\n";
  assert.deepEqual(parse(s), [
    { op: "line", text: "uname -a" },
    { op: "wait", ms: 500 },
    { op: "type", text: "y" },
    { op: "type", text: "  two  " },
    { op: "line", text: "ls" },
  ]);
});

test("interior blank line sends Enter", () => {
  assert.deepEqual(parse("a\n\nb"), [
    { op: "line", text: "a" },
    { op: "line", text: "" },
    { op: "line", text: "b" },
  ]);
  assert.deepEqual(parse(""), []);
  assert.deepEqual(parse("\n\n  \n"), []);
});

test("wait limits", () => {
  assert.deepEqual(parse("# @wait 3600000"), [{ op: "wait", ms: 3_600_000 }]);
  assert.throws(() => parse("# @wait 3600001"));
  assert.throws(() => parse("# @wait soon"));
  assert.throws(() => parse("# @wait -1"));
  assert.deepEqual(parse("# @waiting 5"), []);
  assert.throws(() => parse("# @type"));
});

test("control characters in lines are rejected", () => {
  assert.throws(() => parse("echo \u001b[31m"));
  assert.doesNotThrow(() => parse("a\tb"));
});

test("placeholders are unique and ordered", () => {
  assert.deepEqual(placeholders("ssh {{user}}@{{ host }}\necho {{user}} {{}} {{bad name}} {{x"), ["user", "host"]);
});

test("render substitutes in a single pass", () => {
  const steps = parse("ping {{host}}\n# @type {{host}}");
  assert.deepEqual(render(steps, { host: "10.0.0.1" }, "safe"), [
    { op: "line", text: "ping 10.0.0.1" },
    { op: "type", text: "10.0.0.1" },
  ]);
  assert.throws(() => render(steps, {}, "safe"));
  assert.deepEqual(render(parse("{{a}}"), { a: "{{a}}" }, "unrestricted"), [{ op: "line", text: "{{a}}" }]);
});

test("safe-mode validation", () => {
  assert.equal(validateInput("user@host.example:22/path,a+b-c_d", "safe"), null);
  for (const bad of ["a; rm -rf /", "$(id)", "a|b", "", "ok\n", "ünïcode"]) {
    assert.notEqual(validateInput(bad, "safe"), null, bad);
  }
});

test("unrestricted-mode validation still blocks control characters", () => {
  assert.equal(validateInput("a; echo $(id) | grep 'x'", "unrestricted"), null);
  assert.equal(validateInput("ünïcode", "unrestricted"), null);
  for (const bad of ["line\nbreak", "cr\r", "esc\u001b", "tab\t", "del\u007f", "a".repeat(MAX_INPUT_LEN + 1)]) {
    assert.notEqual(validateInput(bad, "unrestricted"), null, JSON.stringify(bad));
  }
});
