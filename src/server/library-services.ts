import fs from "node:fs";
import path from "node:path";
import { AUTH_FILE, PATHS, LOCAL_STATE_DIR } from "../../config.ts";
import { deviceIdentity, SYNC_LOCAL_DIR } from "../store/sync-state.ts";
import { DocumentService } from "../store/documents.ts";
import { LibraryReplica } from "../store/library-replica.ts";
import { chatStore } from "../store/chats.ts";
import { jobStore } from "../store/jobs.ts";
import { emit, subscribe } from "../core/events.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { compactionInFlight } from "./compaction.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { SyncEngine } from "./sync/engine.ts";
import { SupabaseConnection } from "./sync/supabase.ts";
import { linkedDocumentTools } from "../agent/tools/linked-document.ts";
import { SubjectService } from "../store/subjects.ts";
import { createFolderPort } from "../store/folder-access.ts";
import { resolveSourcePath } from "../agent/tools/fs-shared.ts";
import { subjectTurn } from "../agent/tools/subject.ts";
function build() {
  const identity = deviceIdentity();
  let timer: ReturnType<typeof setTimeout> | undefined,
    ticking = false;
  let lastSync = 0;
  let documentNotice: ReturnType<typeof setTimeout> | undefined;
  let subjectNotice: ReturnType<typeof setTimeout> | undefined;
  const changed = (documentId?: string) => {
    if (documentId) subjects.noteChanged(documentId);
    if (!documentNotice) {
      documentNotice = setTimeout(() => {
        documentNotice = undefined;
        emit("documents-changed", {});
      }, 80);
      documentNotice.unref?.();
    }
    schedule();
  };
  const rendererUrl = process.env.LH_ANDROID_RENDER_URL;
  const documents = new DocumentService({
    dataDir: PATHS.data,
    localDir: path.join(LOCAL_STATE_DIR, "documents"),
    grantsFile: path.join(path.dirname(AUTH_FILE), "document-grants.json"),
    androidUrl: rendererUrl
      ? new URL("/document", rendererUrl).href
      : undefined,
    androidToken: process.env.LH_ANDROID_RENDER_TOKEN,
    readChat: (id) => chatStore.getChat(id),
    changed,
  });
  const replica = new LibraryReplica({
    dataDir: PATHS.data,
    localDir: SYNC_LOCAL_DIR,
    attachmentsDir: process.env.LH_ANDROID_PRIVATE_ROOT
      ? path.join(
          process.env.LH_ANDROID_PRIVATE_ROOT,
          "original",
          "attachments",
        )
      : path.join(PATHS.data, "attachments"),
    deviceId: identity.id,
  });
  const subjects = new SubjectService({
    watch: true,
    dataDir: PATHS.data,
    localDir: path.join(LOCAL_STATE_DIR, "subjects"),
    documents,
    folders: createFolderPort({
      grantsFile: path.join(path.dirname(AUTH_FILE), "document-grants.json"),
      androidUrl: rendererUrl,
      androidToken: process.env.LH_ANDROID_RENDER_TOKEN,
    }),
    readChat: (id) => chatStore.getChat(id),
    changed: () => {
      if (!subjectNotice) {
        subjectNotice = setTimeout(() => {
          subjectNotice = undefined;
          emit("subjects-changed", {});
        }, 100);
        subjectNotice.unref?.();
      }
      schedule();
    },
  });
  const attachmentRoot = replica.options.attachmentsDir;
  if (fs.existsSync(attachmentRoot)) {
    const visit = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink() || e.name === "synced") continue;
        const file = path.join(dir, e.name);
        if (e.isDirectory()) visit(file);
        else if (e.isFile() && fs.statSync(file).size <= 64 * 1024 * 1024)
          replica.register(file);
      }
    };
    visit(attachmentRoot);
  }
  const auth = new SupabaseConnection(
    path.join(path.dirname(AUTH_FILE), "learnharness-sync-auth.json"),
  );
  const busy = () =>
    subjects.busy ||
    documents.busy ||
    replica.busy ||
    extractionStatuses().length > 0 ||
    chatStore
      .listChats()
      .some(
        (c) =>
          isTurnRunning(c.id) ||
          compactionInFlight(c.id) ||
          jobStore
            .listJobs(c.id)
            .some(
              (j) =>
                j.status === "running" &&
                (!j.ownerDeviceId || j.ownerDeviceId === identity.id),
            ),
      );
  const engine = new SyncEngine({
    replica,
    deviceId: identity.id,
    deviceName: identity.name,
    isBusy: busy,
    applied: () => {
      emit("subjects-changed", {});
      emit("chats-changed", {});
      emit("sources-changed", {});
      emit("documents-changed", {});
      for (const c of chatStore.listChats())
        emit("record-changed", { chatId: c.id });
    },
  });
  async function sync(options: Parameters<SyncEngine["sync"]>[1] = {}) {
    if (!auth.status().signedIn) throw new Error("Sign into sync first.");
    try {
      return await engine.sync(await auth.transport(), options);
    } catch (e) {
      engine.connectionFailed(
        e instanceof Error ? e.message : "Sync connection unavailable",
      );
      throw e;
    } finally {
      emit("sync-changed", {});
    }
  }
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      if (!busy()) {
        for (const chatId of new Set(
          documents
            .records()
            .filter((d) => d.logging)
            .flatMap((d) => d.chatIds),
        ))
          await documents.logSession(chatId);
        if (
          auth.status().signedIn &&
          engine.state().libraryId &&
          Date.now() - lastSync > 25000
        ) {
          lastSync = Date.now();
          await sync();
        }
      }
    } catch {
      emit("sync-changed", {});
    } finally {
      ticking = false;
    }
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), 600);
    timer.unref?.();
  }
  const loop = setInterval(() => void tick(), 30000);
  loop.unref?.();
  (
    globalThis as typeof globalThis & { __lhLibraryChanged?: () => void }
  ).__lhLibraryChanged = schedule;
  subscribe((event) => {
    if (
      [
        "turn-settled",
        "record-changed",
        "chats-changed",
        "sources-changed",
        "jobs-changed",
        "activity-changed",
      ].includes(event.type)
    )
      schedule();
  });
  schedule();
  return {
    identity,
    documents,
    subjects,
    replica,
    auth,
    engine,
    sync,
    busy,
    status: () => ({
      ...engine.status(),
      ...auth.status(),
      fileReferences: replica.references(),
      ...(!auth.status().configured
        ? { phase: "disabled" as const }
        : !auth.status().signedIn
          ? { phase: "signed-out" as const }
          : {}),
    }),
  };
}
interface Globals {
  __lhLibraryServices?: ReturnType<typeof build>;
}
export function libraryServices() {
  const g = globalThis as typeof globalThis & Globals;
  return (g.__lhLibraryServices ??= build());
}
/** Original unlinked sessions do not acquire document capabilities or new state. */
export function documentToolsForSession(chatId: string) {
  if (!fs.existsSync(path.join(PATHS.data, "documents"))) return undefined;
  const s = libraryServices();
  if (s.subjects.forChat(chatId)) return undefined;
  const linked = s.documents
    .records()
    .filter((d) => d.chatIds.includes(chatId));
  if (!linked.length) return undefined;
  return linkedDocumentTools({
    read: async (id, offset = 0) => {
      if (!id && linked.length !== 1)
        return { documents: linked.map((d) => ({ id: d.id, name: d.name })) };
      const r = await s.documents.read(id || linked[0]!.id, chatId);
      if (r.document.error) throw new Error(r.document.error);
      const text = r.text.slice(offset, offset + 48000);
      return {
        documentId: r.document.id,
        name: r.document.name,
        revision: r.document.revision,
        text,
        offset,
        ...(offset + text.length < r.text.length
          ? { nextOffset: offset + text.length }
          : {}),
      };
    },
    propose: (id, revision, before, after, reason) =>
      s.documents.propose(id, chatId, revision, before, after, reason),
  });
}
export function subjectSourceGuard(chatId: string) {
  if (!fs.existsSync(path.join(PATHS.data, "workspaces"))) return undefined;
  const s = libraryServices(),
    w = s.subjects.forChat(chatId);
  if (!w) return undefined;
  return (raw: string) => {
    const file = resolveSourcePath(raw);
    return (
      s.replica.permitsSourceRead(file) ||
      s.documents.permitsSourceRead(
        file,
        chatId,
        new Set(w.notes.map((n) => n.id)),
      )
    );
  };
}
export async function subjectContextForSession(
  chatId: string,
  query: string,
  budget: number,
) {
  if (!fs.existsSync(path.join(PATHS.data, "workspaces")))
    return { tools: [], context: "" };
  return subjectTurn(libraryServices().subjects, chatId, query, budget);
}
export function sessionResumeRequired(chatId: string) {
  if (!fs.existsSync(path.join(SYNC_LOCAL_DIR, "state.json"))) return false;
  return libraryServices().engine.requiresResume(chatId);
}
