// Touchscreen support for terminals:
// - one finger: swipe to scroll, with momentum after a flick
// - tap: focus the terminal (so the on-screen keyboard types into it)
// - two fingers: pinch to make the text bigger or smaller (this pane only)
// Swipes are passed to xterm as wheel movement, so scrolling also works in
// full-screen programs (less, vim, htop) the same way the mouse wheel does.

export interface TouchTarget {
  /** The .xterm element of the terminal. */
  element: HTMLElement;
  focus: () => void;
  getFontSize: () => number;
  /** Height of one terminal row in CSS pixels. */
  rowHeight: () => number;
  /** Scroll the scrollback by whole lines (negative = back). */
  scrollLines: (n: number) => void;
  /** A full-screen program (less, vim, htop) is showing, or it wants the mouse. */
  programScrolls: () => boolean;
  setFontSize: (px: number) => void;
}

const TAP_MOVE = 10; // px: more than this is a swipe, not a tap
const FRICTION = 0.94; // momentum decay per frame (60 fps)

export function attachTouch(t: TouchTarget) {
  const el = t.element;
  // Fingers on the terminal (pointer events with pointerType "touch").
  const fingers = new Map<number, { x: number; y: number }>();
  let lastY = 0;
  let startX = 0;
  let startY = 0;
  let startT = 0;
  let moved = false;
  let velocity = 0; // px per ms
  let lastMoveT = 0;
  let raf = 0;
  let pinchStart = 0;
  let fontStart = 0;
  let pinched = false;

  // The text follows the finger 1:1: finger movement becomes whole lines,
  // keeping the remainder for the next move.
  let carry = 0;
  const wheel = (dy: number, x: number, y: number) => {
    if (!dy) return;
    carry += dy / Math.max(4, t.rowHeight());
    const lines = Math.trunc(carry);
    if (!lines) return;
    carry -= lines;
    // Finger moves down = content moves down = scroll back.
    if (!t.programScrolls()) return t.scrollLines(-lines);
    // Full-screen programs scroll by wheel (xterm turns it into arrow keys or
    // mouse-wheel reports). xterm counts about two wheel pixels per row pixel.
    const target = (el.querySelector(".xterm-screen") as HTMLElement | null) ?? el;
    const px = -lines * t.rowHeight() * 2;
    target.dispatchEvent(new WheelEvent("wheel", { deltaY: px, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  };
  const stopMomentum = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  const spread = () => {
    const [a, b] = [...fingers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const isTouch = (e: PointerEvent) => e.pointerType === "touch";

  el.addEventListener(
    "pointerdown",
    (e) => {
      if (!isTouch(e)) return;
      stopMomentum();
      e.preventDefault();
      e.stopPropagation(); // xterm mustn't start a text selection
      try {
        el.setPointerCapture(e.pointerId); // keep getting moves if the finger leaves the pane
      } catch {
        /* not available for this pointer: moves over the pane still arrive */
      }
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (fingers.size === 2) {
        pinchStart = spread();
        fontStart = t.getFontSize();
        pinched = true;
        return;
      }
      if (fingers.size !== 1) return;
      startX = e.clientX;
      startY = lastY = e.clientY;
      carry = 0;
      startT = lastMoveT = performance.now();
      moved = false;
      pinched = false;
      velocity = 0;
    },
    true,
  );

  el.addEventListener(
    "pointermove",
    (e) => {
      if (!isTouch(e) || !fingers.has(e.pointerId)) return;
      e.preventDefault();
      e.stopPropagation();
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (fingers.size === 2 && pinchStart) {
        const size = Math.round(Math.min(40, Math.max(6, fontStart * (spread() / pinchStart))));
        if (size !== t.getFontSize()) t.setFontSize(size);
        return;
      }
      if (fingers.size !== 1 || pinched) return;
      if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) > TAP_MOVE) moved = true;
      if (!moved) return;
      const now = performance.now();
      const dy = e.clientY - lastY;
      const dt = Math.max(1, now - lastMoveT);
      velocity = 0.8 * (dy / dt) + 0.2 * velocity;
      lastY = e.clientY;
      lastMoveT = now;
      wheel(dy, e.clientX, e.clientY);
    },
    true,
  );

  const up = (e: PointerEvent) => {
    if (!isTouch(e) || !fingers.has(e.pointerId)) return;
    e.stopPropagation();
    fingers.delete(e.pointerId);
    if (fingers.size) return; // still a finger down
    pinchStart = 0;
    if (pinched || e.type === "pointercancel") return;
    if (!moved && performance.now() - startT < 500) {
      // A tap: focus the terminal (opens the on-screen keyboard on tablets).
      t.focus();
      return;
    }
    // A flick: keep scrolling and slow down.
    if (Math.abs(velocity) < 0.05 || performance.now() - lastMoveT > 120) return;
    let v = velocity * 16; // px per frame
    const x = startX;
    const y = lastY;
    const step = () => {
      if (Math.abs(v) < 0.5) return stopMomentum();
      wheel(v, x, y);
      v *= FRICTION;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };
  el.addEventListener("pointerup", up, true);
  el.addEventListener("pointercancel", up, true);
}
