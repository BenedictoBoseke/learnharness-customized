import fs from "node:fs";
import path from "node:path";
import { atomicWrite, readJson } from "../../store/atomic-json.ts";
import { LibraryReplica } from "../../store/library-replica.ts";
import {
  EMPTY_MANIFEST,
  RevisionConflictError,
  reconcile,
  sameManifest,
  validateManifest,
  type RemoteRevision,
  type SyncConflict,
  type SyncManifest,
  type SyncPhase,
  type SyncStatus,
  type SyncInventory,
  type SyncTransport,
} from "../../core/sync/types.ts";
interface Pending {
  operationId: string;
  parentId: string | null;
  manifest: SyncManifest;
  localAtStart: SyncManifest;
}
export interface EngineState {
  version: 1;
  libraryId: string | null;
  baseId: string | null;
  base: SyncManifest;
  lastSyncedAt?: string;
  phase: SyncPhase;
  message?: string;
  conflict?: SyncConflict;
  pending?: Pending;
  resumeRequired: Record<string, string>;
  initialChoiceRequired?: boolean;
  review?: { local: SyncInventory; remote: SyncInventory };
}
interface Options {
  replica: LibraryReplica;
  deviceId: string;
  deviceName: string;
  isBusy: () => boolean;
  applied?: () => void;
}
const empty = (): EngineState => ({
  version: 1,
  libraryId: null,
  baseId: null,
  base: EMPTY_MANIFEST,
  phase: "disabled",
  resumeRequired: {},
});
export class SyncEngine {
  private running: Promise<SyncStatus> | null = null;
  constructor(readonly options: Options) {}
  private stateFile() {
    return path.join(this.options.replica.localDir, "state.json");
  }
  get syncing() {
    return this.running !== null;
  }
  state(): EngineState {
    const s = readJson<EngineState>(this.stateFile(), empty());
    if (s.version !== 1)
      throw new Error("Update the app before opening this sync state");
    return s;
  }
  private save(s: EngineState) {
    atomicWrite(this.stateFile(), JSON.stringify(s));
  }
  private backup(name: string, manifest: SyncManifest) {
    const id = Date.now() + "-" + crypto.randomUUID();
    atomicWrite(
      path.join(this.options.replica.localDir, "recovery", id + ".json"),
      JSON.stringify({
        id,
        name,
        createdAt: new Date().toISOString(),
        manifest,
      }),
    );
    return id;
  }
  recoveries() {
    const dir = path.join(this.options.replica.localDir, "recovery");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => {
        const r = readJson<{
          id: string;
          name: string;
          createdAt: string;
          manifest: SyncManifest;
        }>(path.join(dir, n), null!);
        return { id: r.id, name: r.name, createdAt: r.createdAt };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async restoreRecovery(id: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new Error("Invalid recovery identity");
    if (this.running || this.options.isBusy())
      throw new Error(
        "Wait for active learning work to finish before restoring a snapshot.",
      );
    const r = readJson<{ manifest: SyncManifest }>(
      path.join(this.options.replica.localDir, "recovery", id + ".json"),
      null!,
    );
    if (!r) throw new Error("Recovery snapshot not found");
    const before = this.options.replica.capture();
    this.backup("Before recovery", before);
    this.options.replica.apply(validateManifest(r.manifest));
    const s = this.state();
    s.phase = "local";
    s.message = "Recovery applied locally. Review it before syncing.";
    s.conflict = undefined;
    for (const k of Object.keys(r.manifest.entries))
      if (k.startsWith("chat/")) s.resumeRequired[k.slice(5)] = "recovery";
    this.save(s);
    this.options.applied?.();
  }
  status(): SyncStatus {
    const s = this.state();
    let changes = 0;
    try {
      const local = this.options.replica.capture();
      changes = new Set(
        [...Object.keys(local.entries), ...Object.keys(s.base.entries)].filter(
          (k) => local.entries[k] !== s.base.entries[k],
        ),
      ).size;
    } catch {
      changes = 1;
    }
    return {
      phase: s.phase,
      deviceId: this.options.deviceId,
      deviceName: this.options.deviceName,
      libraryId: s.libraryId,
      configured: false,
      lastSyncedAt: s.lastSyncedAt,
      message: s.message,
      localChanges: changes,
      initialChoiceRequired: s.initialChoiceRequired,
      review: s.conflict || s.initialChoiceRequired ? s.review : undefined,
      ...(s.conflict
        ? {
            conflict: {
              id: s.conflict.id,
              keys: s.conflict.keys,
              createdAt: s.conflict.createdAt,
            },
          }
        : {}),
    };
  }
  join(libraryId: string) {
    this.assertIdle();
    if (this.running) throw new Error("Wait for synchronization to finish.");
    if (!/^[a-f0-9-]{36}$/.test(libraryId))
      throw new Error("Invalid library identity");
    const s = this.state();
    this.backup("Before joining a library", this.options.replica.capture());
    this.save({
      ...empty(),
      libraryId,
      phase: "local",
      resumeRequired: s.resumeRequired,
    });
  }
  detach() {
    this.assertIdle();
    if (this.running) throw new Error("Wait for synchronization to finish.");
    this.backup(
      "Before changing sync connection",
      this.options.replica.capture(),
    );
    this.save(empty());
  }
  connectionFailed(message: string) {
    const s = this.state();
    if (!s.conflict) s.phase = "error";
    s.message = message;
    this.save(s);
  }
  requiresResume(chatId: string) {
    return Boolean(this.state().resumeRequired[chatId]);
  }
  resume(chatId: string) {
    const s = this.state();
    if (s.conflict)
      throw new Error(
        "Resolve the library conflict before continuing this session.",
      );
    delete s.resumeRequired[chatId];
    this.save(s);
  }
  private async download(manifest: SyncManifest, t: SyncTransport) {
    for (const [key, hash] of Object.entries(manifest.entries)) {
      if (!this.options.replica.hasBlob(hash))
        this.options.replica.acceptBlob(hash, await t.getBlob(hash));
      for (const dep of this.options.replica.dependencies(key, hash))
        if (!this.options.replica.hasBlob(dep))
          this.options.replica.acceptBlob(dep, await t.getBlob(dep));
    }
  }
  private inventory(manifest: SyncManifest): SyncInventory {
    const result: SyncInventory = {
      sessions: 0,
      notes: 0,
      attachments: 0,
      completedJobs: 0,
      graphNodes: 0,
      sessionPreview: [],
    };
    for (const [key, hash] of Object.entries(manifest.entries)) {
      if (key.startsWith("chat/")) {
        result.sessions++;
        if (result.sessionPreview.length < 20) {
          const c = JSON.parse(this.options.replica.getBlob(hash).toString());
          result.sessionPreview.push({
            id: key.slice(5),
            title: String(c.title || "Untitled session").slice(0, 160),
            messages: Array.isArray(c.messages) ? c.messages.length : 0,
          });
        }
      } else if (key.startsWith("document/")) result.notes++;
      else if (key.startsWith("file/")) result.attachments++;
      else if (key.startsWith("job/")) result.completedJobs++;
      else if (key === "graph/family") {
        const graph = JSON.parse(this.options.replica.getBlob(hash).toString());
        result.graphNodes = Array.isArray(graph.files?.["nodes.jsonl"])
          ? graph.files["nodes.jsonl"].length
          : 0;
      }
    }
    return result;
  }
  private async upload(
    manifest: SyncManifest,
    t: SyncTransport,
    known?: SyncManifest,
  ) {
    const sent = new Set<string>(Object.values(known?.entries || {}));
    if (known)
      for (const [key, hash] of Object.entries(known.entries))
        if (this.options.replica.hasBlob(hash))
          for (const dep of this.options.replica.dependencies(key, hash))
            sent.add(dep);
    for (const [key, hash] of Object.entries(manifest.entries)) {
      for (const dep of [...this.options.replica.dependencies(key, hash), hash])
        if (!sent.has(dep)) {
          await t.putBlob(dep, this.options.replica.getBlob(dep));
          sent.add(dep);
        }
    }
  }
  private assertIdle() {
    if (this.options.isBusy())
      throw new Error(
        "Waiting for active learning or document work to finish. Your changes are saved locally.",
      );
  }
  private apply(
    manifest: SyncManifest,
    local: SyncManifest,
    s: EngineState,
    revisionId: string,
  ) {
    this.assertIdle();
    if (!sameManifest(this.options.replica.capture(), local))
      throw new Error(
        "Local learning changed during synchronization. Retry after the current turn.",
      );
    this.options.replica.apply(manifest);
    for (const [key, hash] of Object.entries(manifest.entries))
      if (key.startsWith("chat/") && hash !== local.entries[key])
        s.resumeRequired[key.slice(5)] = revisionId;
    this.options.applied?.();
  }
  sync(
    t: SyncTransport,
    options: {
      initialChoice?: "local" | "remote" | "merge";
      resolution?: "local" | "remote";
    } = {},
  ): Promise<SyncStatus> {
    if (this.running) return this.running;
    this.running = this.run(t, options).finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async run(
    t: SyncTransport,
    options: {
      initialChoice?: "local" | "remote" | "merge";
      resolution?: "local" | "remote";
    },
  ): Promise<SyncStatus> {
    let s = this.state();
    try {
      if (!s.libraryId)
        throw new Error("Create or join a shared library first.");
      this.assertIdle();
      s.phase = "syncing";
      s.message = undefined;
      this.save(s);
      // Retrying a lost response repeats an operation ID, never an inference or a revision.
      if (s.pending) {
        const pending = s.pending;
        try {
          const receipt = await t.commit(
            s.libraryId,
            pending.parentId,
            pending.operationId,
            this.options.deviceId,
            pending.manifest,
          );
          s.baseId = receipt.id;
          s.base = pending.localAtStart;
          s.pending = undefined;
          this.save(s);
        } catch (e) {
          if (e instanceof RevisionConflictError) {
            s.pending = undefined;
            this.save(s);
          } else throw e;
        }
      }
      const local = this.options.replica.capture(),
        remote = await t.head(s.libraryId);
      let candidate: SyncManifest;
      if (s.conflict && !options.resolution) {
        if (
          remote?.id === s.conflict.remote.id &&
          sameManifest(local, s.conflict.local)
        ) {
          s.phase = "conflict";
          this.save(s);
          return this.status();
        }
        s.conflict = undefined;
        this.save(s);
      }
      if (s.conflict && options.resolution) {
        if (!remote || remote.id !== s.conflict.remote.id)
          throw new Error(
            "The remote library changed again. Refresh the conflict before choosing a version.",
          );
        if (!sameManifest(local, s.conflict.local))
          throw new Error(
            "Local progress changed after this conflict. Refresh before resolving it.",
          );
        candidate =
          options.resolution === "local"
            ? s.conflict.local
            : s.conflict.remote.manifest;
        this.backup("Preserved local conflict version", s.conflict.local);
        await this.download(s.conflict.remote.manifest, t);
        this.backup(
          "Preserved remote conflict version",
          s.conflict.remote.manifest,
        );
      } else if (!remote) {
        if (s.baseId)
          throw new Error(
            "The remote library head is missing. The local library was preserved.",
          );
        candidate = local;
      } else {
        validateManifest(remote.manifest);
        const meaningful =
          Object.keys(local.entries).some((k) => k !== "graph/family") ||
          Object.keys(
            JSON.parse(
              this.options.replica
                .getBlob(local.entries["graph/family"]!)
                .toString(),
            ).files,
          ).length > 0;
        if (
          !s.baseId &&
          meaningful &&
          !sameManifest(local, remote.manifest) &&
          !options.initialChoice
        ) {
          s.phase = "waiting";
          s.initialChoiceRequired = true;
          await this.download(remote.manifest, t);
          s.review = {
            local: this.inventory(local),
            remote: this.inventory(remote.manifest),
          };
          s.message =
            "Both devices contain learning data. Preview and choose the initial library before syncing.";
          this.save(s);
          return this.status();
        }
        if (
          !s.baseId &&
          options.initialChoice &&
          options.initialChoice !== "merge"
        ) {
          await this.download(remote.manifest, t);
          this.backup("Before first synchronization - local", local);
          this.backup("Before first synchronization - remote", remote.manifest);
          candidate =
            options.initialChoice === "local" ? local : remote.manifest;
        } else {
          const result = reconcile(s.base, local, remote.manifest);
          if (result.conflicts.length) {
            await this.download(remote.manifest, t);
            s.review = {
              local: this.inventory(local),
              remote: this.inventory(remote.manifest),
            };
            s.conflict = {
              id: "conflict_" + crypto.randomUUID().replaceAll("-", ""),
              keys: result.conflicts,
              base: s.base,
              local,
              remote,
              createdAt: new Date().toISOString(),
            };
            s.phase = "conflict";
            s.message =
              "Both versions are preserved. Choose the complete library version to continue; the other remains recoverable.";
            this.backup("Local conflict candidate", local);
            this.backup("Remote conflict candidate", remote.manifest);
            this.save(s);
            return this.status();
          }
          candidate = result.manifest;
        }
      }
      await this.download(candidate, t);
      this.assertIdle();
      if (!sameManifest(this.options.replica.capture(), local))
        throw new Error(
          "Local progress changed while syncing. Saved locally; synchronization will retry.",
        );
      let receipt = remote;
      if (!remote || !sameManifest(candidate, remote.manifest)) {
        await this.upload(candidate, t, remote?.manifest);
        this.assertIdle();
        if (!sameManifest(this.options.replica.capture(), local))
          throw new Error(
            "Local progress changed while uploading. Synchronization will retry.",
          );
        s.pending = {
          operationId: crypto.randomUUID(),
          parentId: remote?.id || null,
          manifest: candidate,
          localAtStart: local,
        };
        this.save(s);
        receipt = await t.commit(
          s.libraryId,
          remote?.id || null,
          s.pending.operationId,
          this.options.deviceId,
          candidate,
        );
      }
      if (!receipt) throw new Error("Missing synchronization receipt");
      if (
        !this.options.isBusy() &&
        sameManifest(this.options.replica.capture(), local)
      ) {
        if (!sameManifest(candidate, local))
          this.apply(candidate, local, s, receipt.id);
        s.base = candidate;
        s.phase = "synced";
        s.lastSyncedAt = new Date().toISOString();
        s.message = undefined;
      } else {
        s.base = local;
        s.phase = "local";
        s.message =
          "The uploaded revision is safe. New local changes will sync after current work finishes.";
      }
      s.baseId = receipt.id;
      s.pending = undefined;
      s.conflict = undefined;
      s.initialChoiceRequired = false;
      s.review = undefined;
      this.save(s);
      return this.status();
    } catch (e) {
      s = this.state();
      s.phase = s.conflict
        ? "conflict"
        : this.options.isBusy()
          ? "waiting"
          : "error";
      s.message =
        e instanceof RevisionConflictError
          ? "The other device published a new revision. Retry to compare both versions."
          : e instanceof Error
            ? e.message
            : "Sync failed; local changes are preserved.";
      this.save(s);
      return this.status();
    }
  }
}
