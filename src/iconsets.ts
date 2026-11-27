// The other icon packs. Each draws every icon its own way:
//   Solid  - filled shapes (24×24)
//   Pixel  - 12×12 pixel art; Dot matrix draws the same art as round dots
//   Tiles  - the line icon in white on a coloured rounded tile
//   Sketch - the line icon drawn twice with a rough pencil filter
// Pure data, unit-tested in iconsets.test.ts.

/** 12×12 pixel art ("#" = on). Fewer than 12 rows are centred vertically. */
export const PIXEL: Record<string, string[]> = {
  sessions: [".##########.", ".#........#.", ".#.##..#..#.", ".#........#.", ".##########.", "............", ".##########.", ".#........#.", ".#.##..#..#.", ".#........#.", ".##########."],
  macros: ["......###...", ".....###....", "....###.....", "...###......", "..########..", "......###...", ".....###....", "....###.....", "...###......", "..##........", ".#.........."],
  folder: [".####.......", ".#..#######.", ".#........#.", ".##########.", ".#........#.", ".#........#.", ".#........#.", ".#........#.", ".##########."],
  "folder-plus": [".####.......", ".#..#######.", ".#........#.", ".##########.", ".#...##...#.", ".#.######.#.", ".#...##...#.", ".#........#.", ".##########."],
  settings: [".....##.....", "..#..##..#..", ".##########.", "..########..", "..###..###..", "####....####", "####....####", "..###..###..", "..########..", ".##########.", "..#..##..#..", ".....##....."],
  key: [".####.......", "##..##......", "#....#######", "##..##..#.##", ".####...#.##"],
  lock: ["....####....", "...#....#...", "...#....#...", "...#....#...", ".##########.", ".##########.", ".####..####.", ".####..####.", ".##########.", ".##########."],
  plus: [".....##.....", ".....##.....", ".....##.....", "..########..", "..########..", ".....##.....", ".....##.....", ".....##....."],
  "split-h": [".##########.", ".#...##...#.", ".#...##...#.", ".#...##...#.", ".#...##...#.", ".#...##...#.", ".#...##...#.", ".#...##...#.", ".#...##...#.", ".##########."],
  "split-v": [".##########.", ".#........#.", ".#........#.", ".#........#.", ".##########.", ".##########.", ".#........#.", ".#........#.", ".#........#.", ".##########."],
  grid: [".####..####.", ".#..#..#..#.", ".#..#..#..#.", ".####..####.", "............", "............", ".####..####.", ".#..#..#..#.", ".#..#..#..#.", ".####..####."],
  paste: ["....####....", ".###.##.###.", ".#........#.", ".#.######.#.", ".#........#.", ".#.######.#.", ".#........#.", ".#.####...#.", ".#........#.", ".#........#.", ".##########."],
  copy: ["....#######.", "....#.....#.", ".#######..#.", ".#.....#..#.", ".#.....#..#.", ".#.....####.", ".#.....#....", ".#.....#....", ".#######...."],
  more: [".##..##..##.", ".##..##..##."],
  import: [".....##.....", ".....##.....", ".....##.....", ".....##.....", "..##.##.##..", "...######...", "....####....", ".....##.....", "#..........#", "#..........#", "############"],
  export: [".....##.....", "....####....", "...######...", "..##.##.##..", ".....##.....", ".....##.....", ".....##.....", ".....##.....", "#..........#", "#..........#", "############"],
  "win-min": ["..########.."],
  "win-max": ["..########..", "..#......#..", "..#......#..", "..#......#..", "..#......#..", "..#......#..", "..#......#..", "..########.."],
  "win-restore": ["....######..", "....#....#..", "....#....#..", "..######.#..", "..#....###..", "..#....#....", "..#....#....", "..######...."],
  x: [".##......##.", "..##....##..", "...##..##...", "....####....", ".....##.....", ".....##.....", "....####....", "...##..##...", "..##....##..", ".##......##."],
  play: ["..#.........", "..##........", "..###.......", "..####......", "..#####.....", "..######....", "..#####.....", "..####......", "..###.......", "..##........", "..#........."],
  edit: [".........##.", "........####", ".......####.", "......####..", ".....####...", "....####....", "...####.....", "..####......", ".####.......", ".###........", ".##........."],
  trash: ["....####....", ".##########.", "............", "..########..", "..#.#..#.#..", "..#.#..#.#..", "..#.#..#.#..", "..#.#..#.#..", "..#.#..#.#..", "..#......#..", "..########.."],
  "chevron-right": ["...##.......", "....##......", ".....##.....", "......##....", "......##....", ".....##.....", "....##......", "...##......."],
  "chevron-down": [".##......##.", "..##....##..", "...##..##...", "....####....", ".....##....."],
  upload: [".....##.....", "....####....", "...######...", "..##.##.##..", ".....##.....", ".....##.....", ".....##.....", ".....##.....", "............", ".##########.", ".##########."],
  download: [".....##.....", ".....##.....", ".....##.....", ".....##.....", "..##.##.##..", "...######...", "....####....", ".....##.....", "............", ".##########.", ".##########."],
  refresh: ["........#...", "....######..", "..##....#...", ".#..........", ".#..........", "#..........#", "#..........#", ".#........#.", ".#........#.", "..##....##..", "....####...."],
  bug: ["..#......#..", "...#....#...", "....####....", "#..######..#", ".#.##..##.#.", "..########..", "####.##.####", "..########..", ".#.######.#.", "#..######..#", "....####...."],
  image: ["############", "#..........#", "#.##.......#", "#.##.......#", "#.......#..#", "#......###.#", "#..#..######", "#.##########", "############"],
  "arrow-up": [".....##.....", "....####....", "...######...", "..##.##.##..", ".#...##...#.", ".....##.....", ".....##.....", ".....##.....", ".....##.....", ".....##....."],
  file: ["..######....", "..#....##...", "..#....###..", "..#......#..", "..#.####.#..", "..#......#..", "..#.####.#..", "..#......#..", "..#.###..#..", "..#......#..", "..########.."],
  link: [".####..####.", "#...#..#...#", "#..######..#", "#...#..#...#", ".####..####."],
  serial: ["...#....#...", "...#....#...", "...#....#...", ".##########.", ".#........#.", ".#........#.", "..#......#..", "...######...", ".....##.....", ".....##.....", ".....##.....", ".....##....."],
  terminal: ["############", "#..........#", "#.#........#", "#..#.......#", "#...#......#", "#..#.......#", "#.#..####..#", "#..........#", "############"],
  remote: ["....####....", "..##.##.##..", ".#..#..#..#.", ".#..#..#..#.", "############", "#...#..#...#", ".#..#..#..#.", ".#..#..#..#.", "..##.##.##..", "....####...."],
  stop: ["..########..", "..########..", "..########..", "..########..", "..########..", "..########..", "..########..", "..########.."],
  shield: [".....##.....", "...##..##...", ".##......##.", ".#........#.", ".#........#.", ".#........#.", ".#........#.", "..#......#..", "...#....#...", "....#..#....", ".....##....."],
  palette: ["...######...", ".##......##.", "#..##......#", "#..##..##..#", "#......##..#", "#.##.......#", "#.##...###..", ".#....#.....", "..####......"],
  keyboard: ["############", "#..........#", "#.#.#.#.#..#", "#..........#", "#.#.#.#.#..#", "#..........#", "#..######..#", "#..........#", "############"],
  undo: ["...#........", "..##........", ".#######....", "..##....##..", "...#......#.", "...........#", "...........#", "..........#.", "........##..", "..######...."],
  sound: ["......#.....", ".....##..#..", "....###...#.", "#######.#..#", "#######..#.#", "#######..#.#", "#######.#..#", "....###...#.", ".....##..#..", "......#....."],
  logo: ["......####..", "#...#######.", "##.#####.###", "###########.", "##.#######..", "#....####..."],
};

