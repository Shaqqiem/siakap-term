// Typed wrappers over the backend commands. Nothing here touches the network:
// every call is Tauri IPC to the local Rust process.
import { invoke as rawInvoke, Channel } from "@tauri-apps/api/core";
import { record } from "./diag";

/** Every backend call; a failure is noted for "Report a problem" (command name and error only, never arguments). */
function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return rawInvoke<T>(cmd, args).catch((e: unknown) => {
    record("error", `${cmd} failed: ${typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e)}`);
    throw e;
  });
}

export type UiStyle = "standard" | "glass" | "material" | "fluent" | "dot" | "retro" | "minimal";
export type AnimStyle = "fluid" | "bouncy" | "slide" | "subtle" | "off";
export type SessionKind = "ssh" | "local" | "serial";
export type AuthMethod = "auto" | "agent" | "key" | "password";
export type ValidationMode = "safe" | "unrestricted";

export interface Session {
  id: string;
  name: string;
  folder: string;
  kind: SessionKind;
  host: string;
  port: number;
  user: string;
  auth: AuthMethod;
  keyPath: string;
  shell: string;
  postConnectMacro: string | null;
  serial: SerialConfig;
  startupScript: string;
  startupEnabled: boolean;
  startupDir: string;
}
export interface SerialConfig {
  port: string;
  baud: number;
  dataBits: number;
  parity: "none" | "odd" | "even";
  stopBits: number;
  flow: "none" | "software" | "hardware";
}
export interface SerialPortInfo {
  name: string;
  description: string;
  usb: boolean;
  vid: number | null;
  pid: number | null;
}
export interface RedactedSession extends Session {
  hasPassword: boolean;
}
export interface SessionsView {
  sessions: RedactedSession[];
  folders: string[];
  macroFolders: string[];
}
export interface Macro {
  id: string;
  name: string;
  folder: string;
  script: string;
  editBeforeRun: boolean;
  parameterDefaults: Record<string, string>;
}
export interface Settings {
  fontFamily: string;
  fontSize: number;
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  scrollback: number;
  copyOnSelect: boolean;
  lineDelayMs: number;
  validationMode: ValidationMode;
  autoLockMinutes: number;
  confirmMultilinePaste: boolean;
  startupAction: "nothing" | "shell" | "session";
  startupShell: string;
  startupSession: string;
  defaultShell: string;
  startupPanes: 1 | 2 | 4;
  reviewAll: boolean;
  newMacroReview: boolean;
  startupMacrosEnabled: boolean;
  startupTimeoutMs: number;
  macroSort: "manual" | "name";
  activation: "single" | "double";
  searchInCommands: boolean;
  tabStatus: boolean;
  tabStatusFallback: boolean;
  lockDisconnects: boolean;
  rightClickPaste: boolean;
  logAuto: boolean;
  logDir: string;
  themeName: string;
  palette: string[];
  accent: string;
  customThemes: TerminalTheme[];
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  lineHeight: number;
  minContrast: boolean;
  bell: "off" | "flash";
  wordSeparators: string;
  confirmCloseTab: boolean;
  uiScale: number;
  railLabels: boolean;
  tabWidth: "compact" | "normal" | "wide";
  uiStyle: UiStyle;
  animations: AnimStyle;
  glassTransparency: number;
  glassBlur: number;
  glassTerminal: number;
  uiFont: string;
  uiColors: Record<string, string>;
  iconPack: "style" | "outline" | "bold" | "thin" | "sharp" | "duotone" | "emoji";
  wallpaper: "style" | "color" | "image" | "desktop";
  wallpaperColor: string;
  wallpaperDim: number;
  wallpaperBlur: number;
  desktopEffect: "acrylic" | "clear";
  termWallpaper: "style" | "solid" | "color" | "image" | "through";
  termWallpaperColor: string;
  termWallpaperBlur: number;
  tabCloseOnHover: boolean;
  termPadding: number;
  fontWeight: "300" | "normal" | "500" | "bold";
  letterSpacing: number;
  boldIsBright: boolean;
  cursorInactive: "outline" | "block" | "bar" | "underline" | "none";
  scrollSpeed: number;
  scrollOnInput: boolean;
  tabStopWidth: number;
  newTabPosition: "end" | "next";
  programTitles: boolean;
  middleClickClose: boolean;
  confirmQuit: boolean;
  notifyBackground: boolean;
  startMaximized: boolean;
  sshKeepaliveSecs: number;
  sshConnectTimeoutSecs: number;
  autoReconnect: boolean;
  defaultSshUser: string;
  defaultSshPort: number;
  trimPasteNewline: boolean;
  trimCopyWhitespace: boolean;
  sftpShowHidden: boolean;
  logTimestamps: boolean;
  lockOnMinimize: boolean;
  soundChime: boolean;
  chimeMinSecs: number;
  soundUi: boolean;
  soundVolume: number;
  appSkin: boolean;
  themeIcon: boolean;
  screensaverMinutes: number;
  splash: boolean;
}
export interface TerminalTheme {
  name: string;
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  /** 16 colours (black..white, then bright), or empty for the built-in ones. */
  palette: string[];
  accent: string;
  /** The app's own colours (UI_KEYS in skin.ts); missing = worked out from the terminal colours. */
  ui?: Record<string, string>;
}
export interface KnownHost {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  publicKey: string;
  added: number;
}
export interface ShellInfo {
  id: string;
  label: string;
}
export interface SftpEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  mtime: number | null;
  permissions: number | null;
}
export interface KeyDevice {
  busId: string | null;
  description: string;
  instanceId: string;
  persistedGuid: string | null;
  shared: boolean;
  attached: boolean;
  state: string;
  recommended: boolean;
}
export interface KeyOutcome {
  kind: "done" | "already";
  title: string;
  message: string;
  busId: string;
}
export type Step = { op: "line"; text: string } | { op: "type"; text: string } | { op: "wait"; ms: number };
export type TermOut = { kind: "data"; b64: string } | { kind: "exit"; code: number | null };

