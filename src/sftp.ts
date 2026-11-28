// MobaXterm-style SFTP browser that follows the active SSH pane.
import { icon } from "./icons";
import { loader } from "./loader";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, Channel, errorOf, messageOf, type Progress, type SftpEntry } from "./api";
import type { Pane, TabManager } from "./tabs";
import { $, fill, confirmDialog, fmtSize, h, modal, promptDialog, showMenu, toast } from "./ui";

let transferSeq = 1;

function parentOf(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
}
/** "Skipped 2 (links or special files): a, b". */
function skippedNote(skipped: string[]): string {
  if (!skipped.length) return "";
  const shown = skipped.slice(0, 3).join(", ");
  return ` Skipped ${skipped.length} (links, special files or names this side can't store): ${shown}${skipped.length > 3 ? ", ..." : ""}`;
}
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export class SftpPanel {
  private pane: Pane | null = null;
  private cwd = new Map<number, string>();
  private entries: SftpEntry[] = [];
  private selected: SftpEntry | null = null;
  private loading = false;
  private error = "";
  private transfers = h("div", { class: "transfers" });

  constructor(private tabs: TabManager, private isVisible: () => boolean) {
    tabs.onFocus((p) => this.follow(p));
    // The followed pane finished connecting (e.g. the panel was open first).
    tabs.onPaneConnected((p) => {
      if (p === this.pane && this.isVisible()) void this.refresh();
      else if (p === this.pane) this.render();
    });
    tabs.onPaneClosed((p) => {
      this.cwd.delete(p.uid);
      if (p === this.pane) this.follow(null);
    });
    void getCurrentWebview().onDragDropEvent((ev) => {
      if (ev.payload.type !== "drop" || !this.isVisible()) return;
      const rect = $("panel-sftp").getBoundingClientRect();
      const { x, y } = ev.payload.position;
      const scale = window.devicePixelRatio || 1;
      const [cx, cy] = [x / scale, y / scale];
      if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) return;
      void this.uploadMany(ev.payload.paths);
    });
  }

  private showHidden() {
    return this.tabs.settings?.sftpShowHidden !== false;
  }

  private get termId(): number | null {
    return this.pane && this.pane.kind === "ssh" && this.pane.status === "connected" ? this.pane.termId : null;
  }

  /** Drop the listing and path history (called when the vault locks). */
  clear() {
    this.entries = [];
    this.selected = null;
    this.cwd.clear();
    $("panel-sftp").replaceChildren();
  }

  follow(p: Pane | null) {
    const ssh = p && p.kind === "ssh" ? p : null;
    if (ssh === this.pane) return;
    this.pane = ssh;
    this.entries = [];
    this.selected = null;
    this.error = "";
    if (this.isVisible()) void this.refresh();
    else this.render();
  }

  shown() {
    if (this.termId !== null && this.entries.length === 0) void this.refresh();
    else this.render();
  }

  async refresh(path?: string) {
    const id = this.termId;
    if (id === null || !this.pane) return this.render();
    const pane = this.pane;
    this.loading = true;
    this.render();
    try {
      let target = path ?? this.cwd.get(pane.uid);
      if (!target) target = await api.sftpHome(id);
      const r = await api.sftpList(id, target);
      if (this.pane !== pane) return;
      this.cwd.set(pane.uid, r.path);
      // Names starting with "." are hidden unless Settings > Files shows them.
      this.entries = this.showHidden() ? r.entries : r.entries.filter((e) => !e.name.startsWith("."));
      this.selected = null;
      this.error = "";
    } catch (e) {
      this.error = messageOf(e);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  render() {
    const panel = $("panel-sftp");
    const head = h("header", { class: "panel-head" }, h("h3", {}, "SFTP"));
    if (this.termId === null || !this.pane) {
      fill(panel, head, h("p", { class: "muted" }, "Focus a connected SSH pane to browse its files. SFTP reuses that pane's SSH connection."), this.transfers);
      return;
    }
    const cwd = this.cwd.get(this.pane.uid) ?? "";
    const pathInput = h("input", { value: cwd, spellcheck: "false", class: "mono" });
    pathInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.refresh(pathInput.value);
    });
    const sel = this.selected;
    const tb = h(
      "div",
      { class: "toolbar" },
      h("button", { class: "tool", title: "Parent folder", onclick: () => this.refresh(parentOf(cwd)) }, icon("arrow-up", 15)),
      h("button", { class: "tool", title: "Refresh", onclick: () => this.refresh(cwd) }, icon("refresh", 15)),
      h("button", { class: "tool", title: "New folder", onclick: () => this.mkdir(cwd) }, icon("folder-plus", 15)),
      h(
        "button",
        {
          class: "tool",
          title: "Upload files or a folder",
          onclick: (ev: Event) =>
            showMenu(ev as MouseEvent, [
              { label: "Upload files...", action: () => this.pickUpload() },
              { label: "Upload a folder...", action: () => this.pickUploadFolder() },
            ]),
        },
        icon("upload", 15),
      ),
      h("button", { class: "tool", title: sel?.isDir ? "Download selected folder" : "Download selected item", disabled: !sel, onclick: () => sel && this.download(sel) }, icon("download", 15)),
      h("button", { class: "tool", title: "Rename", disabled: !sel, onclick: () => sel && this.rename(sel) }, icon("edit", 15)),
      h("button", { class: "tool", title: "Delete", disabled: !sel, onclick: () => sel && this.remove(sel) }, icon("trash", 15)),
    );
    const rows = this.entries.map((e) => {
      const row = h(
        "div",
        {
          class: `file-row${e === this.selected ? " selected" : ""}`,
          tabindex: 0,
          onclick: () => {
            this.selected = e;
            this.render();
          },
          ondblclick: () => (e.isDir ? this.refresh(e.path) : this.download(e)),
          oncontextmenu: (ev: Event) => {
            this.selected = e;
            this.render();
            showMenu(ev as MouseEvent, [
              ...(e.isDir ? [{ label: "Open", action: () => this.refresh(e.path) }] : []),
              { label: e.isDir ? "Download folder..." : "Download...", action: () => this.download(e) },
              { label: "Rename...", action: () => this.rename(e) },
              { label: e.isDir ? "Delete folder..." : "Delete...", danger: true, action: () => this.remove(e) },
            ]);
          },
          onkeydown: (ev: Event) => {
            const k = (ev as KeyboardEvent).key;
            if (k === "Enter") void (e.isDir ? this.refresh(e.path) : this.download(e));
            if (k === "Delete") void this.remove(e);
            if (k === "F2") void this.rename(e);
          },
          title: e.path,
        },
        h("span", { class: `ico${e.isDir ? " dir" : ""}` }, icon(e.isDir ? "folder" : e.isSymlink ? "link" : "file", 15)),
        h("span", { class: "name" }, e.name),
        h("span", { class: "size" }, e.isDir ? "" : fmtSize(e.size)),
        h("span", { class: "mtime" }, e.mtime ? new Date(e.mtime * 1000).toLocaleString() : ""),
      );
      return row;
    });
    fill(panel, 
      head,
      h("div", { class: "muted small" }, `${this.pane.title}`),
      pathInput,
      tb,
      this.error ? h("div", { class: "error" }, this.error) : null,
      this.loading ? h("div", { class: "panel-loading" }, loader(18), "Loading...") : null,
      h(
        "div",
        { class: `file-list${this.loading ? " loading" : ""}` },
        cwd !== "/" ? h("div", { class: "file-row", ondblclick: () => this.refresh(parentOf(cwd)) }, h("span", { class: "ico dir" }, icon("folder", 15)), h("span", { class: "name" }, "..")) : null,
        ...rows,
      ),
      h("p", { class: "muted small" }, "Drop files or folders here to upload them to this folder."),
      this.transfers,
    );
  }

  private async mkdir(cwd: string) {
    const name = await promptDialog("New folder", `Create a folder in ${cwd}`, { validate: (v) => (!v || v.includes("/") || v === "." || v === ".." ? "Enter a plain folder name." : null) });
    if (!name || this.termId === null) return;
    await api.sftpMkdir(this.termId, cwd, name).catch((e) => toast(messageOf(e), "error"));
    await this.refresh(cwd);
  }

  private async rename(e: SftpEntry) {
    const n = await promptDialog("Rename", `New name for ${e.name}`, { value: e.name, validate: (v) => (!v || v.includes("/") || v === "." || v === ".." ? "Enter a plain name." : null) });
    if (!n || n === e.name || this.termId === null) return;
    await api.sftpRename(this.termId, e.path, n).catch((x) => toast(messageOf(x), "error"));
    await this.refresh();
  }

  private async remove(e: SftpEntry) {
    // A link to a folder is removed as a link; what it points to stays.
    const tree = e.isDir && !e.isSymlink;
    const ok = await confirmDialog(
      tree ? "Delete folder?" : "Delete file?",
      tree
        ? `Permanently delete ${e.path} and everything inside it?\n\nThis can't be undone. Links inside are removed as links; whatever they point to is left alone.`
        : `Permanently delete ${e.path}?`,
      tree ? "Delete folder" : "Delete",
      { danger: true },
    );
    const id = this.termId;
    if (!ok || id === null) return;
    if (!tree) {
      await api.sftpRemove(id, e.path, false).catch((x) => toast(messageOf(x), "error"));
      return this.refresh();
    }
    const tid = transferSeq++;
    const t = this.transferRow(`Delete ${e.name}`, tid, "items");
    try {
      const n = await api.sftpRemoveTree(id, tid, e.path, t.ch);
      t.txt.textContent = "done";
      toast(`Deleted ${e.name} (${n} item${n === 1 ? "" : "s"}).`, "ok", 2500);
    } catch (x) {
      t.txt.textContent = messageOf(x);
      if (errorOf(x).kind !== "cancelled") toast(messageOf(x), "error");
    } finally {
      t.done();
    }
    await this.refresh();
  }

  private transferRow(label: string, transferId: number, unit: "bytes" | "items" = "bytes") {
    const bar = h("progress", { max: 1, value: 0 });
    const txt = h("span", { class: "small" }, "Starting");
    const cur = h("div", { class: "small muted name" });
    const row = h("div", { class: "transfer" }, h("div", { class: "small name" }, label), bar, txt, h("button", { class: "icon", title: "Cancel", onclick: () => api.sftpCancel(transferId) }, icon("x", 14)), cur);
    this.transfers.append(row);
    const ch = new Channel<Progress>();
    ch.onmessage = (p) => {
      bar.max = Math.max(1, p.total);
      bar.value = p.done;
      const amount = unit === "items" ? `${p.done} / ${p.total} items` : `${fmtSize(p.done)} / ${fmtSize(p.total)}`;
      txt.textContent = p.totalFiles !== undefined ? `${amount} · ${p.files ?? 0} / ${p.totalFiles} files` : amount;
      cur.textContent = p.name ?? "";
    };
    return { ch, done: () => setTimeout(() => row.remove(), 1500), txt };
  }

  private async download(e: SftpEntry) {
    const id = this.termId;
    if (id === null) return;
    if (e.isDir) return this.downloadFolder(id, e);
    const local = await api.pickSave("download", e.name).catch((x) => (toast(messageOf(x), "error"), null));
    if (!local) return;
    const tid = transferSeq++;
    const t = this.transferRow(`Download ${e.name}`, tid);
    try {
      await api.sftpDownload(id, tid, e.path, local, t.ch);
      t.txt.textContent = "done";
      toast(`Downloaded ${e.name}.`, "ok", 2500);
    } catch (x) {
      t.txt.textContent = messageOf(x);
      toast(messageOf(x), "error");
    } finally {
      t.done();
    }
  }

  /** The folder is created inside the folder the user picks. */
  private async downloadFolder(id: number, e: SftpEntry) {
    const dir = await api.pickFolder("download-folder").catch((x) => (toast(messageOf(x), "error"), null));
    if (!dir) return;
    const tid = transferSeq++;
    const t = this.transferRow(`Download ${e.name}/`, tid);
    try {
      const r = await api.sftpDownloadTree(id, tid, e.path, dir, t.ch);
      t.txt.textContent = "done";
      toast(`Downloaded ${e.name}: ${r.files} file${r.files === 1 ? "" : "s"}, ${fmtSize(r.bytes)}.${skippedNote(r.skipped)}`, r.skipped.length ? "info" : "ok", r.skipped.length ? 8000 : 3000);
    } catch (x) {
      t.txt.textContent = messageOf(x);
      if (errorOf(x).kind !== "cancelled") toast(messageOf(x), "error");
    } finally {
      t.done();
    }
  }

  /** Ask before replacing a file that already exists on the server. */
  private askReplace(name: string, dir: string, many: boolean, folder = false): Promise<"replace" | "skip" | "all-replace" | "all-skip" | "cancel"> {
    return modal<"replace" | "skip" | "all-replace" | "all-skip" | "cancel">(
      folder ? "Folder already on the server" : "Replace file on the server?",
      (close) => {
        const all = h("input", { type: "checkbox" });
        const pick = (c: "replace" | "skip") => close(all.checked ? (`all-${c}` as const) : c);
        return {
          body: h(
            "div",
            { class: "form" },
            h("p", {}, `${folder ? "A folder named " : ""}${name} already exists in ${dir}.`),
            h(
              "p",
              { class: "muted small" },
              folder
                ? "Merging copies your folder into it: files with the same name are replaced (each only once the new copy has fully arrived); other files on the server are kept."
                : "If you replace it, the old file stays untouched until the new one has fully arrived.",
            ),
            many ? h("label", { class: "check" }, all, " Do the same for the other files") : null,
          ),
          actions: [
            h("button", { onclick: () => close("cancel") }, "Cancel upload"),
            h("button", { onclick: () => pick("skip") }, "Skip"),
            h("button", { class: "danger", onclick: () => pick("replace") }, folder ? "Merge" : "Replace"),
          ],
        };
      },
      { dismissValue: "cancel" },
    );
  }

  private async pickUpload() {
    const p = await api.pickFiles("upload", true).catch((e) => (toast(messageOf(e), "error"), [] as string[]));
    if (p.length) await this.uploadMany(p);
  }

  private async pickUploadFolder() {
    const p = await api.pickFolder("upload-folder").catch((e) => (toast(messageOf(e), "error"), null));
    if (p) await this.uploadMany([p]);
  }

  async uploadMany(paths: string[]) {
    const id = this.termId;
    if (id === null || !this.pane) return toast("Focus a connected SSH pane first.", "error");
    const dir = this.cwd.get(this.pane.uid);
    if (!dir) return;
    // "replace" / "skip" chosen with "for all remaining files".
    let remembered: "replace" | "skip" | null = null;
    for (const local of paths) {
      const name = baseName(local);
      let overwrite = remembered === "replace";
      for (;;) {
        const tid = transferSeq++;
        const t = this.transferRow(`Upload ${name}`, tid);
        try {
          const r = await api.sftpUpload(id, tid, local, dir, overwrite, t.ch);
          t.txt.textContent = "done";
          t.done();
          if (r.skipped.length) toast(`Uploaded ${name}: ${r.files} file${r.files === 1 ? "" : "s"}.${skippedNote(r.skipped)}`, "info", 8000);
          break;
        } catch (x) {
          t.done();
          if (errorOf(x).kind === "remoteExists" && !overwrite) {
            t.txt.textContent = "already exists";
            type Choice = "replace" | "skip" | "all-replace" | "all-skip" | "cancel";
            const isFolder = /folder/i.test(messageOf(x));
            const choice: Choice = remembered ?? (await this.askReplace(name, dir, paths.length > 1, isFolder));
            if (choice.startsWith("all-")) remembered = choice === "all-replace" ? "replace" : "skip";
            if (choice === "cancel") return this.refresh(dir);
            if (choice.endsWith("replace")) {
              overwrite = true;
              continue;
            }
            break; // skip this file
          }
          t.txt.textContent = messageOf(x);
          if (errorOf(x).kind === "cancelled") return this.refresh(dir);
          toast(`${name}: ${messageOf(x)}`, "error");
          break;
        }
      }
    }
    await this.refresh(dir);
  }
}
