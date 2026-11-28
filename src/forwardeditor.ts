// Port-forward rows for the session editor.
import type { Forward, ForwardKind } from "./api";
import { checkForward, describeForward, isPublic, parseForwardSpec } from "./forwards";
import { icon } from "./icons";
import { h, select } from "./ui";

const MAX = 32;

export function forwardEditor(initial: Forward[]): { el: HTMLElement; read: () => Forward[] | string } {
  const list = h("div", { class: "fwd-list" });
  const rows: { el: HTMLElement; get: () => Forward }[] = [];

  const add = (f: Forward) => {
    if (rows.length >= MAX) return;
    const kind = select(
      [
        ["local", "Local -L"],
        ["remote", "Remote -R"],
        ["dynamic", "SOCKS -D"],
      ],
      f.kind,
    );
    const bindHost = h("input", { value: f.bindHost || "127.0.0.1", spellcheck: "false", class: "mono", title: "Listen address", "aria-label": "Listen address" });
    const bindPort = h("input", { type: "number", min: 1, max: 65535, value: f.bindPort || "", placeholder: "port", class: "mono", "aria-label": "Listen port" });
    const destHost = h("input", { value: f.destHost, spellcheck: "false", placeholder: "host", class: "mono", "aria-label": "Destination host" });
    const destPort = h("input", { type: "number", min: 1, max: 65535, value: f.destPort || "", placeholder: "port", class: "mono", "aria-label": "Destination port" });
    const on = h("input", { type: "checkbox", checked: f.enabled !== false, title: "Start this forward when connecting" });
    const note = h("small", { class: "muted fwd-note" });
    const get = (): Forward => ({
      kind: kind.value as ForwardKind,
      bindHost: bindHost.value.trim() || "127.0.0.1",
      bindPort: Number(bindPort.value),
      destHost: destHost.value.trim(),
      destPort: Number(destPort.value),
      enabled: on.checked,
    });
    const arrow = h("span", { class: "muted" }, "→");
    const sync = () => {
      const dyn = kind.value === "dynamic";
      destHost.classList.toggle("invisible", dyn);
      destPort.classList.toggle("invisible", dyn);
      arrow.classList.toggle("invisible", dyn);
      const g = get();
      const where = g.kind === "remote" ? "on the server" : "on this computer";
      const what =
        g.kind === "dynamic"
          ? `A SOCKS5 proxy ${where}; the server makes the connections.`
          : g.kind === "remote"
            ? `Connections to the server's port reach ${g.destHost || "host"}:${g.destPort || "port"} from this computer.`
            : `Connections to this port reach ${g.destHost || "host"}:${g.destPort || "port"} from the server.`;
      note.textContent = what + (isPublic(g) ? ` Listens on ${g.bindHost}: other machines can use it too.` : "");
      note.classList.toggle("warn", isPublic(g));
    };
    for (const i of [kind, bindHost, bindPort, destHost, destPort]) i.addEventListener("input", sync);
    kind.addEventListener("change", sync);
    const row = h(
      "div",
      { class: "fwd-row" },
      on,
      kind,
      bindHost,
      bindPort,
      arrow,
      destHost,
      destPort,
      h("button", { type: "button", class: "icon", title: "Remove", onclick: () => (row.remove(), rows.splice(rows.findIndex((r) => r.el === row), 1)) }, icon("x", 14)),
      note,
    );
    rows.push({ el: row, get });
    list.append(row);
    sync();
  };
  for (const f of initial) add(f);

  const spec = h("input", { spellcheck: "false", class: "mono", placeholder: "Quick add, e.g. -L 8080:localhost:80 or -D 1080", "aria-label": "Quick add forward" });
  const specErr = h("small", { class: "error" });
  const addSpec = () => {
    const t = spec.value.trim();
    if (!t) return add({ kind: "local", bindHost: "127.0.0.1", bindPort: 0, destHost: "", destPort: 0, enabled: true });
    const f = parseForwardSpec(t);
    if (!f) return void (specErr.textContent = "Use -L port:host:port, -R port:host:port or -D port (an address may go first).");
    specErr.textContent = "";
    spec.value = "";
    add(f);
  };
  spec.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addSpec();
    }
  });
  const el = h(
    "div",
    { class: "fwd" },
    list,
    h("div", { class: "inline" }, spec, h("button", { type: "button", onclick: addSpec }, "Add forward")),
    specErr,
  );
  const read = (): Forward[] | string => {
    const out = rows.map((r) => r.get());
    for (const f of out) {
      const e = checkForward(f);
      if (e) return `Port forward ${describeForward(f)}: ${e}`;
    }
    return out;
  };
  return { el, read };
}