/** Filled versions (inside a 24×24 box). */
export const SOLID: Record<string, string> = {
  sessions: '<path fill-rule="evenodd" d="M3 3h18a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm3 3a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM3 13h18a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zm3 3a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/>',
  macros: '<path d="M13.5 1.5 3.5 14h7l-1.5 8.5L20.5 9.5h-7.2z"/>',
  folder: '<path d="M2 6a2 2 0 0 1 2-2h5.2l2 2H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/>',
  "folder-plus": '<path fill-rule="evenodd" d="M2 6a2 2 0 0 1 2-2h5.2l2 2H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zm9 4.5v2.5H8.5v2H11v2.5h2V15h2.5v-2H13v-2.5z"/>',
  settings: '<path fill-rule="evenodd" d="M10.3 2h3.4l.5 2.6 1.6.7 2.2-1.5 2.4 2.4-1.5 2.2.7 1.6 2.6.5v3.4l-2.6.5-.7 1.6 1.5 2.2-2.4 2.4-2.2-1.5-1.6.7-.5 2.6h-3.4l-.5-2.6-1.6-.7-2.2 1.5-2.4-2.4 1.5-2.2-.7-1.6L2 13.7v-3.4l2.6-.5.7-1.6-1.5-2.2 2.4-2.4 2.2 1.5 1.6-.7zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z"/>',
  key: '<path fill-rule="evenodd" d="M7.5 6.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zm0 3.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12.5 10.5H22V14h-2v3h-3v-3h-4.5z"/>',
  lock: '<path fill-rule="evenodd" d="M7 10V8a5 5 0 0 1 10 0v2h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zm2.5 0h5V8a2.5 2.5 0 0 0-5 0zm2.5 4a1.5 1.5 0 0 0-1 2.6V18h2v-1.4a1.5 1.5 0 0 0-1-2.6z"/>',
  plus: '<path d="M10.5 3h3v7.5H21v3h-7.5V21h-3v-7.5H3v-3h7.5z"/>',
  "split-h": '<path fill-rule="evenodd" d="M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm1 3v12h5.5V6zm8.5 0v12H19V6z"/>',
  "split-v": '<path fill-rule="evenodd" d="M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm1 3v4.5h14V6zm0 7.5V18h14v-4.5z"/>',
  grid: '<path d="M4 3h5.5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm10.5 0H20a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-5.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM4 13.5h5.5a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5.5a1 1 0 0 1 1-1zm10.5 0H20a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1h-5.5a1 1 0 0 1-1-1v-5.5a1 1 0 0 1 1-1z"/>',
  paste: '<path fill-rule="evenodd" d="M9 2h6a1 1 0 0 1 1 1v1h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2V3a1 1 0 0 1 1-1zm0 2v1.5h6V4zm-1 6v2h8v-2zm0 4v2h6v-2z"/>',
  copy: '<path d="M8 2h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-1V8a3 3 0 0 0-3-3H6V4a2 2 0 0 1 2-2zM5 7h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/>',
  more: '<circle cx="5" cy="12" r="2.3"/><circle cx="12" cy="12" r="2.3"/><circle cx="19" cy="12" r="2.3"/>',
  import: '<path d="M10.5 2h3v8.5H17L12 16l-5-5.5h3.5zM2 15h3v4h14v-4h3v7H2z"/>',
  export: '<path d="M12 2l5 5.5h-3.5V15h-3V7.5H7zM2 15h3v4h14v-4h3v7H2z"/>',
  "win-min": '<rect x="5" y="11" width="14" height="2" rx="1"/>',
  "win-max": '<path fill-rule="evenodd" d="M5 5h14v14H5zm2 2v10h10V7z"/>',
  "win-restore": '<path fill-rule="evenodd" d="M8 3h13v13h-4v-2h2V5h-9v2H8zM3 8h13v13H3zm2 2v9h9v-9z"/>',
  x: '<path d="M5.6 3.5 12 9.9l6.4-6.4 2.1 2.1-6.4 6.4 6.4 6.4-2.1 2.1-6.4-6.4-6.4 6.4-2.1-2.1L9.9 12 3.5 5.6z"/>',
  play: '<path d="M7 3.6v16.8a1 1 0 0 0 1.5.9l13-8.4a1 1 0 0 0 0-1.8l-13-8.4A1 1 0 0 0 7 3.6z"/>',
  edit: '<path d="M16.5 2.5a2.1 2.1 0 0 1 3 0l2 2a2.1 2.1 0 0 1 0 3L9 20l-6 1.5L4.5 15.5z"/>',
  trash: '<path fill-rule="evenodd" d="M9 2h6l1 2h5v2.5H3V4h5zM4.5 8h15l-1.2 12.2a2 2 0 0 1-2 1.8H7.7a2 2 0 0 1-2-1.8zm5 3v8H11v-8zm3.5 0v8h1.5v-8z"/>',
  "chevron-right": '<path d="M7.9 4.1 10 2l10 10-10 10-2.1-2.1 7.9-7.9z"/>',
  "chevron-down": '<path d="M4.1 5.9 2 8l10 10L22 8l-2.1-2.1-7.9 7.9z"/>',
  upload: '<path d="M12 2l6 6.5h-4V15h-4V8.5H6zM3 18h18v3.5H3z"/>',
  download: '<path d="M10 2h4v6.5h4L12 15 6 8.5h4zM3 18h18v3.5H3z"/>',
  refresh: '<g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 3.5V11h-7.5"/></g>',
  bug: '<path fill-rule="evenodd" d="M9 4.5 7.3 2.8l1.4-1.4 2 2a4 4 0 0 1 2.6 0l2-2 1.4 1.4L15 4.5A4 4 0 0 1 16 7H8a4 4 0 0 1 1-2.5zM6 9h12v5a6 6 0 0 1-12 0zm5 1v10h2V10zM1.5 10H5v2H1.5zm17.5 0h3.5v2H19zM1.5 15h3.7l.3 2h-4zm17.3 0h3.7v2h-4z"/>',
  image: '<path fill-rule="evenodd" d="M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm4.5 3.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM20 17l-5-6-4 5-2.5-2.5L4 18v1h16z"/>',
  "arrow-up": '<path d="M12 2l8 8.5h-5.5V22h-5V10.5H4z"/>',
  file: '<path fill-rule="evenodd" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V9h5.5zM8 12v2h8v-2zm0 4v2h6v-2z"/>',
  link: '<g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></g>',
  serial: '<path d="M8 2h2v5h4V2h2v5h3v4a7 7 0 0 1-6 6.9V22h-2v-4.1A7 7 0 0 1 5 11V7h3z"/>',
  terminal: '<path fill-rule="evenodd" d="M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm2.6 4.5L5.2 9l3 3-3 3 1.4 1.5L11 12zM12 15v2h6v-2z"/>',
  remote: '<path fill-rule="evenodd" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm-1.6 2.2A8 8 0 0 0 4.1 11h3.4a15 15 0 0 1 2.9-6.8zm3.2 0A15 15 0 0 1 16.5 11h3.4a8 8 0 0 0-6.3-6.8zM9.5 11h5A13 13 0 0 0 12 4.6 13 13 0 0 0 9.5 11zm-5.4 2a8 8 0 0 0 6.3 6.8A15 15 0 0 1 7.5 13zm5.4 0A13 13 0 0 0 12 19.4a13 13 0 0 0 2.5-6.4zm7 0a15 15 0 0 1-2.9 6.8 8 8 0 0 0 6.3-6.8z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2.5"/>',
  shield: '<path d="M12 2 4 5v6.5c0 5 3.4 9.3 8 10.5 4.6-1.2 8-5.5 8-10.5V5z"/>',
  palette: '<path fill-rule="evenodd" d="M12 2C6.5 2 2 6.2 2 11.5S6.3 21 11.5 21c1.4 0 2.3-.9 2.3-2.1 0-.6-.2-1-.5-1.4-.3-.4-.5-.8-.5-1.3 0-1.1.9-1.9 2-1.9h2.4c3 0 4.8-2.2 4.8-4.7C22 5.6 17.5 2 12 2zM7 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm3-4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm3 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/>',
  keyboard: '<path fill-rule="evenodd" d="M3 5h18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm2 3v2h2V8zm4 0v2h2V8zm4 0v2h2V8zm4 0v2h2V8zM5 12v2h2v-2zm4 0v2h2v-2zm4 0v2h2v-2zm4 0v2h2v-2zm-10 3.5V17h10v-1.5z"/>',
  undo: '<g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></g>',
  sound: '<path d="M3 9h4l5-4.5v15L7 15H3z"/><g fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></g>',
  logo: '<path fill-rule="evenodd" d="M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm2.6 5L5.2 9.5 8 12l-2.8 2.5L6.6 16l4.3-4zm5.9 6.5v2h5v-2z"/>',
};

