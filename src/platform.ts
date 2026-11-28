// Which desktop the app runs on, and the app-shortcut modifier for it.

const ua = typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`;
export const isMac = /Mac/.test(ua) && !/iPhone|iPad/.test(ua);
export const isWindows = /Win/.test(ua);

/**
 * App shortcuts: Ctrl+Shift+<key> everywhere, and also ⌘+<key> on a Mac
 * (⌘T new tab, ⌘C copy, ⌘V paste, ⌘F find...). Ctrl alone always goes to the
 * terminal, so Ctrl+C still interrupts the program.
 */
export function appShortcut(e: KeyboardEvent): boolean {
  if (e.altKey) return false;
  if (e.ctrlKey && e.shiftKey && !e.metaKey) return true;
  return isMac && e.metaKey && !e.ctrlKey;
}

/** How to write a shortcut on this computer: "Ctrl+Shift+T" or "⌘T". */
export function keyLabel(ctrlShift: string): string {
  if (!isMac) return ctrlShift;
  return ctrlShift.replace(/Ctrl\+Shift\+([A-Z])\b/g, "⌘$1");
}