/** Error object from the backend: `{ kind, message, ... }`. */
export interface ApiError {
  kind: string;
  message: string;
  host?: string;
  port?: number;
  fingerprint?: string;
  keyType?: string;
  publicKey?: string;
  knownFingerprint?: string;
}

export function errorOf(e: unknown): ApiError {
  if (e && typeof e === "object" && "kind" in e && "message" in e) return e as ApiError;
  return { kind: "unknown", message: String(e) };
}
export function messageOf(e: unknown): string {
  return errorOf(e).message;
}

export const api = {
  vaultStatus: () =>
    invoke<{ exists: boolean; unlocked: boolean; rememberAvailable: boolean; remembered: boolean; passwordless: boolean }>(
      "vault_status",
    ),
  vaultCreatePasswordless: () => invoke<void>("vault_create_passwordless"),
  vaultSetMasterPassword: (password: string) => invoke<void>("vault_set_master_password", { password }),
  vaultUnlockRemembered: () => invoke<void>("vault_unlock_remembered"),
  vaultSetRemember: (remember: boolean, password?: string) => invoke<void>("vault_set_remember", { remember, password: password ?? null }),
  vaultCreate: (password: string) => invoke<void>("vault_create", { password }),
  vaultUnlock: (password: string) => invoke<void>("vault_unlock", { password }),
  vaultLock: () => invoke<void>("vault_lock"),
  vaultChangePassword: (old: string, nw: string) => invoke<void>("vault_change_password", { old, new: nw }),
  touch: () => invoke<void>("touch"),

  sessionsList: () => invoke<SessionsView>("sessions_list"),
  sessionSave: (session: Session, password: string | null, clearPassword: boolean) =>
    invoke<string>("session_save", { input: { session, password, clearPassword } }),
  sessionDelete: (id: string) => invoke<void>("session_delete", { id }),
  sessionsEnableStartup: (ids: string[]) => invoke<number>("sessions_enable_startup", { ids }),
  foldersSave: (kind: "sessions" | "macros", folders: string[]) => invoke<void>("folders_save", { kind, folders }),

  macrosList: () => invoke<Macro[]>("macros_list"),
  macroSave: (m: Macro) => invoke<string>("macro_save", { m }),
  macroDelete: (id: string) => invoke<void>("macro_delete", { id }),
  macroRender: (script: string, values: Record<string, string>) => invoke<Step[]>("macro_render", { script, values }),
  macroDuplicate: (id: string) => invoke<string>("macro_duplicate", { id }),
  macroMove: (id: string, folder: string) => invoke<void>("macro_move", { id, folder }),
  macroFolderSave: (name: string, parent: string, oldPath: string | null) =>
    invoke<string>("macro_folder_save", { name, parent, oldPath }),
  backupExportFile: (path: string, scope: "macros" | "all") => invoke<number>("backup_export_file", { path, scope }),
  backupImportFile: (path: string) => invoke<ImportReport>("backup_import_file", { path }),

  settingsGet: () => invoke<Settings>("settings_get"),
  settingsSave: (settings: Settings) => invoke<Settings>("settings_save", { settings }),
  knownHostsList: () => invoke<KnownHost[]>("known_hosts_list"),
  knownHostRemove: (host: string, port: number) => invoke<void>("known_host_remove", { host, port }),
  trustHostKey: (host: string, port: number, fingerprint: string, publicKey: string) =>
    invoke<void>("trust_host_key", { host, port, fingerprint, publicKey }),

  shellsList: () => invoke<ShellInfo[]>("shells_list"),
  termOpenLocal: (shell: string, cols: number, rows: number, channel: Channel<TermOut>) =>
    invoke<number>("term_open_local", { shell, cols, rows, channel }),
  termOpenSsh: (
    sessionId: string,
    cols: number,
    rows: number,
    channel: Channel<TermOut>,
    password?: string,
    passphrase?: string,
  ) => invoke<number>("term_open_ssh", { sessionId, cols, rows, channel, password, passphrase }),
  serialPortsList: () => invoke<{ ports: SerialPortInfo[]; baudRates: number[] }>("serial_ports_list"),
  termOpenSerial: (config: SerialConfig, channel: Channel<TermOut>) => invoke<number>("term_open_serial", { config, channel }),
  termSerialBreak: (id: number) => invoke<void>("term_serial_break", { id }),
  termWrite: (id: number, data: string) => invoke<void>("term_write", { id, data }),
  termResize: (id: number, cols: number, rows: number) => invoke<void>("term_resize", { id, cols, rows }),
  termClose: (id: number) => invoke<void>("term_close", { id }),

  sftpHome: (id: number) => invoke<string>("sftp_home", { id }),
  sftpList: (id: number, path: string) => invoke<{ path: string; entries: SftpEntry[] }>("sftp_list", { id, path }),
  sftpMkdir: (id: number, dir: string, name: string) => invoke<void>("sftp_mkdir", { id, dir, name }),
  sftpRename: (id: number, path: string, newName: string) => invoke<void>("sftp_rename", { id, path, newName }),
  sftpRemove: (id: number, path: string, isDir: boolean) => invoke<void>("sftp_remove", { id, path, isDir }),
  sftpDownload: (id: number, transferId: number, remote: string, local: string, progress: Channel<Progress>) =>
    invoke<number>("sftp_download", { id, transferId, remote, local, progress }),
  sftpUpload: (id: number, transferId: number, local: string, remoteDir: string, overwrite: boolean, progress: Channel<Progress>) =>
    invoke<string>("sftp_upload", { id, transferId, local, remoteDir, overwrite, progress }),
  sftpCancel: (transferId: number) => invoke<void>("sftp_cancel", { transferId }),

  pickFiles: (purpose: "upload" | "key" | "import" | "theme", multiple: boolean) => invoke<string[]>("pick_files", { purpose, multiple }),
  pickSave: (purpose: "download" | "export" | "log" | "text" | "theme" | "report", defaultName: string) => invoke<string | null>("pick_save", { purpose, defaultName }),
  clipboardRead: () => invoke<string>("clipboard_read"),
  clipboardWrite: (text: string) => invoke<void>("clipboard_write", { text }),
  termLogStart: (id: number, path: string, title: string) =>
    invoke<string>("term_log_start", { id, path, title, tzOffset: -new Date().getTimezoneOffset() }),
  termLogAuto: (id: number, title: string, stamp: string) =>
    invoke<string>("term_log_auto", { id, title, stamp, tzOffset: -new Date().getTimezoneOffset() }),
  termLogStop: (id: number) => invoke<void>("term_log_stop", { id }),
  logFolderPick: () => invoke<string | null>("log_folder_pick"),
  saveTextFile: (path: string, text: string) => invoke<void>("save_text_file", { path, text }),
  themeReadFile: (path: string) => invoke<string>("theme_read_file", { path }),
  updateCheck: () =>
    invoke<{ current: string; latest: string; newer: boolean; url: string; published: string; notes: string; installerUrl: string | null; installerSize: number }>("update_check"),
  updateDownload: (progress: Channel<{ done: number; total: number }>) => invoke<string>("update_download", { progress }),
  updateInstall: () => invoke<void>("update_install"),
  openReleasePage: (url: string) => invoke<void>("open_release_page", { url }),
  wallpaperPick: (target: "app" | "term") => invoke<boolean>("wallpaper_pick", { target }),
  wallpaperGet: (target: "app" | "term") => invoke<string | null>("wallpaper_get", { target }),
  wallpaperClear: (target: "app" | "term") => invoke<void>("wallpaper_clear", { target }),
  windowBackdrop: (kind: "acrylic" | "clear" | "none") => invoke<void>("window_backdrop", { kind }),
  adminCheck: (password: string) => invoke<boolean>("admin_check", { password }),
  diagInfo: () => invoke<Record<string, unknown>>("diag_info"),
  fontsList: () => invoke<{ name: string; monospace: boolean }[]>("fonts_list"),
  securityKeyState: () => invoke<KeyDevice[]>("security_key_state"),
  securityKeyAction: (action: "attach" | "detach", d: KeyDevice) =>
    invoke<KeyOutcome>("security_key_action", {
      action,
      device: { busId: d.busId, instanceId: d.instanceId, persistedGuid: d.persistedGuid },
    }),
};

export interface ImportReport {
  macros: number;
  duplicates: number;
  sessions: number;
  skippedSessions: number;
  invalid: number;
  startupDisabled: number;
  needsReview: string[];
  skippedTypes: Record<string, number>;
  source: "siakap" | "mobaxterm";
  startupSessionIds: string[];
}

export interface Progress {
  done: number;
  total: number;
}

export { Channel };

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
