import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite, readJson } from "./atomic-json.ts";
import { parseFilePaths } from "../core/file-paths.ts";
import { validateManifest, type SyncManifest } from "../core/sync/types.ts";
import {
  portableSubject,
  externalSubjectTranscript,
} from "../core/subject-sync.ts";
export const bytesHash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const CHUNK = 4 * 1024 * 1024;
const GRAPH_FILES = [
  "nodes.jsonl",
  "chains.jsonl",
  "sessions.jsonl",
  "coverage.jsonl",
  "sources.json",
  "source-organization.json",
  "format.json",
];
const idOk = (v: string) => /^[A-Za-z0-9_-]{1,100}$/.test(v);
const cleanName = (v: string) =>
  v.replace(/[\\/\u0000-\u001f]/g, "_").slice(-180) || "attachment";
interface FileBinding {
  id: string;
  name: string;
  path?: string;
  managed: boolean;
  aliases?: string[];
}
interface FileEntity {
  version: 1;
  id: string;
  name: string;
  size: number;
  chunks: Array<{ hash: string; size: number }>;
}
interface Journal {
  phase: "prepared" | "committed";
  files: Array<{ name: string; before: string | null; after: string | null }>;
}
export interface ReplicaOptions {
  dataDir: string;
  attachmentsDir: string;
  deviceId: string;
  localDir?: string;
}
/** Immutable blobs + staged, rollback-capable application of a coherent library generation. */
export class LibraryReplica {
  readonly localDir: string;
  private applying = false;
  constructor(readonly options: ReplicaOptions) {
    this.localDir =
      options.localDir || path.join(options.dataDir, ".sync-local");
    this.recover();
  }
  get busy() {
    return this.applying;
  }
  private fileMap() {
    return readJson<Record<string, FileBinding>>(
      path.join(this.localDir, "files.json"),
      {},
    );
  }
  private saveMap(map: Record<string, FileBinding>) {
    atomicWrite(path.join(this.localDir, "files.json"), JSON.stringify(map));
  }
  register(file: string, managed = true): FileBinding {
    const canonical = fs.realpathSync(file);
    const stat = fs.statSync(canonical);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
      throw new Error("Choose an attachment up to 64 MB.");
    const map = this.fileMap();
    let binding = Object.values(map).find((b) => b.path === canonical);
    if (!binding) {
      binding = {
        id: "file_" + crypto.randomUUID().replaceAll("-", ""),
        name: cleanName(path.basename(canonical)),
        path: canonical,
        managed,
        aliases: [file],
      };
      map[binding.id] = binding;
    } else if (managed) binding.managed = true;
    this.saveMap(map);
    return binding;
  }
  permitsSourceRead(file: string) {
    try {
      const canonical = fs.realpathSync(file);
      return (
        fs.statSync(canonical).isFile() &&
        Object.values(this.fileMap()).some(
          (b) =>
            b.path &&
            fs.existsSync(b.path) &&
            fs.realpathSync(b.path) === canonical,
        )
      );
    } catch {
      return false;
    }
  }
  references() {
    return Object.values(this.fileMap()).map((b) => ({
      id: b.id,
      name: b.name,
      bound: Boolean(b.path && fs.existsSync(b.path)),
      managed: b.managed,
    }));
  }
  bind(id: string, file: string) {
    const map = this.fileMap();
    if (!map[id]) throw new Error("File reference not found");
    const canonical = fs.realpathSync(file),
      stat = fs.statSync(canonical);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
      throw new Error("Choose a file up to 64 MB");
    const old = map[id]!;
    map[id] = {
      ...old,
      path: canonical,
      managed: true,
      aliases: Array.from(
        new Set([
          ...(old.aliases || []),
          ...(old.path ? [old.path] : []),
          file,
        ]),
      ),
    };
    this.saveMap(map);
    const snapshot = this.capture();
    this.apply(snapshot);
  }
  private translateDocument(
    original: Record<string, any>,
    translated: Record<string, any>,
  ) {
    if (
      original.mode !== "app" ||
      typeof original.text !== "string" ||
      typeof translated.text !== "string"
    )
      return translated;
    const revision = bytesHash(translated.text);
    translated.revision = revision;
    for (const proposal of translated.proposals || []) {
      if (proposal.baseRevision === original.revision)
        proposal.baseRevision = revision;
      if (proposal.appliedRevision === original.revision)
        proposal.appliedRevision = revision;
    }
    for (const [token, expected] of Object.entries(
      original.blockHashes || {},
    )) {
      const start = `<!--lh:block:${token}-->`,
        end = `<!--/lh:block:${token}-->`;
      const find = (text: string) => {
        const i = text.indexOf(start),
          j = i < 0 ? -1 : text.indexOf(end, i);
        return i >= 0 && j >= 0 ? text.slice(i, j + end.length) : null;
      };
      const before = find(original.text),
        after = find(translated.text);
      if (before && after && bytesHash(before) === expected)
        translated.blockHashes[token] = bytesHash(after);
    }
    return translated;
  }
  private reference(file: string, map: Record<string, FileBinding>): string {
    let binding = Object.values(map).find(
      (b) => b.path === file || b.aliases?.includes(file),
    );
    if (!binding) {
      binding = {
        id: "file_" + crypto.randomUUID().replaceAll("-", ""),
        name: cleanName(path.basename(file.replaceAll("\\", "/"))),
        path: file,
        managed: false,
      };
      map[binding.id] = binding;
    }
    return `lh-file://${binding.id}/${encodeURIComponent(binding.name)}`;
  }
  private encode(
    value: unknown,
    map: Record<string, FileBinding>,
    key = "",
  ): unknown {
    if (typeof value === "string") {
      const text = value.replace(/lh-unbound:\/\//g, "lh-file://");
      if (
        (key === "path" || key === "filePath") &&
        /^(?:[A-Za-z]:[\\/]|\/|~\/)/.test(text)
      )
        return this.reference(text, map);
      return parseFilePaths(text)
        .map((p) =>
          p.kind === "path" ? "`" + this.reference(p.path, map) + "`" : p.text,
        )
        .join("");
    }
    if (Array.isArray(value)) return value.map((v) => this.encode(v, map));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, this.encode(v, map, k)]),
      );
    return value;
  }
  private decode(value: unknown, map: Record<string, FileBinding>): unknown {
    if (typeof value === "string")
      return value.replace(
        /lh-file:\/\/([A-Za-z0-9_-]+)\/([^`\s"<>]*)/g,
        (_all, id, name) => {
          if (!map[id])
            map[id] = {
              id,
              name: cleanName(decodeURIComponent(name || "Relink file")),
              managed: false,
            };
          return (
            map[id]?.path ||
            `lh-unbound://${id}/${encodeURIComponent(map[id]?.name || "Relink file")}`
          );
        },
      );
    if (Array.isArray(value)) return value.map((v) => this.decode(v, map));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, this.decode(v, map)]),
      );
    return value;
  }
  blobFile(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid blob checksum");
    return path.join(this.localDir, "blobs", hash);
  }
  hasBlob(hash: string) {
    return fs.existsSync(this.blobFile(hash));
  }
  getBlob(hash: string): Buffer {
    const bytes = fs.readFileSync(this.blobFile(hash));
    if (bytesHash(bytes) !== hash)
      throw new Error(
        "A saved sync payload failed its checksum. Preserve the local library and retry.",
      );
    return bytes;
  }
  putBlob(bytes: Uint8Array): string {
    const hash = bytesHash(bytes),
      file = this.blobFile(hash);
    if (!fs.existsSync(file)) atomicWrite(file, bytes);
    return hash;
  }
  acceptBlob(hash: string, bytes: Uint8Array) {
    if (bytesHash(bytes) !== hash)
      throw new Error("Downloaded sync data failed its checksum.");
    this.putBlob(bytes);
  }
  dependencies(key: string, hash: string): string[] {
    if (!key.startsWith("file/")) return [];
    const entity = JSON.parse(
      this.getBlob(hash).toString("utf8"),
    ) as FileEntity;
    this.validateFile(entity);
    return entity.chunks.map((c) => c.hash);
  }
  private validateFile(v: FileEntity) {
    if (
      v.version !== 1 ||
      !idOk(v.id) ||
      typeof v.name !== "string" ||
      v.name.length > 200 ||
      !Number.isSafeInteger(v.size) ||
      v.size < 0 ||
      v.size > 64 * 1024 * 1024 ||
      !Array.isArray(v.chunks) ||
      v.chunks.length > 16 ||
      v.chunks.some(
        (c) =>
          !c ||
          !/^[a-f0-9]{64}$/.test(c.hash) ||
          !Number.isInteger(c.size) ||
          c.size < 0 ||
          c.size > CHUNK,
      ) ||
      v.chunks.reduce((n, c) => n + c.size, 0) !== v.size
    )
      throw new Error("Invalid attachment manifest");
  }
  private objectEntry(value: unknown) {
    return this.putBlob(Buffer.from(JSON.stringify(value)));
  }
  capture(): SyncManifest {
    const entries: Record<string, string> = {},
      map = this.fileMap();
    const workspaceDir = path.join(this.options.dataDir, "workspaces");
    const workspaces = fs.existsSync(workspaceDir)
      ? fs
          .readdirSync(workspaceDir)
          .filter((n) => n.endsWith(".json"))
          .map((n) =>
            portableSubject(
              JSON.parse(fs.readFileSync(path.join(workspaceDir, n), "utf8")),
            ),
          )
      : [];
    const externalNoteIds = new Set<string>(),
      externalChats = new Set<string>();
    const docsDir = path.join(this.options.dataDir, "documents");
    if (fs.existsSync(docsDir))
      for (const name of fs
        .readdirSync(docsDir)
        .filter((n) => n.endsWith(".json"))) {
        const d = JSON.parse(fs.readFileSync(path.join(docsDir, name), "utf8"));
        if (d.mode === "external") {
          externalNoteIds.add(d.id);
          for (const chatId of d.chatIds || []) externalChats.add(chatId);
        }
      }
    for (const w of workspaces)
      if (w.mode === "external")
        for (const chatId of w.chatIds) externalChats.add(chatId);
    for (const w of workspaces) {
      w.chatIds = w.chatIds.filter((id) =>
        fs.existsSync(path.join(this.options.dataDir, "chats", id + ".json")),
      );
      entries["workspace/" + w.id] = this.objectEntry(portableSubject(w));
    }
    for (const kind of ["chats", "jobs", "documents"]) {
      const dir = path.join(this.options.dataDir, kind);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs
        .readdirSync(dir)
        .filter((n) => n.endsWith(".json"))) {
        const id = name.slice(0, -5);
        if (!idOk(id)) throw new Error("Unexpected library file identity");
        let value = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        if (kind === "chats") {
          value = externalSubjectTranscript(
            value,
            externalNoteIds,
            externalChats.has(value.id),
          );
          if (
            value.id !== id ||
            !Array.isArray(value.messages) ||
            (typeof value.version === "number" && value.version > 1)
          )
            throw new Error(
              "A session is incompatible or corrupt. Sync stopped without deleting any data.",
            );
        }
        if (kind === "jobs") {
          if (value.status === "running") continue;
          value = {
            ...value,
            ownerDeviceId: value.ownerDeviceId || this.options.deviceId,
          };
        }
        if (kind === "documents") {
          if (value.version !== 1)
            throw new Error("A linked document requires a newer app.");
          delete value.error;
          if (value.mode === "external")
            value = {
              version: 1,
              id: value.id,
              name: value.name,
              chatIds: value.chatIds,
              mode: value.mode,
              logging: value.logging,
              external: true,
            };
        }
        const key =
          (kind === "chats" ? "chat" : kind === "jobs" ? "job" : "document") +
          "/" +
          id;
        const encoded = this.encode(value, map) as Record<string, any>;
        entries[key] = this.objectEntry(
          kind === "documents"
            ? this.translateDocument(value, encoded)
            : encoded,
        );
      }
    }
    const graph: Record<string, unknown> = {};
    for (const name of GRAPH_FILES) {
      const file = path.join(this.options.dataDir, "graph", name);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      if (name.endsWith(".jsonl")) {
        graph[name] = text
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => this.encode(JSON.parse(line), map));
      } else {
        const value = JSON.parse(text);
        if (name === "sources.json" && value && typeof value === "object")
          for (const source of Object.values(value) as Array<{
            filePath?: string;
          }>) {
            if (
              typeof source?.filePath === "string" &&
              fs.existsSync(source.filePath) &&
              fs.statSync(source.filePath).isFile() &&
              fs.statSync(source.filePath).size <= 64 * 1024 * 1024
            ) {
              const binding = this.register(source.filePath);
              map[binding.id] = binding;
            }
          }
        if (
          name === "format.json" &&
          typeof value.version === "number" &&
          value.version > 1
        )
          throw new Error("This graph requires a newer app. Sync stopped.");
        graph[name] = this.encode(value, map);
      }
    }
    entries["graph/family"] = this.objectEntry({ version: 1, files: graph });
    for (const binding of Object.values(map)) {
      if (!binding.managed || !binding.path) continue;
      if (!fs.existsSync(binding.path))
        throw new Error(
          `Attachment unavailable: ${binding.name}. Relink it before syncing.`,
        );
      const stat = fs.statSync(binding.path);
      if (stat.size > 64 * 1024 * 1024)
        throw new Error("Attachment exceeds 64 MB.");
      const chunks: FileEntity["chunks"] = [];
      const fd = fs.openSync(binding.path, "r");
      try {
        let count = 0;
        while (count < stat.size) {
          const bytes = Buffer.alloc(Math.min(CHUNK, stat.size - count));
          const n = fs.readSync(fd, bytes, 0, bytes.length, count);
          if (n === 0)
            throw new Error(
              "Attachment changed while reading. Retry after saving the file.",
            );
          chunks.push({ hash: this.putBlob(bytes.subarray(0, n)), size: n });
          count += n;
        }
      } finally {
        fs.closeSync(fd);
      }
      entries["file/" + binding.id] = this.objectEntry({
        version: 1,
        id: binding.id,
        name: binding.name,
        size: stat.size,
        chunks,
      });
    }
    this.saveMap(map);
    const upgraded =
      workspaces.length > 0 ||
      readJson<{ base?: { version: number } }>(
        path.join(this.localDir, "state.json"),
        {},
      ).base?.version === 2;
    return { version: upgraded ? 2 : 1, entries };
  }
  /** Checks every entity and constructs all target bytes before touching canonical records. */
  apply(candidate: SyncManifest): void {
    if (this.applying)
      throw new Error("Another library update is being applied");
    const manifest = validateManifest(candidate),
      changes = new Map<string, Buffer | null>(),
      map = this.fileMap();
    this.applying = true;
    try {
      for (const [key, hash] of Object.entries(manifest.entries))
        if (key.startsWith("file/")) {
          const entity = JSON.parse(
            this.getBlob(hash).toString("utf8"),
          ) as FileEntity;
          this.validateFile(entity);
          if (key !== "file/" + entity.id)
            throw new Error("Attachment identity mismatch");
          const dest = path.join(
            this.options.attachmentsDir,
            "synced",
            entity.id,
            hash,
            cleanName(entity.name),
          );
          if (!fs.existsSync(dest)) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            const tmp = dest + ".tmp-" + crypto.randomUUID();
            const fd = fs.openSync(tmp, "wx", 0o600);
            try {
              for (const c of entity.chunks) {
                const bytes = this.getBlob(c.hash);
                if (bytes.length !== c.size)
                  throw new Error("Attachment chunk size mismatch");
                fs.writeSync(fd, bytes);
              }
              fs.fsyncSync(fd);
            } finally {
              fs.closeSync(fd);
            }
            fs.renameSync(tmp, dest);
          }
          map[entity.id] = {
            id: entity.id,
            name: entity.name,
            path: dest,
            managed: true,
          };
        }
      for (const [key, hash] of Object.entries(manifest.entries)) {
        if (key.startsWith("file/")) continue;
        const portable = JSON.parse(this.getBlob(hash).toString("utf8"));
        let value = this.decode(portable, map) as Record<string, any>;
        if (key.startsWith("document/"))
          value = this.translateDocument(portable, value);
        if (key === "graph/family") {
          if (
            value.version !== 1 ||
            !value.files ||
            typeof value.files !== "object"
          )
            throw new Error("Invalid graph generation");
          for (const name of GRAPH_FILES) {
            const item = value.files[name];
            if (name === "format.json" && item && item.version > 1)
              throw new Error("Update the app before applying this graph");
            changes.set(
              "graph/" + name,
              item === undefined
                ? null
                : Buffer.from(
                    name.endsWith(".jsonl")
                      ? Array.isArray(item)
                        ? item.map((v) => JSON.stringify(v)).join("\n") +
                          (item.length ? "\n" : "")
                        : (() => {
                            throw new Error("Invalid graph ledger");
                          })()
                      : JSON.stringify(item, null, 2),
                  ),
            );
          }
          continue;
        }
        const [kind, id] = key.split("/");
        const dir =
          kind === "chat"
            ? "chats"
            : kind === "job"
              ? "jobs"
              : kind === "workspace"
                ? "workspaces"
                : "documents";
        if (value.id !== id)
          throw new Error("Library record identity mismatch");
        if (
          kind === "chat" &&
          (!Array.isArray(value.messages) ||
            (typeof value.version === "number" && value.version > 1))
        )
          throw new Error("Unsupported session format");
        if (kind === "job") {
          if (value.status === "running")
            throw new Error("A running job cannot be imported");
          if (!value.ownerDeviceId) value.ownerDeviceId = "foreign";
        }
        if (kind === "workspace") value = portableSubject(value);
        if (kind === "document" && value.version !== 1)
          throw new Error("Unsupported linked document version");
        if (kind === "document" && value.external) {
          const existing = readJson<Record<string, unknown>>(
            path.join(this.options.dataDir, dir, id + ".json"),
            {},
          );
          value = {
            ...existing,
            ...value,
            text: existing.text || "",
            revision: existing.revision || bytesHash(""),
            updatedAt: existing.updatedAt || new Date().toISOString(),
            proposals: existing.proposals || [],
            blockHashes: existing.blockHashes || {},
          };
          delete value.external;
        }
        changes.set(
          dir + "/" + id + ".json",
          Buffer.from(JSON.stringify(value, null, 2)),
        );
      }
      for (const [kind, dir] of [
        ["chat", "chats"],
        ["job", "jobs"],
        ["document", "documents"],
        ["workspace", "workspaces"],
      ] as const) {
        const parent = path.join(this.options.dataDir, dir);
        if (fs.existsSync(parent))
          for (const name of fs.readdirSync(parent))
            if (
              name.endsWith(".json") &&
              !manifest.entries[kind + "/" + name.slice(0, -5)]
            )
              changes.set(dir + "/" + name, null);
      }
      for (const [key, hash] of Object.entries(manifest.entries))
        if (key.startsWith("workspace/")) {
          const workspace = portableSubject(
            JSON.parse(this.getBlob(hash).toString("utf8")),
          );
          for (const note of workspace.notes) {
            const hash = manifest.entries["document/" + note.id];
            if (!hash)
              throw Error(
                "Subject note reference is missing from the incoming generation.",
              );
            const doc = JSON.parse(this.getBlob(hash).toString("utf8"));
            if (doc.mode !== workspace.mode)
              throw Error(
                "Subject note sync ownership does not match its workspace.",
              );
          }
          for (const chatId of workspace.chatIds)
            if (!manifest.entries["chat/" + chatId])
              throw Error(
                "Subject session reference is missing from the incoming generation.",
              );
        }
      changes.set(".sync-local/files.json", Buffer.from(JSON.stringify(map)));
      const journal: Journal = {
        phase: "prepared",
        files: [...changes].map(([name, after]) => {
          const file = this.target(name);
          return {
            name,
            before: fs.existsSync(file)
              ? fs.readFileSync(file).toString("base64")
              : null,
            after: after?.toString("base64") ?? null,
          };
        }),
      };
      atomicWrite(
        path.join(this.localDir, "apply-journal.json"),
        JSON.stringify(journal),
      );
      try {
        for (const f of journal.files) this.replace(f.name, f.after);
        journal.phase = "committed";
        atomicWrite(
          path.join(this.localDir, "apply-journal.json"),
          JSON.stringify(journal),
        );
        fs.unlinkSync(path.join(this.localDir, "apply-journal.json"));
      } catch (error) {
        this.recover();
        throw error;
      }
    } finally {
      this.applying = false;
    }
  }
  private target(name: string) {
    if (name === ".sync-local/files.json")
      return path.join(this.localDir, "files.json");
    if (
      !/^(chats|jobs|documents|workspaces)\/[A-Za-z0-9_-]+\.json$/.test(name) &&
      !(name.startsWith("graph/") && GRAPH_FILES.includes(name.slice(6))) &&
      name !== ".sync-local/files.json"
    )
      throw new Error("Invalid journal target");
    return path.join(this.options.dataDir, ...name.split("/"));
  }
  private replace(name: string, encoded: string | null) {
    const file = this.target(name);
    if (encoded === null) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } else atomicWrite(file, Buffer.from(encoded, "base64"));
  }
  recover() {
    const file = path.join(this.localDir, "apply-journal.json");
    const journal = readJson<Journal | null>(file, null);
    if (!journal) return;
    if (
      !Array.isArray(journal.files) ||
      !["prepared", "committed"].includes(journal.phase)
    )
      throw new Error("Invalid sync recovery journal");
    if (journal.phase === "prepared")
      for (const f of journal.files) this.replace(f.name, f.before);
    fs.unlinkSync(file);
  }
}
