// Tabs, each holding a binary split tree of terminal panes.
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { api, b64ToBytes, Channel, errorOf, type RedactedSession, type Settings, type TermOut } from "./api";
import { $, alertDialog, confirmDialog, h, modal, promptDialog, toast } from "./ui";

export type PaneStatus = "connecting" | "connected" | "closed";

export interface Pane {
  uid: number;
  termId: number | null;
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
  kind: "local" | "ssh";
  title: string;
  shellId?: string;
  session?: RedactedSession;
  status: PaneStatus;
  tab: Tab;
  disposed: boolean;
  /** Input typed before the backend returned the terminal id. */
  pending: string[];
}

type SplitNode = { type: "leaf"; pane: Pane } | { type: "split"; dir: "h" | "v"; ratio: number; a: SplitNode; b: SplitNode };

export interface Tab {
  uid: number;
  root: SplitNode;
  focused: Pane;
  el: HTMLElement;
  tabEl: HTMLElement;
}

type Listener<T> = (v: T) => void;

let uidSeq = 1;

function panesOf(n: SplitNode): Pane[] {
  return n.type === "leaf" ? [n.pane] : [...panesOf(n.a), ...panesOf(n.b)];
}

export class TabManager {
  tabs: Tab[] = [];
  active: Tab | null = null;
  settings!: Settings;
  private focusListeners: Listener<Pane | null>[] = [];
  private closeListeners: Listener<Pane>[] = [];
  onConnected: (pane: Pane) => void = () => {};

  constructor(private workspace = $("workspace"), private tabbar = $("tabs")) {}

  onFocus(l: Listener<Pane | null>) {
    this.focusListeners.push(l);
  }
  onPaneClosed(l: Listener<Pane>) {
    this.closeListeners.push(l);
  }
  get focusedPane(): Pane | null {
    return this.active?.focused ?? null;
  }
  allPanes(): Pane[] {
    return this.tabs.flatMap((t) => panesOf(t.root));
  }

  private emitFocus() {
    const p = this.focusedPane;
    this.focusListeners.forEach((l) => l(p));
  }

  theme(): ITheme {
    const s = this.settings;
    return { background: s.background, foreground: s.foreground, cursor: s.cursor, cursorAccent: s.background, selectionBackground: s.selection };
  }

  applySettings(s: Settings) {
    this.settings = s;
    for (const p of this.allPanes()) {
      p.term.options.fontFamily = s.fontFamily;
      p.term.options.fontSize = s.fontSize;
      p.term.options.scrollback = s.scrollback;
      p.term.options.theme = this.theme();
      this.refit(p);
    }
  }

  // ------------------------------------------------------------ pane creation

