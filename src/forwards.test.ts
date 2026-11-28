import { test } from "node:test";
import assert from "node:assert/strict";
import { checkForward, describeForward, isPublic, parseForwardSpec } from "./forwards.ts";

test("OpenSSH shorthand parses", () => {
  assert.deepEqual(parseForwardSpec("-L 8080:db.internal:5432"), { kind: "local", bindHost: "127.0.0.1", bindPort: 8080, destHost: "db.internal", destPort: 5432, enabled: true });
  assert.deepEqual(parseForwardSpec("R 0.0.0.0:9000:localhost:3000")?.bindHost, "0.0.0.0");
  assert.equal(parseForwardSpec("D 1080")?.kind, "dynamic");
  assert.equal(parseForwardSpec("-L [::1]:8080:[fe80::1]:22")?.destHost, "[fe80::1]");
  for (const bad of ["", "X 1:2:3", "-L 8080", "-L 99999:a:1", "-L 80:a b:1", "-L 80:a:0", "D a:b:c"]) assert.equal(parseForwardSpec(bad), null, bad);
});

test("checks and descriptions match the backend", () => {
  const f = { kind: "local" as const, bindHost: "", bindPort: 8080, destHost: "db", destPort: 5432, enabled: true };
  assert.equal(checkForward(f), null);
  assert.equal(describeForward(f), "-L 127.0.0.1:8080 → db:5432");
  assert.equal(isPublic(f), false);
  assert.equal(isPublic({ ...f, bindHost: "0.0.0.0" }), true);
  assert.match(checkForward({ ...f, destHost: "" }) ?? "", /Enter where/);
  assert.match(checkForward({ ...f, bindPort: 0 }) ?? "", /listen port/);
  assert.equal(checkForward({ ...f, kind: "dynamic", destHost: "", destPort: 0 }), null);
  assert.equal(describeForward({ ...f, kind: "remote" }), "-R server 127.0.0.1:8080 → db:5432");
});
