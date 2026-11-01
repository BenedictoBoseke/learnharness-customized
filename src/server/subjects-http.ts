import { trusted, body } from "./library-http.ts";
import { libraryServices } from "./library-services.ts";
import { chatStore } from "../store/chats.ts";
const json = (v: unknown, status = 200) =>
  Response.json(v, { status, headers: { "cache-control": "no-store" } });
export async function subjectsResponse(request: Request) {
  if (!trusted(request))
    return json({ error: "Open subjects inside LearnHarness." }, 403);
  try {
    const s = libraryServices(),
      w = s.subjects,
      u = new URL(request.url);
    if (request.method === "GET") {
      const id = u.searchParams.get("id");
      if (!id) return json({ subjects: w.list() });
      const noteId = u.searchParams.get("noteId");
      return json(
        noteId
          ? await w.read(
              id,
              noteId,
              u.searchParams.get("chatId") || undefined,
              Number(u.searchParams.get("offset") || 0),
            )
          : {
              subject: w.view(id),
              notes: w.noteList(
                id,
                u.searchParams.get("query") || "",
                Number(u.searchParams.get("offset") || 0),
              ),
              groups: w.groups(id),
              lessons: w.lessons(id),
            },
      );
    }
    const b = await body(request);
    if (s.engine.syncing)
      throw Error("Wait for the active sync before changing subjects.");
    switch (b.op) {
      case "preview":
        return json(await w.preview(b.folder, request.signal));
      case "link":
        return json(await w.link(b as any));
      case "refresh":
        return json(w.refresh(String(b.workspaceId)));
      case "cancel":
        w.cancel(String(b.workspaceId));
        return json({ ok: true });
      case "update":
        return json(w.update(String(b.workspaceId), b.patch));
      case "associate":
        return json(w.associate(String(b.workspaceId), String(b.chatId)));
      case "new-session": {
        if (w.view(String(b.workspaceId)).scan.phase === "scanning")
          throw Error("Wait for the folder scan before starting a session.");
        const chat = chatStore.createChat(w.record(String(b.workspaceId)).name);
        w.associate(String(b.workspaceId), chat.id);
        return json({ chatId: chat.id });
      }
      case "apply-lesson-log":
        return json(
          await w.applyLessonLog(String(b.workspaceId), String(b.lessonId)),
        );
      case "materialization-preview":
        return json(
          await w.materializationPreview(
            String(b.workspaceId),
            String(b.previewId),
          ),
        );
      case "materialize":
        return json(
          await w.materialize(
            String(b.workspaceId),
            String(b.previewId),
            b.decisions,
          ),
        );
      case "transition":
        return json(await w.transition(String(b.workspaceId), b.mode));
      case "search":
        return json(w.search(String(b.workspaceId), String(b.query)));
      case "create-note":
        return json(
          await w.createNote(
            String(b.workspaceId),
            String(b.path),
            String(b.text || ""),
          ),
        );
      case "finish":
        if (s.busy())
          throw Error("Wait for active learning or indexing to finish.");
        return json(
          await w.finish(
            String(b.workspaceId),
            String(b.chatId),
            String(b.operationId),
          ),
        );
      case "review-group":
        return json(
          await w.reviewGroup(
            String(b.workspaceId),
            String(b.groupId),
            b.action,
            b.selected,
          ),
        );
      default:
        throw Error("Unknown subject action");
    }
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Subjects unavailable." },
      400,
    );
  }
}
