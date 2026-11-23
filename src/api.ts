// Typed wrappers over the backend commands. Nothing here touches the network:
// every call is Tauri IPC to the local Rust process.
import { invoke, Channel } from "@tauri-apps/api/core";

export type SessionKind = "ssh" | "local";
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
  preview: boolean;
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
export interface YubiDevice {
  busId: string | null;
  description: string;
  instanceId: string;
  shared: boolean;
  attached: boolean;
}
export type YubiPlan = { action: "attach" | "detach"; busIds: string[] };
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
  vaultStatus: () => invoke<{ exists: boolean; unlocked: boolean }>("vault_status"),
  vaultCreate: (password: string) => invoke<void>("vault_create", { password }),
  vaultUnlock: (password: string) => invoke<void>("vault_unlock", { password }),
  vaultLock: () => invoke<void>("vault_lock"),
  vaultChangePassword: (old: string, nw: string) => invoke<void>("vault_change_password", { old, new: nw }),
  touch: () => invoke<void>("touch"),

  sessionsList: () => invoke<SessionsView>("sessions_list"),
  sessionSave: (session: Session, password: string | null, clearPassword: boolean) =>
    invoke<string>("session_save", { input: { session, password, clearPassword } }),
  sessionDelete: (id: string) => invoke<void>("session_delete", { id }),
  foldersSave: (kind: "sessions" | "macros", folders: string[]) => invoke<void>("folders_save", { kind, folders }),

  macrosList: () => invoke<Macro[]>("macros_list"),
  macroSave: (m: Macro) => invoke<string>("macro_save", { m }),
  macroDelete: (id: string) => invoke<void>("macro_delete", { id }),
  macroRender: (script: string, values: Record<string, string>) => invoke<Step[]>("macro_render", { script, values }),
  macrosExportFile: (path: string, ids: string[] | null) => invoke<number>("macros_export_file", { path, ids }),
  macrosImportFile: (path: string) =>
    invoke<{ added: number; duplicates: number; invalid: number }>("macros_import_file", { path }),

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
  sftpUpload: (id: number, transferId: number, local: string, remoteDir: string, progress: Channel<Progress>) =>
    invoke<string>("sftp_upload", { id, transferId, local, remoteDir, progress }),
  sftpCancel: (transferId: number) => invoke<void>("sftp_cancel", { transferId }),

  yubikeyState: () => invoke<YubiDevice[]>("yubikey_state"),
  yubikeyToggle: () => invoke<YubiPlan>("yubikey_toggle"),
};

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