/** Tile colours (iOS-like), by icon. Others get one by name. */
const TILE: Record<string, string> = {
  sessions: "#0a84ff", macros: "#ff9f0a", folder: "#64d2ff", "folder-plus": "#64d2ff", settings: "#8e8e93", key: "#ffd60a",
  lock: "#636366", plus: "#30d158", trash: "#ff453a", x: "#ff453a", stop: "#ff453a", bug: "#30d158", palette: "#bf5af2",
  terminal: "#1c1c1e", logo: "#0a84ff", remote: "#5e5ce6", shield: "#34c759", sound: "#ff375f", keyboard: "#8e8e93",
  refresh: "#0a84ff", upload: "#0a84ff", download: "#0a84ff", image: "#ff9f0a", link: "#5e5ce6", serial: "#ac8e68",
};
const SPARE = ["#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#ff375f", "#64d2ff", "#5e5ce6", "#ac8e68"];
export function tileColour(name: string): string {
  if (TILE[name]) return TILE[name];
  let n = 0;
  for (const c of name) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return SPARE[n % SPARE.length];
}

/** Pixel art as rectangles (each pixel is 2×2 in the 24×24 box), merged along rows. */
export function pixelRects(rows: string[]): string {
  const top = Math.floor((12 - rows.length) / 2);
  let out = "";
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      if (row[x] !== "#") {
        x++;
        continue;
      }
      let w = 0;
      while (row[x + w] === "#") w++;
      out += `<rect x="${x * 2}" y="${(y + top) * 2}" width="${w * 2}" height="2"/>`;
      x += w;
    }
  });
  return out;
}

/** The same art as round dots. */
export function pixelDots(rows: string[]): string {
  const top = Math.floor((12 - rows.length) / 2);
  let out = "";
  rows.forEach((row, y) => [...row].forEach((c, x) => c === "#" && (out += `<circle cx="${x * 2 + 1}" cy="${(y + top) * 2 + 1}" r=".85"/>`)));
  return out;
}

// ---------------------------------------------------------------- Neon
/** Neon tubes: their own minimal drawings, glowing in a colour per icon. */
export const NEON: Record<string, string> = {
  sessions: "M5 5h14a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H5M5 14h14a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H8M7.5 7h.01M7.5 16h.01",
  macros: "M13 3 6 13h6l-1 8",
  folder: "M3 8V6a1 1 0 0 1 1-1h5l2 2h9v11a1 1 0 0 1-1 1H4",
  "folder-plus": "M3 8V6a1 1 0 0 1 1-1h5l2 2h9v11a1 1 0 0 1-1 1H4M12 11v5M9.5 13.5h5",
  settings: "M12 8.5a3.5 3.5 0 1 1-3.3 2.3M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M5 19l2-2",
  key: "M12.5 11.5 20 4m-3 3 2.5 2.5M9 19a4 4 0 1 1 0-8 4 4 0 0 1 0 8z",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5zM12 15v2",
  plus: "M12 4v16M4 12h16",
  "split-h": "M3 5h18v14H3zM12 8v8",
  "split-v": "M3 5h18v14H3zM7 12h10",
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  paste: "M9 4h6v3H9zM7 5H5v16h14V5h-2M8 12h8M8 16h5",
  copy: "M9 9h11v11H9zM5 15V4h11",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  import: "M12 3v12m-5-5 5 5 5-5M4 17v3h16v-3",
  export: "M12 15V3m-5 5 5-5 5 5M4 17v3h16v-3",
  "win-min": "M5 12h14",
  "win-max": "M5 5h14v14H5z",
  "win-restore": "M8 4h12v12M4 8h12v12H4z",
  x: "M5 5l14 14M19 5 5 19",
  play: "M7 4v16l13-8z",
  edit: "M4 20l1-5L16 4l4 4L9 19zM14 6l4 4",
  trash: "M4 6h16M9 6V4h6v2M6 6l1 14h10l1-14",
  "chevron-right": "M9 4l8 8-8 8",
  "chevron-down": "M4 8l8 8 8-8",
  upload: "M12 16V4m-5 5 5-5 5 5M4 20h16",
  download: "M12 4v12m-5-5 5 5 5-5M4 20h16",
  refresh: "M20 12a8 8 0 1 1-3-6.2M20 4v5h-5",
  bug: "M8 9a4 4 0 0 1 8 0v6a4 4 0 0 1-8 0zM4 12h4M16 12h4M5 7l3 2M19 7l-3 2M5 18l3-2M19 18l-3-2",
  image: "M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 8.5h.01",
  "arrow-up": "M12 20V4m-7 7 7-7 7 7",
  file: "M6 3h8l5 5v13H6zM14 3v5h5",
  link: "M10 14l4-4M8 11l-2 2a3.5 3.5 0 0 0 5 5l2-2M16 13l2-2a3.5 3.5 0 0 0-5-5l-2 2",
  serial: "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4",
  terminal: "M4 4h16v16H4zM8 9l3 3-3 3M13 15h4",
  remote: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  stop: "M6 6h12v12H6z",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  palette: "M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2s0-2.5 1.5-2.5H18a3 3 0 0 0 3-3C21 7 17 3 12 3zM7.5 11h.01M10 7h.01M14.5 7h.01",
  keyboard: "M2 6h20v12H2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10",
  undo: "M9 15 4 10l5-5M4 10h11a5 5 0 0 1 0 10h-3",
  sound: "M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12",
  logo: "M3 12c3-5 9-6 13-3l4-3v12l-4-3c-4 3-10 2-13-3zM8 11h.01",
};
const NEON_COLOURS = ["#ff4fd8", "#2ef2ff", "#b6ff3b", "#ffb02e", "#a78bfa", "#ff4d6d", "#3dffa8"];
export function neonColour(name: string): string {
  let n = 7;
  for (const c of name) n = (n * 33 + c.charCodeAt(0)) >>> 0;
  return NEON_COLOURS[n % NEON_COLOURS.length];
}

