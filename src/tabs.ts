// Tabs, each holding a binary split tree of terminal panes.
import { icon } from "./icons";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { api, b64ToBytes, Channel, errorOf, messageOf, type RedactedSession, type SerialConfig, type Settings, type TermOut } from "./api";
import { serialSummary } from "./serial";
import { aggregate, TabCommandStatus } from "./status";
import { $, alertDialog, confirmDialog, h, modal, promptDialog, showMenu, toast, type MenuEntry } from "./ui";

export type PaneStatus = "connecting" | "connected" | "closed";

export interface Pane {
  uid: number;
  termId: number | null;
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
  kind: "local" | "ssh" | "serial";
  title: string;
  shellId?: string;
  session?: RedactedSession;
  serial?: SerialConfig;
  status: PaneStatus;
  tab: Tab;
  disposed: boolean;
  /** Command status for the tab dot (null when switched off). */
  cmd: TabCommandStatus | null;
  /** Last ~4 KB of output with escape codes removed (used to spot a prompt). */
  tail: string;
  decoder: TextDecoder;
  /** Input typed before the backend returned the terminal id. */
  pending: string[];
  /** Reconnect in place after the connection ended (R key). */
  reconnect?: () => void;
  /** Size last given to the shell or server ("cols x rows"). */
  sentSize?: string;
}

/** Turn low-level errors into something a non-technical colleague can act on. */
export function friendlyError(kind: Pane["kind"], raw: string, target = ""): string {
  const m = raw.toLowerCase();
  const has = (...xs: string[]) => xs.some((x) => m.includes(x));
  let nice = "";
  if (kind === "serial") {
    if (has("in use", "access is denied", "busy")) nice = `${target} is already open in another program (PuTTY, MobaXterm or another tab). Close it there and try again.`;
    else if (has("not find", "no such file", "not found", "os error 2")) nice = `${target} isn't there. Check the console cable is plugged in, or pick a different port.`;
  } else if (has("refused", "os error 111", "10061")) nice = `${target} refused the connection. Check the address and port, and that the server is running SSH.`;
  else if (has("timed out", "timeout", "10060")) nice = `${target} didn't answer. Check the address, your network or VPN, and that the device is switched on.`;
  else if (has("lookup", "no such host", "name or service not known", "11001", "nodename nor servname")) nice = `Couldn't find a server called ${target}. Check the spelling of the address.`;
  else if (has("unreachable", "10051", "10065")) nice = `This PC can't reach ${target}. Are you connected to the right network or VPN?`;
  else if (has("authentication failed", "password was rejected")) nice = "Sign-in failed: wrong username or password, or the server doesn't accept this sign-in method.";
  else if (has("reset by peer", "10054", "broken pipe")) nice = `The connection to ${target} was dropped.`;
  return nice ? `${nice}\n(Details: ${raw})` : raw;
}

type SplitNode = { type: "leaf"; pane: Pane } | { type: "split"; dir: "h" | "v"; ratio: number; a: SplitNode; b: SplitNode };

export interface Tab {
  uid: number;
  root: SplitNode;
  focused: Pane;
  el: HTMLElement;
  tabEl: HTMLElement;
  /** Name set with "Rename tab" (otherwise the focused pane's title). */
  customTitle?: string;
}

