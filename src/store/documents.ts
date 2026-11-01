import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite, readJson } from "./atomic-json.ts";
import {
  replaceExact,
  type DocumentBinding,
  type DocumentProposal,
  type DocumentSyncMode,
  type DocumentView,
  type DocumentNativeAdapter,
  type LinkedDocument,
} from "../core/documents/types.ts";
import { liveDocumentBlocks } from "../core/documents/live-markdown.ts";
import type { ChatRecord } from "../core/contracts.ts";
export const textHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export interface DocumentRecord extends LinkedDocument {
  version: 1;
  proposals: DocumentProposal[];
  frozenBlocks?: string[];
}
interface Binding extends DocumentBinding {
  conflict?: { localText: string; remoteRevision: string };
}
interface Grant {
  path: string;
  name: string;
  writable: boolean;
}
export interface DocumentServiceOptions {
  dataDir: string;
  localDir?: string;
  nativeAdapter?: DocumentNativeAdapter;
  grantsFile: string;
  androidUrl?: string;
  androidToken?: string;
  readChat: (id: string) => ChatRecord | null;
  changed?: () => void;
}
const safeId = (id: string) => {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id))
    throw new Error("Invalid document identity");
  return id;
};
export class DocumentService {
  private locks = new Map<string, Promise<unknown>>();
  private working = 0;
  constructor(private options: DocumentServiceOptions) {}
  get busy() {
    return this.working > 0;
  }
  private dir() {
    return path.join(this.options.dataDir, "documents");
  }
  private local() {
    return (
      this.options.localDir ||
      path.join(this.options.dataDir, ".documents-local")
    );
  }
  private file(id: string) {
    return path.join(this.dir(), safeId(id) + ".json");
  }
  record(id: string) {
    const d = readJson<DocumentRecord | null>(this.file(id), null);
    if (!d) throw new Error("Linked document not found");
    if (d.version !== 1)
      throw new Error("This document requires a newer app version.");
    return d;
  }
  records(): DocumentRecord[] {
    if (!fs.existsSync(this.dir())) return [];
    return fs
      .readdirSync(this.dir())
      .filter((n) => n.endsWith(".json"))
      .map((n) => this.record(n.slice(0, -5)));
  }
  private save(d: DocumentRecord) {
    atomicWrite(this.file(d.id), JSON.stringify(d, null, 2));
    this.options.changed?.();
  }
  private bindings() {
    return readJson<Record<string, Binding>>(
      path.join(this.local(), "bindings.json"),
      {},
    );
  }
  private binding(id: string) {
    return this.bindings()[id];
  }
  private saveBinding(b: Binding) {
    const all = this.bindings();
    all[b.documentId] = b;
    atomicWrite(path.join(this.local(), "bindings.json"), JSON.stringify(all));
  }
  private async lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(async () => {
        this.working++;
        try {
          return await fn();
        } finally {
          this.working--;
        }
      });
    this.locks.set(id, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }
  private grant(handle: string): Grant {
    safeId(handle);
    const grant = readJson<Record<string, Grant>>(this.options.grantsFile, {})[
      handle
    ];
    if (!grant || typeof grant.path !== "string")
      throw new Error("The file permission is missing. Relink the document.");
    return grant;
  }
  private async android(
    operation: string,
    b: Binding,
    extra: Record<string, unknown> = {},
  ) {
    if (!this.options.androidUrl || !this.options.androidToken)
      throw new Error(
        "Android document service unavailable. Restart the engine.",
      );
    const r = await fetch(this.options.androidUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.androidToken}`,
      },
      redirect: "error",
      body: JSON.stringify({ operation, handle: b.handle, ...extra }),
      signal: AbortSignal.timeout(30000),
    });
    const result = await r.json();
    if (!r.ok || result.error)
      throw new Error(
        typeof result.error === "string"
          ? result.error
          : "The selected document could not be accessed.",
      );
    return result;
  }
  private async nativeRead(b: Binding): Promise<string> {
    if (this.options.nativeAdapter)
      return this.options.nativeAdapter.read(b.handle);
    if (b.kind === "android")
      return String((await this.android("read", b)).text);
    const file = this.grant(b.handle).path;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024)
      throw new Error("Select a UTF-8 Markdown file up to 5 MB.");
    const bytes = fs.readFileSync(file),
      text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes))
      throw new Error("Select a UTF-8 Markdown document.");
    return text;
  }
  private backup(id: string, text: string) {
    const hash = textHash(text);
    atomicWrite(
      path.join(this.local(), "history", safeId(id), hash + ".md"),
      text,
    );
  }
  private async nativeWrite(b: Binding, text: string, expected: string) {
    if (Buffer.byteLength(text) > 5 * 1024 * 1024)
      throw new Error("Markdown exceeds the 5 MB document limit.");
    if (!b.writable)
      throw new Error("This file is read-only. Relink with write permission.");
    const before = await this.nativeRead(b);
    if (textHash(before) !== expected)
      throw new Error(
        "The file changed outside LearnHarness. Review the current document before saving.",
      );
    this.backup(b.documentId, before);
    if (this.options.nativeAdapter)
      await this.options.nativeAdapter.write(b.handle, text, expected);
    else if (b.kind === "android")
      await this.android("write", b, { text, expectedHash: expected });
    else {
      const grant = this.grant(b.handle);
      if (!grant.writable)
        throw new Error(
          "This document was linked read-only. Choose a writable file.",
        );
      const mode = fs.statSync(grant.path).mode;
      atomicWrite(grant.path, text);
      fs.chmodSync(grant.path, mode);
    }
    const saved = await this.nativeRead(b);
    if (textHash(saved) !== textHash(text))
      throw new Error(
        "The document provider did not retain the complete write. A recovery copy is available.",
      );
  }
  private intentFile(id: string) {
    return path.join(this.local(), "write-intents", safeId(id) + ".json");
  }
  private finishIntent(next: DocumentRecord, b: Binding) {
    this.save(next);
    b.lastWrittenRevision = next.revision;
    delete b.conflict;
    this.saveBinding(b);
    if (fs.existsSync(this.intentFile(next.id)))
      fs.unlinkSync(this.intentFile(next.id));
    const error = path.join(this.local(), next.id + "-error.json");
    if (fs.existsSync(error)) fs.unlinkSync(error);
  }
  private freezeChangedBlocks(before: DocumentRecord, next: DocumentRecord) {
    const frozen = new Set(next.frozenBlocks || []);
    for (const [token, hash] of Object.entries(before.blockHashes)) {
      const start = `<!--lh:block:${token}-->`,
        end = `<!--/lh:block:${token}-->`,
        i = next.text.indexOf(start),
        j = i < 0 ? -1 : next.text.indexOf(end, i);
      const current =
        i >= 0 && j >= 0 ? textHash(next.text.slice(i, j + end.length)) : "";
      if (current !== hash) frozen.add(token);
      else frozen.delete(token);
    }
    next.frozenBlocks = [...frozen];
  }
  private async commitText(
    before: DocumentRecord,
    next: DocumentRecord,
    b: Binding,
    expected: string,
  ) {
    this.backup(before.id, before.text);
    atomicWrite(
      this.intentFile(before.id),
      JSON.stringify({ before, after: next, expected }),
    );
    try {
      await this.nativeWrite(b, next.text, expected);
      this.finishIntent(next, b);
    } catch (error) {
      atomicWrite(
        path.join(this.local(), before.id + "-error.json"),
        JSON.stringify({
          message:
            "The note could not be completely saved. The prior version and proposed changes are preserved; review the document before retrying.",
        }),
      );
      throw error;
    }
  }
  private async refresh(d: DocumentRecord): Promise<DocumentRecord> {
    const b = this.binding(d.id);
    if (!b) return d;
    try {
      const text = await this.nativeRead(b),
        hash = textHash(text);
      const pending = readJson<{
        before: DocumentRecord;
        after: DocumentRecord;
        expected: string;
      } | null>(this.intentFile(d.id), null);
      if (pending) {
        if (hash === pending.after.revision) {
          this.finishIntent(pending.after, b);
          return pending.after;
        }
        if (hash === pending.expected) {
          fs.unlinkSync(this.intentFile(d.id));
        } else {
          d.error =
            "A document write was interrupted. The cached note and the provider's current bytes are preserved. Choose which version to keep.";
          return d;
        }
      }
      if (b.conflict && hash !== d.revision) {
        b.conflict.localText = text;
        this.saveBinding(b);
        d.error =
          "The selected local file and synced note differ. Review which version to keep before saving.";
        return d;
      }
      if (hash === d.revision) {
        if (b.lastWrittenRevision !== hash) {
          b.lastWrittenRevision = hash;
          delete b.conflict;
          this.saveBinding(b);
        }
        delete d.error;
        return d;
      }
      if (
        d.mode === "app" &&
        b.lastWrittenRevision &&
        b.lastWrittenRevision !== d.revision
      ) {
        if (hash === b.lastWrittenRevision) {
          await this.commitText(d, d, b, hash);
          delete d.error;
          return d;
        }
        b.conflict = { localText: text, remoteRevision: d.revision };
        this.saveBinding(b);
        d.error =
          "Both this file and the synced document changed. Choose which version to use; both are preserved.";
        return d;
      }
      this.backup(d.id, d.text);
      d.text = text;
      d.revision = hash;
      d.updatedAt = new Date().toISOString();
      delete d.error;
      b.lastWrittenRevision = hash;
      this.saveBinding(b);
      this.save(d);
      return d;
    } catch (e) {
      d.error =
        e instanceof Error
          ? e.message
          : "The document is unavailable. Relink it to continue.";
      return d;
    }
  }
  private view(d: DocumentRecord): DocumentView {
    const b = this.binding(d.id);
    return {
      id: d.id,
      name: d.name,
      chatIds: d.chatIds,
      mode: d.mode,
      logging: d.logging,
      revision: d.revision,
      updatedAt: d.updatedAt,
      bound: Boolean(b),
      writable: Boolean(b?.writable),
      error:
        d.error ||
        readJson<{ message: string } | null>(
          path.join(this.local(), d.id + "-error.json"),
          null,
        )?.message,
      proposals: d.proposals,
    };
  }
  async selectedAttachment(
    handle: string,
    kind: "desktop" | "android",
  ): Promise<string> {
    safeId(handle);
    if (kind === "desktop") return this.grant(handle).path;
    if (kind !== "android") throw new Error("Invalid file permission");
    return String(
      (
        await this.android("copy", {
          documentId: "attachment",
          kind,
          handle,
          writable: false,
        })
      ).path,
    );
  }
  async list(chatId?: string): Promise<DocumentView[]> {
    const result: DocumentView[] = [];
    for (const record of this.records())
      if (!chatId || record.chatIds.includes(chatId))
        result.push(
          await this.lock(record.id, async () =>
            this.view(await this.refresh(this.record(record.id))),
          ),
        );
    return result;
  }
  async link(input: {
    documentId?: string;
    chatId: string;
    name: string;
    handle: string;
    kind: "desktop" | "android";
    writable: boolean;
    mode: DocumentSyncMode;
  }): Promise<DocumentView> {
    if (!this.options.readChat(input.chatId))
      throw new Error("Session not found");
    if (
      (input.kind !== "desktop" && input.kind !== "android") ||
      (input.mode !== "app" && input.mode !== "external")
    )
      throw new Error("Invalid document binding");
    safeId(input.handle);
    const alreadyLinked = this.records().find((record) => {
      const binding = this.binding(record.id);
      return binding?.kind === input.kind && binding.handle === input.handle;
    });
    if (
      input.documentId &&
      alreadyLinked &&
      alreadyLinked.id !== input.documentId
    )
      throw new Error(
        "This file already belongs to another linked note. Select that note, or choose a different file.",
      );
    const id = input.documentId
      ? safeId(input.documentId)
      : alreadyLinked?.id || "doc_" + crypto.randomUUID().replaceAll("-", "");
    return this.lock(id, async () => {
      const binding: Binding = {
        documentId: id,
        handle: input.handle,
        kind: input.kind,
        writable: input.writable,
      };
      const text = await this.nativeRead(binding);
      if (text.includes("\u0000"))
        throw new Error("Select a UTF-8 Markdown document.");
      const now = new Date().toISOString();
      const existing =
        input.documentId || alreadyLinked ? this.record(id) : null;
      const d: DocumentRecord = existing || {
        version: 1,
        id,
        name: input.name.slice(0, 200) || "Learning note.md",
        chatIds: [],
        mode: input.mode,
        logging: true,
        text,
        revision: textHash(text),
        updatedAt: now,
        blockHashes: {},
        proposals: [],
      };
      d.chatIds = Array.from(new Set([...d.chatIds, input.chatId]));
      binding.lastWrittenRevision = textHash(text);
      this.saveBinding(binding);
      if (
        existing &&
        existing.mode === "app" &&
        existing.revision !== textHash(text)
      ) {
        binding.conflict = {
          localText: text,
          remoteRevision: existing.revision,
        };
        this.saveBinding(binding);
        d.error =
          "The selected file differs from the synced version. Review which version to use.";
      }
      this.save(d);
      return this.view(d);
    });
  }
  async read(
    id: string,
    chatId?: string,
  ): Promise<{ document: DocumentView; text: string }> {
    return this.lock(id, async () => {
      const d = await this.refresh(this.record(id));
      if (chatId && !d.chatIds.includes(chatId))
        throw new Error("This document is not linked to the current session.");
      return { document: this.view(d), text: d.text };
    });
  }
  async setLogging(id: string, logging: boolean) {
    return this.lock(id, async () => {
      const d = this.record(id);
      d.logging = logging;
      if (!logging) {
        const e = path.join(this.local(), d.id + "-error.json");
        if (fs.existsSync(e)) fs.unlinkSync(e);
      }
      this.save(d);
      return this.view(d);
    });
  }
  async unlink(id: string, chatId: string) {
    return this.lock(id, async () => {
      const d = this.record(id);
      d.chatIds = d.chatIds.filter((c) => c !== chatId);
      this.save(d);
      return this.view(d);
    });
  }
  async propose(
    id: string,
    chatId: string,
    baseRevision: string,
    before: string,
    after: string,
    reason: string,
  ) {
    return this.lock(id, async () => {
      let d = await this.refresh(this.record(id));
      if (d.error) throw new Error(d.error);
      if (!d.chatIds.includes(chatId))
        throw new Error("Link the document to this session first.");
      if (d.revision !== baseRevision)
        throw new Error(
          "The document changed. Read its current revision before proposing an edit.",
        );
      if (before.includes("<!--lh:") || after.includes("<!--lh:"))
        throw new Error(
          "Edit the note prose while preserving its learning block markers.",
        );
      replaceExact(d.text, before, after);
      if (before.length + after.length > 1024 * 1024)
        throw new Error("Propose an edit of up to 1 MB.");
      if (!after)
        throw new Error(
          "Include nearby unchanged text in the replacement so a deletion can be safely undone.",
        );
      const proposal: DocumentProposal = {
        id: "edit_" + crypto.randomUUID().replaceAll("-", ""),
        documentId: id,
        chatId,
        baseRevision,
        before,
        after,
        reason: reason.slice(0, 2000),
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      d.proposals.push(proposal);
      this.save(d);
      return proposal;
    });
  }
  async review(
    id: string,
    proposalId: string,
    action: "apply" | "reject" | "undo",
  ) {
    return this.lock(id, async () => {
      const d = await this.refresh(this.record(id)),
        p = d.proposals.find((p) => p.id === proposalId);
      if (!p) throw new Error("Edit proposal not found");
      if (action === "reject") {
        if (p.status !== "pending")
          throw new Error("This proposal is already settled.");
        p.status = "rejected";
        this.save(d);
        return this.view(d);
      }
      if (d.error) throw new Error(d.error);
      const undo = action === "undo";
      if (undo ? p.status !== "applied" : p.status !== "pending")
        throw new Error("This edit is already settled.");
      if (d.revision !== (undo ? p.appliedRevision : p.baseRevision))
        throw new Error(
          "The note changed since this edit. Read it and create a new focused proposal.",
        );
      const b = this.binding(id);
      if (!b)
        throw new Error(
          "Relink this document on this device before applying edits.",
        );
      const text = replaceExact(
        d.text,
        undo ? p.after : p.before,
        undo ? p.before : p.after,
      );
      const next: DocumentRecord = {
        ...structuredClone(d),
        text,
        revision: textHash(text),
        updatedAt: new Date().toISOString(),
      };
      const edit = next.proposals.find((e) => e.id === p.id)!;
      edit.status = undo ? "undone" : "applied";
      edit.appliedRevision = next.revision;
      this.freezeChangedBlocks(d, next);
      await this.commitText(d, next, b, d.revision);
      return this.view(next);
    });
  }
  async resolveFile(id: string, choice: "local" | "synced") {
    return this.lock(id, async () => {
      const d = this.record(id),
        b = this.binding(id);
      if (!b) throw new Error("Relink the document first.");
      const local = await this.nativeRead(b);
      this.backup(id, local);
      this.backup(id, d.text);
      const next = {
        ...structuredClone(d),
        text: choice === "local" ? local : d.text,
        revision: choice === "local" ? textHash(local) : d.revision,
        updatedAt: new Date().toISOString(),
      };
      delete next.error;
      if (choice === "local") {
        this.freezeChangedBlocks(d, next);
        this.finishIntent(next, b);
      } else await this.commitText(d, next, b, textHash(local));
      return this.view(next);
    });
  }
  async logSession(chatId: string) {
    const record = this.options.readChat(chatId);
    if (!record) return;
    for (const item of this.records())
      if (item.logging && item.chatIds.includes(chatId))
        await this.lock(item.id, async () => {
          const d = await this.refresh(this.record(item.id)),
            b = this.binding(d.id);
          if (!b || !b.writable || d.error) return;
          let next = d.text;
          const eol = next.includes("\r\n") ? "\r\n" : "\n",
            hashes = { ...d.blockHashes };
          try {
            for (const block of liveDocumentBlocks(record)) {
              const token = Buffer.from(chatId + ":" + block.id).toString(
                "base64url",
              );
              if (d.frozenBlocks?.includes(token)) continue;
              const start = `<!--lh:block:${token}-->`,
                end = `<!--/lh:block:${token}-->`;
              const markdown = block.markdown.replace(/\r?\n/g, eol),
                body = start + eol + markdown + eol + end;
              const index = next.indexOf(start);
              if (index >= 0) {
                const endAt = next.indexOf(end, index + start.length);
                if (endAt < 0)
                  throw new Error(
                    "A learning block boundary was edited. Restore its markers or unlink live logging.",
                  );
                const old = next.slice(index, endAt + end.length);
                if (old === body) {
                  hashes[token] = textHash(body);
                  continue;
                }
                if (!hashes[token] || textHash(old) !== hashes[token])
                  throw new Error(
                    "A learning block was edited outside LearnHarness. Your edits are preserved; pause logging or resolve the note.",
                  );
                next =
                  next.slice(0, index) + body + next.slice(endAt + end.length);
              } else next += (next.length ? eol + eol : "") + body + eol;
              hashes[token] = textHash(body);
            }
            if (next !== d.text) {
              const updated = {
                ...structuredClone(d),
                text: next,
                revision: textHash(next),
                blockHashes: hashes,
                updatedAt: new Date().toISOString(),
              };
              // Our own logging may append while an edit awaits review. Carry
              // its revision only when the exact scoped passage is unchanged;
              // external/manual changes never take this path.
              for (const p of updated.proposals) {
                const undo = p.status === "applied";
                if (
                  (p.status === "pending" && p.baseRevision === d.revision) ||
                  (undo && p.appliedRevision === d.revision)
                ) {
                  try {
                    replaceExact(
                      next,
                      undo ? p.after : p.before,
                      undo ? p.before : p.after,
                    );
                    if (undo) p.appliedRevision = updated.revision;
                    else p.baseRevision = updated.revision;
                  } catch {
                    /* A changed or ambiguous passage still needs a fresh proposal. */
                  }
                }
              }
              delete updated.error;
              await this.commitText(d, updated, b, d.revision);
            }
          } catch (e) {
            d.error =
              e instanceof Error
                ? e.message
                : "The learning note could not be updated.";
            atomicWrite(
              path.join(this.local(), d.id + "-error.json"),
              JSON.stringify({ message: d.error }),
            );
          }
        });
  }
}