// ---------------------------------------------------------------- Tiles
/** Bold white symbols drawn for the small tiles (fill white unless a stroke is given). */
export const TILEGLYPH: Record<string, string> = {
  sessions: '<path d="M5 5h14a2.5 2.5 0 0 1 0 5H5a2.5 2.5 0 0 1 0-5zm0 9h14a2.5 2.5 0 0 1 0 5H5a2.5 2.5 0 0 1 0-5z"/>',
  macros: '<path d="M14 2 5 13.5h6L9.5 22 19 10h-6z"/>',
  folder: '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2.5 2.5h7A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  "folder-plus": '<path fill-rule="evenodd" d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2.5 2.5h7A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5zM10.8 10v2.3H8.5v2.4h2.3V17h2.4v-2.3h2.3v-2.4h-2.3V10z"/>',
  settings: '<path fill-rule="evenodd" d="M10 2h4l.7 3 2.6 1.5 2.9-1 2 3.5-2.3 2V13l2.3 2-2 3.5-2.9-1L14.7 19l-.7 3h-4l-.7-3-2.6-1.5-2.9 1-2-3.5 2.3-2V11L1.8 9l2-3.5 2.9 1L9.3 5zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>',
  key: '<path fill-rule="evenodd" d="M8 7a5 5 0 1 1 0 10A5 5 0 0 1 8 7zm0 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM12.5 10.5H21v3h-2V16h-3v-2.5h-3.5z"/>',
  lock: '<path d="M6 11h12a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 18 21H6a1.5 1.5 0 0 1-1.5-1.5v-7A1.5 1.5 0 0 1 6 11zm2 0V8a4 4 0 0 1 8 0v3h-2.5V8a1.5 1.5 0 0 0-3 0v3z"/>',
  plus: '<path d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z"/>',
  "split-h": '<rect x="3" y="5" width="7.5" height="14" rx="1.5"/><rect x="13.5" y="5" width="7.5" height="14" rx="1.5"/>',
  "split-v": '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/>',
  grid: '<circle cx="7" cy="7" r="3.5"/><circle cx="17" cy="7" r="3.5"/><circle cx="7" cy="17" r="3.5"/><circle cx="17" cy="17" r="3.5"/>',
  paste: '<path d="M8 3h8v3H8zM5 5h2v2h10V5h2v16H5z"/>',
  copy: '<path d="M8 2h12v12H8zM4 8h2v10h10v2H4z"/>',
  more: '<circle cx="5" cy="12" r="2.7"/><circle cx="12" cy="12" r="2.7"/><circle cx="19" cy="12" r="2.7"/>',
  import: '<path d="M10 3h4v7h4l-6 6-6-6h4zM3 17h4v2h10v-2h4v4H3z"/>',
  export: '<path d="M12 3l6 6h-4v6h-4V9H6zM3 17h4v2h10v-2h4v4H3z"/>',
  "win-min": '<rect x="4" y="10.5" width="16" height="3" rx="1.5"/>',
  "win-max": '<path fill-rule="evenodd" d="M4 4h16v16H4zm3 3v10h10V7z"/>',
  "win-restore": '<path d="M8 3h13v13h-3V6H8zM3 8h13v13H3z"/>',
  x: '<path d="M6.3 3.5 12 9.2l5.7-5.7 2.8 2.8-5.7 5.7 5.7 5.7-2.8 2.8-5.7-5.7-5.7 5.7-2.8-2.8 5.7-5.7-5.7-5.7z"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  edit: '<path d="M15 3l6 6L10 20H4v-6z"/>',
  trash: '<path d="M8 3h8v2h4v3H4V5h4zM5.5 9h13L17 21H7z"/>',
  "chevron-right": '<path d="M8 3l9 9-9 9-2.5-2.5L12 12 5.5 5.5z"/>',
  "chevron-down": '<path d="M3 8l9 9 9-9-2.5-2.5L12 12 5.5 5.5z"/>',
  upload: '<path d="M12 2l7 7h-5v7h-4V9H5zM4 18h16v3H4z"/>',
  download: '<path d="M10 2h4v7h5l-7 7-7-7h5zM4 18h16v3H4z"/>',
  refresh: '<path d="M19 12a7 7 0 1 1-2.1-5" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/><path d="M21 3v7h-7z"/>',
  bug: '<ellipse cx="12" cy="13.5" rx="5" ry="6.5"/><path d="M9 6a3 3 0 0 1 6 0z"/><path d="M3 10l4 1.5M21 10l-4 1.5M3 18l4-1.5M21 18l-4-1.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>',
  image: '<circle cx="8" cy="8" r="2.5"/><path d="M2 19l6-7 4 4 3-3 7 6z"/>',
  "arrow-up": '<path d="M12 2l8 8h-5v12H9V10H4z"/>',
  file: '<path d="M5 2h8.5v6H19v14H5zM15 2.5 18.5 6H15z"/>',
  link: '<g transform="rotate(-45 12 12)" fill="none" stroke="#fff" stroke-width="2.8"><rect x="2.5" y="8.5" width="10" height="7" rx="3.5"/><rect x="11.5" y="8.5" width="10" height="7" rx="3.5"/></g>',
  serial: '<path d="M8 2h2v5h4V2h2v5h3v3a7 7 0 0 1-5.5 6.8V22h-3v-5.2A7 7 0 0 1 5 10V7h3z"/>',
  terminal: '<path d="M4 6l6 6-6 6" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 16.5h8v3h-8z"/>',
  remote: '<g fill="none" stroke="#fff" stroke-width="2.4"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3.5 3.5 3.5 14.5 0 18M12 3c-3.5 3.5-3.5 14.5 0 18"/></g>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="3"/>',
  shield: '<path d="M12 2l9 3.5v6c0 5.5-4 9.5-9 10.5-5-1-9-5-9-10.5v-6z"/>',
  palette: '<path fill-rule="evenodd" d="M12 3a9 9 0 0 0 0 18c1.6 0 2.2-1.2 1.6-2.4-.7-1.4.2-2.6 1.8-2.6H18a3 3 0 0 0 3-3c0-5.5-4-10-9-10zM7.5 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm3-4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/>',
  keyboard: '<path fill-rule="evenodd" d="M2 6h20v12H2zm3 3v2h2V9zm4 0v2h2V9zm4 0v2h2V9zm4 0v2h2V9zM7 13v2h10v-2z"/>',
  undo: '<path d="M10 4 3 10l7 6v-4h4.5a3.5 3.5 0 0 1 0 7H12v3h2.5a6.5 6.5 0 0 0 0-13H10z"/>',
  sound: '<path d="M3 9h4l6-5v16l-6-5H3z"/><path d="M16 8.5a5 5 0 0 1 0 7M19 5.5a9 9 0 0 1 0 13" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>',
  logo: '<path fill-rule="evenodd" d="M2 12c3-5.5 10-7 15-3l5-3.5v13L17 15c-5 4-12 2.5-15-3zm5.5-1.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z"/>',
};

// ---------------------------------------------------------------- Badges
/** Letter marks: [label, shape]. Shapes group the icons: actions are round, system things hexagons, documents rounded squares, window and navigation pills. */
export const BADGE: Record<string, [string, "circle" | "hex" | "square" | "pill"]> = {
  sessions: ["SV", "hex"], macros: ["MC", "square"], folder: ["FO", "square"], "folder-plus": ["F+", "square"], settings: ["ST", "hex"],
  key: ["KY", "hex"], lock: ["LK", "hex"], plus: ["+", "circle"], "split-h": ["||", "pill"], "split-v": ["=", "pill"], grid: ["#", "pill"],
  paste: ["PS", "circle"], copy: ["CP", "circle"], more: ["···", "pill"], import: ["IN", "circle"], export: ["EX", "circle"],
  "win-min": ["–", "pill"], "win-max": ["MX", "pill"], "win-restore": ["RS", "pill"], x: ["×", "circle"], play: ["GO", "circle"],
  edit: ["ED", "circle"], trash: ["DL", "circle"], "chevron-right": ["›", "pill"], "chevron-down": ["v", "pill"], upload: ["UP", "circle"],
  download: ["DN", "circle"], refresh: ["RF", "circle"], bug: ["BG", "hex"], image: ["IM", "square"], "arrow-up": ["↑", "pill"],
  file: ["FL", "square"], link: ["LN", "square"], serial: ["SR", "hex"], terminal: [">_", "hex"], remote: ["RM", "hex"], stop: ["■", "circle"],
  shield: ["SH", "hex"], palette: ["PL", "square"], keyboard: ["KB", "square"], undo: ["UN", "circle"], sound: ["SD", "square"], logo: ["SK", "hex"],
};
const BADGE_COLOURS: Record<string, string> = { circle: "#e8590c", hex: "#1971c2", square: "#2f9e44", pill: "#6741d9" };
export function badgeSvg(name: string): string {
  const [label, shape] = BADGE[name];
  const c = BADGE_COLOURS[shape];
  const ring = 'fill="none" stroke="#fff" stroke-opacity=".38" stroke-width=".8"';
  const hex = (r: number) => Array.from({ length: 6 }, (_, i) => `${(12 + r * Math.cos((Math.PI / 3) * i + Math.PI / 6)).toFixed(2)},${(12 + r * Math.sin((Math.PI / 3) * i + Math.PI / 6)).toFixed(2)}`).join(" ");
  const base =
    shape === "circle" ? `<circle cx="12" cy="12" r="10.8" fill="${c}"/><circle cx="12" cy="12" r="9" ${ring}/>`
    : shape === "hex" ? `<polygon points="${hex(11.5)}" fill="${c}"/><polygon points="${hex(9.6)}" ${ring}/>`
    : shape === "square" ? `<rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="${c}"/><rect x="3.3" y="3.3" width="17.4" height="17.4" rx="3.6" ${ring}/>`
    : `<rect x="1" y="5" width="22" height="14" rx="7" fill="${c}"/><rect x="2.6" y="6.6" width="18.8" height="10.8" rx="5.4" ${ring}/>`;
  const size = [...label].length > 1 ? 9.2 : 13;
  return `${base}<text x="12" y="12.7" text-anchor="middle" dominant-baseline="central" font-family="Segoe UI, Arial, sans-serif" font-weight="800" font-size="${size}" letter-spacing="-.4" fill="#fff" stroke="none">${label}</text>`;
}

