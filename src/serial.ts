// Serial console UI: a MobaXterm-style form (port and speed dropdowns plus line
// settings) and the quick-connect dialog. Ports are re-detected every couple of
// seconds while the form is open, so plugging in a console cable just works.
import { api, messageOf, type SerialConfig, type SerialPortInfo } from "./api";
import { icon } from "./icons";
import { field, h, modal, select } from "./ui";

export const DEFAULT_SERIAL: SerialConfig = { port: "", baud: 9600, dataBits: 8, parity: "none", stopBits: 1, flow: "none" };
const FALLBACK_RATES = [300, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const OTHER = "__other__";

export function serialSummary(c: SerialConfig): string {
  return `${c.port} ${c.baud} ${c.dataBits}${c.parity[0].toUpperCase()}${c.stopBits}`;
}

function portLabel(p: SerialPortInfo): string {
  return `${p.name}  ${p.description}`;
}

export interface SerialForm {
  el: HTMLElement;
  /** The chosen settings, or an error message. */
  read(): SerialConfig | string;
  dispose(): void;
}

export function serialForm(initial: SerialConfig = DEFAULT_SERIAL): SerialForm {
  let ports: SerialPortInfo[] = [];
  let rates = FALLBACK_RATES;

  // Port: dropdown of detected ports, plus "Other..." for a name typed by hand.
  const portSel = h("select", {});
  const portOther = h("input", { placeholder: "e.g. COM7 or /dev/ttyUSB0", spellcheck: "false", class: "hidden" });
  const refresh = h("button", { type: "button", class: "tool", title: "Look for ports again" }, icon("refresh", 15));
  const hint = h("small", { class: "muted" });

  // Speed: dropdown of common rates, plus "Custom..." for anything else.
  const baudSel = h("select", {});
  const baudCustom = h("input", { type: "number", min: 50, max: 4000000, placeholder: "Baud", class: "hidden" });

  const dataBits = select([["8", "8"], ["7", "7"], ["6", "6"], ["5", "5"]], String(initial.dataBits));
  const parity = select([["none", "None"], ["even", "Even"], ["odd", "Odd"]], initial.parity);
  const stopBits = select([["1", "1"], ["2", "2"]], String(initial.stopBits));
  const flow = select([["none", "None"], ["software", "XON/XOFF"], ["hardware", "RTS/CTS"]], initial.flow);

  let chosenPort = initial.port;
  const fillPorts = () => {
    const typingOther = portSel.value === OTHER;
    const keep = portSel.value && !typingOther ? portSel.value : chosenPort;
    portSel.replaceChildren();
    for (const p of ports) portSel.append(h("option", { value: p.name }, portLabel(p)));
    if (keep && !ports.some((p) => p.name === keep)) portSel.append(h("option", { value: keep }, `${keep}  (not connected)`));
    if (!ports.length && !keep) portSel.append(h("option", { value: "" }, "No serial ports found"));
    portSel.append(h("option", { value: OTHER }, "Other..."));
    if (typingOther) portSel.value = OTHER; // don't yank "Other..." away while the user types
    else if (keep) portSel.value = keep;
    else {
      // Nothing chosen yet: pick the only USB adapter, or the first port.
      const usb = ports.filter((p) => p.usb);
      portSel.value = (usb.length === 1 ? usb[0] : ports[0])?.name ?? "";
    }
    syncPort();
    if (!announced) {
      hint.textContent = ports.length
        ? "Not sure which one? Unplug the console cable and plug it back in. The port that appears is yours, and it gets picked for you."
        : "No ports yet. Plug in the console cable and it will appear here automatically.";
    }
  };
  const syncPort = () => {
    portOther.classList.toggle("hidden", portSel.value !== OTHER);
    if (portSel.value !== OTHER) chosenPort = portSel.value;
  };
  portSel.addEventListener("change", syncPort);

  const fillRates = () => {
    baudSel.replaceChildren(...rates.map((r) => h("option", { value: String(r) }, String(r))), h("option", { value: OTHER }, "Custom..."));
    if (rates.includes(initial.baud)) baudSel.value = String(initial.baud);
    else {
      baudSel.value = OTHER;
      baudCustom.value = String(initial.baud);
    }
    syncBaud();
  };
  const syncBaud = () => baudCustom.classList.toggle("hidden", baudSel.value !== OTHER);
  baudSel.addEventListener("change", syncBaud);
  fillRates();

  let lastKey = "";
  let loadedOnce = false;
  let announced = false;
  const load = async () => {
    try {
      const r = await api.serialPortsList();
      const key = r.ports.map((p) => p.name + p.description).join("|");
      if (r.baudRates.length && rates !== r.baudRates && r.baudRates.join() !== rates.join()) {
        rates = r.baudRates;
        fillRates();
      }
      if (key !== lastKey || !portSel.options.length) {
        const before = new Set(ports.map((p) => p.name));
        const firstLoad = lastKey === "" && !loadedOnce;
        lastKey = key;
        ports = r.ports;
        loadedOnce = true;
        // A cable plugged in while the dialog is open: pick it automatically.
        const added = firstLoad ? [] : ports.filter((p) => !before.has(p.name));
        if (added.length === 1 && portSel.value !== OTHER) {
          chosenPort = added[0].name;
          portSel.value = "";
          announced = true;
          fillPorts();
          portSel.value = added[0].name;
          syncPort();
          hint.textContent = `New port found: ${added[0].name} (${added[0].description}). It's selected for you.`;
          hint.classList.add("flash");
          portSel.classList.add("flash");
          window.setTimeout(() => (hint.classList.remove("flash"), portSel.classList.remove("flash")), 2500);
        } else fillPorts();
      }
    } catch (e) {
      hint.textContent = messageOf(e);
      if (!portSel.options.length) fillPorts();
    }
  };
  refresh.addEventListener("click", () => void load());
  void load();
  const timer = window.setInterval(() => {
    if (!el.isConnected) return window.clearInterval(timer);
    void load();
  }, 2500);

  // Advanced settings: hidden unless a saved session uses something non-standard.
  const isStandard = () => dataBits.value === "8" && parity.value === "none" && stopBits.value === "1" && flow.value === "none";
  const advSummary = h("span", { class: "muted" });
  const updateSummary = () => {
    const p = parity.value === "none" ? "N" : parity.value === "even" ? "E" : "O";
    const f = flow.value === "none" ? "no flow control" : flow.value === "software" ? "XON/XOFF" : "RTS/CTS";
    advSummary.textContent = isStandard() ? "  (standard: 8N1, no flow control)" : `  (custom: ${dataBits.value}${p}${stopBits.value}, ${f})`;
  };
  for (const x of [dataBits, parity, stopBits, flow]) x.addEventListener("change", updateSummary);
  const reset = h("button", { type: "button" }, "Reset to standard");
  reset.addEventListener("click", () => {
    dataBits.value = "8";
    parity.value = "none";
    stopBits.value = "1";
    flow.value = "none";
    updateSummary();
  });
  updateSummary();
  const advanced = h(
    "details",
    { class: "advanced" },
    h("summary", {}, "Advanced settings", advSummary),
    h("p", { class: "muted small" }, "Almost every switch, router and firewall uses the standard settings. Only change these if the device's manual says so."),
    h(
      "div",
      { class: "grid2" },
      field("Data bits", dataBits, "Usually 8."),
      field("Parity", parity, "Usually None."),
      field("Stop bits", stopBits, "Usually 1."),
      field("Flow control", flow, "Usually None. Try RTS/CTS if text drops out."),
    ),
    h("div", { class: "adv-actions" }, reset),
  );
  if (!isStandard()) advanced.open = true;

  const el = h(
    "div",
    { class: "serial-form" },
    h("label", { class: "field" }, h("span", {}, "1. Serial port"), h("div", { class: "inline" }, portSel, refresh), portOther, hint),
    h(
      "label",
      { class: "field" },
      h("span", {}, "2. Speed (baud rate)"),
      h("div", { class: "inline" }, baudSel, baudCustom),
      h("small", { class: "muted" }, "Most switches and routers use 9600. If you see garbled text, try 115200."),
    ),
    advanced,
  );

  return {
    el,
    read() {
      const port = (portSel.value === OTHER ? portOther.value : portSel.value).trim();
      if (!port) return "Choose a serial port.";
      const baud = Number(baudSel.value === OTHER ? baudCustom.value : baudSel.value);
      if (!Number.isInteger(baud) || baud < 50 || baud > 4_000_000) return "Enter a speed between 50 and 4000000 baud.";
      return {
        port,
        baud,
        dataBits: Number(dataBits.value),
        parity: parity.value as SerialConfig["parity"],
        stopBits: Number(stopBits.value),
        flow: flow.value as SerialConfig["flow"],
      };
    },
    dispose() {
      window.clearInterval(timer);
    },
  };
}

/** Quick-connect dialog. Resolves with the chosen settings, plus whether to save them as a session. */
export function serialDialog(initial?: Partial<SerialConfig>): Promise<{ config: SerialConfig; save: boolean } | null> {
  const form = serialForm({ ...DEFAULT_SERIAL, ...initial });
  const err = h("div", { class: "error" });
  return modal<{ config: SerialConfig; save: boolean } | null>(
    "Serial console",
    (close) => {
      const go = (save: boolean) => {
        const r = form.read();
        if (typeof r === "string") return void (err.textContent = r);
        form.dispose();
        close({ config: r, save });
      };
      return {
        body: h("div", { class: "form" }, form.el, err),
        actions: [
          h("button", { onclick: () => (form.dispose(), close(null)) }, "Cancel"),
          h("button", { onclick: () => go(true) }, "Save as session"),
          h("button", { class: "primary", onclick: () => go(false) }, "Connect"),
        ],
      };
    },
    { dismissValue: null },
  ).finally(() => form.dispose());
}