/** Most panes one tab can hold. */
export const MAX_PANES = 4;

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
      if (!s.tabStatus) p.cmd = null;
      else if (!p.cmd) this.attachStatus(p);
      else p.cmd.fallback = s.tabStatusFallback;
      p.term.options.fontFamily = s.fontFamily;
      p.term.options.fontSize = s.fontSize;
      p.term.options.scrollback = s.scrollback;
      p.term.options.theme = this.theme();
      this.refit(p);
    }
  }

  // ------------------------------------------------------------ command status & prompts

  private promptWaiters = new Map<Pane, () => void>();
  private clearTimers = new Map<Pane, number>();

  private attachStatus(pane: Pane) {
    if (!this.settings?.tabStatus) return;
    pane.cmd = new TabCommandStatus((state) => {
      // On the tab you're looking at, show the result briefly; background tabs keep it until opened.
      if ((state === "success" || state === "error") && this.active === pane.tab) {
        window.clearTimeout(this.clearTimers.get(pane));
        this.clearTimers.set(pane, window.setTimeout(() => pane.cmd?.clearNotification(), 4000));
      }
      this.scheduleTabs();
    }, this.settings.tabStatusFallback);
  }

  /** Called for text a macro sends, so the tab dot also tracks macro commands. */
  noteInput(pane: Pane, text: string) {
    pane.cmd?.input(text);
  }

  private observeOutput(pane: Pane, text: string) {
    if (!text) return;
    pane.cmd?.output(text);
    // eslint-disable-next-line no-control-regex
    const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
    pane.tail = (pane.tail + clean).slice(-4096);
    this.promptWaiters.get(pane)?.();
  }

  /** Resolve true once the pane shows a ready prompt ($ # > % ❯), false on timeout or close. */
  waitForPrompt(pane: Pane, timeoutMs: number): Promise<boolean> {
    const ready = () => /[$#>%❯]\s*$/.test(pane.tail);
    if (ready()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v: boolean) => {
        window.clearTimeout(timer);
        window.clearInterval(poll);
        this.promptWaiters.delete(pane);
        resolve(v);
      };
      const timer = window.setTimeout(() => done(false), timeoutMs);
      const poll = window.setInterval(() => (pane.disposed || pane.status === "closed") && done(false), 250);
      this.promptWaiters.set(pane, () => ready() && done(true));
    });
  }

  private tabsTimer: number | null = null;
  private scheduleTabs() {
    if (this.tabsTimer !== null) return;
    this.tabsTimer = window.setTimeout(() => {
      this.tabsTimer = null;
      this.renderTabs();
    }, 40);
  }

  // ------------------------------------------------------------ pane creation

  private makePane(kind: Pane["kind"], title: string, tab: Tab | null): Pane {
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
      // Links printed by a program or server (OSC 8) are never opened: Siakap
      // makes no web requests. Show the address so it can be copied instead.
      linkHandler: { activate: (_e: MouseEvent, uri: string) => void showLink(uri), allowNonHttpProtocols: false },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const el = h("div", { class: "pane" });
    const pane: Pane = { uid: uidSeq++, termId: null, term, fit, el, kind, title, status: "connecting", tab: tab as Tab, disposed: false, pending: [], cmd: null, tail: "", decoder: new TextDecoder() };
    this.attachStatus(pane);

    term.open(el);
    term.attachCustomKeyEventHandler((e) => this.keyHandler(pane, e));
    term.onData((d) => {
      if (pane.termId !== null && pane.status === "connected") {
        api.termWrite(pane.termId, d).catch(() => {});
        pane.cmd?.input(d);
      } else if (pane.status === "connecting") {
        // Output can arrive before the open call returns; keep keystrokes.
        if (pane.pending.length < 256) pane.pending.push(d);
      } else if (pane.status === "closed" && d === "\r") {
        this.closePane(pane);
      } else if (pane.status === "closed" && (d === "r" || d === "R") && pane.reconnect) {
        this.reconnectPane(pane);
      }
    });
    term.onSelectionChange(() => {
      if (this.settings.copyOnSelect && term.hasSelection()) api.clipboardWrite(term.getSelection()).catch(() => {});
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
    el.addEventListener("contextmenu", (e) => this.paneMenu(pane, e), true);
    const closeBtn = h("button", { class: "pane-close", title: "Close this pane (Ctrl+Shift+W)" }, icon("x", 13));
    closeBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.closePane(pane);
    });
    el.append(closeBtn);
    new ResizeObserver(() => this.refit(pane)).observe(el);
    return pane;
  }

  /** Right-click inside a terminal. */
  private paneMenu(pane: Pane, e: MouseEvent) {
    const sel = pane.term.hasSelection() ? pane.term.getSelection() : "";
    if (this.settings?.rightClickPaste && !e.shiftKey) {
      // Like Windows Terminal and PuTTY: copy a selection, otherwise paste.
      e.preventDefault();
      e.stopPropagation();
      this.focus(pane);
      if (sel) {
        void api.clipboardWrite(sel).then(() => toast("Copied.", "ok", 1200), () => toast("Clipboard is not available.", "error"));
        pane.term.clearSelection();
      } else if (pane.status !== "closed") {
        api.clipboardRead().then((t) => this.guardedPaste(pane, t), () => toast("Clipboard is not available.", "error"));
      }
      return;
    }
    const count = panesOf(pane.tab.root).length;
    const canSplit = pane.kind !== "serial" && count < MAX_PANES;
    const entries: MenuEntry[] = [
      { label: "Copy", disabled: !sel, action: () => api.clipboardWrite(sel) },
      {
        label: "Paste",
        disabled: pane.status === "closed",
        action: () => api.clipboardRead().then((t) => this.guardedPaste(pane, t), () => toast("Clipboard is not available.", "error")),
      },
      { label: "Select all", action: () => pane.term.selectAll() },
      { label: "Clear screen", action: () => pane.term.clear() },
      { label: "Split side by side", disabled: !canSplit, action: () => (this.focus(pane), this.splitFocused("h")) },
      { label: "Split top and bottom", disabled: !canSplit, action: () => (this.focus(pane), this.splitFocused("v")) },
      ...(pane.status === "closed" && pane.reconnect ? [{ label: "Reconnect", action: () => this.reconnectPane(pane) }] : []),
      count > 1
        ? { label: "Close this pane", danger: true, action: () => this.closePane(pane) }
        : { label: "Close tab", danger: true, action: () => this.closeTab(pane.tab) },
    ];
    showMenu(e, entries);
  }

  private reconnectPane(pane: Pane) {
    if (pane.status !== "closed" || !pane.reconnect || pane.disposed) return;
    pane.status = "connecting";
    pane.termId = null;
    pane.term.write("\r\n");
    this.renderTabs();
    pane.reconnect();
  }

  private keyHandler(pane: Pane, e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    const ctrlShift = e.ctrlKey && e.shiftKey && !e.altKey;
    if (ctrlShift && e.code === "KeyC") {
      if (pane.term.hasSelection()) api.clipboardWrite(pane.term.getSelection()).catch(() => {});
      e.preventDefault();
      return false;
    }
    if (ctrlShift && e.code === "KeyV") {
      e.preventDefault();
      api.clipboardRead().then((t) => this.guardedPaste(pane, t), () => toast("Clipboard is not available.", "error"));
      return false;
    }
    // Let app shortcuts bubble to the window handler.
    if (ctrlShift && e.code === "KeyB" && pane.kind === "serial") {
      e.preventDefault();
      void this.sendBreak(pane);
      return false;
    }
    if (ctrlShift && ["KeyT", "KeyD", "KeyE", "KeyG", "KeyW"].includes(e.code)) return false;
    if (e.ctrlKey && e.code === "Tab") return false;
    return true;
  }

  async guardedPaste(pane: Pane, text: string) {
    if (!text || pane.status === "closed") return;
    if (this.settings.confirmMultilinePaste && /[\r\n]/.test(text)) {
      const lines = text.split(/\r\n|\r|\n/);
      const preview = h("pre", { class: "paste-preview" }, lines.slice(0, 30).join("\n") + (lines.length > 30 ? `\n... and ${lines.length - 30} more lines` : ""));
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

  /**
   * Fit the terminal to its pane and tell the shell or server whenever the
   * size differs from what it was last told. Comparing with the size last
   * *sent* (not the size before this fit) matters: a fit that happens while
   * the connection is still opening must still be sent once it is open.
   */
  private refit(p: Pane) {
    if (p.disposed || !p.el.isConnected || p.el.clientWidth === 0) return;
    try {
      p.fit.fit();
    } catch {
      return;
    }
    const size = `${p.term.cols}x${p.term.rows}`;
    if (p.termId !== null && p.sentSize !== size) {
      p.sentSize = size;
      api.termResize(p.termId, p.term.cols, p.term.rows).catch(() => {});
    }
  }

  /** Measure the pane now, so a new shell or server starts at the right size. */
  private sizeForOpen(p: Pane): [number, number] {
    this.refit(p);
    p.sentSize = `${p.term.cols}x${p.term.rows}`;
    return [p.term.cols, p.term.rows];
  }

  private wireChannel(pane: Pane): Channel<TermOut> {
    const ch = new Channel<TermOut>();
    ch.onmessage = (m) => {
      if (pane.disposed) return;
      if (m.kind === "data") {
        const bytes = b64ToBytes(m.b64);
        pane.term.write(bytes);
        this.observeOutput(pane, pane.decoder.decode(bytes, { stream: true }));
      } else {
        pane.status = "closed";
        pane.cmd?.closed();
        pane.term.write(`\r\n\x1b[2m[${pane.kind === "ssh" ? "connection closed" : pane.kind === "serial" ? "port closed" : "process exited"}${m.code !== null ? ` with code ${m.code}` : ""}. Press R to reconnect or Enter to close.]\x1b[0m\r\n`);
        this.renderTabs();
        this.closeListeners.forEach((l) => l(pane));
      }
    };
    return ch;
  }

  // ------------------------------------------------------------ open

  /** Open a serial console. Each port can only be open once. */
  async openSerial(config: SerialConfig, title?: string, where: "tab" | "h" | "v" = "tab", session?: RedactedSession) {
    const pane = this.place(this.makePane("serial", title || config.port, null), where);
    pane.serial = config;
    pane.session = session; // enables its post-connect macro
    pane.reconnect = () => void this.connectSerial(pane);
    await this.connectSerial(pane);
  }

  private async connectSerial(pane: Pane) {
    const config = pane.serial!;
    pane.term.write(`\x1b[2mOpening ${serialSummary(config)}... \x1b[0m\r\n\x1b[2mPress Enter if nothing appears. Ctrl+Shift+B sends a break.\x1b[0m\r\n`);
    try {
      pane.termId = await api.termOpenSerial(config, this.wireChannel(pane));
      this.markConnected(pane);
    } catch (e) {
      this.failPane(pane, friendlyError("serial", errorOf(e).message, config.port));
    }
  }

  async sendBreak(pane = this.focusedPane) {
    if (!pane || pane.kind !== "serial" || pane.termId === null || pane.status !== "connected") return;
    try {
      await api.termSerialBreak(pane.termId);
      toast("Break sent.", "ok", 1500);
    } catch (e) {
      toast(messageOf(e), "error");
    }
  }

  async openLocal(shellId: string, label: string, where: "tab" | "h" | "v" = "tab", session?: RedactedSession) {
    const pane = this.place(this.makePane("local", label, null), where);
    pane.shellId = shellId;
    pane.session = session; // enables its startup commands
    pane.reconnect = () => void this.connectLocal(pane);
    await this.connectLocal(pane);
  }

  private async connectLocal(pane: Pane) {
    try {
      const [cols, rows] = this.sizeForOpen(pane);
      pane.termId = await api.termOpenLocal(pane.shellId ?? "", cols, rows, this.wireChannel(pane));
      this.markConnected(pane);
    } catch (e) {
      this.failPane(pane, errorOf(e).message);
    }
  }

  async openSsh(session: RedactedSession, where: "tab" | "h" | "v" = "tab") {
    const pane = this.place(this.makePane("ssh", session.name, null), where);
    pane.session = session;
    pane.reconnect = () => void this.connectSsh(pane);
    await this.connectSsh(pane);
  }

  private async connectSsh(pane: Pane) {
    const session = pane.session!;
    const target = session.port && session.port !== 22 ? `${session.host}:${session.port}` : session.host;
    pane.term.write(`\x1b[2mConnecting to ${session.user}@${target}...\x1b[0m\r\n`);
    let password: string | undefined;
    let passphrase: string | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const [cols, rows] = this.sizeForOpen(pane);
        pane.termId = await api.termOpenSsh(session.id, cols, rows, this.wireChannel(pane), password, passphrase);
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
            "Host key changed: possible man-in-the-middle attack",
            (close) => ({
              body: h(
                "div",
                {},
                h("p", {}, h("strong", {}, "Don't continue. This server's identity has changed since you last connected. Contact your IT team before trying again.")),
                h("p", { class: "pre muted small" }, e.message),
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
        if (e.kind === "auth" && session.auth !== "key" && session.auth !== "agent") {
          const pw = await promptDialog(
            "Sign-in failed",
            `The username or password wasn't accepted. Enter the password for ${session.user}@${session.host} to try again.`,
            { password: true, okLabel: "Try again" },
          );
          if (pw === null) return this.failPane(pane, "Cancelled.");
          password = pw;
          continue;
        }
        this.failPane(pane, friendlyError("ssh", e.message, target));
        return;
      }
    }
    this.failPane(pane, "Too many attempts.");
  }

  private askTrust(host: string, port: number, keyType: string, fp: string): Promise<boolean> {
    return modal<boolean>(
      "First connection to this server",
      (close) => ({
        body: h(
          "div",
          {},
          h("p", {}, `You haven't connected to ${host}${port !== 22 ? `:${port}` : ""} before, so Siakap can't be sure it's the right server yet.`),
          h("dl", { class: "kv" }, h("dt", {}, "Key type"), h("dd", {}, keyType), h("dt", {}, "Fingerprint"), h("dd", { class: "mono" }, fp)),
          h("p", { class: "muted" }, "If you have the server's fingerprint from your IT team, check it matches. On a trusted network, connecting to a server for the first time is normally fine. Siakap will remember it and warn you loudly if it ever changes."),
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
    const [main, details] = msg.split("\n(Details: ");
    const hint = pane.reconnect && !danger ? "Press R to try again or Enter to close." : "Press Enter to close.";
    pane.term.write(
      `\r\n\x1b[${danger ? "1;31" : "31"}m${main.replace(/\n/g, "\r\n")}\x1b[0m\r\n` +
        (details ? `\x1b[2mDetails: ${details.replace(/\)$/, "").replace(/\n/g, "\r\n")}\x1b[0m\r\n` : "") +
        `\x1b[2m[${hint}]\x1b[0m\r\n`,
    );
    this.renderTabs();
  }

  // ------------------------------------------------------------ layout

  private place(pane: Pane, where: "tab" | "h" | "v"): Pane {
    const target = this.focusedPane;
    if (where !== "tab" && target && panesOf(target.tab.root).length >= MAX_PANES) {
      toast(`A tab holds up to ${MAX_PANES} panes, so this opened in a new tab.`, "info");
      where = "tab";
    }
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

  /**
   * The toolbar layouts (side by side, top and bottom, 4 panes): they only
   * split a tab that has one pane, so clicking again does nothing.
   */
  layout(kind: "h" | "v" | "grid"): boolean {
    const p = this.focusedPane;
    if (!p) return false;
    if (panesOf(p.tab.root).length > 1) {
      toast("This tab is already split. To change it, close a pane (right-click it, or the x in its corner).", "info");
      return true;
    }
    if (kind === "grid") this.splitGrid();
    else this.splitFocused(kind);
    return true;
  }

  /** Open the focused tab's shell or session again, in a new tab. */
  duplicateTab(tab: Tab) {
    const p = tab.focused;
    if (p.kind === "serial") return toast("A serial port can only be open once.", "error");
    this.activate(tab);
    if (p.kind === "ssh" && p.session) void this.openSsh(p.session, "tab");
    else void this.openLocal(p.shellId ?? "", p.title, "tab", p.session);
  }

  splitFocused(dir: "h" | "v") {
    const p = this.focusedPane;
    if (!p) return;
    if (panesOf(p.tab.root).length >= MAX_PANES) {
      toast(`A tab holds up to ${MAX_PANES} panes.`, "info");
      return;
    }
    if (p.kind === "serial") {
      toast("A serial port can only be open in one pane at a time.", "error");
      return;
    }
    if (p.kind === "ssh" && p.session) void this.openSsh(p.session, dir);
    else void this.openLocal(p.shellId ?? "", p.title, dir);
  }

  /** Turn the focused pane into a 2×2 grid of the same shell or session. */
  splitGrid() {
    const topLeft = this.focusedPane;
    if (!topLeft) return;
    if (topLeft.kind === "serial") {
      toast("A serial port can only be open in one pane at a time.", "error");
      return;
    }
    this.splitFocused("h"); // panes are placed synchronously, so focus is already on the new one
    const topRight = this.focusedPane;
    this.focus(topLeft);
    this.splitFocused("v");
    if (topRight && topRight !== topLeft) {
      this.focus(topRight);
      this.splitFocused("v");
    }
    this.focus(topLeft);
    requestAnimationFrame(() => topLeft.term.focus());
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
    // Opening a tab means its command results have been seen.
    for (const p of panesOf(tab.root)) {
      const st = p.cmd?.state;
      if (st === "success" || st === "error") {
        window.clearTimeout(this.clearTimers.get(p));
        this.clearTimers.set(p, window.setTimeout(() => p.cmd?.clearNotification(), 4000));
      }
    }
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
    tab.el.classList.toggle("multi", panesOf(tab.root).length > 1);
  }

  private tabMenu(t: Tab, e: MouseEvent) {
    const i = this.tabs.indexOf(t);
    const others = this.tabs.filter((x) => x !== t);
    const right = this.tabs.slice(i + 1);
    const closed = panesOf(t.root).filter((p) => p.status === "closed" && p.reconnect);
    showMenu(e, [
      { label: "Rename tab...", action: () => this.renameTab(t) },
      { label: "Duplicate tab", disabled: t.focused.kind === "serial", action: () => this.duplicateTab(t) },
      ...(closed.length ? [{ label: "Reconnect", action: () => closed.forEach((p) => this.reconnectPane(p)) }] : []),
      { label: "Close tab", danger: true, action: () => this.closeTab(t) },
      { label: "Close other tabs", disabled: !others.length, action: () => this.closeTabs(others) },
      { label: "Close tabs to the right", disabled: !right.length, action: () => this.closeTabs(right) },
    ]);
  }

  private async renameTab(t: Tab) {
    const name = await promptDialog("Rename tab", "Tab name (leave empty to use the session name)", { value: t.customTitle ?? t.focused.title, okLabel: "Rename" });
    if (name === null) return;
    t.customTitle = name.trim().slice(0, 80) || undefined;
    this.renderTabs();
  }

  private async closeTabs(list: Tab[]) {
    const live = list.flatMap((t) => panesOf(t.root)).filter((p) => p.status === "connected").length;
    if (live > 1 && !(await confirmDialog("Close tabs?", `${list.length} tabs with ${live} open sessions will close.`, "Close"))) return;
    for (const t of list) for (const p of panesOf(t.root)) await this.closePane(p);
  }

  /** Drag a tab sideways to move it. */
  private bindTabDrag(el: HTMLElement) {
    el.addEventListener("pointerdown", (down) => {
      if (down.button !== 0 || (down.target as HTMLElement).closest("button")) return;
      const sx = down.clientX;
      const els = [...this.tabbar.children] as HTMLElement[];
      const rects = els.map((x) => x.getBoundingClientRect());
      const from = els.indexOf(el);
      let active = false;
      let to = from;
      const move = (e: PointerEvent) => {
        const dx = e.clientX - sx;
        if (!active) {
          if (Math.abs(dx) < 6) return;
          active = true;
          el.setPointerCapture(e.pointerId);
          el.classList.add("tab-dragging");
          document.body.classList.add("is-dragging");
        }
        el.style.transform = `translateX(${dx}px)`;
        to = rects.findIndex((r) => e.clientX < r.left + r.width / 2);
        if (to === -1) to = rects.length - 1;
        else if (to > from) to -= 1;
        els.forEach((x, k) => {
          x.classList.toggle("tab-drop-before", k === to && to < from);
          x.classList.toggle("tab-drop-after", k === to && to > from);
        });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        if (!active) return;
        document.body.classList.remove("is-dragging");
        const block = (c: Event) => (c.stopPropagation(), c.preventDefault());
        window.addEventListener("click", block, true);
        setTimeout(() => window.removeEventListener("click", block, true), 0);
        if (to !== from && to >= 0) {
          const [moved] = this.tabs.splice(from, 1);
          this.tabs.splice(to, 0, moved);
        }
        this.renderTabs();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
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
        const cmdState = this.settings?.tabStatus ? aggregate(panes.map((p) => p.cmd?.state ?? "idle")) : null;
        const shown = cmdState && cmdState !== "closed" && status !== "closed" ? `cmd-${cmdState}` : status;
        const detail = panes.map((p) => p.cmd?.detail).find(Boolean);
        const dotTitle =
          shown === "cmd-running" ? "Command running" : shown === "cmd-success" ? `Success: ${detail ?? ""}` : shown === "cmd-error" ? `Failure: ${detail ?? ""}` : status === "connected" ? "Connected" : status === "connecting" ? "Connecting" : "Closed";
        const label = (t.customTitle ?? t.focused.title) + (panes.length > 1 ? ` (${panes.length})` : "");
        const el = h(
          "div",
          { class: `tab${t === this.active ? " active" : ""}`, title: label, onclick: () => this.activate(t) },
          h("span", { class: `dot ${shown}`, title: dotTitle }),
          h("span", { class: "tab-title" }, label),
          h("button", {
            class: "tab-close",
            title: "Close tab",
            onclick: (e: Event) => {
              e.stopPropagation();
              void this.closeTab(t);
            },
          }, icon("x", 13)),
        );
        el.addEventListener("auxclick", (e) => {
          if ((e as MouseEvent).button === 1) void this.closeTab(t);
        });
        el.addEventListener("contextmenu", (e) => this.tabMenu(t, e));
        this.bindTabDrag(el);
        t.tabEl = el;
        return el;
      }),
    );
  }
}

/** A link in terminal output was clicked: show it as text, offer to copy. */
function showLink(uri: string) {
  return modal<void>("Link in terminal output", (close) => ({
    body: h(
      "div",
      { class: "form" },
      h("p", {}, "The program or server printed this link. Siakap doesn't open web pages; copy it if you want to visit it in your browser."),
      h("p", { class: "mono link-text" }, uri.length > 2000 ? uri.slice(0, 2000) + "..." : uri),
    ),
    actions: [
      h("button", { onclick: () => close() }, "Close"),
      h("button", { class: "primary", onclick: () => (api.clipboardWrite(uri).catch(() => {}), toast("Link copied.", "ok", 1500), close()) }, "Copy link"),
    ],
  }));
}

export async function chooseShell(): Promise<{ id: string; label: string } | null> {
  const shells = await api.shellsList();
  if (!shells.length) {
    await alertDialog("No shells", "No local shell was found.");
    return null;
  }
  return shells[0];
}
