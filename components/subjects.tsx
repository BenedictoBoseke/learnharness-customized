"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  SubjectView,
  SubjectNote,
  DocumentView,
  FolderSelection,
} from "@/src/core";
import { useServerEvent, useServerResync } from "./server-events";
import { useDismissLayer } from "./dismiss-layer";
const btn =
  "lh-subject-button rounded border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-40";
const field =
  "w-full min-w-0 rounded border border-border bg-background px-3 py-2 text-base";
export function SubjectsButton({ chatId }: { chatId?: string }) {
  return (
    <button
      type="button"
      className={"lh-no-drag shrink-0 " + btn}
      data-testid="subjects-open"
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent("lh:open-subjects", { detail: { chatId } }),
        )
      }
    >
      {chatId ? "Subject" : "Subjects"}
    </button>
  );
}
interface Preview {
  previewId: string;
  name: string;
  writable: boolean;
  paths: string[];
  issues: Array<{ path: string; reason: string }>;
}
export function SubjectManager() {
  const [groupSelection, setGroupSelection] = useState<Record<string, boolean>>(
    {},
  );
  const router = useRouter(),
    [open, setOpen] = useState(false),
    [chatId, setChatId] = useState<string>(),
    [subjects, setSubjects] = useState<SubjectView[]>([]),
    [selected, setSelected] = useState(""),
    [subject, setSubject] = useState<SubjectView>(),
    [notes, setNotes] = useState<SubjectNote[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [groups, setGroups] = useState<any[]>([]),
    [lessons, setLessons] = useState<any[]>([]),
    [preview, setPreview] = useState<Preview>(),
    [included, setIncluded] = useState<string[]>([]),
    [name, setName] = useState(""),
    [mode, setMode] = useState<"external" | "app">("external"),
    [modeChosen, setModeChosen] = useState(false),
    [query, setQuery] = useState(""),
    [exclusions, setExclusions] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [note, setNote] = useState<any>(),
    [doc, setDoc] = useState<DocumentView>(),
    [finish, setFinish] = useState<any>(),
    [materialization, setMaterialization] = useState<any>(),
    [decisions, setDecisions] = useState<Record<string, string>>({}),
    [newPath, setNewPath] = useState(""),
    [newText, setNewText] = useState(""),
    [transition, setTransition] = useState<"app" | "external">();
  const [relinkTarget, setRelinkTarget] = useState(""),
    [discovering, setDiscovering] = useState(false);
  const discoveryAbort = useRef<AbortController | null>(null);
  const guard = useRef(false),
    completion = useRef<string>("");
  const load = useCallback(async () => {
    if (!open) return;
    try {
      const r = await fetch("/api/subjects", {
          cache: "no-store",
        }),
        b = await r.json();
      if (!r.ok) throw Error(b.error);
      setSubjects(b.subjects);
      if (selected) {
        const r2 = await fetch(
            "/api/subjects?id=" +
              encodeURIComponent(selected) +
              "&query=" +
              encodeURIComponent(query) +
              "&offset=" +
              offset,
            { cache: "no-store" },
          ),
          b2 = await r2.json();
        if (!r2.ok) throw Error(b2.error);
        setSubject(b2.subject);
        setNotes(b2.notes.notes);
        setTotal(b2.notes.total);
        setGroups(b2.groups);
        setLessons(b2.lessons || []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Subjects unavailable.");
    }
  }, [open, selected, query, offset]);
  useEffect(() => {
    const show = (e: Event) => {
      const current = (e as CustomEvent).detail?.chatId;
      setChatId(current);
      setOpen(true);
      setError("");
      setPreview(undefined);
      setMaterialization(undefined);
      setFinish(undefined);
      completion.current = "";
      try {
        setSelected(localStorage.getItem("lh:last-subject") || "");
        setQuery(localStorage.getItem("lh:subject-filter") || "");
      } catch {}
    };
    window.addEventListener("lh:open-subjects", show);
    return () => window.removeEventListener("lh:open-subjects", show);
  }, []);
  useEffect(() => {
    if (open) try {localStorage.setItem("lh:subject-filter",query);} catch {}
  }, [open,query]);
  useEffect(() => {
    void load();
  }, [load]);
  useServerEvent("subjects-changed", () => void load());
  useServerResync(() => void load());
  useDismissLayer(open, () => setOpen(false), '[data-testid="subjects-dialog"]');
  useEffect(() => {
    if (subject) setExclusions(subject.exclusions.join("\n"));
  }, [subject?.id, subject?.exclusions.join("\n")]);
  async function act(op: string, extra: Record<string, unknown> = {}) {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError("");
    try {
      if (op === "preview") {
        discoveryAbort.current = new AbortController();
        setDiscovering(true);
      }
      const r = await fetch("/api/subjects", {
          ...(op === "preview"
            ? { signal: discoveryAbort.current!.signal }
            : {}),
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op, workspaceId: selected, ...extra }),
        }),
        b = await r.json();
      if (!r.ok) throw Error(b.error);
      await load();
      return b;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
      return null;
    } finally {
      if (op === "preview") {
        setDiscovering(false);
        discoveryAbort.current = null;
      }
      guard.current = false;
      setBusy(false);
    }
  }
  function choose(key: string) {
    setSelected(key);
    setOffset(0);
    setQuery("");
    setNote(undefined);
    setDoc(undefined);
    setFinish(undefined);
    try {
      localStorage.setItem("lh:last-subject", key);
    } catch {}
  }
  async function pick(relink = false) {
    setRelinkTarget(relink ? selected : "");
    setError("");
    try {
      const bridge = window.lh as typeof window.lh & {
        documents?: { pick: (kind: string) => Promise<FolderSelection | null> };
      };
      if (!bridge?.documents)
        throw Error("Open the Windows or Android app to link a native folder.");
      const root = await bridge.documents.pick("folder");
      if (!root) return;
      const p = await act("preview", { folder: root });
      if (p) {
        setPreview(p);
        setIncluded(p.paths);
        setName(p.name);
        setModeChosen(false);
        setMaterialization(undefined);
        if (relink && subject?.mode === "app" && selected) {
          const m = await act("materialization-preview", {
            previewId: p.previewId,
          });
          if (m) {
            setMaterialization(m);
            setMode("app");
            setModeChosen(true);
            setDecisions(
              Object.fromEntries(
                m.rows.map((n: any) => [
                  n.id,
                  n.status === "same" ? "synced" : "skip",
                ]),
              ),
            );
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Folder selection failed.");
    }
  }
  async function readNote(id: string) {
    setError("");
    try {
      const r = await fetch(
          "/api/subjects?id=" +
            encodeURIComponent(selected) +
            "&noteId=" +
            encodeURIComponent(id),
        ),
        b = await r.json();
      if (!r.ok) throw Error(b.error);
      setNote(b);
      const d = await fetch("/api/documents?id=" + encodeURIComponent(id));
      if (d.ok) setDoc((await d.json()).document);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Note unavailable.");
    }
  }
  async function review(proposalId: string, action: string) {
    if (!doc || guard.current) return;
    guard.current = true;
    setBusy(true);
    try {
      const r = await fetch("/api/documents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            op: "review",
            documentId: doc.id,
            proposalId,
            action,
          }),
        }),
        b = await r.json();
      if (!r.ok) throw Error(b.error);
      await readNote(doc.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Review failed.");
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  if (!open) return null;
  return (
    <div
      className="lh-no-drag fixed inset-0 z-[90] flex items-center justify-center bg-background/90 p-2"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Learning subjects"
        data-testid="subjects-dialog"
        className="lh-subject-dialog flex h-[min(94dvh,960px)] w-[min(100%,1000px)] min-w-0 flex-col overflow-hidden rounded border border-border bg-card"
      >
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border p-3">
          <h2 className="font-title text-2xl">Subjects</h2>
          <button
            className={btn}
            onClick={() => setOpen(false)}
            aria-label="Close subjects"
          >
            Close
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {discovering && (
            <p role="status">
              Discovering Markdown notes…{" "}
              <button
                className={btn}
                onClick={() => discoveryAbort.current?.abort()}
              >
                Cancel folder discovery
              </button>
            </p>
          )}
          {error && (
            <p role="alert" className="break-words text-sm text-red-400">
              {error}
            </p>
          )}
          {status && (
            <p role="status" className="text-sm">
              {status}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              className={btn}
              disabled={busy}
              onClick={() => void pick(false)}
            >
              Link subject folder
            </button>
            <select
              className={field + " max-w-lg"}
              aria-label="Selected subject"
              value={selected}
              onChange={(e) => choose(e.target.value)}
            >
              <option value="">Choose a subject</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.notes.length} notes
                </option>
              ))}
            </select>
          </div>
          {materialization && preview && (
            <div className="space-y-3 rounded border border-border p-3">
              <h3>Review destination files</h3>
              <p>
                Only explicitly chosen files are written. Different local files
                require a choice. Missing files are created only when you choose
                Use synced. Skipped files remain unbound.
              </p>
              {materialization.rows.map((n: any) => (
                <label key={n.id} className="block break-all">
                  {n.path} · {n.status}
                  <select
                    className={field}
                    value={decisions[n.id] || "skip"}
                    onChange={(e) =>
                      setDecisions({ ...decisions, [n.id]: e.target.value })
                    }
                  >
                    <option value="skip">Skip</option>
                    {n.status !== "unavailable" && (
                      <option value="synced">
                        Use synced / create if missing
                      </option>
                    )}
                    {n.status === "different" && (
                      <option value="local">
                        Keep local and synchronize that version
                      </option>
                    )}
                  </select>
                </label>
              ))}
              <button
                className={btn}
                disabled={busy}
                onClick={async () => {
                  const r = await act("materialize", {
                    previewId: preview.previewId,
                    decisions: materialization.rows.map((n: any) => ({
                      id: n.id,
                      choice: decisions[n.id] || "skip",
                      localRevision: n.localRevision,
                    })),
                  });
                  if (r) {
                    setStatus(
                      Object.entries(r.results)
                        .map(
                          ([id, result]) =>
                            `${subject?.notes.find((n) => n.id === id)?.path}: ${result}`,
                        )
                        .join("; "),
                    );
                    setPreview(undefined);
                    setMaterialization(undefined);
                  }
                }}
              >
                Confirm destination actions
              </button>
              <button
                className={btn}
                onClick={() => {
                  setPreview(undefined);
                  setMaterialization(undefined);
                }}
              >
                Cancel
              </button>
            </div>
          )}
          {preview && !materialization && (
            <div className="space-y-3 rounded border border-border p-3">
              <h3>Review folder inclusion</h3>
              <p className="text-sm text-muted-foreground">
                Subject sync upgrades the library format. Install the subject
                sync SQL migration and update both devices before syncing a
                subject. Earlier apps will refuse that library format; local
                learning remains available.
              </p>
              <label className="block">
                Subject name
                <input
                  className={field}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="block">
                Original note synchronization
                <select
                  className={field}
                  value={modeChosen ? mode : ""}
                  onChange={(e) => {
                    setMode(e.target.value as "external" | "app");
                    setModeChosen(true);
                  }}
                >
                  <option value="" disabled>
                    Choose who carries the original files
                  </option>
                  <option value="external">
                    My folder/provider already synchronizes these notes
                  </option>
                  <option value="app">
                    LearnHarness carries selected note content
                  </option>
                </select>
              </label>
              <p className="text-sm text-muted-foreground">
                External mode keeps source files, indexes and raw note-tool
                payloads off Supabase. Ordinary lesson conversations, including
                quoted note text, still sync. Each device must bind its own
                folder. Choose app-managed mode only when another service is not
                already carrying these files.
              </p>
              <p>
                {included.length} of {preview.paths.length} Markdown notes
                selected ·{" "}
                {preview.writable
                  ? "folder supports creation"
                  : "read-only folder or provider"}
              </p>
              <div className="max-h-64 overflow-auto">
                {preview.paths.slice(offset, offset + 100).map((p) => (
                  <label
                    key={p}
                    className="flex min-h-12 items-center gap-3 break-all py-2"
                  >
                    <input
                      type="checkbox"
                      checked={included.includes(p)}
                      onChange={(e) =>
                        setIncluded(
                          e.target.checked
                            ? [...included, p]
                            : included.filter((i) => i !== p),
                        )
                      }
                    />
                    {p}
                  </label>
                ))}
              </div>
              {preview.paths.length > 100 && (
                <div className="flex gap-2">
                  <button
                    className={btn}
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - 100))}
                  >
                    Previous
                  </button>
                  <button
                    className={btn}
                    disabled={offset + 100 >= preview.paths.length}
                    onClick={() => setOffset(offset + 100)}
                  >
                    Next
                  </button>
                </div>
              )}
              <details>
                <summary>
                  Excluded or unavailable ({preview.issues.length})
                </summary>
                {preview.issues.slice(0, 100).map((i, n) => (
                  <p key={n} className="break-all text-sm">
                    {i.path}: {i.reason}
                  </p>
                ))}
              </details>
              <div className="flex flex-wrap gap-2">
                <button
                  className={btn}
                  disabled={busy || !modeChosen}
                  onClick={async () => {
                    const w = await act("link", {
                      previewId: preview.previewId,
                      name,
                      mode,
                      included,
                      ...(relinkTarget && subject
                        ? { workspaceId: relinkTarget }
                        : {}),
                    });
                    if (w) {
                      choose(w.id);
                      setPreview(undefined);
                    }
                  }}
                >
                  Link and index selected notes
                </button>
                <button className={btn} onClick={() => setPreview(undefined)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {subject && selected && !preview && (
            <>
              <div className="space-y-2 rounded border border-border p-3">
                <h3 className="break-words font-title text-xl">
                  {subject.name}
                </h3>
                <label className="block">
                  Subject name
                  <input
                    className={field}
                    defaultValue={subject.name}
                    key={subject.id}
                    onBlur={(e) => {
                      if (e.target.value !== subject.name)
                        void act("update", { patch: { name: e.target.value } });
                    }}
                  />
                </label>
                <p role="status">
                  {subject.bound
                    ? "Folder linked on this device"
                    : "Folder needs relinking"}{" "}
                  · {subject.scan.phase} · {subject.scan.indexed} notes indexed
                  · {subject.pending} pending edits
                </p>
                <p className="text-sm text-muted-foreground">
                  {subject.mode === "external"
                    ? "Original files use external folder sync; LearnHarness cannot confirm the external transfer."
                    : "Selected note content uses LearnHarness sync; destination writes require a local folder binding."}{" "}
                  Last indexed:{" "}
                  {subject.scan.lastScannedAt
                    ? new Date(subject.scan.lastScannedAt).toLocaleString()
                    : "not yet"}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    className={btn}
                    disabled={busy || !subject.bound}
                    onClick={() => void act("refresh")}
                  >
                    Refresh folder
                  </button>
                  {subject.scan.phase === "scanning" && (
                    <button className={btn} onClick={() => void act("cancel")}>
                      Cancel indexing
                    </button>
                  )}
                  <button
                    className={btn}
                    disabled={busy}
                    onClick={() => void pick(true)}
                  >
                    Relink folder
                  </button>
                  <button
                    className={btn}
                    disabled={busy}
                    onClick={async () => {
                      const r = await act("new-session");
                      if (r) {
                        setOpen(false);
                        router.push("/chat/" + r.chatId);
                      }
                    }}
                  >
                    New session
                  </button>
                  {chatId && (
                    <button
                      className={btn}
                      disabled={busy}
                      onClick={() => void act("associate", { chatId })}
                    >
                      Use for this session
                    </button>
                  )}
                  <button
                    className={btn}
                    disabled={busy}
                    onClick={async () => {
                      if (subject.roles.checkpoint)
                        await readNote(subject.roles.checkpoint);
                      setStatus(
                        "Review your checkpoint, then choose a related session or create one. Send your next question to resume learning.",
                      );
                    }}
                  >
                    Resume subject
                  </button>
                </div>
              </div>
              <details>
                <summary className="min-h-12 py-3">
                  Note roles and subject preferences
                </summary>
                <div className="space-y-3">
                  <div className="space-y-2">
                    <p className="text-sm">
                      Suggested checkpoint:{" "}
                      {subject.notes.find((n) => /checkpoint/i.test(n.path))
                        ?.path || "none"}
                      ; suggested log:{" "}
                      {subject.notes.find((n) =>
                        /lesson.*log|(^|\/)log\.md$/i.test(n.path),
                      )?.path || "none"}
                      . Other notes can be source material.
                    </p>
                    <button
                      className={btn}
                      disabled={busy}
                      onClick={() => {
                        const checkpoint = subject.notes.find((n) =>
                            /checkpoint/i.test(n.path),
                          ),
                          log = subject.notes.find((n) =>
                            /lesson.*log|(^|\/)log\.md$/i.test(n.path),
                          );
                        void act("update", {
                          patch: {
                            roles: {
                              checkpoint: checkpoint?.id,
                              log: log?.id,
                              sources: subject.notes
                                .filter(
                                  (n) =>
                                    n.id !== checkpoint?.id && n.id !== log?.id,
                                )
                                .map((n) => n.id),
                            },
                            logging: false,
                          },
                        });
                      }}
                    >
                      Use suggested roles with logging off
                    </button>
                  </div>
                  {(["checkpoint", "log"] as const).map((role) => (
                    <label key={role} className="block">
                      {role === "log"
                        ? "Lesson log (optional)"
                        : "Checkpoint (optional)"}
                      <select
                        className={field}
                        value={subject.roles[role] || ""}
                        disabled={busy}
                        onChange={(e) =>
                          void act("update", {
                            patch: {
                              roles: {
                                ...subject.roles,
                                [role]: e.target.value || undefined,
                              },
                            },
                          })
                        }
                      >
                        <option value="">Unset</option>
                        {subject.notes.map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.path}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <p className="text-sm">
                    Select source notes from the list below. Role suggestions:
                    filenames containing “checkpoint” or “lesson log”; confirm
                    them above.
                  </p>
                  <label className="flex min-h-12 items-center gap-3">
                    <input
                      type="checkbox"
                      checked={subject.logging}
                      disabled={busy || !subject.roles.log}
                      onChange={(e) =>
                        void act("update", {
                          patch: { logging: e.target.checked },
                        })
                      }
                    />
                    Automatically append completed lessons to the selected log
                  </label>
                  <p className="text-sm text-muted-foreground">
                    Logging starts only after you enable it and finish a lesson.
                    Checkpoint/source revisions always require review.
                  </p>
                  <label className="block">
                    Excluded relative paths (one per line)
                    <textarea
                      className={field}
                      value={exclusions}
                      onChange={(e) => setExclusions(e.target.value)}
                    />
                  </label>
                  <button
                    className={btn}
                    disabled={busy}
                    onClick={() =>
                      void act("update", {
                        patch: {
                          exclusions: exclusions
                            .split("\n")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        },
                      })
                    }
                  >
                    Save exclusions
                  </button>
                </div>
              </details>
              <details>
                <summary className="min-h-12 py-3">
                  Create a missing note
                </summary>
                <label className="block">
                  Relative Markdown path
                  <input
                    className={field}
                    value={newPath}
                    onChange={(e) => setNewPath(e.target.value)}
                    placeholder="HSK 1 - Checkpoint.md"
                  />
                </label>
                <label className="block">
                  Initial content
                  <textarea
                    className={field}
                    value={newText}
                    onChange={(e) => setNewText(e.target.value)}
                  />
                </label>
                <p className="text-sm">
                  This creates exactly the path and content shown. Existing
                  notes will not be overwritten.
                </p>
                <button
                  className={btn}
                  disabled={busy || !newPath || !subject.writable}
                  onClick={async () => {
                    if (
                      await act("create-note", { path: newPath, text: newText })
                    ) {
                      setNewPath("");
                      setNewText("");
                    }
                  }}
                >
                  Create this note
                </button>
              </details>
              <details>
                <summary className="min-h-12 py-3">
                  Change original note sync owner
                </summary>
                <p>
                  Changing owner pauses automatic logging. Existing cloud
                  revision history may retain earlier app-managed note content.
                  Ensure your external provider is not also synchronizing
                  app-managed originals.
                </p>
                <select
                  aria-label="New note sync owner"
                  className={field}
                  value={transition || ""}
                  onChange={(e) =>
                    setTransition(e.target.value as "app" | "external")
                  }
                >
                  <option value="" disabled>
                    Choose the new owner
                  </option>
                  <option value="external">External folder/provider</option>
                  <option value="app">LearnHarness</option>
                </select>
                <p>
                  Current local originals will be rechecked. Resolve outstanding
                  file conflicts before confirming. This does not rewrite
                  original files.
                </p>
                <button
                  className={btn}
                  disabled={busy || !transition || transition === subject.mode}
                  onClick={async () => {
                    if (await act("transition", { mode: transition }))
                      setTransition(undefined);
                  }}
                >
                  Confirm sync owner change and pause logging
                </button>
              </details>
              <label className="block">
                Find a note
                <input
                  aria-label="Search subject notes"
                  className={field}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setOffset(0);
                  }}
                />
              </label>
              <div className="space-y-1">
                {notes.map((n) => (
                  <div key={n.id} className="flex min-w-0 items-center gap-2">
                    <button
                      className={btn + " min-w-0 flex-1 break-all text-left"}
                      title={n.path}
                      onClick={() => void readNote(n.id)}
                    >
                      {n.path}
                    </button>
                    <label className="flex min-h-12 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        aria-label={"Use " + n.path + " as source"}
                        checked={subject.roles.sources.includes(n.id)}
                        disabled={busy}
                        onChange={(e) =>
                          void act("update", {
                            patch: {
                              roles: {
                                ...subject.roles,
                                sources: e.target.checked
                                  ? [...subject.roles.sources, n.id]
                                  : subject.roles.sources.filter(
                                      (id) => id !== n.id,
                                    ),
                              },
                            },
                          })
                        }
                      />
                      Source
                    </label>
                  </div>
                ))}
              </div>
              <p>
                {offset + 1}–{Math.min(offset + 100, total)} of {total}
              </p>
              <div className="flex gap-2">
                <button
                  className={btn}
                  disabled={!offset}
                  onClick={() => setOffset(Math.max(0, offset - 100))}
                >
                  Previous
                </button>
                <button
                  className={btn}
                  disabled={offset + 100 >= total}
                  onClick={() => setOffset(offset + 100)}
                >
                  Next
                </button>
              </div>
              <details>
                <summary className="min-h-12 py-3">
                  Scan issues ({subject.scan.issues.length})
                </summary>
                {subject.scan.error && <p role="alert">{subject.scan.error}</p>}
                {subject.scan.issues.slice(0, 100).map((i, n) => (
                  <p key={n} className="break-all text-sm">
                    {i.path}: {i.reason}
                  </p>
                ))}
              </details>
              <details>
                <summary className="min-h-12 py-3">
                  Related sessions ({subject.chatIds.length})
                </summary>
                {subject.chatIds.map((id) => (
                  <button
                    key={id}
                    className={btn + " block"}
                    onClick={() => {
                      setOpen(false);
                      router.push("/chat/" + id);
                    }}
                  >
                    Open session {id}
                  </button>
                ))}
              </details>
              {chatId && subject.chatIds.includes(chatId) && (
                <div className="space-y-2">
                  <button
                    className={btn}
                    disabled={busy || subject.scan.phase === "scanning"}
                    onClick={async () => {
                      completion.current ||= crypto.randomUUID();
                      const result = await act("finish", {
                        chatId,
                        operationId: completion.current,
                      });
                      if (result) setFinish(result);
                    }}
                  >
                    Finish lesson
                  </button>
                  {finish && (
                    <div>
                      <p role="status">
                        {finish.status === "logged"
                          ? "Lesson appended once to the log."
                          : "Lesson boundary saved. Continue in the composer to ask your selected model for the summary and reviewed checkpoint edits."}{" "}
                        Review the summary and ask your teacher to propose
                        checkpoint/source updates.
                      </p>
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">
                        {finish.summary || finish.requestPrompt}
                      </pre>
                      <button
                        className={btn}
                        onClick={() => {
                          setOpen(false);
                          window.dispatchEvent(
                            new CustomEvent("lh:subject-draft", {
                              detail: { chatId, text: finish.requestPrompt },
                            }),
                          );
                        }}
                      >
                        Prepare finish request in lesson composer
                      </button>
                      <button
                        className={btn}
                        onClick={() => {
                          completion.current = "";
                          setFinish(undefined);
                          setStatus("Ready for the next lesson.");
                        }}
                      >
                        Start next lesson boundary
                      </button>
                    </div>
                  )}
                </div>
              )}
              {note && (
                <div className="space-y-3 rounded border border-border p-3">
                  <h3 className="break-all">{note.path}</h3>
                  {note.error && <p role="alert">{note.error}</p>}
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">
                    {note.text}
                  </pre>
                  {note.nextOffset !== undefined && (
                    <button
                      className={btn}
                      onClick={async () => {
                        const r = await fetch(
                          "/api/subjects?id=" +
                            selected +
                            "&noteId=" +
                            note.noteId +
                            "&offset=" +
                            note.nextOffset,
                        );
                        if (r.ok) setNote(await r.json());
                      }}
                    >
                      Next section
                    </button>
                  )}
                  {note.links?.map((l: any, i: number) => (
                    <p key={i} className="break-all text-sm">
                      {l.target}: {l.status}
                      {l.status === "resolved" && (
                        <button
                          className={btn}
                          onClick={() => void readNote(l.noteId)}
                        >
                          Open referenced note
                        </button>
                      )}
                    </p>
                  ))}
                  {doc?.proposals.map((p) => (
                    <div
                      key={p.id}
                      className="space-y-2 border-t border-border pt-3"
                    >
                      <p>
                        {p.reason} · {p.status}
                      </p>
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-sm">
                        − {p.before}
                      </pre>
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-sm">
                        + {p.after}
                      </pre>
                      <div className="flex flex-wrap gap-2">
                        {p.status === "pending" ? (
                          <>
                            <button
                              className={btn}
                              disabled={busy || !doc.writable || !!note.error}
                              onClick={() => void review(p.id, "apply")}
                            >
                              Apply
                            </button>
                            <button
                              className={btn}
                              disabled={busy}
                              onClick={() => void review(p.id, "reject")}
                            >
                              Reject
                            </button>
                          </>
                        ) : p.status === "applied" ? (
                          <button
                            className={btn}
                            disabled={busy || !doc.writable || !!note.error}
                            onClick={() => void review(p.id, "undo")}
                          >
                            Undo
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {lessons
                .filter((l) => l.status !== "pending")
                .map((l) => (
                  <div
                    key={l.id}
                    className="space-y-2 rounded border border-border p-3"
                  >
                    <p>
                      {new Date(l.createdAt).toLocaleString()} · {l.status}
                    </p>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">
                      {l.summary}
                    </pre>
                    {l.status === "review" && subject.roles.log && (
                      <button
                        className={btn}
                        disabled={busy}
                        onClick={() =>
                          void act("apply-lesson-log", { lessonId: l.id })
                        }
                      >
                        Apply this log append
                      </button>
                    )}
                  </div>
                ))}
              {groups.map((g) => (
                <div
                  key={g.id}
                  className="space-y-2 rounded border border-border p-3"
                >
                  <h3>{g.title}</h3>
                  {g.items.map((i: any) => (
                    <label key={i.proposalId} className="flex min-h-12 items-center gap-2 break-all text-sm">
                      <input
                        aria-label={"Select edit " + i.proposalId}
                        type="checkbox"
                        checked={groupSelection[i.proposalId] !== false}
                        onChange={(e) =>
                          setGroupSelection({
                            ...groupSelection,
                            [i.proposalId]: e.target.checked,
                          })
                        }
                      />
                      {subject.notes.find((n) => n.id === i.documentId)?.path}:{" "}
                      {g.results[i.proposalId] || "pending review"}
                    </label>
                  ))}
                  <div className="flex flex-wrap gap-2">
                    {(["apply", "reject", "undo"] as const).map((action) => (
                      <button
                        key={action}
                        className={btn}
                        disabled={busy}
                        onClick={() =>
                          void act("review-group", {
                            groupId: g.id,
                            action,
                            selected: g.items
                              .filter(
                                (i: any) =>
                                  groupSelection[i.proposalId] !== false,
                              )
                              .map((i: any) => i.proposalId),
                          })
                        }
                      >
                        {action} group
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
