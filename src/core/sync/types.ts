/** Portable revision protocol. Native records remain the learning authority. */
export type EntityMap = Record<string, string>;
export interface SyncManifest {
  version: 1 | 2;
  entries: EntityMap;
}
export interface RemoteRevision {
  id: string;
  parentId: string | null;
  deviceId: string;
  manifest: SyncManifest;
  operationId: string;
  createdAt: string;
}
export interface SyncConflict {
  id: string;
  keys: string[];
  base: SyncManifest;
  local: SyncManifest;
  remote: RemoteRevision;
  createdAt: string;
}
export type SyncPhase =
  | "disabled"
  | "signed-out"
  | "local"
  | "syncing"
  | "synced"
  | "waiting"
  | "conflict"
  | "error";
export interface SyncInventory {
  sessions: number;
  notes: number;
  attachments: number;
  completedJobs: number;
  graphNodes: number;
  sessionPreview: Array<{ id: string; title: string; messages: number }>;
}
export interface SyncStatus {
  phase: SyncPhase;
  deviceId: string;
  deviceName: string;
  libraryId: string | null;
  email?: string;
  configured: boolean;
  lastSyncedAt?: string;
  message?: string;
  localChanges: number;
  conflict?: { id: string; keys: string[]; createdAt: string };
  projectUrl?: string;
  initialChoiceRequired?: boolean;
  review?: { local: SyncInventory; remote: SyncInventory };
}
export interface SyncTransport {
  head(libraryId: string): Promise<RemoteRevision | null>;
  listLibraries(): Promise<Array<{ id: string; name: string }>>;
  createLibrary(name: string): Promise<string>;
  getBlob(hash: string): Promise<Uint8Array>;
  putBlob(hash: string, bytes: Uint8Array): Promise<void>;
  commit(
    libraryId: string,
    parentId: string | null,
    operationId: string,
    deviceId: string,
    manifest: SyncManifest,
  ): Promise<RemoteRevision>;
}
export class RevisionConflictError extends Error {
  constructor() {
    super(
      "The library changed on another device. Both versions are preserved.",
    );
    this.name = "RevisionConflictError";
  }
}
export function validateManifest(value: unknown): SyncManifest {
  if (
    !value ||
    typeof value !== "object" ||
    ![1,2].includes((value as SyncManifest).version)
  )
    throw new Error(
      "This library uses an unsupported sync format. Update the app before syncing.",
    );
  const entries = (value as SyncManifest).entries;
  if (
    !entries ||
    typeof entries !== "object" ||
    Array.isArray(entries) ||
    Object.keys(entries).length > 100000
  )
    throw new Error("Invalid library manifest");
  for (const [key, hash] of Object.entries(entries))
    if (
      (!/^(chat|job|file|document)\/[A-Za-z0-9_-]+$/.test(key) && !((value as SyncManifest).version===2 && /^workspace\/[A-Za-z0-9_-]+$/.test(key)) &&
        key !== "graph/family") ||
      typeof hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(hash)
    )
      throw new Error("Invalid library entity");
  return { version: (value as SyncManifest).version, entries: { ...entries } };
}
export function sameManifest(a: SyncManifest, b: SyncManifest): boolean {
  const keys = Object.keys(a.entries);
  return (
    a.version===b.version && keys.length === Object.keys(b.entries).length &&
    keys.every((k) => a.entries[k] === b.entries[k])
  );
}
/** Three-way merge includes absence, so a deletion cannot be mistaken for a stale update. */
export function reconcile(
  base: SyncManifest,
  local: SyncManifest,
  remote: SyncManifest,
): { manifest: SyncManifest; conflicts: string[] } {
  const entries: EntityMap = {},
    conflicts: string[] = [];
  for (const key of new Set([
    ...Object.keys(base.entries),
    ...Object.keys(local.entries),
    ...Object.keys(remote.entries),
  ])) {
    const b = base.entries[key],
      l = local.entries[key],
      r = remote.entries[key];
    let chosen: string | undefined;
    if (l === r) chosen = l;
    else if (l === b) chosen = r;
    else if (r === b) chosen = l;
    else {
      conflicts.push(key);
      continue;
    }
    if (chosen) entries[key] = chosen;
  }
  return { manifest: { version: base.version===2||local.version===2||remote.version===2?2:1, entries }, conflicts: conflicts.sort() };
}
export const EMPTY_MANIFEST: SyncManifest = { version: 1, entries: {} };