// ---------------------------------------------------------------- Doodle
/** Hand-drawn cartoon stickers: shapes with a colour fill that's slightly off, and faces on some. */
export const DOODLE: Record<string, [string, string][]> = {
  sessions: [["M4 4.5h16v6H4z", "b"], ["M4 13.5h16v6H4z", "b"], ["M8 7.1v.8M11 7.1v.8", ""], ["M14 7.6q1.5 1.2 3 0", ""], ["M7.5 16.5h1.5M10.5 16.5h1.5", ""], ["M14.5 16.8q1.2.6 2.4 0", ""]],
  macros: [["M13 2.5 5.5 13h5.5l-1.5 8.5 8-11.5h-5.5z", "y"], ["M3 6l2 1M2.5 10h2", ""]],
  folder: [["M3 7.5c0-1 .5-2 1.5-2H9l1.8 2h8.7c1 0 1.5.8 1.5 1.8V18c0 1-.6 1.5-1.5 1.5h-15C3.6 19.5 3 19 3 18z", "y"], ["M9 12.8v.8M14.5 12.8v.8", ""], ["M10 15.8q1.8 1.4 3.6 0", ""]],
  "folder-plus": [["M3 7.5c0-1 .5-2 1.5-2H9l1.8 2h8.7c1 0 1.5.8 1.5 1.8V18c0 1-.6 1.5-1.5 1.5h-15C3.6 19.5 3 19 3 18z", "y"], ["M13.5 16a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0", "g"], ["M17 14.3v3.4M15.3 16h3.4", ""]],
  settings: [["M12 3.5l1.6 2 2.4-.6.6 2.4 2.3.9-.7 2.4 1.6 1.8-1.6 1.8.7 2.4-2.3.9-.6 2.4-2.4-.6-1.6 2-1.6-2-2.4.6-.6-2.4-2.3-.9.7-2.4L3.4 12 5 10.2l-.7-2.4 2.3-.9.6-2.4 2.4.6z", "v"], ["M9.8 12a2.2 2.2 0 1 0 4.4 0 2.2 2.2 0 1 0-4.4 0", ""]],
  key: [["M4 13.5a4 4 0 1 0 8 0 4 4 0 1 0-8 0", "o"], ["M11.5 12l9-.2v2.5h-2v2.2h-2.4v-2.2h-4.6", "o"], ["M6.8 13.5h.1", ""]],
  lock: [["M5.5 11h13v9.5h-13z", "y"], ["M8 11V8.2a4 4 0 0 1 8 0V11", ""], ["M10 14.3v.7M14 14.3v.7", ""], ["M10.5 17.6q1.5-1 3 0", ""]],
  plus: [["M10 3.5h4v6.5h6.5v4H14v6.5h-4V14H3.5v-4H10z", "g"]],
  "split-h": [["M3 4.5h8v15H3z", "b"], ["M13 4.5h8v15h-8z", "p"]],
  "split-v": [["M3.5 3h17v8h-17z", "b"], ["M3.5 13h17v8h-17z", "p"]],
  grid: [["M3 3.5h7.5v7H3z", "b"], ["M13.5 3h7.5v7.5h-7.5z", "p"], ["M3.5 13.5H11V21H3.5z", "g"], ["M13.5 13.5H21V21h-7.5z", "y"]],
  paste: [["M5 5h14v16H5z", "w"], ["M9 3h6v3.5H9z", "o"], ["M8 10.5h8M8 13.5h8M8 16.5h5", ""]],
  copy: [["M8.5 3h11.5v12H8.5z", "b"], ["M4 8h11.5v13H4z", "w"], ["M6.5 12h6M6.5 15h6", ""]],
  more: [["M3 12a2 2 0 1 0 4 0 2 2 0 1 0-4 0", "p"], ["M10 12a2 2 0 1 0 4 0 2 2 0 1 0-4 0", "g"], ["M17 12a2 2 0 1 0 4 0 2 2 0 1 0-4 0", "b"]],
  import: [["M3 15h18v5.5H3z", "b"], ["M12 3v10.5m-4.5-4.5L12 13.5 16.5 9", ""]],
  export: [["M3 15h18v5.5H3z", "o"], ["M12 13V3M7.5 7.5 12 3l4.5 4.5", ""]],
  "win-min": [["M5 12.2q7-1 14 0", ""]],
  "win-max": [["M5 5q7-.6 14 0 .6 7 0 14-7 .6-14 0-.6-7 0-14z", "w"]],
  "win-restore": [["M8 4h12v12", ""], ["M4 8.5h11.5V20H4z", "w"]],
  x: [["M3.5 12a8.5 8.5 0 1 0 17 0 8.5 8.5 0 1 0-17 0", "r"], ["M8 8q4 4.2 8 8M16 8q-4.2 4-8 8", ""]],
  play: [["M7 4.5l12.5 7.5L7 19.5z", "g"], ["M2.5 9h2M2.5 15h2", ""]],
  edit: [["M5 19l1-4.5L16.5 4l3.5 3.5L9.5 18z", "y"], ["M5 19l1-4.5 3.5 3.5z", "w"], ["M14.5 6l3.5 3.5", ""], ["M3.5 21.5q4-1 8 0", ""]],
  trash: [["M6 7.5h12l-1.2 13H7.2z", "w"], ["M4 7h16", ""], ["M9.5 7V4.5h5V7", ""], ["M10 11v6M14 11v6", ""]],
  "chevron-right": [["M8.5 4.5l8 7.5-8 7.5", ""]],
  "chevron-down": [["M4.5 8.5l7.5 8 7.5-8", ""]],
  upload: [["M7 18a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.7-1.2A4 4 0 0 1 17.5 18z", "b"], ["M12 16.5v-6m-2.5 2.5L12 10.5l2.5 2.5", ""]],
  download: [["M7 18a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.7-1.2A4 4 0 0 1 17.5 18z", "b"], ["M12 10v6m-2.5-2.5L12 16l2.5-2.5", ""]],
  refresh: [["M5 12a7 7 0 1 0 14 0 7 7 0 1 0-14 0", "g"], ["M17 7.5A6.5 6.5 0 1 0 18.5 13", ""], ["M18 3.5V8h-4.5", ""]],
  bug: [["M5.5 13.5a6.5 6.5 0 1 0 13 0 6.5 6.5 0 1 0-13 0", "r"], ["M9 7.5a3 3 0 0 1 6 0", ""], ["M12 7.5v12.5", ""], ["M9 12h.1M15 12h.1M9.5 16h.1M14.5 16h.1", ""], ["M8.5 5 7 3M15.5 5 17 3", ""]],
  image: [["M3 4.5h18v15H3z", "w"], ["M3 19.5V17l5-5.5 4 4 3-3 6 5.5v1.5z", "g"], ["M15 8a1.8 1.8 0 1 0 3.6 0 1.8 1.8 0 1 0-3.6 0", "y"]],
  "arrow-up": [["M12 20.5V4.5", ""], ["M6 10.5l6-6.5 6 6.5", ""], ["M9 22q3-1.5 6 0", ""]],
  file: [["M6 2.8h8.5L19 7.5v13.7H6z", "w"], ["M14.5 2.8v4.7H19", ""], ["M8.5 11h7M8.5 14h7M8.5 17h4.5", ""]],
  link: [["M9.5 14.5l5-5", ""], ["M10.8 7.2l1.6-1.6a3.8 3.8 0 0 1 5.4 5.4l-1.6 1.6", ""], ["M13.2 16.8l-1.6 1.6a3.8 3.8 0 0 1-5.4-5.4l1.6-1.6", ""]],
  serial: [["M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0z", "o"], ["M9.5 3.5V8M14.5 3.5V8", ""], ["M12 17v4.5", ""], ["M19 4l1-1M20.5 7H22", ""]],
  terminal: [["M3 4.5h18v15H3z", "v"], ["M7 9.5l3 2.5-3 2.5", ""], ["M12.5 15H17", ""]],
  remote: [["M3.5 12a8.5 8.5 0 1 0 17 0 8.5 8.5 0 1 0-17 0", "b"], ["M7.5 7.5q2.5-1 3.5 1.5t-1.5 3.5-2.5-1.5z", "g"], ["M13.5 13q2-.5 3 1.5t-2 3-1.5-2z", "g"]],
  stop: [["M5.5 5.5h13v13h-13z", "r"]],
  shield: [["M12 3l7.5 3v5.5c0 4.5-3 8-7.5 9.5-4.5-1.5-7.5-5-7.5-9.5V6z", "g"], ["M8.5 12l2.5 2.5 4.5-5", ""]],
  palette: [["M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 1.9-1 1.4-2-.6-1.2.1-2.3 1.5-2.3h2.6a3 3 0 0 0 3-3c0-5.3-3.8-9.7-8.5-9.7z", "w"], ["M7 11.5a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 1 0-2.6 0", "r"], ["M9.5 7.2a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 1 0-2.6 0", "y"], ["M14 7.2a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 1 0-2.6 0", "b"]],
  keyboard: [["M2.5 6.5h19v11h-19z", "w"], ["M6 10h.1M9.5 10h.1M13 10h.1M16.5 10h.1M7.5 14h9", ""]],
  undo: [["M9 14.5 4.5 10 9 5.5", ""], ["M4.5 10h10a5 5 0 0 1 0 10H12", ""]],
  sound: [["M3.5 9h4l5-4v14l-5-4h-4z", "o"], ["M15.5 9q1.8 3 0 6M18.5 6.5q3.5 5.5 0 11", ""]],
  logo: [["M3 12c3-5 9.5-6 13-2.5l4.5-3v11l-4.5-3c-3.5 3.5-10 2.5-13-2.5z", "b"], ["M7.5 11h.1", ""], ["M10 13q1 .8 2 0", ""]],
};
const DOODLE_FILL: Record<string, string> = { y: "#ffd166", b: "#74c0fc", p: "#f783ac", g: "#8ce99a", o: "#ffa94d", v: "#b197fc", r: "#ff8787", w: "#dee2e6" };
export function doodleSvg(name: string): string {
  return DOODLE[name]
    .map(([d, f]) =>
      (f ? `<path d="${d}" fill="${DOODLE_FILL[f]}" stroke="none" transform="translate(.9 .8)"/>` : "") +
      `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" filter="url(#i-rough-a)"/>`,
    )
    .join("");
}