  private makePane(kind: "local" | "ssh", title: string, tab: Tab | null): Pane {
    const s = this.settings;
    const term = new Terminal({
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      scrollback: s.scrollback,
      theme: this.theme(),
      cursorBlink: true,
      allowProposedApi: false,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const el = h("div", { class: "pane" });
    const pane: Pane = { uid: uidSeq++, termId: null, term, fit, el, kind, title, status: "connecting", tab: tab as Tab, disposed: false, pending: [] };

    term.open(el);
    term.attachCustomKeyEventHandler((e) => this.keyHandler(pane, e));
    term.onData((d) => {
      if (pane.termId !== null && pane.status === "connected") {
        api.termWrite(pane.termId, d).catch(() => {});
      } else if (pane.status === "connecting") {
        // Output can arrive before the open call returns; keep keystrokes.
        if (pane.pending.length < 256) pane.pending.push(d);
      } else if (pane.status === "closed" && d === "\r") {
        this.closePane(pane);
      }
    });
    term.onSelectionChange(() => {
      if (this.settings.copyOnSelect && term.hasSelection()) navigator.clipboard.writeText(term.getSelection()).catch(() => {});
    });
    // Paste protection: intercept the browser paste before xterm sees it.
    el.addEventListener(
      "paste",
      (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        const text = e.clipboardData?.getData("text/plain") ?? "";
        void this.guardedPaste(pane, text);
      },
      true,
    );
    el.addEventListener("focusin", () => this.focus(pane));
    el.addEventListener("mousedown", () => this.focus(pane));
    new ResizeObserver(() => this.refit(pane)).observe(el);
    return pane;
  }

  private keyHandler(pane: Pane, e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    const ctrlShift = e.ctrlKey && e.shiftKey && !e.altKey;
    if (ctrlShift && e.code === "KeyC") {
      if (pane.term.hasSelection()) navigator.clipboard.writeText(pane.term.getSelection()).catch(() => {});
      e.preventDefault();
      return false;
    }
    if (ctrlShift && e.code === "KeyV") {
      e.preventDefault();
      navigator.clipboard.readText().then((t) => this.guardedPaste(pane, t), () => toast("Clipboard is not available.", "error"));
      return false;
    }
    // Let app shortcuts bubble to the window handler.
    if (ctrlShift && ["KeyT", "KeyD", "KeyE", "KeyW"].includes(e.code)) return false;
    if (e.ctrlKey && e.code === "Tab") return false;
    return true;
  }

  async guardedPaste(pane: Pane, text: string) {
    if (!text || pane.status === "closed") return;
    if (this.settings.confirmMultilinePaste && /[\r\n]/.test(text)) {
      const lines = text.split(/\r\n|\r|\n/);
      const preview = h("pre", { class: "paste-preview" }, lines.slice(0, 30).join("\n") + (lines.length > 30 ? `\n… (${lines.length - 30} more lines)` : ""));
      const ok = await confirmDialog(
        "Paste multiple lines?",
        h("div", {}, h("p", {}, `The clipboard contains ${lines.length} lines. Each line break may run a command.`), preview),
        "Paste",
        { danger: true },
      );
      if (!ok) return;
    }
    pane.term.paste(text);
    pane.term.focus();
  }

  private refit(p: Pane) {
    if (p.disposed || !p.el.isConnected || p.el.clientWidth === 0) return;
    const before = [p.term.cols, p.term.rows];
    try {
      p.fit.fit();
    } catch {
      return;
    }
    if (p.termId !== null && (before[0] !== p.term.cols || before[1] !== p.term.rows)) {
      api.termResize(p.termId, p.term.cols, p.term.rows).catch(() => {});
    }
  }

  private wireChannel(pane: Pane): Channel<TermOut> {
    const ch = new Channel<TermOut>();
    ch.onmessage = (m) => {
      if (pane.disposed) return;
      if (m.kind === "data") pane.term.write(b64ToBytes(m.b64));
      else {
        pane.status = "closed";
        pane.term.write(`\r\n\x1b[2m[${pane.kind === "ssh" ? "connection closed" : "process exited"}${m.code !== null ? ` with code ${m.code}` : ""} — press Enter to close]\x1b[0m\r\n`);
        this.renderTabs();
        this.closeListeners.forEach((l) => l(pane));
      }
    };
    return ch;
  }

  // ------------------------------------------------------------ open

  async openLocal(shellId: string, label: string, where: "tab" | "h" | "v" = "tab") {
    const pane = this.place(this.makePane("local", label, null), where);
    pane.shellId = shellId;
    try {
      pane.termId = await api.termOpenLocal(shellId, pane.term.cols, pane.term.rows, this.wireChannel(pane));
      this.markConnected(pane);
    } catch (e) {
      this.failPane(pane, errorOf(e).message);
    }
  }

  async openSsh(session: RedactedSession, where: "tab" | "h" | "v" = "tab") {
    const pane = this.place(this.makePane("ssh", session.name, null), where);
    pane.session = session;
    pane.term.write(`\x1b[2mConnecting to ${session.user}@${session.host}:${session.port}…\x1b[0m\r\n`);
    let password: string | undefined;
    let passphrase: string | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        pane.termId = await api.termOpenSsh(session.id, pane.term.cols, pane.term.rows, this.wireChannel(pane), password, passphrase);
        password = passphrase = undefined;
        this.markConnected(pane);
        return;
      } catch (raw) {
        const e = errorOf(raw);
        if (pane.disposed) return;
        if (e.kind === "hostKeyUnknown") {
          if (await this.askTrust(e.host!, e.port!, e.keyType!, e.fingerprint!)) {
            try {
              await api.trustHostKey(e.host!, e.port!, e.fingerprint!, e.publicKey!);
              continue;
            } catch (e2) {
              this.failPane(pane, errorOf(e2).message);
              return;
            }
          }
          this.failPane(pane, "Host key not trusted; connection aborted.");
          return;
        }
        if (e.kind === "hostKeyChanged") {
          this.failPane(pane, e.message, true);
          await modal<void>(
            "⚠ HOST KEY CHANGED — possible attack",
            (close) => ({
              body: h(
                "div",
                {},
                h("p", { class: "pre" }, e.message),
                h("dl", { class: "kv" }, h("dt", {}, "Stored"), h("dd", { class: "mono" }, e.knownFingerprint ?? ""), h("dt", {}, "Presented"), h("dd", { class: "mono" }, `${e.fingerprint} (${e.keyType})`)),
              ),
              actions: [h("button", { class: "danger", onclick: () => close() }, "Close")],
            }),
            { danger: true },
          );
          return;
        }
        if (e.kind === "passwordRequired") {
          const pw = await promptDialog("Password", e.message, { password: true });
          if (pw === null) return this.failPane(pane, "Cancelled.");
          password = pw;
          continue;
        }
        if (e.kind === "passphraseRequired") {
          const pp = await promptDialog("Key passphrase", `Passphrase for ${session.keyPath}`, { password: true });
          if (pp === null) return this.failPane(pane, "Cancelled.");
          passphrase = pp;
          continue;
        }
        if (e.kind === "auth" && password !== undefined) {
          toast(e.message, "error");
          const pw = await promptDialog("Password", `Password for ${session.user}@${session.host} (try again)`, { password: true });
          if (pw === null) return this.failPane(pane, "Cancelled.");
          password = pw;
          continue;
        }
        this.failPane(pane, e.message);
        return;
      }
    }
    this.failPane(pane, "Too many attempts.");
  }

