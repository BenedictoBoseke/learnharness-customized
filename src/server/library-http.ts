import { desktopAPIAuthorized } from "./desktop-access.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";
import { libraryServices } from "./library-services.ts";
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
export function trusted(r: Request) {
  return (
    r.headers.get("sec-fetch-site") !== "cross-site" &&
    desktopAPIAuthorized(r.headers) &&
    (r.method === "GET" ||
      (r.headers.get("origin") === subscriptionRequestOrigin(r) &&
        r.headers.get("sec-fetch-site") !== "cross-site"))
  );
}
export async function body(r: Request) {
  if (r.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw new Error("Expected a JSON request");
  const reader = r.body?.getReader();
  if (!reader) throw new Error("Expected request content");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const n = await reader.read();
    if (n.done) break;
    size += n.value.length;
    if (size > 2 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("Request exceeds 2 MB");
    }
    chunks.push(n.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    any
  >;
}
export async function syncResponse(r: Request): Promise<Response> {
  if (!trusted(r)) return json({ error: "Use Sync inside LearnHarness." }, 403);
  try {
    const s = libraryServices();
    if (r.method === "GET") {
      const chatId = new URL(r.url).searchParams.get("chatId");
      return json({
        ...s.status(),
        ...(chatId ? { resumeRequired: s.engine.requiresResume(chatId) } : {}),
        recoveries: s.engine.recoveries(),
      });
    }
    const b = await body(r);
    if (
      s.engine.syncing &&
      [
        "configure",
        "request-code",
        "verify-code",
        "sign-out",
        "create-library",
        "join-library",
        "leave-library",
      ].includes(b.op)
    )
      throw new Error(
        "Wait for the current sync to finish before changing its connection.",
      );
    switch (b.op) {
      case "configure": {
        const old = s.auth.config()?.projectUrl;
        s.auth.configure(String(b.projectUrl), String(b.publishableKey));
        if (old && old !== s.auth.config()?.projectUrl) s.engine.detach();
        break;
      }
      case "request-code":
        await s.auth.requestCode(String(b.email));
        break;
      case "verify-code": {
        const old = s.auth.config()?.boundUserId;
        const signed = await s.auth.verifyCode(String(b.email), String(b.code));
        if (old && old !== signed.userId) s.engine.detach();
        break;
      }
      case "sign-out":
        s.auth.signOut();
        break;
      case "leave-library":
        s.engine.detach();
        break;
      case "libraries":
        return json({
          libraries: await (await s.auth.transport()).listLibraries(),
        });
      case "create-library": {
        const id = await (
          await s.auth.transport()
        ).createLibrary(String(b.name || "My learning library"));
        s.engine.join(id);
        break;
      }
      case "join-library":
        s.engine.join(String(b.libraryId));
        break;
      case "sync":
        await s.sync({
          initialChoice: b.initialChoice,
          resolution: b.resolution,
        });
        break;
      case "resume-session":
        if (typeof b.chatId !== "string")
          throw new Error("Session identity required");
        s.engine.resume(b.chatId);
        break;
      case "restore-recovery":
        await s.engine.restoreRecovery(String(b.id));
        break;
      case "relink-file": {
        if (s.busy())
          throw new Error(
            "Wait for active learning work to finish before relinking a file.",
          );
        const file = await s.documents.selectedAttachment(
          String(b.handle),
          b.kind,
        );
        s.replica.bind(String(b.fileId), file);
        break;
      }
      case "register-files":
        if (
          !Array.isArray(b.paths) ||
          b.paths.length > 16 ||
          !b.paths.every((p) => typeof p === "string")
        )
          throw new Error("Select up to 16 files");
        for (const p of b.paths) s.replica.register(p);
        break;
      default:
        throw new Error("Unknown sync action");
    }
    return json(s.status());
  } catch (e) {
    return json(
      {
        error:
          e instanceof Error
            ? e.message
            : "Sync is unavailable; local learning is preserved.",
      },
      400,
    );
  }
}
export async function documentsResponse(r: Request): Promise<Response> {
  if (!trusted(r))
    return json({ error: "Open linked documents inside LearnHarness." }, 403);
  try {
    const s = libraryServices();
    if (r.method === "GET") {
      const u = new URL(r.url),
        id = u.searchParams.get("id");
      return json(
        id
          ? await s.documents.read(
              id,
              u.searchParams.get("chatId") || undefined,
            )
          : {
              documents: await s.documents.list(
                u.searchParams.get("chatId") || undefined,
              ),
            },
      );
    }
    const b = await body(r);
    switch (b.op) {
      case "link":
        return json(await s.documents.link(b as any));
      case "logging":
        return json(
          await s.documents.setLogging(
            String(b.documentId),
            Boolean(b.logging),
          ),
        );
      case "unlink":
        return json(
          await s.documents.unlink(String(b.documentId), String(b.chatId)),
        );
      case "backfill":
        await s.documents.logSession(String(b.chatId));
        return json({ ok: true });
      case "propose":
        return json(
          await s.documents.propose(
            String(b.documentId),
            String(b.chatId),
            String(b.baseRevision),
            String(b.before),
            String(b.after),
            String(b.reason || "Manual note edit"),
          ),
        );
      case "review":
        if (!["apply", "reject", "undo"].includes(b.action))
          throw new Error("Choose Apply, Reject or Undo");
        return json(
          await s.documents.review(
            String(b.documentId),
            String(b.proposalId),
            b.action,
          ),
        );
      case "resolve-file":
        if (!["local", "synced"].includes(b.choice))
          throw new Error("Choose the file or synced version");
        return json(
          await s.documents.resolveFile(String(b.documentId), b.choice),
        );
      default:
        throw new Error("Unknown document action");
    }
  } catch (e) {
    return json(
      {
        error:
          e instanceof Error
            ? e.message
            : "The learning note could not be accessed.",
      },
      400,
    );
  }
}
