import { NEON, PIXEL, SOLID, TILEGLYPH, badgeSvg, doodleSvg, isoSvg, neonColour, pixelDots, pixelRects, tileColour } from "./iconsets";
// Small line-icon set (24×24 grid, 1.75 stroke, currentColor). Static markup
// only — never built from user data.

const P: Record<string, string> = {
  sessions:
    '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>',
  macros: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  "folder-plus":
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M17 6l3 3M15 8l2 2"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  "split-h": '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  "split-v": '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18M3 12h18"/>',
  paste: '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  import: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  export: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 21h14"/>',
  "win-min": '<path d="M5 12h14"/>',
  "win-max": '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  "win-restore": '<rect x="5" y="8" width="11" height="11" rx="1"/><path d="M8 8V5h11v11h-3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/>',
  "chevron-right": '<path d="m9 6 6 6-6 6"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  bug: '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M12 10v10M8 13H4M20 13h-4M8 17l-3 2M16 17l3 2M8 9 5 7M16 9l3-2M10 6l-1-2M14 6l1-2"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 9"/>',
  "arrow-up": '<path d="M12 19V5M5 12l7-7 7 7"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  serial: '<path d="M9 2v4M15 2v4"/><rect x="6" y="6" width="12" height="7" rx="1.5"/><path d="M12 13v3a3 3 0 0 0 3 3h1a3 3 0 0 1 3 3"/>',
  terminal: '<path d="m5 7 5 5-5 5M12 18h7"/>',
  remote: '<path d="M17 3l4 4-4 4M21 7H8M7 21l-4-4 4-4M3 17h13"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4.1-4-7.4-9-7.4z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="14.5" cy="7" r="1"/><circle cx="17" cy="11" r="1"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  sound: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  logo: '<rect x="2.5" y="3.5" width="19" height="17" rx="3.5"/><path d="m7 9 3.5 3L7 15M12.5 15.5h4.5"/>',
};

export type IconName = keyof typeof P;

/** Emoji for the Emoji icon pack (icons without one keep their outline). */
const EMOJI: Record<string, string> = {
  sessions: "🖥️", macros: "⚡", folder: "📁", "folder-plus": "📂", settings: "⚙️", key: "🔑", lock: "🔒", plus: "➕",
  paste: "📋", copy: "📄", import: "📥", export: "📤", play: "▶️", edit: "✏️", trash: "🗑️", upload: "⬆️", download: "⬇️",
  refresh: "🔄", bug: "🐛", image: "🖼️", file: "📄", link: "🔗", serial: "🔌", terminal: "💻", remote: "🌐", stop: "⏹️",
  shield: "🛡️", palette: "🎨", keyboard: "⌨️", undo: "↩️", sound: "🔊", logo: "🐟", grid: "🔲", "arrow-up": "⬆️",
};

export const ICON_PACKS = ["line", "solid", "pixel", "tiles", "neon", "iso", "badges", "doodle", "emoji"] as const;
export type IconPack = (typeof ICON_PACKS)[number];

export function icon(name: string, size = 16, cls = ""): SVGSVGElement {
  const tpl = document.createElement("template");
  const known = name in P;
  if (known) iconSprite();
  // The line drawing is inline (its thickness follows the slider); the other
  // packs are referenced from one hidden sprite, and CSS shows the chosen one.
  const others = known
    ? ["solid", "pixel", "dot", "tiles", "sketch", "neon", "iso", "badges", "doodle"].map((v) => `<use class="v-${v}" href="#i-${v}-${name}"/>`).join("") + (EMOJI[name] ? `<use class="v-emoji" href="#i-emoji-${name}"/>` : "")
    : "";
  tpl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon ${EMOJI[name] ? "has-em " : ""}${cls}" data-name="${name}"><g class="v-line">${P[name] ?? ""}</g>${others}</svg>`;
  return tpl.content.firstElementChild as SVGSVGElement;
}

/** The icon pack a style uses by default. */
export function iconPackFor(pack: string | undefined, style: string | undefined): IconPack {
  if (pack && (ICON_PACKS as readonly string[]).includes(pack)) return pack as IconPack;
  return (({ standard: "line", glass: "tiles", material: "solid", fluent: "line", dot: "pixel", retro: "pixel", minimal: "line" } as Record<string, IconPack>)[style ?? "standard"] ?? "line");
}

