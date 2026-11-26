// "Report a problem": builds a plain-text report the user can save or copy
// and send to the developer themselves. Nothing is sent by the app.
import { api, messageOf } from "./api";
import { buildReport, diagEvents, redact } from "./diag";
import { field, h, modal, toast } from "./ui";

export async function openReport(prefill = "") {
  // Gather first so the preview is ready when the dialog opens.
  let info: Record<string, unknown> = {};
  const words: string[] = [];
  try {
    const [d, { sessions }, hosts] = await Promise.all([api.diagInfo(), api.sessionsList(), api.knownHostsList()]);
    info = d;
    for (const s of sessions) words.push(s.host, s.user);
    for (const k of hosts) words.push(k.host);
    const set = d.settings as { defaultUser?: string } | undefined;
    if (set?.defaultUser) words.push(set.defaultUser);
  } catch (e) {
    info = { note: `Some details couldn't be read: ${messageOf(e)}` };
  }
  const extra = {
    window: `${window.innerWidth}×${window.innerHeight} at ${devicePixelRatio}x`,
    language: navigator.language,
    touch: navigator.maxTouchPoints > 0,
  };

  await modal<void>(
    "Report a problem",
    (close) => {
      const what = h("textarea", { rows: "4", placeholder: "What were you doing, what did you expect, and what happened instead?", spellcheck: "true" }) as HTMLTextAreaElement;
      what.value = prefill;
      const hide = h("input", { type: "checkbox", checked: true }) as HTMLInputElement;
      const preview = h("pre", { class: "report-preview", tabindex: "0" });
      const text = () => {
        const raw = buildReport(what.value, info, diagEvents(), extra);
        return hide.checked ? redact(raw, { words }) : raw;
      };
      const refresh = () => {
        preview.textContent = text();
      };
      what.addEventListener("input", refresh);
      hide.addEventListener("change", refresh);
      refresh();
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      const save = h("button", { type: "button", class: "primary" }, "Save report...") as HTMLButtonElement;
      save.addEventListener("click", async () => {
        try {
          const path = await api.pickSave("report", `siakap-report-${stamp}.txt`);
          if (!path) return;
          await api.saveTextFile(path, text());
          toast("Report saved. Send that file to the developer, for example on the GitHub Issues page.", "ok", 6000);
          close();
        } catch (e) {
          toast(messageOf(e), "error");
        }
      });
      const copy = h("button", { type: "button" }, "Copy") as HTMLButtonElement;
      copy.addEventListener("click", () =>
        api
          .clipboardWrite(text())
          .then(() => toast("Report copied. Paste it into a message or a GitHub issue.", "ok", 4000))
          .catch((e) => toast(messageOf(e), "error")),
      );
      return {
        body: h(
          "div",
          { class: "report" },
          h("p", { class: "muted small" }, "Siakap writes a report you can save or copy and send yourself. Nothing is sent by the app. Read it below before you share it."),
          field("What happened?", what),
          h("label", { class: "check" }, hide, " Hide server names, user names and IP addresses"),
          h("details", {}, h("summary", { class: "small" }, "Preview the report"), preview),
          h("p", { class: "muted small" }, "Included: versions, Windows version, counts of sessions and macros, settings, and the app's recent errors since it started. Not included: terminal output, what you typed, passwords, keys, or your sessions' and macros' details."),
        ),
        actions: [h("button", { type: "button", onclick: () => close() }, "Close"), copy, save],
        focus: what,
      };
    },
    { wide: true },
  );
}
