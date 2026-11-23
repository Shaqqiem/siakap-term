// Run with `npm test` (Node's built-in test runner, no extra dependencies).
// Mirrors the Rust tests in core/src/macros.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { check, fill, inputNames, parse, render, signature, validateInput, validateInputName, MAX_INPUT_LEN } from "./macros.ts";
import { TabCommandStatus } from "./status.ts";

test("parses lines, waits, types and comments", () => {
  const s = "# comment\r\nuname -a\r\n# @wait 500\n#@type y\n#   @type   two  \n\nls\n\n\n";
  assert.deepEqual(parse(s), [
    { op: "line", text: "uname -a" },
    { op: "wait", ms: 500 },
    { op: "type", text: "y" },
    { op: "type", text: "  two  " },
    { op: "line", text: "ls" },
  ]);
});

test("blank lines are skipped like the plugin", () => {
  assert.deepEqual(parse("a\n\n  \nb"), [
    { op: "line", text: "a" },
    { op: "line", text: "b" },
  ]);
  assert.deepEqual(parse(""), []);
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

test("input names allow spaces and are unique", () => {
  assert.deepEqual(inputNames("int {{Switch port}}\ndesc {{ Switch port }} {{vlan}} {{}} {{a{b}} {{x\ny}}"), ["Switch port", "vlan"]);
});

test("fill then parse", () => {
  assert.deepEqual(render("ping {{host}}\n# @wait {{delay}}\n# @type {{host}}", { host: "10.0.0.1", delay: "250" }, "safe"), [
    { op: "line", text: "ping 10.0.0.1" },
    { op: "wait", ms: 250 },
    { op: "type", text: "10.0.0.1" },
  ]);
  assert.throws(() => render("ping {{host}}", {}, "safe"), /host/);
  assert.equal(fill("{{a}}", { a: "{{a}}" }), "{{a}}");
  assert.doesNotThrow(() => check("# @wait {{delay}}\nshow {{x}}"));
  assert.throws(() => check("# @wait soon"));
});

test("safe-mode validation", () => {
  assert.equal(validateInput("user@host.example:22/path,a+b-c_d", "safe"), null);
  for (const bad of ["a; rm -rf /", "$(id)", "a|b", "", "   ", "ok\n", "ünïcode"]) {
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

test("input name rules", () => {
  assert.equal(validateInputName(" Switch port "), null);
  assert.notEqual(validateInputName(""), null);
  assert.notEqual(validateInputName("a{b"), null);
  assert.notEqual(validateInputName("x".repeat(81)), null);
});

test("signature matches plugin rules", () => {
  assert.equal(signature("NCP/NV", "show  int {{port}}\r\n"), "ncp/nv|show int {{input}}");
  assert.equal(signature("", "show int {{a}}"), signature("", "SHOW INT {{other}}"));
  assert.notEqual(signature("a", "ls"), signature("b", "ls"));
});

test("tab status: shell markers", () => {
  const states: string[] = [];
  const t = new TabCommandStatus((s) => states.push(s));
  t.output("\x1b]133;C\x07output\r\n\x1b]133;D;0\x07");
  assert.equal(t.state, "success");
  t.output("\x1b]133;C\x07\x1b]633;D;2\x1b\\");
  assert.equal(t.state, "error");
});

test("tab status: prompt and error text fallback", () => {
  const t = new TabCommandStatus(() => {});
  t.input("show ip int brief\r");
  assert.equal(t.state, "running");
  t.output("Interface  Status\r\nVlan1 up\r\nswitch# ");
  assert.equal(t.state, "success");
  t.input("\r");
  t.output("% Invalid input detected at '^' marker.\r\nswitch# ");
  assert.equal(t.state, "error");
  t.input("\r");
  t.output("bash: foo: command not found\r\nuser@host:~$ ");
  assert.equal(t.state, "error");
  const off = new TabCommandStatus(() => {}, false);
  off.input("ls\r");
  assert.equal(off.state, "idle");
});
