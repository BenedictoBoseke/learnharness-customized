import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { atomicWrite, readJson } from "./atomic-json.ts";
import {
  relativeNotePath,
  type FolderEntry,
  type FolderSelection,
} from "../core/subjects.ts";
export interface FolderPort {
  watch?(root: FolderSelection, changed: () => void): () => void;
  list(root: FolderSelection, relative: string): Promise<FolderEntry[]>;
  bind(root: FolderSelection, relative: string): Promise<FolderSelection>;
  create(
    root: FolderSelection,
    relative: string,
    text: string,
  ): Promise<FolderSelection>;
}
interface Grant {
  path: string;
  name: string;
  writable: boolean;
  directory?: boolean;
  identity?: string;
  rootHandle?: string;
  relative?: string;
}
const same = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const identity = (s: fs.Stats) => `${s.dev}:${s.ino}`;
export function grantedFile(grantsFile: string, handle: string): Grant {
  const all = readJson<Record<string, Grant>>(grantsFile, {}),
    g = all[handle];
  if (
    !g ||
    typeof g.path !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(handle)
  )
    throw Error("Folder/file permission missing. Relink it.");
  if (g.rootHandle) {
    const resolved = folderChild(grantsFile, g.rootHandle, g.relative!);
    if (!same(resolved, g.path))
      throw Error("The file moved outside its granted folder. Relink it.");
  }
  if (g.directory) throw Error("Choose a note, not a directory.");
  return g;
}
export function folderChild(
  grantsFile: string,
  handle: string,
  relative: string,
  creating = false,
): string {
  relativeNotePath(relative, true);
  const root = readJson<Record<string, Grant>>(grantsFile, {})[handle];
  if (!root?.directory)
    throw Error("Folder permission missing. Relink the subject.");
  const real = fs.realpathSync(root.path),
    stat = fs.statSync(real);
  if (
    !same(real, root.path) ||
    !stat.isDirectory() ||
    identity(stat) !== root.identity
  )
    throw Error("The folder changed. Relink the subject.");
  let cursor = real;
  const segments = relative ? relative.split("/") : [];
  for (let i = 0; i < segments.length; i++) {
    cursor = path.join(cursor, segments[i]!);
    if (creating && i === segments.length - 1 && !fs.existsSync(cursor)) break;
    const s = fs.lstatSync(cursor);
    if (s.isSymbolicLink())
      throw Error("Symlinks and junctions are excluded from subject folders.");
    const canonical = fs.realpathSync(cursor),
      rel = path.relative(real, canonical);
    if (rel.startsWith(".." + path.sep) || rel === ".." || path.isAbsolute(rel))
      throw Error("The note is outside its granted subject.");
    cursor = canonical;
  }
  return cursor;
}
export function createFolderPort(options: {
  grantsFile: string;
  androidUrl?: string;
  androidToken?: string;
}): FolderPort {
  async function android(
    operation: string,
    root: FolderSelection,
    relative: string,
    text?: string,
  ) {
    relativeNotePath(relative, true);
    if (!options.androidUrl || !options.androidToken)
      throw Error("Android folder service unavailable. Restart the app.");
    const r = await fetch(new URL("/folder", options.androidUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.androidToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation, handle: root.handle, relative, text }),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    const b = await r.json();
    if (!r.ok || b.error)
      throw Error(b.error || "The folder provider is unavailable.");
    return b;
  }
  function bind(root: FolderSelection, relative: string): FolderSelection {
    const file = folderChild(options.grantsFile, root.handle, relative),
      s = fs.statSync(file);
    if (!s.isFile() || s.size > 5 * 1024 * 1024)
      throw Error("Choose a Markdown note up to 5 MB.");
    const all = readJson<Record<string, Grant>>(options.grantsFile, {});
    let writable = true;
    try {
      fs.accessSync(file, fs.constants.W_OK);
    } catch {
      writable = false;
    }
    const existing = Object.keys(all).find(
        (k) => same(all[k]!.path, file) && !all[k]!.directory,
      ),
      handle = existing || "grant_" + randomBytes(16).toString("hex");
    if (!existing)
      all[handle] = {
        path: file,
        name: path.basename(file),
        writable,
        rootHandle: root.handle,
        relative,
      };
    atomicWrite(options.grantsFile, JSON.stringify(all));
    return { handle, name: path.basename(file), kind: "desktop", writable };
  }
  return {
    watch(root, changed) {
      if (root.kind !== "desktop") return () => {};
      const dir = folderChild(options.grantsFile, root.handle, "");
      const watcher = fs.watch(dir, { recursive: true }, changed);
      watcher.on("error", changed);
      return () => watcher.close();
    },
    async list(root, relative) {
      if (root.kind === "android")
        return (await android("list", root, relative)).entries;
      const dir = folderChild(options.grantsFile, root.handle, relative);
      const names = await fs.promises.readdir(dir, { withFileTypes: true });
      if (names.length > 25000)
        throw Error(
          "Directory exceeds 25,000 entries. Narrow the selected folder.",
        );
      return Promise.all(
        names.map(async (e) => {
          if (e.isSymbolicLink())
            return {
              name: e.name,
              directory: false,
              error: "Symlink/junction excluded",
            };
          try {
            const s = await fs.promises.stat(path.join(dir, e.name));
            return {
              name: e.name,
              directory: e.isDirectory(),
              size: s.size,
              identity: identity(s),
            };
          } catch {
            return {
              name: e.name,
              directory: e.isDirectory(),
              error: "File metadata unavailable",
            };
          }
        }),
      );
    },
    async bind(root, relative) {
      return root.kind === "android"
        ? (await android("bind", root, relative)).document
        : bind(root, relative);
    },
    async create(root, relative, text) {
      relativeNotePath(relative);
      if (!relative.toLowerCase().endsWith(".md"))
        throw Error("Choose a Markdown filename.");
      if (root.kind === "android")
        return (await android("create", root, relative, text)).document;
      const dest = folderChild(options.grantsFile, root.handle, relative, true);
      const fd = fs.openSync(dest, "wx");
      try {
        fs.writeFileSync(fd, text);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return bind(root, relative);
    },
  };
}