  private askTrust(host: string, port: number, keyType: string, fp: string): Promise<boolean> {
    return modal<boolean>(
      "Unknown host key",
      (close) => ({
        body: h(
          "div",
          {},
          h("p", {}, `The authenticity of ${host}:${port} can't be established. This is the first time you connect to it.`),
          h("dl", { class: "kv" }, h("dt", {}, "Key type"), h("dd", {}, keyType), h("dt", {}, "Fingerprint"), h("dd", { class: "mono" }, fp)),
          h("p", { class: "muted" }, "Compare the fingerprint with the one the server's administrator gave you (e.g. `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). Trust it only if they match."),
        ),
        actions: [h("button", { onclick: () => close(false) }, "Cancel"), h("button", { class: "primary", onclick: () => close(true) }, "Trust and connect")],
      }),
      { dismissValue: false },
    );
  }

  private markConnected(pane: Pane) {
    pane.status = "connected";
    const queued = pane.pending.join("");
    pane.pending = [];
    if (queued && pane.termId !== null) api.termWrite(pane.termId, queued).catch(() => {});
    this.refit(pane);
    this.renderTabs();
    this.onConnected(pane);
  }

  private failPane(pane: Pane, msg: string, danger = false) {
    pane.status = "closed";
    pane.pending = [];
    pane.term.write(`\r\n\x1b[${danger ? "1;31" : "31"}m${msg.replace(/\n/g, "\r\n")}\x1b[0m\r\n\x1b[2m[press Enter to close]\x1b[0m\r\n`);
    this.renderTabs();
  }

  // ------------------------------------------------------------ layout

  private place(pane: Pane, where: "tab" | "h" | "v"): Pane {
    const target = this.focusedPane;
    if (where === "tab" || !target) {
      const tab: Tab = {
        uid: uidSeq++,
        root: { type: "leaf", pane },
        focused: pane,
        el: h("div", { class: "tab-content" }),
        tabEl: h("div", { class: "tab" }),
      };
      pane.tab = tab;
      this.tabs.push(tab);
      this.workspace.append(tab.el);
      this.activate(tab);
    } else {
      const tab = target.tab;
      pane.tab = tab;
      const replace = (n: SplitNode): SplitNode => {
        if (n.type === "leaf") return n.pane === target ? { type: "split", dir: where, ratio: 0.5, a: n, b: { type: "leaf", pane } } : n;
        return { ...n, a: replace(n.a), b: replace(n.b) };
      };
      tab.root = replace(tab.root);
      tab.focused = pane;
      this.renderTab(tab);
    }
    this.renderTabs();
    requestAnimationFrame(() => {
      this.refit(pane);
      pane.term.focus();
    });
    return pane;
  }

  splitFocused(dir: "h" | "v") {
    const p = this.focusedPane;
    if (!p) return;
    if (p.kind === "ssh" && p.session) void this.openSsh(p.session, dir);
    else void this.openLocal(p.shellId ?? "", p.title, dir);
  }

  focus(pane: Pane) {
    if (pane.disposed) return;
    const changed = this.active !== pane.tab || pane.tab.focused !== pane;
    pane.tab.focused = pane;
    if (this.active !== pane.tab) this.activate(pane.tab);
    pane.tab.el.querySelectorAll(".pane").forEach((el) => el.classList.toggle("focused", el === pane.el));
    if (changed) {
      this.renderTabs();
      this.emitFocus();
    }
  }

  activate(tab: Tab) {
    this.active = tab;
    for (const t of this.tabs) t.el.classList.toggle("hidden", t !== tab);
    $("empty").classList.toggle("hidden", this.tabs.length > 0);
    this.renderTab(tab);
    this.renderTabs();
    requestAnimationFrame(() => tab.focused.term.focus());
    this.emitFocus();
  }

