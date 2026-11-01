"use client";
import { MessageResponse } from "@/components/ai-elements/message";
import { useCallback, useEffect, useState } from "react";
import type { DocumentView, DocumentSyncMode } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";
interface NativePick {
  handle: string;
  name: string;
  kind: "android" | "desktop";
  writable: boolean;
}
const button =
  "rounded border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-40";
const field =
  "w-full rounded border border-border bg-background px-3 py-2 text-sm";
export function LinkedDocumentsButton({ chatId }: { chatId: string }) {
  const [open, setOpen] = useState(false),
    [docs, setDocs] = useState<DocumentView[]>([]),
    [allDocs, setAllDocs] = useState<DocumentView[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [text, setText] = useState(""),
    [revision, setRevision] = useState(""),
    [selected, setSelected] = useState(""),
    [mode, setMode] = useState<DocumentSyncMode>("app"),
    [reason, setReason] = useState(""),
    [before, setBefore] = useState(""),
    [after, setAfter] = useState(""),
    [resume, setResume] = useState(false),
    [relink, setRelink] = useState(""),
    [source, setSource] = useState(false);
  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([
        fetch("/api/documents?chatId=" + encodeURIComponent(chatId), {
          cache: "no-store",
        }),
        fetch("/api/sync?chatId=" + encodeURIComponent(chatId), {
          cache: "no-store",
        }),
      ]);
      const body = await r.json();
      if (!r.ok) throw Error(body.error);
      setDocs(body.documents);
      const sync = await s.json();
      setResume(Boolean(sync.resumeRequired));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Notes are unavailable");
    }
  }, [chatId]);
  useEffect(() => {
    void load();
  }, [load]);
  useServerEvent("documents-changed", () => {
    void load();
    if (open && selected) void read(selected);
  });
  useServerEvent("sync-changed", () => {
    void load();
    if (open && selected) void read(selected);
  });
  useServerResync(() => void load());
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", close);
    void fetch("/api/documents")
      .then((r) => r.json())
      .then((b) => setAllDocs(b.documents || []))
      .catch(() => {});
    return () => document.removeEventListener("keydown", close);
  }, [open]);
  async function act(op: string, fields: Record<string, unknown> = {}) {
    setError("");
    setBusy(true);
    try {
      const r = await fetch("/api/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op, chatId, ...fields }),
      });
      const b = await r.json();
      if (!r.ok) throw Error(b.error);
      await load();
      return b;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The document could not be updated",
      );
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function read(id: string) {
    try {
      const r = await fetch(
          "/api/documents?id=" +
            encodeURIComponent(id) +
            "&chatId=" +
            encodeURIComponent(chatId),
          { cache: "no-store" },
        ),
        b = await r.json();
      if (!r.ok) throw Error(b.error);
      setSelected(id);
      setText(b.text);
      setRevision(b.document.revision);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Document unavailable");
    }
  }
  async function pick() {
    const native = (
      window.lh as typeof window.lh & {
        documents?: { pick: () => Promise<NativePick | null> };
      }
    )?.documents;
    if (!native) {
      setError("Linking a writable file requires the desktop or Android app.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const picked = await native.pick();
      if (picked) {
        const d = await act("link", {
          ...picked,
          mode,
          ...(relink ? { documentId: relink } : {}),
        });
        if (d) {
          await act("backfill");
          await read(d.id);
          setRelink("");
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "File selection failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {resume && (
        <button
          className="lh-no-drag rounded border border-border px-2 py-1 text-xs"
          data-testid="resume-synced-session"
          onClick={async () => {
            const r = await fetch("/api/sync", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ op: "resume-session", chatId }),
            });
            if (r.ok) window.location.reload();
            else setError((await r.json()).error);
          }}
        >
          Resume here
        </button>
      )}
      <button
        className="lh-no-drag shrink-0 rounded border border-border px-2 py-1 text-xs"
        data-testid="linked-documents-open"
        onClick={() => setOpen(true)}
      >
        {docs.some((d) => d.proposals.some((p) => p.status === "pending"))
          ? "Review note edit"
          : "Note"}
        {docs.length ? ` · ${docs.length}` : ""}
      </button>
      {open && (
        <div
          className="lh-no-drag fixed inset-0 z-[80] flex items-center justify-center bg-background/90 p-2"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Linked Markdown notes"
            data-testid="linked-documents-dialog"
            className="flex h-[min(90dvh,900px)] w-[min(960px,100%)] flex-col overflow-hidden rounded border border-border bg-card shadow-xl"
          >
            <header className="flex items-center justify-between border-b border-border p-4">
              <h2 className="font-title text-xl">Linked Markdown</h2>
              <button
                className={button}
                aria-label="Close linked notes"
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </header>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              {error && (
                <p role="alert" className="text-sm text-red-400">
                  {error}
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                Link an existing note to update it as you learn. Revisions to
                your writing appear as proposals for Apply or Reject.
              </p>
              <label className="block text-sm">
                Document synchronization
                <select
                  className={field}
                  aria-label="Document sync mode"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as DocumentSyncMode)}
                >
                  <option value="app">
                    LearnHarness carries this document between devices
                  </option>
                  <option value="external">
                    My folder/provider already synchronizes this document
                  </option>
                </select>
              </label>
              <label className="block text-sm">
                Link a new file, or bind a synced note on this device
                <select
                  className={field}
                  value={relink}
                  onChange={(e) => setRelink(e.target.value)}
                >
                  <option value="">New linked document</option>
                  {allDocs.map((d) => (
                    <option value={d.id} key={d.id}>
                      {d.name}
                      {d.bound ? "" : " · choose a local file"}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className={button}
                disabled={busy}
                data-testid="link-markdown"
                onClick={() => void pick()}
              >
                Choose existing .md file
              </button>
              {docs.map((d) => (
                <article
                  className="space-y-2 rounded border border-border p-3"
                  key={d.id}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="break-all text-sm">{d.name}</strong>
                    <span className="text-xs text-muted-foreground">
                      {!d.bound
                        ? "Needs a local file"
                        : d.writable
                          ? "Writable"
                          : "Read-only"}{" "}
                      ·{" "}
                      {d.mode === "app" ? "LearnHarness sync" : "External sync"}
                    </span>
                  </div>
                  {d.error && (
                    <div className="space-y-2">
                      <p role="alert" className="text-sm text-red-400">
                        {d.error}
                      </p>
                      <button
                        className={button}
                        disabled={busy || !d.bound}
                        onClick={() =>
                          void act("resolve-file", {
                            documentId: d.id,
                            choice: "local",
                          })
                        }
                      >
                        Keep local file content
                      </button>
                      <button
                        className={button}
                        disabled={busy || !d.writable}
                        onClick={() =>
                          void act("resolve-file", {
                            documentId: d.id,
                            choice: "synced",
                          })
                        }
                      >
                        Write synced content to file
                      </button>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      className={button}
                      disabled={busy}
                      onClick={() => void read(d.id)}
                    >
                      Read / edit
                    </button>
                    <button
                      className={button}
                      disabled={busy}
                      onClick={() =>
                        void act("logging", {
                          documentId: d.id,
                          logging: !d.logging,
                        })
                      }
                    >
                      {d.logging ? "Pause live logging" : "Resume live logging"}
                    </button>
                    <button
                      className={button}
                      disabled={busy || !d.bound}
                      onClick={() => void act("backfill")}
                    >
                      Update from session
                    </button>
                    <button
                      className={button}
                      disabled={busy}
                      onClick={() => void act("unlink", { documentId: d.id })}
                    >
                      Unlink session
                    </button>
                  </div>
                  {d.proposals
                    .filter(
                      (p) => p.status !== "rejected" && p.status !== "undone",
                    )
                    .map((p) => (
                      <div
                        className="space-y-2 border-t border-border pt-2"
                        key={p.id}
                        data-testid="document-proposal"
                      >
                        <p className="text-sm">{p.reason}</p>
                        <div className="grid gap-2 md:grid-cols-2">
                          <pre className="whitespace-pre-wrap break-words rounded bg-red-500/10 p-2 text-xs">
                            {p.before}
                          </pre>
                          <pre className="whitespace-pre-wrap break-words rounded bg-green-500/10 p-2 text-xs">
                            {p.after}
                          </pre>
                        </div>
                        {p.status === "pending" ? (
                          <div className="flex gap-2">
                            <button
                              className={button}
                              disabled={busy || !d.writable}
                              onClick={() =>
                                void act("review", {
                                  documentId: d.id,
                                  proposalId: p.id,
                                  action: "apply",
                                })
                              }
                            >
                              Apply edit
                            </button>
                            <button
                              className={button}
                              disabled={busy}
                              onClick={() =>
                                void act("review", {
                                  documentId: d.id,
                                  proposalId: p.id,
                                  action: "reject",
                                })
                              }
                            >
                              Reject
                            </button>
                          </div>
                        ) : (
                          <button
                            className={button}
                            disabled={busy || !d.writable}
                            onClick={() =>
                              void act("review", {
                                documentId: d.id,
                                proposalId: p.id,
                                action: "undo",
                              })
                            }
                          >
                            Undo edit
                          </button>
                        )}
                      </div>
                    ))}
                </article>
              ))}
              {selected && (
                <div className="space-y-3 border-t border-border pt-4">
                  <h3 className="text-sm">Current note</h3>
                  <button className={button} onClick={() => setSource(!source)}>
                    {source ? "Rendered note" : "Markdown source"}
                  </button>
                  {source ? (
                    <pre
                      className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border p-3 text-sm"
                      data-testid="linked-document-text"
                    >
                      {text}
                    </pre>
                  ) : (
                    <div
                      className="max-h-96 overflow-auto rounded border border-border p-3"
                      data-testid="linked-document-text"
                    >
                      <MessageResponse>{text.slice(0, 100000)}</MessageResponse>
                      {text.length > 100000 && (
                        <p className="text-xs">
                          Preview limited to the first 100,000 characters. Use
                          Markdown source to read the complete note.
                        </p>
                      )}
                    </div>
                  )}
                  <label className="block text-sm">
                    Exact passage to replace
                    <textarea
                      className={field}
                      value={before}
                      onChange={(e) => setBefore(e.target.value)}
                    />
                  </label>
                  <label className="block text-sm">
                    Replacement
                    <textarea
                      className={field}
                      value={after}
                      onChange={(e) => setAfter(e.target.value)}
                    />
                  </label>
                  <label className="block text-sm">
                    Reason
                    <input
                      className={field}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                  <button
                    className={button}
                    disabled={busy || !before || before === after}
                    onClick={async () => {
                      if (
                        await act("propose", {
                          documentId: selected,
                          baseRevision: revision,
                          before,
                          after,
                          reason,
                        })
                      )
                        setBefore("");
                    }}
                  >
                    Preview edit
                  </button>
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => void read(selected)}
                  >
                    Refresh current note
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
