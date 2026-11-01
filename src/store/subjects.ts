import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite, readJson } from "./atomic-json.ts";
import {
  SUBJECT_LIMITS,
  relativeNotePath,
  excludedSubjectPath,
  validSubject,
  resolveSubjectLink,
  type Subject,
  type SubjectView,
  type ScanState,
  type FolderSelection,
} from "../core/subjects.ts";
import type { FolderPort } from "./folder-access.ts";
import type { DocumentService } from "./documents.ts";
import { subjectNoteIndex } from "./subject-index.ts";
import {
  hasUnresolvedQuestion,
  activeProblemOf,
} from "../core/native-messages.ts";
import { liveDocumentBlocks } from "../core/documents/live-markdown.ts";
import type { ChatRecord } from "../core/contracts.ts";
const id = (prefix: string) => prefix + crypto.randomUUID().replaceAll("-", "");
const safe = (s: string) => {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(s))
    throw Error("Invalid subject identity.");
  return s;
};
interface IndexNote {
  id: string;
  path: string;
  text: string;
  revision: string;
  identity?: string;
  aliases?: string[];
  anchors?: string[];
  available?: boolean;
  pending?: number;
  headings: Array<{ title: string; offset: number }>;
}
interface Local {
  binding?: FolderSelection;
  scan: ScanState;
  index: IndexNote[];
  included?: string[];
  pending?: Record<string, number>;
}
interface ProposalGroup {
  id: string;
  workspaceId: string;
  chatId: string;
  lessonId?: string;
  title: string;
  items: Array<{ documentId: string; proposalId: string }>;
  results: Record<string, string>;
  summary?: string;
  createdAt: string;
}
interface Lesson {
  id: string;
  chatId: string;
  summary: string;
  logRevision?: string;
  status: "pending" | "logged" | "review";
  groupId?: string;
  createdAt: string;
  boundary?: string;
}
export interface SubjectOptions {
  dataDir: string;
  localDir: string;
  folders: FolderPort;
  documents: DocumentService;
  readChat: (id: string) => ChatRecord | null;
  changed?: () => void;
  watch?: boolean;
}
const blank = (): ScanState => ({
  phase: "idle",
  visited: 0,
  indexed: 0,
  bytes: 0,
  issues: [],
});
/** Portable metadata, device-local retrieval index, and the existing original-note write engine. */
export class SubjectService {
  private localCache = new Map<string, Local>();
  private watchers = new Map<string, () => void>();
  private refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Map<string, AbortController>();
  private scans = new Map<string, Promise<void>>();
  private locks = new Map<string, Promise<unknown>>();
  private previews = new Map<
    string,
    {
      root: FolderSelection;
      paths: string[];
      issues: Array<{ path: string; reason: string }>;
    }
  >();
  constructor(readonly options: SubjectOptions) {}
  get busy() {
    return this.running.size > 0 || this.locks.size > 0;
  }
  private file(key: string) {
    return path.join(this.options.dataDir, "workspaces", safe(key) + ".json");
  }
  private localFile(key: string) {
    return path.join(this.options.localDir, safe(key) + ".json");
  }
  private local(key: string): Local {
    safe(key);
    let value = this.localCache.get(key);
    if (!value) {
      value = readJson<Local>(this.localFile(key), {
        scan: blank(),
        index: [],
      });
      value.index = readJson<IndexNote[]>(
        path.join(this.options.localDir, key + "-index.json"),
        value.index || [],
      );
      if (value.scan.phase === "scanning") {
        value.scan.phase = "cancelled";
        value.scan.error =
          "Indexing was interrupted. Refresh the folder to continue.";
      }
      this.localCache.set(key, value);
    }
    return value;
  }
  private saveLocal(key: string, l: Local, publishIndex = false) {
    this.localCache.set(key, l);
    atomicWrite(
      this.localFile(key),
      JSON.stringify({ ...l, index: undefined }),
    );
    if (publishIndex)
      atomicWrite(
        path.join(this.options.localDir, safe(key) + "-index.json"),
        JSON.stringify(l.index),
      );
    this.options.changed?.();
  }
  private watch(key: string) {
    if (
      !this.options.watch ||
      !this.options.folders.watch ||
      this.watchers.has(key)
    )
      return;
    const root = this.local(key).binding;
    if (!root) return;
    try {
      this.watchers.set(
        key,
        this.options.folders.watch(root, () => {
          const previous = this.refreshTimers.get(key);
          if (previous) clearTimeout(previous);
          const timer = setTimeout(() => {
            this.refreshTimers.delete(key);
            if (!this.running.has(key)) this.refresh(key);
          }, 800);
          timer.unref?.();
          this.refreshTimers.set(key, timer);
        }),
      );
    } catch {
      /* Revoked providers remain explicitly relinkable. */
    }
  }
  private save(w: Subject) {
    w.updatedAt = new Date().toISOString();
    if (!validSubject(w)) throw Error("Invalid subject record.");
    atomicWrite(this.file(w.id), JSON.stringify(w));
    this.options.changed?.();
  }
  record(key: string): Subject {
    const w = readJson<Subject | null>(this.file(key), null);
    if (!validSubject(w))
      throw Error("Subject unavailable or requires a newer app.");
    return w;
  }
  records(): Subject[] {
    const dir = path.join(this.options.dataDir, "workspaces");
    return fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((n) => n.endsWith(".json"))
          .map((n) => this.record(n.slice(0, -5)))
      : [];
  }
  forChat(chatId: string) {
    return this.records().find((w) => w.chatIds.includes(chatId));
  }
  private async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
  view(key: string): SubjectView {
    const w = this.record(key),
      l = this.local(key);
    this.watch(key);
    const pending = l.index.reduce(
      (sum, n) => sum + (l.pending?.[n.id] ?? n.pending ?? 0),
      0,
    );
    return {
      ...w,
      bound: !!l.binding,
      writable: !!l.binding?.writable,
      scan: l.scan,
      pending,
    };
  }
  noteChanged(noteId: string) {
    for (const w of this.records()) {
      if (!w.notes.some((n) => n.id === noteId)) continue;
      const l = this.local(w.id),
        indexed = l.index.find((n) => n.id === noteId);
      if (!indexed) continue;
      const doc = this.options.documents.record(noteId);
      l.pending ||= {};
      l.pending[noteId] = doc.proposals.filter(
        (p) => p.status === "pending",
      ).length;
      const changed = indexed.revision !== doc.revision;
      if (changed)
        Object.assign(indexed, {
          text: doc.text,
          revision: doc.revision,
          available: !doc.error,
          ...subjectNoteIndex(doc.text),
        });
      this.saveLocal(w.id, l, changed);
    }
  }
  list() {
    return this.records().map((w) => this.view(w.id));
  }
  private async walk(
    root: FolderSelection,
    exclusions: string[],
    signal: AbortSignal,
    progress?: (visited: number) => void,
  ) {
    const files: Array<{ path: string; identity?: string; size?: number }> = [],
      issues: Array<{ path: string; reason: string }> = [];
    let visited = 0,
      complete = true;
    const queue = [""];
    while (queue.length) {
      if (signal.aborted) throw Error("Scan cancelled.");
      const dir = queue.shift()!;
      let entries;
      try {
        entries = await this.options.folders.list(root, dir);
      } catch (e) {
        issues.push({
          path: dir,
          reason: e instanceof Error ? e.message : "Folder unavailable",
        });
        complete = false;
        continue;
      }
      for (const entry of entries) {
        if (signal.aborted) throw Error("Scan cancelled.");
        if (++visited > SUBJECT_LIMITS.entries) {
          issues.push({ path: dir, reason: "25,000-entry scan limit reached" });
          complete = false;
          queue.length = 0;
          break;
        }
        const p = dir ? dir + "/" + entry.name : entry.name;
        try {
          relativeNotePath(p);
        } catch {
          issues.push({ path: p, reason: "Unsupported relative path" });
          continue;
        }
        if (excludedSubjectPath(p, exclusions)) {
          issues.push({ path: p, reason: "Excluded by subject rules" });
          continue;
        }
        if (entry.error) {
          issues.push({ path: p, reason: entry.error });
          complete = false;
          continue;
        }
        if (entry.directory) {
          if (p.split("/").length >= SUBJECT_LIMITS.depth) {
            issues.push({ path: p, reason: "Folder depth limit reached" });
            complete = false;
          } else queue.push(p);
        } else if (p.toLowerCase().endsWith(".md")) {
          if ((entry.size || 0) > SUBJECT_LIMITS.noteBytes)
            issues.push({ path: p, reason: "Note exceeds 5 MiB" });
          else if (files.length >= SUBJECT_LIMITS.notes) {
            issues.push({ path: p, reason: "10,000-note limit reached" });
            complete = false;
          } else
            files.push({ path: p, identity: entry.identity, size: entry.size });
        }
      }
      progress?.(visited);
      await new Promise((r) => setTimeout(r, 0));
    }
    return { files, issues, visited, complete };
  }
  async preview(root: FolderSelection, signal = new AbortController().signal) {
    if (
      !root ||
      !["desktop", "android"].includes(root.kind) ||
      !/^grant_[a-f0-9]{32}$/.test(root.handle)
    )
      throw Error("Choose a native subject folder.");
    const scan = await this.walk(root, [], signal);
    const previewId = id("preview_");
    this.previews.set(previewId, {
      root,
      paths: scan.files.map((f) => f.path),
      issues: scan.issues,
    });
    if (this.previews.size > 8)
      this.previews.delete(this.previews.keys().next().value!);
    return {
      previewId,
      name: root.name,
      writable: root.writable,
      paths: scan.files.map((f) => f.path),
      issues: scan.issues,
      complete: scan.complete,
    };
  }
  async link(input: {
    previewId: string;
    name: string;
    mode: "external" | "app";
    included: string[];
    exclusions?: string[];
    workspaceId?: string;
  }) {
    const p = this.previews.get(input.previewId);
    if (!p) throw Error("Folder preview expired. Choose the folder again.");
    if (
      !["external", "app"].includes(input.mode) ||
      !Array.isArray(input.included) ||
      input.included.some((n) => !p.paths.includes(n))
    )
      throw Error("Choose included notes from the folder preview.");
    const already = this.records().find(
      (w) => this.local(w.id).binding?.handle === p.root.handle,
    );
    if (already && !input.workspaceId)
      throw Error(
        "This folder is already linked. Select that subject to relink it.",
      );
    const key = input.workspaceId ? safe(input.workspaceId) : id("ws_");
    const existing = input.workspaceId ? this.record(key) : null;
    if (existing && existing.mode !== input.mode)
      throw Error("Relinking cannot change sync ownership.");
    // Foreground refresh can race with the picker round trip. Settle its last
    // generation before replacing the binding, rather than rejecting relink.
    this.watchers.get(key)?.();
    this.watchers.delete(key);
    clearTimeout(this.refreshTimers.get(key));
    this.refreshTimers.delete(key);
    this.running.get(key)?.abort();
    await this.scans.get(key);
    const w: Subject = existing || {
      version: 1,
      id: key,
      name: input.name.slice(0, 200) || p.root.name,
      mode: input.mode,
      notes: [],
      exclusions: [],
      roles: { sources: [] },
      chatIds: [],
      logging: false,
      updatedAt: new Date().toISOString(),
    };
    if (existing && existing.mode === "app")
      throw Error(
        "Review destination materialization before binding app-managed notes.",
      );
    w.exclusions = (input.exclusions || w.exclusions).map((p) =>
      relativeNotePath(p),
    );
    const l = this.local(key);
    this.watchers.get(key)?.();
    this.watchers.delete(key);
    l.index = l.index.map((n) => ({ ...n, identity: undefined }));
    l.binding = p.root;
    l.included =
      input.included.length === p.paths.length
        ? undefined
        : [...new Set(input.included)];
    this.save(w);
    this.saveLocal(key, l);
    this.previews.delete(input.previewId);
    this.refresh(key);
    return this.view(key);
  }
  refresh(key: string) {
    this.record(key);
    if (this.running.has(key)) return this.view(key);
    const controller = new AbortController();
    this.running.set(key, controller);
    const task = this.scan(key, controller.signal).finally(() => {
      this.running.delete(key);
      this.scans.delete(key);
    });
    this.scans.set(key, task);
    return this.view(key);
  }
  cancel(key: string) {
    this.running.get(key)?.abort();
  }
  private async scan(key: string, signal: AbortSignal) {
    let l = this.local(key);
    if (!l.binding) {
      l.scan = {
        ...blank(),
        phase: "error",
        error: "Relink the subject folder on this device.",
      };
      this.saveLocal(key, l);
      return;
    }
    l.scan = {
      ...blank(),
      phase: "scanning",
      lastScannedAt: l.scan.lastScannedAt,
    };
    this.saveLocal(key, l);
    try {
      let w = this.record(key);
      const walked = await this.walk(l.binding, w.exclusions, signal, (n) => {
        l.scan.visited = n;
        this.saveLocal(key, l);
      });
      l.scan.issues = walked.issues;
      const next: IndexNote[] = [];
      let total = 0;
      for (const entry of walked.files) {
        if (signal.aborted) throw Error("Scan cancelled.");
        if (l.included && !l.included.includes(entry.path)) continue;
        if (total + (entry.size || 0) > SUBJECT_LIMITS.bytes) {
          l.scan.issues.push({
            path: entry.path,
            reason: "250 MiB subject index limit reached",
          });
          continue;
        }
        try {
          const pick = await this.options.folders.bind(l.binding, entry.path);
          let member = w.notes.find((n) => n.path === entry.path);
          if (!member && entry.identity) {
            const moved = l.index.filter(
              (n) =>
                n.identity === entry.identity &&
                !walked.files.some((f) => f.path === n.path),
            );
            if (moved.length === 1)
              member = w.notes.find((n) => n.id === moved[0]!.id);
          }
          const d = await this.options.documents.link({
            ...pick,
            registerId: member?.id,
            mode: w.mode,
            logging: false,
          });
          if (!member) {
            member = { id: d.id, path: entry.path };
            w.notes.push(member);
          } else if (member.id !== d.id)
            throw Error(
              "This file is already assigned to another note. Review its mapping.",
            );
          else member.path = entry.path;
          const r = await this.options.documents.read(d.id);
          if (r.document.error) throw Error(r.document.error);
          const bytes = Buffer.byteLength(r.text);
          if (total + bytes > SUBJECT_LIMITS.bytes)
            throw Error("250 MiB subject index limit reached");
          total += bytes;
          next.push({
            id: d.id,
            path: entry.path,
            text: r.text,
            revision: r.document.revision,
            identity: entry.identity,
            available: true,
            pending: r.document.proposals.filter((p) => p.status === "pending")
              .length,
            ...subjectNoteIndex(r.text),
          });
          l.scan.indexed = next.length;
          l.scan.bytes = total;
        } catch (e) {
          l.scan.issues.push({
            path: entry.path,
            reason: e instanceof Error ? e.message : "Note unavailable",
          });
        }
        if (next.length % 10 === 0) {
          this.saveLocal(key, l);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      for (const n of w.notes)
        if (!next.some((i) => i.id === n.id))
          l.scan.issues.push({
            path: n.path,
            reason: walked.complete
              ? "Missing, excluded or unavailable; cached note retained"
              : "Scan incomplete; previous note state retained",
          });
      // Publish the completed index generation; partial reads retain unavailable cached candidates.
      const ids = new Set(next.map((n) => n.id));
      l.index = [
        ...next,
        ...l.index
          .filter((n) => !ids.has(n.id) && w.notes.some((m) => m.id === n.id))
          .map((n) => ({ ...n, available: false })),
      ];
      l.scan.phase = l.scan.issues.some((i) => !i.reason.startsWith("Excluded"))
        ? "partial"
        : "ready";
      l.scan.lastScannedAt = new Date().toISOString();
      const latest = this.record(key);
      latest.notes = w.notes;
      this.save(latest);
      this.saveLocal(key, l, true);
    } catch (e) {
      l = this.local(key);
      l.scan.phase = signal.aborted ? "cancelled" : "error";
      l.scan.error = e instanceof Error ? e.message : "Folder unavailable";
      this.saveLocal(key, l);
    }
  }
  update(
    key: string,
    patch: {
      name?: string;
      roles?: Subject["roles"];
      logging?: boolean;
      exclusions?: string[];
    },
  ) {
    if (this.running.has(key))
      throw Error("Wait for the folder scan before changing subject settings.");
    const w = this.record(key);
    if (patch.name !== undefined) w.name = patch.name.slice(0, 200);
    if (patch.roles) w.roles = patch.roles;
    if (patch.logging !== undefined) w.logging = patch.logging;
    if (patch.exclusions)
      w.exclusions = patch.exclusions.map((p) => relativeNotePath(p));
    if (w.logging && !w.roles.log)
      throw Error("Choose a lesson log before enabling automatic logging.");
    this.save(w);
    return this.view(key);
  }
  associate(key: string, chatId: string) {
    if (this.running.has(key))
      throw Error("Wait for the folder scan before associating a session.");
    if (!this.options.readChat(chatId)) throw Error("Session unavailable.");
    const other = this.forChat(chatId);
    if (other && other.id !== key)
      throw Error("This session already belongs to another subject.");
    const w = this.record(key);
    if (!w.chatIds.includes(chatId)) {
      w.chatIds.push(chatId);
      this.save(w);
    }
    return this.view(key);
  }
  private included(w: Subject, n: { id: string; path: string }) {
    const l = this.local(w.id);
    return (
      !excludedSubjectPath(n.path, w.exclusions) &&
      (!l.included || l.included.includes(n.path))
    );
  }
  noteList(key: string, query = "", offset = 0) {
    const w = this.record(key),
      l = this.local(key);
    const matches = w.notes.filter(
      (n) =>
        this.included(w, n) &&
        n.path.toLowerCase().includes(query.toLowerCase()),
    );
    return {
      offset,
      notes: matches.slice(offset, offset + 100).map((n) => ({
        ...n,
        headings: l.index.find((i) => i.id === n.id)?.headings || [],
        cached: l.index.some((i) => i.id === n.id),
      })),
      total: matches.length,
      nextOffset: offset + 100 < matches.length ? offset + 100 : undefined,
    };
  }
  search(key: string, query: string, limit = 12) {
    const workspace = this.record(key);
    const words =
      query
        .slice(0, 500)
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) || [];
    const terms = [
      ...new Set(
        words.flatMap((word) =>
          /\p{Script=Han}/u.test(word) && word.length > 2
            ? [
                word,
                ...Array.from({ length: word.length - 1 }, (_, i) =>
                  word.slice(i, i + 2),
                ),
              ]
            : [word],
        ),
      ),
    ].slice(0, 20);
    if (!terms.length) return [];
    return this.local(key)
      .index.filter((n) => this.included(workspace, n))
      .map((n) => {
        const lower = n.text.toLowerCase();
        let offset = lower.indexOf(terms[0]!);
        const score = terms.reduce(
          (s, t) =>
            s +
            (lower.includes(t) ? 1 : 0) +
            (n.path.toLowerCase().includes(t) ? 3 : 0) +
            (n.headings.some((h) => h.title.toLowerCase().includes(t)) ? 2 : 0),
          0,
        );
        if (offset < 0) offset = 0;
        return {
          noteId: n.id,
          path: n.path,
          revision: n.revision,
          offset: Math.max(0, offset - 120),
          available: n.available !== false,
          snippet: n.text.slice(Math.max(0, offset - 120), offset + 500),
          score,
        };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(20, limit));
  }
  excludedNoteIds(key: string) {
    const w = this.record(key);
    return new Set(
      w.notes.filter((n) => !this.included(w, n)).map((n) => n.id),
    );
  }
  contextTargets(key: string, query: string) {
    const w = this.record(key),
      index = this.local(key).index,
      targets: Array<{ noteId: string; offset: number }> = [];
    if (w.roles.checkpoint)
      targets.push({ noteId: w.roles.checkpoint, offset: 0 });
    if (w.roles.log) {
      const log = index.find((n) => n.id === w.roles.log);
      targets.push({
        noteId: w.roles.log,
        offset: Math.max(0, (log?.text.length || 0) - 1200),
      });
    }
    for (const result of this.search(key, query, 3))
      targets.push({ noteId: result.noteId, offset: result.offset });
    for (const noteId of w.roles.sources) targets.push({ noteId, offset: 0 });
    const seen = new Set<string>();
    return targets.filter((t) => {
      if (seen.has(t.noteId)) return false;
      seen.add(t.noteId);
      return true;
    });
  }
  async read(
    key: string,
    noteId: string,
    chatId?: string,
    offset = 0,
    maxChars = 12000,
  ) {
    const w = this.record(key),
      n = w.notes.find((n) => n.id === noteId);
    if (!n || !this.included(w, n))
      throw Error("Note is not included in this subject.");
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(maxChars) ||
      maxChars < 0 ||
      maxChars > 48000
    )
      throw Error("Invalid note window.");
    if (chatId) {
      if (!w.chatIds.includes(chatId))
        throw Error("Subject is not associated with this session.");
      await this.options.documents.associate(noteId, chatId);
    }
    let folderError: string | undefined;
    const binding = this.local(key).binding;
    if (!binding)
      folderError =
        "Folder is not bound on this device. Relink it before using original notes.";
    if (binding)
      try {
        const current = await this.options.folders.bind(binding, n.path),
          bound = this.options.documents.boundHandle(noteId);
        if (
          !bound ||
          bound.handle !== current.handle ||
          bound.kind !== current.kind
        )
          folderError =
            "The file identity changed at this relative path. Review the mapping and relink before editing.";
      } catch (e) {
        folderError =
          e instanceof Error ? e.message : "Folder unavailable. Relink it.";
      }
    const r = await this.options.documents.read(noteId, chatId);
    const text = r.text.slice(offset, offset + maxChars);
    const links = [
      ...text.matchAll(/!?\[\[([^\]]+)\]\]|\[[^\]]*\]\(([^)]+)\)/g),
    ]
      .slice(0, 30)
      .map((m) => ({
        target: m[1] || m[2]!,
        ...resolveSubjectLink(
          w.notes
            .filter((member) => this.included(w, member))
            .map((member) => ({
              ...member,
              aliases: this.local(key).index.find((i) => i.id === member.id)
                ?.aliases,
            })),
          n.path,
          m[1] || m[2]!,
        ),
      }));
    for (const link of links)
      if (link.status === "resolved" && link.anchor) {
        const target = this.local(key).index.find((i) => i.id === link.noteId);
        if (!target?.anchors?.includes(link.anchor.toLowerCase()))
          link.status = "missing";
      }
    return {
      workspaceId: key,
      noteId,
      path: n.path,
      heading: this.local(key)
        .index.find((i) => i.id === noteId)
        ?.headings.filter((h) => h.offset <= offset)
        .at(-1)?.title,
      revision: r.document.revision,
      text,
      offset,
      nextOffset:
        offset + text.length < r.text.length ? offset + text.length : undefined,
      error: folderError || r.document.error,
      links,
    };
  }
  async propose(
    key: string,
    chatId: string,
    noteId: string,
    revision: string,
    before: string,
    after: string,
    reason: string,
  ) {
    const read = await this.read(key, noteId, chatId, 0, 0);
    if (read.error) throw Error(read.error);
    return this.options.documents.propose(
      noteId,
      chatId,
      revision,
      before,
      after,
      reason,
    );
  }
  private groupsFile(key: string) {
    return path.join(this.options.localDir, safe(key) + "-groups.json");
  }
  groups(key: string) {
    const w = this.record(key),
      groups = readJson<ProposalGroup[]>(this.groupsFile(key), []);
    for (const meta of w.groups || [])
      if (!groups.some((g) => g.id === meta.id))
        groups.push({ ...meta, workspaceId: key, results: {} });
    for (const g of groups)
      for (const item of g.items) {
        try {
          const p = this.options.documents
            .record(item.documentId)
            .proposals.find((p) => p.id === item.proposalId);
          if (
            p &&
            (p.status !== "pending" ||
              !g.results[item.proposalId] ||
              ["pending", "applied", "undone", "rejected"].includes(
                g.results[item.proposalId]!,
              ))
          )
            g.results[item.proposalId] = p.status;
          else if (!g.results[item.proposalId])
            g.results[item.proposalId] =
              "Review on originating device; external proposal content is not synchronized.";
        } catch {}
      }
    return groups;
  }
  createGroup(key: string, chatId: string, title: string) {
    const w = this.record(key);
    if (!w.chatIds.includes(chatId))
      throw Error("Session must belong to this subject.");
    const group: ProposalGroup = {
      id: id("group_"),
      workspaceId: key,
      chatId,
      title: title.slice(0, 200),
      items: [],
      results: {},
      createdAt: new Date().toISOString(),
    };
    const groups = this.groups(key);
    groups.push(group);
    atomicWrite(this.groupsFile(key), JSON.stringify(groups));
    w.groups = [
      ...(w.groups || []),
      {
        id: group.id,
        chatId,
        title: group.title,
        items: [],
        createdAt: group.createdAt,
      },
    ];
    this.save(w);
    return group;
  }
  addToGroup(
    key: string,
    groupId: string,
    documentId: string,
    proposalId: string,
  ) {
    const groups = this.groups(key),
      g = groups.find((g) => g.id === groupId);
    if (!g || !this.record(key).notes.some((n) => n.id === documentId))
      throw Error("Proposal group unavailable.");
    const p = this.options.documents
      .record(documentId)
      .proposals.find((p) => p.id === proposalId);
    if (!p || p.chatId !== g.chatId)
      throw Error("Proposal does not belong to this group session.");
    if (!g.items.some((i) => i.proposalId === proposalId))
      g.items.push({ documentId, proposalId });
    atomicWrite(this.groupsFile(key), JSON.stringify(groups));
    const w = this.record(key),
      meta = w.groups?.find((m) => m.id === groupId);
    if (meta) {
      meta.items = g.items;
      this.save(w);
    }
    this.options.changed?.();
    return g;
  }
  async reviewGroup(
    key: string,
    groupId: string,
    action: "apply" | "reject" | "undo",
    selected?: string[],
  ) {
    if (!["apply", "reject", "undo"].includes(action))
      throw Error("Choose Apply, Reject or Undo.");
    return this.lock(key, async () => {
      const groups = this.groups(key),
        g = groups.find((g) => g.id === groupId);
      if (!g) throw Error("Proposal group not found.");
      if (action !== "reject")
        for (const item of g.items) {
          if (selected && !selected.includes(item.proposalId)) continue;
          const w = this.record(key),
            n = w.notes.find((n) => n.id === item.documentId);
          if (!n || !this.included(w, n))
            throw Error("A selected proposal belongs to an excluded note.");
          const p = this.options.documents
            .record(item.documentId)
            .proposals.find((p) => p.id === item.proposalId);
          if (!p)
            throw Error(
              "Review this external proposal on its originating device.",
            );
          if (
            (action === "apply" && p.status === "applied") ||
            (action === "undo" && p.status === "undone")
          )
            continue;
          const current = await this.read(
            key,
            item.documentId,
            undefined,
            0,
            0,
          );
          if (
            current.error ||
            current.revision !==
              (action === "undo" ? p.appliedRevision : p.baseRevision)
          ) {
            g.results[p.id] =
              current.error ||
              "Preflight: the note changed; re-read it and create a fresh proposal.";
            atomicWrite(this.groupsFile(key), JSON.stringify(groups));
            return g;
          }
        }
      for (const item of g.items) {
        if (selected && !selected.includes(item.proposalId)) continue;
        const p = this.options.documents
          .record(item.documentId)
          .proposals.find((p) => p.id === item.proposalId);
        if (!p) continue;
        if (
          (action === "apply" && p.status === "applied") ||
          (action === "undo" && p.status === "undone") ||
          (action === "reject" && p.status === "rejected")
        ) {
          g.results[p.id] = p.status;
          continue;
        }
        g.results[p.id] = "pending " + action;
        atomicWrite(this.groupsFile(key), JSON.stringify(groups));
        try {
          await this.options.documents.review(
            item.documentId,
            item.proposalId,
            action,
          );
          g.results[p.id] =
            action === "apply"
              ? "applied"
              : action === "undo"
                ? "undone"
                : "rejected";
        } catch (e) {
          g.results[p.id] =
            e instanceof Error ? e.message : "File update failed";
          atomicWrite(this.groupsFile(key), JSON.stringify(groups));
          break;
        }
        atomicWrite(this.groupsFile(key), JSON.stringify(groups));
      }
      this.options.changed?.();
      this.refresh(key);
      return g;
    });
  }
  async createNote(key: string, relative: string, text: string) {
    const w = this.record(key),
      l = this.local(key);
    if (!l.binding) throw Error("Relink the subject folder.");
    relativeNotePath(relative);
    await this.options.folders.create(l.binding, relative, text);
    if (l.included && !l.included.includes(relative)) {
      l.included.push(relative);
      this.saveLocal(key, l);
    }
    this.refresh(w.id);
    return { created: true };
  }
  async materializationPreview(key: string, previewId: string) {
    const w = this.record(key),
      p = this.previews.get(previewId);
    if (w.mode !== "app" || !p)
      throw Error("Choose a destination folder for this app-managed subject.");
    const rows = [];
    for (const n of w.notes) {
      const d = this.options.documents.record(n.id);
      if (!p.paths.includes(n.path)) {
        rows.push({
          ...n,
          status: "missing",
          localRevision: null,
          remoteRevision: d.revision,
        });
        continue;
      }
      try {
        const picked = await this.options.folders.bind(p.root, n.path),
          current = await this.options.documents.inspect(picked);
        rows.push({
          ...n,
          status: current.revision === d.revision ? "same" : "different",
          localRevision: current.revision,
          remoteRevision: d.revision,
        });
      } catch (e) {
        rows.push({
          ...n,
          status: "unavailable",
          localRevision: null,
          remoteRevision: d.revision,
          error: e instanceof Error ? e.message : "Unavailable",
        });
      }
    }
    return { previewId, rows };
  }
  async materialize(
    key: string,
    previewId: string,
    decisions: Array<{
      id: string;
      choice: "local" | "synced" | "skip";
      localRevision: string | null;
    }>,
  ) {
    if (this.running.has(key))
      throw Error("Wait for indexing before binding a destination.");
    return this.lock(key, async () => {
      const w = this.record(key),
        p = this.previews.get(previewId);
      if (w.mode !== "app" || !p) throw Error("Destination preview expired.");
      if (
        !Array.isArray(decisions) ||
        decisions.length > w.notes.length ||
        new Set(decisions.map((d) => d.id)).size !== decisions.length
      )
        throw Error("Invalid materialization choices.");
      const journal = path.join(
          this.options.localDir,
          safe(key) + "-materialize.json",
        ),
        results: Record<string, string> = {};
      for (const choice of decisions) {
        const n = w.notes.find((n) => n.id === choice.id);
        if (!n || !["local", "synced", "skip"].includes(choice.choice))
          throw Error("Choose a valid included note and resolution.");
        if (choice.choice === "skip") {
          results[n.id] = "skipped";
          continue;
        }
        atomicWrite(
          journal,
          JSON.stringify({ previewId, decisions, results, pending: n.id }),
        );
        try {
          const d = this.options.documents.record(n.id);
          let picked: FolderSelection;
          try {
            picked = await this.options.folders.bind(p.root, n.path);
          } catch (e) {
            if (
              choice.localRevision !== null ||
              choice.choice !== "synced" ||
              p.paths.includes(n.path)
            )
              throw e;
            picked = await this.options.folders.create(p.root, n.path, d.text);
          }
          const now = await this.options.documents.inspect(picked);
          if (
            now.revision !== d.revision &&
            now.revision !== choice.localRevision
          )
            throw Error("Destination changed after preview. Review it again.");
          await this.options.documents.link({
            ...picked,
            documentId: n.id,
            mode: "app",
            logging: false,
          });
          if (now.revision !== d.revision)
            await this.options.documents.resolveFile(n.id, choice.choice);
          results[n.id] = "bound";
        } catch (e) {
          results[n.id] =
            e instanceof Error ? e.message : "Destination write failed";
          atomicWrite(
            journal,
            JSON.stringify({ previewId, decisions, results }),
          );
          break;
        }
        atomicWrite(journal, JSON.stringify({ previewId, decisions, results }));
      }
      const l = this.local(key);
      this.watchers.get(key)?.();
      this.watchers.delete(key);
      l.index = l.index.map((n) => ({ ...n, identity: undefined }));
      l.binding = p.root;
      l.included = w.notes
        .filter((n) => results[n.id] === "bound")
        .map((n) => n.path);
      this.saveLocal(key, l);
      this.refresh(key);
      return { results };
    });
  }
  async transition(key: string, mode: "app" | "external") {
    if (this.busy)
      throw Error("Wait for active subject work before changing sync owner.");
    if (!["external", "app"].includes(mode))
      throw Error("Choose the new note sync owner.");
    return this.lock(key, async () => {
      const w = this.record(key),
        previous = w.mode;
      for (const n of w.notes) {
        if (
          this.records().some(
            (other) =>
              other.id !== key && other.notes.some((m) => m.id === n.id),
          )
        )
          throw Error(
            "A note also belongs to another subject. Reconcile shared ownership first.",
          );
        const r = await this.options.documents.read(n.id);
        if (r.document.error) throw Error(r.document.error);
      }
      w.logging = false;
      this.save(w);
      const changed: string[] = [];
      try {
        for (const n of w.notes) {
          await this.options.documents.setMode(n.id, mode);
          changed.push(n.id);
        }
        w.mode = mode;
        this.save(w);
      } catch (e) {
        for (const id of changed)
          await this.options.documents.setMode(id, previous);
        throw e;
      }
      return this.view(key);
    });
  }
  private lessonsFile(key: string) {
    return path.join(this.options.localDir, safe(key) + "-lessons.json");
  }
  lessons(key: string) {
    this.record(key);
    return Object.values(
      readJson<Record<string, Lesson>>(this.lessonsFile(key), {}),
    );
  }
  /** Explicit completion creates a durable request; opening a subject never invokes a model. */
  async finish(key: string, chatId: string, operationId: string) {
    safe(operationId);
    return this.lock(key, async () => {
      const w = this.record(key);
      if (!w.chatIds.includes(chatId))
        throw Error("Session does not belong to this subject.");
      const file = this.lessonsFile(key),
        lessons = readJson<Record<string, Lesson>>(file, {});
      const chat = this.options.readChat(chatId);
      if (!chat) throw Error("Session unavailable.");
      const boundaryMessage = [...chat.messages]
        .reverse()
        .find(
          (m) =>
            m.role === "user" &&
            !/Call record_subject_lesson with lessonId lesson_[a-f0-9]+/.test(
              JSON.stringify(m.content),
            ),
        );
      const boundary =
        boundaryMessage?.id ||
        createHash("sha256")
          .update(JSON.stringify(boundaryMessage || chat.messages))
          .digest("hex");
      const lessonId =
        "lesson_" +
        createHash("sha256")
          .update(key + "\0" + chatId + "\0" + boundary)
          .digest("hex")
          .slice(0, 32);
      let lesson =
        lessons[operationId] ||
        Object.values(lessons).find(
          (l) =>
            l.chatId === chatId &&
            (l.boundary === boundary || l.id === lessonId),
        );
      if (!lesson) {
        if (
          hasUnresolvedQuestion(chat.messages) ||
          activeProblemOf(chat.messages)
        )
          throw Error(
            "Answer or dismiss the pending question/problem before finishing this lesson.",
          );
        if (!liveDocumentBlocks(chat).length)
          throw Error("There is no visible learning material yet.");
        lesson = {
          id: lessonId,
          boundary,
          chatId,
          summary: "",
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        lessons[operationId] = lesson;
        atomicWrite(file, JSON.stringify(lessons));
      }
      return {
        ...lesson,
        checkpointId: w.roles.checkpoint,
        automaticLog: !!w.roles.log && w.logging,
        requestPrompt: `Finish this completed lesson for subject ${w.name}. Summarize material covered, demonstrated progress, mistakes and weak points, and the next review/practice. Use only material already visible to me; do not reveal pending solutions. Call record_subject_lesson with lessonId ${lesson.id} and the summary. Its result identifies a review group: read the current checkpoint and propose a focused checkpoint update, then any useful source-note changes in that group. Never apply edits yourself. Explain what was logged and what awaits review.`,
      };
    });
  }
  async recordLesson(
    key: string,
    chatId: string,
    lessonId: string,
    summary: string,
  ) {
    return this.lock(key, async () => {
      const w = this.record(key),
        file = this.lessonsFile(key),
        lessons = readJson<Record<string, Lesson>>(file, {}),
        lesson = Object.values(lessons).find(
          (l) => l.id === lessonId && l.chatId === chatId,
        );
      if (!lesson)
        throw Error(
          "The learner must explicitly finish a lesson before recording its summary.",
        );
      if (lesson.status !== "pending")
        return {
          lessonId: lesson.id,
          status: lesson.status,
          groupId: lesson.groupId,
        };
      if (!summary.trim() || summary.length > 24000)
        throw Error("Provide a lesson summary up to 24,000 characters.");
      const chat = this.options.readChat(chatId);
      if (
        !chat ||
        hasUnresolvedQuestion(chat.messages) ||
        activeProblemOf(chat.messages)
      )
        throw Error(
          "Resolve the pending question before recording this lesson.",
        );
      lesson.summary = `## Lesson — ${lesson.createdAt.slice(0, 10)}\n\n${summary}`;
      lesson.groupId = this.createGroup(
        key,
        chatId,
        "Completed lesson note updates",
      ).id;
      if (w.roles.log) {
        const log = await this.read(key, w.roles.log, undefined, 0, 0);
        if (log.error) throw Error(log.error);
        lesson.logRevision = log.revision;
      }
      lesson.status = "review";
      atomicWrite(file, JSON.stringify(lessons));
      if (w.logging && w.roles.log) {
        await this.options.documents.appendLesson(
          w.roles.log,
          lesson.id,
          lesson.summary,
        );
        lesson.status = "logged";
        atomicWrite(file, JSON.stringify(lessons));
        this.refresh(key);
      }
      this.options.changed?.();
      return {
        lessonId: lesson.id,
        status: lesson.status,
        groupId: lesson.groupId,
        checkpointId: w.roles.checkpoint,
      };
    });
  }
  async applyLessonLog(key: string, lessonId: string) {
    return this.lock(key, async () => {
      const w = this.record(key),
        file = this.lessonsFile(key),
        lessons = readJson<Record<string, Lesson>>(file, {}),
        lesson = Object.values(lessons).find((l) => l.id === lessonId);
      if (!lesson || !w.roles.log || lesson.status === "pending")
        throw Error("Prepare a summary and select a log first.");
      if (lesson.status === "logged") return lesson;
      const original = await this.read(key, w.roles.log, lesson.chatId, 0, 0);
      if (original.error) throw Error(original.error);
      const current = await this.options.documents.read(w.roles.log);
      if (current.document.revision !== lesson.logRevision)
        throw Error(
          "The log changed after this summary was prepared. Review it again before appending.",
        );
      await this.options.documents.appendLesson(
        w.roles.log,
        lesson.id,
        lesson.summary,
      );
      lesson.status = "logged";
      atomicWrite(file, JSON.stringify(lessons));
      this.refresh(key);
      return lesson;
    });
  }
}
