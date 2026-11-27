// A loading indicator that matches the interface style: iOS-like spokes for
// Glass, a Material arc, Windows-like orbiting dots for Fluent, blinking dots
// for Dot matrix, an ASCII spinner for Retro, a thin bar for Minimal and a
// ring for Standard. Pure CSS (see looks.css); this only builds the markup.

export type LoaderStyle = "standard" | "glass" | "material" | "fluent" | "dot" | "retro" | "minimal";

/** A loader in the current style (or the one given). `size` is in CSS pixels. */
export function loader(size = 16, style?: LoaderStyle): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "loader";
  el.setAttribute("role", "progressbar");
  el.setAttribute("aria-label", "Loading");
  el.dataset.ld = style ?? ((document.documentElement.dataset.ui as LoaderStyle | undefined) || "standard");
  el.style.setProperty("--ld", `${size}px`);
  for (let i = 0; i < 8; i++) {
    const dot = document.createElement("i");
    dot.style.setProperty("--n", String(i));
    el.append(dot);
  }
  return el;
}