// ---------------------------------------------------------------- Isometric 3D
// Small 3D objects in isometric view, built from boxes, standing extruded
// shapes, flat shapes on faces, tubes and dots. Units: x, y and z run 0..10.
type P2 = [number, number];
type P3 = [number, number, number];
type IsoPart =
  | { b: [number, number, number, number, number, number]; c: string } // box x, y, z, width, depth, height
  | { s: P2[]; y: number; d: number; c: string } // shape in (x, z), standing, from y to y+d
  | { f: P2[]; y: number; c: string } // flat shape in (x, z) on the plane at y
  | { t: P2[]; z: number; c: string } // flat shape in (x, y) on the plane at height z
  | { tube: P3[]; c: string; w: number }
  | { dot: P3; r: number; c: string }
  | { raw: string };

const ISO_C: Record<string, string> = {
  B: "#4c8bf5", Y: "#f6c343", R: "#ef5350", G: "#43c463", O: "#ff9f43", V: "#9b7bf7", K: "#3a3f52",
  W: "#e9edf2", S: "#aab4c0", T: "#2ec4b6", P: "#f472b6", L: "#a3e635", D: "#16303a",
};
const proj = ([x, y, z]: P3): P2 => [12 + (x - y) * 0.95, 9.6 + (x + y) * 0.52 - z];
const shade = (hex: string, f: number) => {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.round(f >= 1 ? v + (255 - v) * (f - 1) : v * f).toString(16).padStart(2, "0");
  return `#${ch(n >> 16)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
};
let seen: P2[] = [];
const poly = (pts: P2[], fill: string) => (seen.push(...pts), "") + `<path d="M${pts.map(([a, b]) => `${a.toFixed(2)} ${b.toFixed(2)}`).join("L")}Z" fill="${fill}" stroke="${shade(fill, 0.62)}" stroke-width=".3" stroke-linejoin="round"/>`;
const ring = (cx: number, cy: number, rx: number, ry = rx, n = 18): P2[] => Array.from({ length: n }, (_, i) => [cx + rx * Math.cos((2 * Math.PI * i) / n), cy + ry * Math.sin((2 * Math.PI * i) / n)]);
const arcBand = (cx: number, cz: number, ro: number, ri: number, a0: number, a1: number, n = 14): P2[] => {
  const at = (r: number, a: number): P2 => [cx + r * Math.cos((a * Math.PI) / 180), cz + r * Math.sin((a * Math.PI) / 180)];
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) out.push(at(ro, a0 + ((a1 - a0) * i) / n));
  for (let i = n; i >= 0; i--) out.push(at(ri, a0 + ((a1 - a0) * i) / n));
  return out;
};
const gear = (cx: number, cz: number, ro: number, ri: number, teeth: number): P2[] => {
  const out: P2[] = [];
  for (let i = 0; i < teeth * 4; i++) {
    const a = (Math.PI * 2 * i) / (teeth * 4);
    const r = i % 4 < 2 ? ro : ri;
    out.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
  }
  return out;
};
const rect = (x0: number, z0: number, x1: number, z1: number): P2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

function isoPart(p: IsoPart): string {
  if ("raw" in p) return p.raw;
  if ("dot" in p) {
    const [x, y] = proj(p.dot);
    seen.push([x - p.r, y - p.r], [x + p.r, y + p.r]);
    return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${p.r}" fill="${ISO_C[p.c] ?? p.c}"/>`;
  }
  if ("tube" in p) {
    p.tube.forEach((q) => { const [a, b] = proj(q); seen.push([a - p.w / 2, b - p.w / 2], [a + p.w / 2, b + p.w / 2]); });
    const d = "M" + p.tube.map((q) => proj(q).map((v) => v.toFixed(2)).join(" ")).join("L");
    const c = ISO_C[p.c] ?? p.c;
    return `<path d="${d}" fill="none" stroke="${shade(c, 0.7)}" stroke-width="${p.w}" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="${shade(c, 1.25)}" stroke-width="${(p.w * 0.4).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" transform="translate(-.15 -.2)"/>`;
  }
  const c = ISO_C[(p as { c: string }).c] ?? (p as { c: string }).c;
  if ("t" in p) return poly(p.t.map(([x, y]) => proj([x, y, p.z])), c);
  if ("f" in p) return poly(p.f.map(([x, z]) => proj([x, p.y, z])), c);
  if ("b" in p) {
    const [x0, y0, z0, w, d, h] = p.b;
    const [x1, y1, z1] = [x0 + w, y0 + d, z0 + h];
    return (
      poly([proj([x1, y0, z0]), proj([x1, y1, z0]), proj([x1, y1, z1]), proj([x1, y0, z1])], shade(c, 0.68)) +
      poly([proj([x0, y1, z0]), proj([x1, y1, z0]), proj([x1, y1, z1]), proj([x0, y1, z1])], c) +
      poly([proj([x0, y0, z1]), proj([x1, y0, z1]), proj([x1, y1, z1]), proj([x0, y1, z1])], shade(c, 1.2))
    );
  }
  // Standing shape: sides that face the viewer, then the front.
  let pts = p.s;
  const area = pts.reduce((a, [x, z], i) => { const [x2, z2] = pts[(i + 1) % pts.length]; return a + x * z2 - x2 * z; }, 0);
  if (area < 0) pts = [...pts].reverse();
  const y0 = p.y;
  const y1 = p.y + p.d;
  const sides: { depth: number; svg: string }[] = [];
  pts.forEach(([x, z], i) => {
    const [x2, z2] = pts[(i + 1) % pts.length];
    const nx = z2 - z;
    const nz = -(x2 - x);
    if (nx <= 0.001 && nz <= 0.001) return;
    const len = Math.hypot(nx, nz) || 1;
    const f = 0.68 + 0.52 * (Math.max(0, nz) / len) * (Math.max(0, nz) / (Math.max(0, nx) + Math.max(0, nz) || 1));
    sides.push({ depth: (x + x2) / 2 + (z + z2) / 2, svg: poly([proj([x, y0, z]), proj([x2, y0, z2]), proj([x2, y1, z2]), proj([x, y1, z])], shade(c, f)) });
  });
  sides.sort((a, b) => a.depth - b.depth);
  return sides.map((s) => s.svg).join("") + poly(pts.map(([x, z]) => proj([x, y1, z])), c);
}