  cycle(delta: number) {
    if (!this.active || this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(i + delta + this.tabs.length) % this.tabs.length]);
  }

  async closePane(pane: Pane) {
    if (pane.disposed) return;
    pane.disposed = true;
    if (pane.termId !== null) api.termClose(pane.termId).catch(() => {});
    pane.status = "closed";
    this.closeListeners.forEach((l) => l(pane));
    pane.term.dispose();
    pane.el.remove();
    const tab = pane.tab;
    const remove = (n: SplitNode): SplitNode | null => {
      if (n.type === "leaf") return n.pane === pane ? null : n;
      const a = remove(n.a);
      const b = remove(n.b);
      if (!a) return b;
      if (!b) return a;
      return { ...n, a, b };
    };
    const root = remove(tab.root);
    if (!root) {
      this.tabs = this.tabs.filter((t) => t !== tab);
      tab.el.remove();
      if (this.active === tab) {
        this.active = null;
        if (this.tabs.length) this.activate(this.tabs[this.tabs.length - 1]);
        else {
          $("empty").classList.remove("hidden");
          this.emitFocus();
        }
      }
      this.renderTabs();
      return;
    }
    tab.root = root;
    const first = (n: SplitNode): Pane => (n.type === "leaf" ? n.pane : first(n.a));
    if (tab.focused === pane) tab.focused = first(root);
    this.renderTab(tab);
    this.renderTabs();
    if (this.active === tab) {
      this.emitFocus();
      requestAnimationFrame(() => tab.focused.term.focus());
    }
  }

  async closeTab(tab: Tab) {
    const panes = panesOf(tab.root);
    const live = panes.filter((p) => p.status === "connected").length;
    if (live > 1 && !(await confirmDialog("Close tab?", `This tab has ${live} open sessions.`, "Close all"))) return;
    for (const p of panes) await this.closePane(p);
  }

  async closeAll() {
    for (const p of this.allPanes()) await this.closePane(p);
  }

  private renderTab(tab: Tab) {
    const build = (n: SplitNode): HTMLElement => {
      if (n.type === "leaf") {
        n.pane.el.classList.toggle("focused", n.pane === tab.focused);
        return n.pane.el;
      }
      const a = build(n.a);
      const b = build(n.b);
      const wrapA = h("div", { class: "split-child" });
      const wrapB = h("div", { class: "split-child" });
      wrapA.append(a);
      wrapB.append(b);
      wrapA.style.flex = `${n.ratio} 1 0`;
      wrapB.style.flex = `${1 - n.ratio} 1 0`;
      const div = h("div", { class: `divider ${n.dir}` });
      const box = h("div", { class: `split ${n.dir}` }, wrapA, div, wrapB);
      div.addEventListener("pointerdown", (e) => {
        div.setPointerCapture(e.pointerId);
        const rect = box.getBoundingClientRect();
        const move = (ev: PointerEvent) => {
          const r = n.dir === "h" ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
          n.ratio = Math.min(0.9, Math.max(0.1, r));
          wrapA.style.flex = `${n.ratio} 1 0`;
          wrapB.style.flex = `${1 - n.ratio} 1 0`;
        };
        const up = () => {
          div.removeEventListener("pointermove", move);
          div.removeEventListener("pointerup", up);
        };
        div.addEventListener("pointermove", move);
        div.addEventListener("pointerup", up);
      });
      return box;
    };
    tab.el.replaceChildren(build(tab.root));
  }

  renderTabs() {
    this.tabbar.replaceChildren(
      ...this.tabs.map((t) => {
        const panes = panesOf(t.root);
        const status: PaneStatus = panes.some((p) => p.status === "connected")
          ? "connected"
          : panes.some((p) => p.status === "connecting")
            ? "connecting"
            : "closed";
        const label = t.focused.title + (panes.length > 1 ? ` (${panes.length})` : "");
        const el = h(
          "div",
          { class: `tab${t === this.active ? " active" : ""}`, title: label, onclick: () => this.activate(t) },
          h("span", { class: `dot ${status}` }),
          h("span", { class: "tab-title" }, label),
          h("button", {
            class: "tab-close",
            title: "Close tab",
            onclick: (e: Event) => {
              e.stopPropagation();
              void this.closeTab(t);
            },
          }, "×"),
        );
        el.addEventListener("auxclick", (e) => {
          if ((e as MouseEvent).button === 1) void this.closeTab(t);
        });
        t.tabEl = el;
        return el;
      }),
    );
  }
}

export async function chooseShell(): Promise<{ id: string; label: string } | null> {
  const shells = await api.shellsList();
  if (!shells.length) {
    await alertDialog("No shells", "No local shell was found.");
    return null;
  }
  return shells[0];
}
