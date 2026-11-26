import { play } from "./sound";
// Tiny DOM + modal helpers. All text goes through textContent (never
// innerHTML with data), so names from the vault can't inject markup.

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "value" && "value" in el) (el as HTMLInputElement).value = String(v);
    else if (k === "checked" && "checked" in el) (el as HTMLInputElement).checked = Boolean(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

/** replaceChildren that skips null/false entries. */
export function fill(el: Element, ...children: (Node | string | null | undefined | false)[]) {
  el.replaceChildren(...(children.filter((c) => c !== null && c !== undefined && c !== false) as (Node | string)[]));
}

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

export function toast(msg: string, kind: "info" | "error" | "ok" = "info", ms = 4000) {
  if (kind === "error") play("error");
  // The same message again replaces the old one instead of stacking.
  for (const old of $("toasts").children) if ((old as HTMLElement).textContent === msg) old.remove();
  const t = h("div", { class: `toast ${kind}` }, msg);
  $("toasts").append(t);
  setTimeout(() => t.remove(), kind === "error" ? Math.max(ms, 7000) : ms);
}

let modalDepth = 0;
export function isModalOpen() {
  return modalDepth > 0;
}

/** Close every open dialog at once (used when the vault locks). */
export function closeAllModals() {
  modalDepth = 0;
  $("modal-root").replaceChildren();
}

/** Show a modal; resolves with whatever `close` is called with. */
export function modal<T>(
  title: string,
  build: (close: (v: T) => void) => { body: Node; actions?: Node[]; focus?: HTMLElement },
  opts: { wide?: boolean; danger?: boolean; dismissValue?: T } = {},
): Promise<T> {
  return new Promise((resolve) => {
    const prev = document.activeElement as HTMLElement | null;
    const backdrop = h("div", { class: "modal-backdrop" });
    let done = false;
    const close = (v: T) => {
      if (done) return;
      done = true;
      modalDepth--;
      backdrop.remove();
      prev?.focus?.();
      resolve(v);
    };
    const { body, actions = [], focus } = build(close);
    const box = h(
      "div",
      { class: `modal${opts.wide ? " wide" : ""}${opts.danger ? " danger" : ""}`, role: "dialog", "aria-modal": "true" },
      h("h2", {}, title),
      body,
      actions.length ? h("div", { class: "modal-actions" }, ...actions) : null,
    );
    backdrop.append(box);
    backdrop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(opts.dismissValue as T);
      }
    });
    modalDepth++;
    $("modal-root").append(backdrop);
    (focus ?? (box.querySelector("input,textarea,select,button") as HTMLElement | null))?.focus();
  });
}

export function confirmDialog(
  title: string,
  message: string | Node,
  okLabel = "OK",
  opts: { danger?: boolean } = {},
): Promise<boolean> {
  return modal<boolean>(
    title,
    (close) => {
      const ok = h("button", { class: opts.danger ? "danger" : "primary", onclick: () => close(true) }, okLabel);
      return {
        body: typeof message === "string" ? h("p", { class: "pre" }, message) : message,
        actions: [h("button", { onclick: () => close(false) }, "Cancel"), ok],
        focus: opts.danger ? undefined : ok,
      };
    },
    { danger: opts.danger, dismissValue: false },
  );
}

export function alertDialog(title: string, message: string): Promise<void> {
  return modal<void>(title, (close) => {
    const ok = h("button", { class: "primary", onclick: () => close() }, "OK");
    return { body: h("p", { class: "pre" }, message), actions: [ok], focus: ok };
  });
}

/** Ask for one value. `validate` returns an error message or null. */
export function promptDialog(
  title: string,
  label: string,
  opts: { value?: string; password?: boolean; validate?: (v: string) => string | null; okLabel?: string; hint?: string } = {},
): Promise<string | null> {
  return modal<string | null>(
    title,
    (close) => {
      const input = h("input", {
        type: opts.password ? "password" : "text",
        value: opts.value ?? "",
        spellcheck: "false",
        autocomplete: "off",
      });
      const err = h("div", { class: "error" });
      const submit = () => {
        const v = input.value;
        const e = opts.validate?.(v) ?? null;
        if (e) {
          err.textContent = e;
          return;
        }
        close(v);
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      });
      return {
        body: h("label", { class: "field" }, h("span", {}, label), input, opts.hint ? h("small", { class: "muted" }, opts.hint) : null, err),
        actions: [
          h("button", { onclick: () => close(null) }, "Cancel"),
          h("button", { class: "primary", onclick: submit }, opts.okLabel ?? "OK"),
        ],
        focus: input,
      };
    },
    { dismissValue: null },
  );
}

export function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h("label", { class: "field" }, h("span", {}, label), input, hint ? h("small", { class: "muted" }, hint) : null);
}