/** Which drawing shows: the pack, or its dots / hand-drawn version. */
export function iconVariant(pack: string | undefined, style: string | undefined, dots: boolean, handDrawn: boolean): string {
  const p = iconPackFor(pack, style);
  if (p === "pixel") return dots || ((pack ?? "style") === "style" && style === "dot") ? "dot" : "pixel";
  if (p === "line") return handDrawn ? "sketch" : "line";
  return p;
}

let sprite = false;
function iconSprite() {
  if (sprite || typeof document === "undefined") return;
  sprite = true;
  const sym = (id: string, body: string, extra = "") => `<symbol id="${id}" viewBox="0 0 24 24"${extra}>${body}</symbol>`;
  let out = `<defs>
    <filter id="i-rough-a" filterUnits="userSpaceOnUse" x="-3" y="-3" width="30" height="30"><feTurbulence type="fractalNoise" baseFrequency="0.22" numOctaves="3" seed="4"/><feDisplacementMap in="SourceGraphic" scale="2.6"/></filter>
    <filter id="i-rough-b" filterUnits="userSpaceOnUse" x="-3" y="-3" width="30" height="30"><feTurbulence type="fractalNoise" baseFrequency="0.3" numOctaves="2" seed="17"/><feDisplacementMap in="SourceGraphic" scale="3.4"/></filter>
    <filter id="i-glow" filterUnits="userSpaceOnUse" x="-4" y="-4" width="32" height="32"><feGaussianBlur stdDeviation="1.1" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <radialGradient id="i-iso-globe" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#8ec5ff"/><stop offset=".6" stop-color="#3b82f6"/><stop offset="1" stop-color="#1e3a8a"/></radialGradient>
    <linearGradient id="i-shine" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient>
  </defs>`;
  for (const name of Object.keys(P)) {
    const line = P[name];
    out += sym(`i-solid-${name}`, `<g fill="currentColor" stroke="none">${SOLID[name] ?? line}</g>`);
    const px = PIXEL[name];
    out += sym(`i-pixel-${name}`, px ? `<g fill="currentColor" stroke="none" shape-rendering="crispEdges">${pixelRects(px)}</g>` : line);
    out += sym(`i-dot-${name}`, px ? `<g fill="currentColor" stroke="none">${pixelDots(px)}</g>` : line);
    out += sym(
      `i-tiles-${name}`,
      `<rect x="1" y="1" width="22" height="22" rx="6.2" fill="${tileColour(name)}" stroke="none"/><rect x="1" y="1" width="22" height="22" rx="6.2" fill="url(#i-shine)" stroke="none"/><g transform="translate(4.6 4.6) scale(.6167)" fill="#fff" stroke="none">${TILEGLYPH[name] ?? line}</g>`,
    );
    out += sym(
      `i-sketch-${name}`,
      `<g filter="url(#i-rough-a)" fill="none" stroke="currentColor" style="stroke-width:calc(var(--icon-w, 1.75) * 1px)" stroke-linecap="round" stroke-linejoin="round">${line}</g><g filter="url(#i-rough-b)" opacity=".6" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" transform="translate(.9 .7) rotate(1.5 12 12)">${line}</g>`,
    );
    const neon = NEON[name];
    const nc = neonColour(name);
    out += sym(`i-neon-${name}`, neon ? `<g fill="none" stroke="${nc}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" filter="url(#i-glow)"><path d="${neon}"/></g><g fill="none" stroke="#fff" stroke-opacity=".9" stroke-width=".7" stroke-linecap="round" stroke-linejoin="round"><path d="${neon}"/></g>` : line);
    out += sym(`i-iso-${name}`, isoSvg(name));
    out += sym(`i-badges-${name}`, badgeSvg(name));
    out += sym(`i-doodle-${name}`, doodleSvg(name));
    if (EMOJI[name])
      out += sym(`i-emoji-${name}`, `<text x="12" y="13" text-anchor="middle" dominant-baseline="central" font-size="18" stroke="none" fill="currentColor" font-family="Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif">${EMOJI[name]}</text>`);
  }
  const tpl = document.createElement("template");
  tpl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true" id="icon-sprite">${out}</svg>`;
  document.body.prepend(tpl.content.firstElementChild!);
}

/** Fill every `[data-icon]` element in the static HTML. */
export function hydrateIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
    const size = Number(el.dataset.iconSize) || 18;
    el.prepend(icon(el.dataset.icon!, size));
  });
}
