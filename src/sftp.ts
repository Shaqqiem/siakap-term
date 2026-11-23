// MobaXterm-style SFTP browser that follows the active SSH pane.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, Channel, messageOf, type Progress, type SftpEntry } from "./api";
import type { Pane, TabManager } from "./tabs";
import { $, fill, confirmDialog, fmtSize, h, promptDialog, toast } from "./ui";

let transferSeq = 1;

function parentOf(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
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

  constructor(tabs: TabManager, private isVisible: () => boolean) {
    tabs.onFocus((p) => this.follow(p));
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

  private get termId(): number | null {
    return this.pane && this.pane.kind === "ssh" && this.pane.status === "connected" ? this.pane.termId : null;
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
      this.entries = r.entries;
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
      h("button", { title: "Up", onclick: () => this.refresh(parentOf(cwd)) }, "↑"),
      h("button", { title: "Refresh", onclick: () => this.refresh(cwd) }, "⟳"),
      h("button", { title: "New folder", onclick: () => this.mkdir(cwd) }, "+📁"),
      h("button", { title: "Upload files", onclick: () => this.pickUpload() }, "⇪ Upload"),
      h("button", { title: "Download selected file", disabled: !sel || sel.isDir, onclick: () => sel && this.download(sel) }, "⇩"),
      h("button", { title: "Rename", disabled: !sel, onclick: () => sel && this.rename(sel) }, "✎"),
      h("button", { title: "Delete", disabled: !sel, onclick: () => sel && this.remove(sel) }, "🗑"),
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
          onkeydown: (ev: Event) => {
            const k = (ev as KeyboardEvent).key;
            if (k === "Enter") void (e.isDir ? this.refresh(e.path) : this.download(e));
            if (k === "Delete") void this.remove(e);
            if (k === "F2") void this.rename(e);
          },
          title: e.path,
        },
        h("span", { class: "ico" }, e.isDir ? "📁" : e.isSymlink ? "↪" : "📄"),
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
      h(
        "div",
        { class: `file-list${this.loading ? " loading" : ""}` },
        cwd !== "/" ? h("div", { class: "file-row", ondblclick: () => this.refresh(parentOf(cwd)) }, h("span", { class: "ico" }, "📁"), h("span", { class: "name" }, "..")) : null,
        ...rows,
      ),
      h("p", { class: "muted small" }, "Drop files here to upload them to this folder."),
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
    const ok = await confirmDialog(
      e.isDir ? "Delete folder?" : "Delete file?",
      `Permanently delete ${e.path}?${e.isDir ? "\n\nOnly empty folders can be deleted." : ""}`,
      "Delete",
      { danger: true },
    );
    if (!ok || this.termId === null) return;
    await api.sftpRemove(this.termId, e.path, e.isDir).catch((x) => toast(messageOf(x), "error"));
    await this.refresh();
  }

  private transferRow(label: string, transferId: number) {
    const bar = h("progress", { max: 1, value: 0 });
    const txt = h("span", { class: "small" }, "starting…");
    const row = h("div", { class: "transfer" }, h("div", { class: "small name" }, label), bar, txt, h("button", { class: "icon", title: "Cancel", onclick: () => api.sftpCancel(transferId) }, "×"));
    this.transfers.append(row);
    const ch = new Channel<Progress>();
    ch.onmessage = (p) => {
      bar.max = Math.max(1, p.total);
      bar.value = p.done;
      txt.textContent = `${fmtSize(p.done)} / ${fmtSize(p.total)}`;
    };
    return { ch, done: () => setTimeout(() => row.remove(), 1500), txt };
  }

  private async download(e: SftpEntry) {
    const id = this.termId;
    if (id === null || e.isDir) return;
    const local = await saveDialog({ title: "Save file", defaultPath: e.name });
    if (!local) return;
    const tid = transferSeq++;
    const t = this.transferRow(`⇩ ${e.name}`, tid);
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

  private async pickUpload() {
    const p = await openDialog({ multiple: true, directory: false, title: "Upload files" });
    if (!p) return;
    await this.uploadMany(Array.isArray(p) ? p : [p]);
  }

  async uploadMany(paths: string[]) {
    const id = this.termId;
    if (id === null || !this.pane) return toast("Focus a connected SSH pane first.", "error");
    const dir = this.cwd.get(this.pane.uid);
    if (!dir) return;
    for (const local of paths) {
      const tid = transferSeq++;
      const t = this.transferRow(`⇪ ${baseName(local)}`, tid);
      try {
        await api.sftpUpload(id, tid, local, dir, t.ch);
        t.txt.textContent = "done";
      } catch (x) {
        t.txt.textContent = messageOf(x);
        toast(`${baseName(local)}: ${messageOf(x)}`, "error");
      } finally {
        t.done();
      }
    }
    await this.refresh(dir);
  }
}