export function select(options: [string, string][], value: string): HTMLSelectElement {
  const s = h("select", {});
  for (const [v, l] of options) s.append(h("option", { value: v }, l));
  s.value = value;
  return s;
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KiB", "MiB", "GiB", "TiB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

/** Group items into a folder tree for rendering. */
export interface FolderNode<T> {
  name: string;
  path: string;
  children: Map<string, FolderNode<T>>;
  items: T[];
}
export function buildTree<T>(items: T[], folderOf: (t: T) => string, extraFolders: string[] = []): FolderNode<T> {
  const root: FolderNode<T> = { name: "", path: "", children: new Map(), items: [] };
  const ensure = (path: string) => {
    let node = root;
    if (!path) return node;
    let acc = "";
    for (const seg of path.split("/")) {
      acc = acc ? `${acc}/${seg}` : seg;
      let c = node.children.get(seg);
      if (!c) {
        c = { name: seg, path: acc, children: new Map(), items: [] };
        node.children.set(seg, c);
      }
      node = c;
    }
    return node;
  };
  for (const f of extraFolders) ensure(f);
  for (const it of items) ensure(folderOf(it)).items.push(it);
  return root;
}

export interface MenuEntry {
  label: string;
  action: () => unknown;
  danger?: boolean;
  disabled?: boolean;
}

let openMenu: HTMLElement | null = null;
export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

/** Small pop-up menu at the mouse (right-click) or under a button. */
export function showMenu(ev: MouseEvent, entries: MenuEntry[]) {
  ev.preventDefault();
  ev.stopPropagation();
  closeMenu();
  const menu = h(
    "div",
    { class: "menu", role: "menu" },
    ...entries.map((e) =>
      h(
        "button",
        {
          class: `menu-item${e.danger ? " danger-text" : ""}`,
          role: "menuitem",
          disabled: e.disabled,
          onclick: () => {
            closeMenu();
            void Promise.resolve(e.action()).catch((x) => toast(String((x as Error)?.message ?? x), "error"));
          },
        },
        e.label,
      ),
    ),
  );
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  const target = ev.currentTarget instanceof HTMLElement && ev.type === "click" ? ev.currentTarget.getBoundingClientRect() : null;
  let x = target ? target.left : ev.clientX;
  let y = target ? target.bottom + 2 : ev.clientY;
  x = Math.min(x, window.innerWidth - r.width - 8);
  y = Math.min(y, window.innerHeight - r.height - 8);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
  openMenu = menu;
  (menu.querySelector("button:not([disabled])") as HTMLElement | null)?.focus();
}
window.addEventListener("mousedown", (e) => {
  if (openMenu && !openMenu.contains(e.target as Node)) closeMenu();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});
window.addEventListener("blur", closeMenu);

// ------------------------------------------------------------------ pointer drag
// HTML drag and drop is unreliable in the Windows web view while file drops
// are enabled, so rows are dragged with pointer events instead. Drop targets
// carry `data-drop="<value>"`; `onDrop` gets that value.

export interface DragOptions {
  label: string;
  /** Return false to refuse a target. */
  accept?: (target: string) => boolean;
  onDrop: (target: string) => void;
  /** Called on every move with the hovered target (or null). */
  onOver?: (target: HTMLElement | null, e: PointerEvent) => void;
  /** Use a live callback instead of drop targets (tab reordering). */
  ghost?: boolean;
  onEnd?: () => void;
}

export function enableDrag(el: HTMLElement, opts: DragOptions) {
  el.addEventListener("pointerdown", (down) => {
    if (down.button !== 0 || (down.target as HTMLElement).closest("button,input,select,textarea")) return;
    const sx = down.clientX;
    const sy = down.clientY;
    let active = false;
    // Touch: a swipe scrolls the list; press and hold (~0.45 s) to pick a row up.
    const touch = down.pointerType === "touch";
    let held = !touch;
    let holdTimer = 0;
    const noScroll = (e: TouchEvent) => active && e.preventDefault();
    if (touch) {
      holdTimer = window.setTimeout(() => {
        held = true;
        el.classList.add("drag-ready");
        navigator.vibrate?.(15);
      }, 450);
      el.addEventListener("touchmove", noScroll, { passive: false });
    }
    let ghost: HTMLElement | null = null;
    let over: HTMLElement | null = null;
    const setOver = (t: HTMLElement | null) => {
      if (over === t) return;
      over?.classList.remove("drop-target");
      over = t;
      over?.classList.add("drop-target");
    };
    const move = (e: PointerEvent) => {
      if (!active) {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) < 6) return;
        if (!held) {
          // Moved before the hold: it's a scroll, not a drag.
          window.clearTimeout(holdTimer);
          return finish(false);
        }
        active = true;
        el.setPointerCapture(e.pointerId);
        el.classList.add("dragging");
        document.body.classList.add("is-dragging");
        if (opts.ghost !== false) {
          ghost = h("div", { class: "drag-ghost" }, opts.label);
          document.body.append(ghost);
        }
      }
      if (ghost) ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`;
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-drop]") ?? null;
      setOver(hit && (!opts.accept || opts.accept(hit.dataset.drop ?? "")) ? hit : null);
      opts.onOver?.(over, e);
    };
    const finish = (drop: boolean) => {
      window.clearTimeout(holdTimer);
      el.classList.remove("drag-ready");
      el.removeEventListener("touchmove", noScroll);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      if (!active) return;
      el.classList.remove("dragging");
      document.body.classList.remove("is-dragging");
      ghost?.remove();
      const target = over;
      setOver(null);
      // The click that ends a drag must not also activate the row.
      const block = (c: Event) => (c.stopPropagation(), c.preventDefault());
      window.addEventListener("click", block, true);
      setTimeout(() => window.removeEventListener("click", block, true), 0);
      if (drop && target) opts.onDrop(target.dataset.drop ?? "");
      opts.onEnd?.();
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  });
}
