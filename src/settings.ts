// Settings panel: appearance, behaviour, security, known hosts.
import { api, messageOf, type KnownHost, type Settings } from "./api";
import { $, confirmDialog, field, h, modal, select, toast } from "./ui";

export class SettingsPanel {
  constructor(private onSaved: (s: Settings) => void) {}

  async render() {
    const panel = $("panel-settings");
    let s: Settings;
    let hosts: KnownHost[];
    try {
      [s, hosts] = await Promise.all([api.settingsGet(), api.knownHostsList()]);
    } catch (e) {
      panel.replaceChildren(h("p", { class: "error" }, messageOf(e)));
      return;
    }
    const fontFamily = h("input", { value: s.fontFamily, spellcheck: "false" });
    const fontSize = h("input", { type: "number", min: 6, max: 48, value: s.fontSize });
    const bg = h("input", { type: "color", value: s.background });
    const fg = h("input", { type: "color", value: s.foreground });
    const cursor = h("input", { type: "color", value: s.cursor });
    const selection = h("input", { type: "color", value: s.selection });
    const scrollback = h("input", { type: "number", min: 0, max: 200000, step: 1000, value: s.scrollback });
    const copyOnSelect = h("input", { type: "checkbox", checked: s.copyOnSelect });
    const confirmPaste = h("input", { type: "checkbox", checked: s.confirmMultilinePaste });
    const lineDelay = h("input", { type: "number", min: 0, max: 60000, step: 10, value: s.lineDelayMs });
    const mode = select([["safe", "Safe (A-Z 0-9 space _ . / : @ , + -)"], ["unrestricted", "Unrestricted (control characters still blocked)"]], s.validationMode);
    const autoLock = h("input", { type: "number", min: 0, max: 1440, value: s.autoLockMinutes });

    const save = async () => {
      const next: Settings = {
        fontFamily: fontFamily.value,
        fontSize: Number(fontSize.value),
        background: bg.value,
        foreground: fg.value,
        cursor: cursor.value,
        selection: selection.value,
        scrollback: Number(scrollback.value),
        copyOnSelect: copyOnSelect.checked,
        confirmMultilinePaste: confirmPaste.checked,
        lineDelayMs: Number(lineDelay.value),
        validationMode: mode.value as Settings["validationMode"],
        autoLockMinutes: Number(autoLock.value),
      };
      try {
        const saved = await api.settingsSave(next);
        this.onSaved(saved);
        toast("Settings saved.", "ok", 2000);
        await this.render();
      } catch (e) {
        toast(messageOf(e), "error");
      }
    };

    const hostRows = hosts.map((k) =>
      h(
        "div",
        { class: "kh-row" },
        h("div", {}, h("strong", {}, `${k.host}:${k.port}`), h("div", { class: "mono small" }, `${k.keyType} ${k.fingerprint}`)),
        h(
          "button",
          {
            class: "icon",
            title: "Forget this host key",
            onclick: async () => {
              if (!(await confirmDialog("Forget host key?", `Remove the stored key for ${k.host}:${k.port}? You will be asked to verify the fingerprint again on the next connection.`, "Forget", { danger: true }))) return;
              await api.knownHostRemove(k.host, k.port).catch((e) => toast(messageOf(e), "error"));
              await this.render();
            },
          },
          "🗑",
        ),
      ),
    );

    panel.replaceChildren(
      h("header", { class: "panel-head" }, h("h3", {}, "Settings")),
      h(
        "form",
        { class: "form", onsubmit: (e: Event) => (e.preventDefault(), void save()) },
        h("h4", {}, "Terminal"),
        field("Font family", fontFamily, "Local fonts only, e.g. Cascadia Mono, Consolas."),
        field("Font size", fontSize),
        h("div", { class: "grid2" }, field("Background", bg), field("Foreground", fg), field("Cursor", cursor), field("Selection", selection)),
        field("Scrollback lines", scrollback),
        h("label", { class: "check" }, copyOnSelect, " Copy on select"),
        h("label", { class: "check" }, confirmPaste, " Confirm before pasting multiple lines"),
        h("h4", {}, "Macros"),
        field("Delay between lines (ms)", lineDelay),
        field("Placeholder input validation", mode),
        h("h4", {}, "Security"),
        field("Auto-lock after idle minutes", autoLock, "0 disables auto-lock."),
        h("button", { type: "submit", class: "primary" }, "Save settings"),
      ),
      h("button", { onclick: () => this.changePassword() }, "Change master password…"),
      h("h4", {}, `Known hosts (${hosts.length})`),
      hosts.length ? h("div", { class: "kh-list" }, ...hostRows) : h("p", { class: "muted small" }, "No trusted host keys yet."),
      h("h4", {}, "Privacy"),
      h("p", { class: "muted small" }, "Siakap makes no network connections except the SSH sessions you start: no telemetry, no update checks, no remote fonts."),
    );
  }

  private async changePassword() {
    const old = h("input", { type: "password", autocomplete: "off" });
    const n1 = h("input", { type: "password", autocomplete: "off" });
    const n2 = h("input", { type: "password", autocomplete: "off" });
    const err = h("div", { class: "error" });
    await modal<void>("Change master password", (close) => {
      const go = async () => {
        if (n1.value !== n2.value) return void (err.textContent = "The new passwords don't match.");
        if (n1.value.length < 8) return void (err.textContent = "Use at least 8 characters.");
        try {
          await api.vaultChangePassword(old.value, n1.value);
          old.value = n1.value = n2.value = "";
          toast("Master password changed.", "ok");
          close();
        } catch (e) {
          err.textContent = messageOf(e);
        }
      };
      return {
        body: h("div", { class: "form" }, field("Current password", old), field("New password", n1), field("Repeat new password", n2), err),
        actions: [h("button", { onclick: () => close() }, "Cancel"), h("button", { class: "primary", onclick: () => void go() }, "Change")],
        focus: old,
      };
    });
  }
}
