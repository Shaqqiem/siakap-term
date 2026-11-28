// Port-forward rows in the session editor, and their checks (unit-tested).
import type { Forward, ForwardKind } from "./api";

const HOST_RE = /^[A-Za-z0-9._:%[\]-]{1,253}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Problem with one forward, or null. Mirrors the backend's checks. */
export function checkForward(f: Forward): string | null {
  const bind = f.bindHost.trim() || "127.0.0.1";
  if (!HOST_RE.test(bind)) return `"${bind}" is not a valid listen address.`;
  if (!Number.isInteger(f.bindPort) || f.bindPort < 1 || f.bindPort > 65535) return "The listen port must be 1-65535.";
  if (f.kind === "dynamic") return null;
  if (!HOST_RE.test(f.destHost.trim())) return f.destHost.trim() ? `"${f.destHost.trim()}" is not a valid host.` : "Enter where the forward goes (host).";
  if (!Number.isInteger(f.destPort) || f.destPort < 1 || f.destPort > 65535) return "The destination port must be 1-65535.";
  return null;
}

export function isPublic(f: Forward): boolean {
  return !LOOPBACK.has((f.bindHost.trim() || "127.0.0.1").toLowerCase());
}

/** "-L 127.0.0.1:8080 → db:5432", the same wording the backend reports. */
export function describeForward(f: Forward): string {
  const b = `${f.bindHost.trim() || "127.0.0.1"}:${f.bindPort}`;
  if (f.kind === "dynamic") return `-D SOCKS ${b}`;
  const d = `${f.destHost.trim()}:${f.destPort}`;
  return f.kind === "remote" ? `-R server ${b} → ${d}` : `-L ${b} → ${d}`;
}

/**
 * OpenSSH-style shorthand, e.g. "-L 8080:db:5432", "R 0.0.0.0:9000:localhost:3000",
 * "D 1080". Returns null if it doesn't parse.
 */
export function parseForwardSpec(text: string): Forward | null {
  const m = /^\s*-?([LRD])\s*(.+?)\s*$/i.exec(text);
  if (!m) return null;
  const kind: ForwardKind = ({ l: "local", r: "remote", d: "dynamic" } as const)[m[1].toLowerCase() as "l" | "r" | "d"];
  // Split on ":" but keep [IPv6] brackets together.
  const parts = m[2].match(/\[[^\]]*\]|[^:]+/g) ?? [];
  const num = (x: string | undefined) => (x !== undefined && /^\d+$/.test(x) ? Number(x) : NaN);
  let f: Forward;
  if (kind === "dynamic") {
    if (parts.length === 1) f = { kind, bindHost: "127.0.0.1", bindPort: num(parts[0]), destHost: "", destPort: 0, enabled: true };
    else if (parts.length === 2) f = { kind, bindHost: parts[0], bindPort: num(parts[1]), destHost: "", destPort: 0, enabled: true };
    else return null;
  } else if (parts.length === 3) {
    f = { kind, bindHost: "127.0.0.1", bindPort: num(parts[0]), destHost: parts[1], destPort: num(parts[2]), enabled: true };
  } else if (parts.length === 4) {
    f = { kind, bindHost: parts[0], bindPort: num(parts[1]), destHost: parts[2], destPort: num(parts[3]), enabled: true };
  } else return null;
  return checkForward(f) ? null : f;
}