const arrowUp: P2[] = [[3.8, 2.5], [6.2, 2.5], [6.2, 6], [8, 6], [5, 9], [2, 6], [3.8, 6]];
const arrowDown: P2[] = [[3.8, 9], [6.2, 9], [6.2, 5.5], [8, 5.5], [5, 2.5], [2, 5.5], [3.8, 5.5]];
const folderShape: P2[] = [[0.5, 0], [9.5, 0], [9.5, 7], [4.5, 7], [3.5, 8.2], [0.5, 8.2]];
const shackle: P3[] = [[2.7, 4.5, 5.5], ...Array.from({ length: 13 }, (_, i): P3 => [5 - 2.3 * Math.cos((Math.PI * i) / 12), 4.5, 7 + 2.3 * Math.sin((Math.PI * i) / 12)]), [7.3, 4.5, 5.5]];

export const ISO: Record<string, IsoPart[]> = {
  sessions: [{ b: [1, 1.5, 0, 8, 7, 2.4], c: "B" }, { b: [1, 1.5, 3.2, 8, 7, 2.4], c: "B" }, { dot: [9, 3, 1.2], r: 0.55, c: "L" }, { dot: [9, 4.6, 1.2], r: 0.55, c: "L" }, { dot: [9, 3, 4.4], r: 0.55, c: "L" }, { dot: [9, 4.6, 4.4], r: 0.55, c: "O" }],
  macros: [{ s: [[6.5, 9], [2, 4.2], [5, 4.2], [3.5, 0], [8.5, 5.2], [5.5, 5.2], [7.5, 9]], y: 3, d: 3, c: "Y" }],
  folder: [{ s: folderShape, y: 3, d: 2.5, c: "Y" }],
  "folder-plus": [{ s: folderShape, y: 3, d: 2.5, c: "Y" }, { f: rect(4.3, 2, 5.7, 6), y: 5.5, c: "W" }, { f: rect(3, 3.3, 7, 4.7), y: 5.5, c: "W" }],
  settings: [{ s: gear(5, 4.5, 4.4, 3.3, 8), y: 3, d: 2.5, c: "S" }, { f: ring(5, 4.5, 1.5), y: 5.5, c: "K" }],
  key: [{ s: rect(5, 4.3, 10, 5.7), y: 3, d: 2.2, c: "Y" }, { s: rect(8.3, 2.6, 9.3, 4.3), y: 3, d: 2.2, c: "Y" }, { s: rect(6.6, 3, 7.5, 4.3), y: 3, d: 2.2, c: "Y" }, { s: ring(2.8, 5, 2.6), y: 3, d: 2.2, c: "Y" }, { f: ring(2.8, 5, 1), y: 5.2, c: "K" }],
  lock: [{ tube: shackle, c: "S", w: 1.4 }, { b: [1.8, 2.5, 0, 6.4, 4, 5.8], c: "Y" }, { f: ring(5, 3.4, 0.75), y: 6.5, c: "K" }, { f: rect(4.7, 1.4, 5.3, 3.2), y: 6.5, c: "K" }],
  plus: [{ s: [[3.8, 0], [6.2, 0], [6.2, 3.3], [9.5, 3.3], [9.5, 5.7], [6.2, 5.7], [6.2, 9], [3.8, 9], [3.8, 5.7], [0.5, 5.7], [0.5, 3.3], [3.8, 3.3]], y: 3, d: 2.5, c: "G" }],
  "split-h": [{ b: [0.5, 0.5, 0, 4.2, 9, 3], c: "B" }, { b: [5.3, 0.5, 0, 4.2, 9, 3], c: "P" }],
  "split-v": [{ b: [0.5, 0.5, 0, 9, 4.2, 3], c: "B" }, { b: [0.5, 5.3, 0, 9, 4.2, 3], c: "P" }],
  grid: [{ b: [0.6, 0.6, 0, 3.8, 3.8, 3.8], c: "B" }, { b: [5.4, 0.6, 0, 3.8, 3.8, 3.8], c: "P" }, { b: [0.6, 5.4, 0, 3.8, 3.8, 3.8], c: "G" }, { b: [5.4, 5.4, 0, 3.8, 3.8, 3.8], c: "Y" }],
  paste: [{ b: [1, 1, 0, 8, 9, 1], c: "O" }, { t: [[2, 2.6], [8, 2.6], [8, 9], [2, 9]], z: 1, c: "W" }, { t: [[3, 4.5], [7, 4.5], [7, 5.1], [3, 5.1]], z: 1, c: "K" }, { t: [[3, 6.3], [7, 6.3], [7, 6.9], [3, 6.9]], z: 1, c: "K" }, { b: [3.5, 0.6, 1, 3, 2, 1], c: "S" }],
  copy: [{ b: [2.6, 0.4, 0, 7, 7, 1], c: "W" }, { b: [0.4, 2.6, 1.6, 7, 7, 1], c: "B" }],
  more: [{ b: [0.5, 4, 0, 2.2, 2.2, 2.2], c: "P" }, { b: [3.9, 4, 0, 2.2, 2.2, 2.2], c: "V" }, { b: [7.3, 4, 0, 2.2, 2.2, 2.2], c: "B" }],
  import: [{ b: [0.5, 0.5, 0, 9, 9, 1.6], c: "S" }, { s: arrowDown, y: 3.8, d: 2.4, c: "G" }],
  export: [{ b: [0.5, 0.5, 0, 9, 9, 1.6], c: "S" }, { s: arrowUp, y: 3.8, d: 2.4, c: "O" }],
  "win-min": [{ b: [1, 4, 0, 8, 2, 1.2], c: "S" }],
  "win-max": [{ b: [1, 1, 0, 8, 1.2, 1.2], c: "S" }, { b: [1, 1, 0, 1.2, 8, 1.2], c: "S" }, { b: [7.8, 1, 0, 1.2, 8, 1.2], c: "S" }, { b: [1, 7.8, 0, 8, 1.2, 1.2], c: "S" }],
  "win-restore": [{ b: [3, 0.5, 0, 6.5, 6.5, 0.8], c: "S" }, { b: [0.5, 3, 1.4, 6.5, 6.5, 0.8], c: "W" }],
  x: [{ s: [[1, 0], [2.8, 0], [5, 3], [7.2, 0], [9, 0], [6, 4.5], [9, 9], [7.2, 9], [5, 6], [2.8, 9], [1, 9], [4, 4.5]], y: 3, d: 2.5, c: "R" }],
  play: [{ s: [[1.5, 0], [9, 4.5], [1.5, 9]], y: 3, d: 2.5, c: "G" }],
  edit: [{ b: [0.5, 4, 0, 6.8, 2, 2], c: "Y" }, { s: [[7.3, 0], [10, 1], [7.3, 2]], y: 4, d: 2, c: "W" }, { b: [0, 4, 0, 0.6, 2, 2], c: "P" }],
  trash: [{ b: [2, 2, 0, 6, 6, 5.6], c: "S" }, { f: rect(3.5, 1, 4.1, 4.6), y: 8, c: "K" }, { f: rect(5.7, 1, 6.3, 4.6), y: 8, c: "K" }, { b: [1.2, 1.2, 5.6, 7.6, 7.6, 0.9], c: "S" }, { b: [3.8, 4.2, 6.5, 2.4, 1.6, 0.6], c: "S" }],
  "chevron-right": [{ s: [[1.5, 0.5], [9, 4.5], [1.5, 8.5], [1.5, 6], [5.5, 4.5], [1.5, 3]], y: 3, d: 2.5, c: "B" }],
  "chevron-down": [{ s: [[0.5, 8.5], [5, 0.5], [9.5, 8.5], [7, 8.5], [5, 4.5], [3, 8.5]], y: 3, d: 2.5, c: "B" }],
  upload: [{ b: [0.5, 0.5, 0, 9, 9, 1.2], c: "S" }, { s: arrowUp, y: 3.8, d: 2.4, c: "B" }],
  download: [{ b: [0.5, 0.5, 0, 9, 9, 1.2], c: "S" }, { s: arrowDown, y: 3.8, d: 2.4, c: "B" }],
  refresh: [{ s: arcBand(5, 4.5, 4.3, 2.8, 50, 330), y: 3, d: 2.4, c: "G" }, { s: [[8.6, 8.3], [9.9, 5.2], [6.6, 5.3]], y: 3, d: 2.4, c: "G" }],
  bug: [{ tube: [[2.5, 5, 3.5], [0.5, 5, 1.5]], c: "K", w: 0.8 }, { tube: [[7.5, 5, 3.5], [9.5, 5, 1.5]], c: "K", w: 0.8 }, { tube: [[2.3, 5, 5.5], [0.3, 5, 6.5]], c: "K", w: 0.8 }, { tube: [[7.7, 5, 5.5], [9.7, 5, 6.5]], c: "K", w: 0.8 }, { s: ring(5, 8.6, 1.6), y: 3.5, d: 2.5, c: "K" }, { s: ring(5, 4.5, 3.2, 3.8), y: 3, d: 3, c: "R" }, { f: rect(4.85, 0.8, 5.15, 8.2), y: 6, c: "K" }, { f: ring(3.6, 5.5, 0.6), y: 6, c: "K" }, { f: ring(6.4, 3.6, 0.6), y: 6, c: "K" }],
  image: [{ s: rect(0.5, 0, 9.5, 8), y: 4, d: 1, c: "W" }, { f: rect(1.2, 0.7, 8.8, 7.3), y: 5, c: "B" }, { f: [[1.2, 0.7], [4, 4.5], [5.8, 2.6], [7, 3.8], [8.8, 0.7]], y: 5, c: "G" }, { f: ring(7, 6, 0.9), y: 5, c: "Y" }],
  "arrow-up": [{ s: [[3.8, 0], [6.2, 0], [6.2, 5], [8.5, 5], [5, 9], [1.5, 5], [3.8, 5]], y: 3, d: 2.5, c: "B" }],
  file: [{ s: [[1.5, 0], [8.5, 0], [8.5, 6.5], [6, 9], [1.5, 9]], y: 3.5, d: 1.2, c: "W" }, { f: [[6, 9], [6, 6.5], [8.5, 6.5]], y: 4.7, c: "S" }, { f: rect(3, 5, 7, 5.5), y: 4.7, c: "K" }, { f: rect(3, 3.5, 7, 4), y: 4.7, c: "K" }, { f: rect(3, 2, 5.5, 2.5), y: 4.7, c: "K" }],
  link: [{ tube: Array.from({ length: 19 }, (_, i): P3 => [3.8 + 2.6 * Math.cos((Math.PI * i) / 9), 4, 4.5 + 1.6 * Math.sin((Math.PI * i) / 9)]), c: "S", w: 1.1 }, { tube: Array.from({ length: 19 }, (_, i): P3 => [6.3 + 2.6 * Math.cos((Math.PI * i) / 9), 4 + 1.6 * Math.sin((Math.PI * i) / 9), 4.5]), c: "O", w: 1.1 }],
  serial: [{ tube: [[5, 5, 0], [5, 5, 2.2]], c: "K", w: 1.2 }, { b: [2.5, 2.5, 2.2, 5, 5, 3.6], c: "K" }, { b: [3.6, 4.2, 5.8, 0.8, 1.6, 2.5], c: "S" }, { b: [5.6, 4.2, 5.8, 0.8, 1.6, 2.5], c: "S" }],
  terminal: [{ b: [3, 3, 0, 4, 3, 0.5], c: "S" }, { b: [4.4, 4, 0.5, 1.2, 1, 1.8], c: "S" }, { s: rect(0.5, 2.3, 9.5, 9), y: 3.3, d: 1, c: "K" }, { f: rect(1.2, 3, 8.8, 8.3), y: 4.3, c: "D" }, { f: [[2.2, 7.2], [4.2, 5.9], [2.2, 4.6], [2.2, 5.3], [3.2, 5.9], [2.2, 6.5]], y: 4.3, c: "L" }, { f: rect(4.8, 4.6, 7.2, 5.2), y: 4.3, c: "L" }],
  remote: [{ raw: '<ellipse cx="12" cy="20.6" rx="5.5" ry="1.3" fill="#000" opacity=".25"/><circle cx="12" cy="11" r="7.6" fill="url(#i-iso-globe)"/><ellipse cx="12" cy="11" rx="3.1" ry="7.6" fill="none" stroke="#dbeafe" stroke-width=".6" opacity=".85"/><path d="M4.4 11h15.2M5.6 7h12.8M5.6 15h12.8" fill="none" stroke="#dbeafe" stroke-width=".6" opacity=".85"/>' }],
  stop: [{ b: [2, 2, 0, 6, 6, 6], c: "R" }],
  shield: [{ s: [[5, 0], [1, 3.5], [1, 8], [5, 9.2], [9, 8], [9, 3.5]], y: 3, d: 2.5, c: "G" }, { f: [[3, 4.8], [4.3, 3.5], [7.3, 6.5], [6.6, 7.2], [4.3, 4.9], [3.7, 5.5]], y: 5.5, c: "W" }],
  palette: [{ b: [0.5, 1, 0, 9, 8, 0.9], c: "W" }, { dot: [3, 3, 1], r: 0.9, c: "R" }, { dot: [6, 2.5, 1], r: 0.9, c: "Y" }, { dot: [8, 5, 1], r: 0.9, c: "B" }, { dot: [3.5, 6.5, 1], r: 0.9, c: "G" }],
  keyboard: [{ b: [0, 2, 0, 10, 6, 1], c: "S" }, ...[0.8, 3.1, 5.4, 7.7].flatMap((x): IsoPart[] => [{ b: [x, 2.7, 1, 1.6, 1.6, 0.6], c: "W" }, { b: [x, 4.8, 1, 1.6, 1.4, 0.6], c: "W" }]), { b: [2.2, 6.6, 1, 5.6, 1, 0.6], c: "W" }],
  undo: [{ s: arcBand(5, 3, 4.2, 2.6, 0, 180), y: 3, d: 2.4, c: "O" }, { s: [[-0.3, 3.2], [3.3, 3.2], [1.5, 0.2]], y: 3, d: 2.4, c: "O" }],
  sound: [{ b: [1, 3.5, 2.5, 2.5, 3, 3.5], c: "K" }, { s: [[3.5, 2.5], [6.5, 0.5], [6.5, 8.5], [3.5, 6]], y: 3.5, d: 3, c: "K" }, { tube: arcBand(6.5, 4.5, 2, 2, -50, 50, 8).slice(0, 9).map(([x, z]): P3 => [x, 5, z]), c: "B", w: 0.9 }, { tube: arcBand(6.5, 4.5, 3.4, 3.4, -50, 50, 8).slice(0, 9).map(([x, z]): P3 => [x, 5, z]), c: "B", w: 0.9 }],
  logo: [{ s: [[7.6, 4.5], [10, 7], [10, 2]], y: 3.2, d: 2, c: "T" }, { s: ring(4.5, 4.5, 3.8, 2.6), y: 3, d: 2.4, c: "T" }, { f: ring(2.2, 5.1, 0.5), y: 5.4, c: "K" }],
};

/** The 3D drawing, scaled and centred to fill the icon box. */
export function isoSvg(name: string): string {
  seen = [];
  const body = ISO[name].map(isoPart).join("");
  if (!seen.length) return body;
  const xs = seen.map((q) => q[0]);
  const ys = seen.map((q) => q[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const k = Math.min(22 / (x1 - x0), 22 / (y1 - y0), 2.2);
  const tx = 12 - ((x0 + x1) / 2) * k;
  const ty = 12 - ((y0 + y1) / 2) * k;
  return `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${k.toFixed(3)})">${body}</g>`;
}
