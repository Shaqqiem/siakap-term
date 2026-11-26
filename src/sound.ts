// Small synthesised sounds (Web Audio): no sound files, nothing loaded.
// Volume and on/off come from Settings via configure().

export type SoundName = "click" | "enter" | "open" | "close" | "chime" | "fail" | "error" | "toggle" | "splash";

let ctx: AudioContext | null = null;
let volume = 0.4;
let uiOn = true;
let chimeOn = true;

export function configure(o: { ui: boolean; chime: boolean; volume: number }) {
  uiOn = o.ui;
  chimeOn = o.chime;
  volume = Math.max(0, Math.min(1, o.volume / 100));
}

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** One soft note: sine/triangle with a quick attack and exponential decay. */
function note(c: AudioContext, freq: number, start: number, dur: number, gain: number, type: OscillatorType = "sine") {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * volume), start + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(c.destination);
  o.start(start);
  o.stop(start + dur + 0.02);
}

export function play(name: SoundName) {
  const isChime = name === "chime" || name === "fail";
  if (isChime ? !chimeOn : !uiOn && name !== "splash") return;
  if (volume <= 0) return;
  const c = audio();
  if (!c) return;
  const t = c.currentTime + 0.005;
  switch (name) {
    case "click":
      note(c, 1900, t, 0.035, 0.12, "triangle");
      break;
    case "toggle":
      note(c, 1400, t, 0.04, 0.12, "triangle");
      note(c, 2100, t + 0.035, 0.05, 0.1, "triangle");
      break;
    case "enter":
      note(c, 760, t, 0.06, 0.1, "sine");
      break;
    case "open":
      note(c, 660, t, 0.09, 0.14);
      note(c, 990, t + 0.06, 0.12, 0.12);
      break;
    case "close":
      note(c, 880, t, 0.08, 0.12);
      note(c, 587, t + 0.06, 0.12, 0.1);
      break;
    case "chime": // bright three-note bell: work finished
      [1046.5, 1318.5, 1568].forEach((f, i) => {
        note(c, f, t + i * 0.11, 0.9, 0.22);
        note(c, f * 2, t + i * 0.11, 0.35, 0.05);
      });
      break;
    case "fail": // two falling notes: finished with an error
      note(c, 659, t, 0.35, 0.22, "triangle");
      note(c, 494, t + 0.16, 0.5, 0.22, "triangle");
      break;
    case "error":
      note(c, 220, t, 0.16, 0.16, "square");
      break;
    case "splash":
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(c, f, t + i * 0.09, 0.7, 0.16));
      break;
  }
}
