"use client";
import { useCallback, useEffect, useState } from "react";
import type { SyncStatus, SyncInventory } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";
interface Status extends SyncStatus {
  signedIn?: boolean;
  fileReferences?: Array<{ id: string; name: string; bound: boolean }>;
  recoveries?: Array<{ id: string; name: string; createdAt: string }>;
}
const input =
  "w-full rounded border border-border bg-background px-3 py-2 text-sm";
const button =
  "rounded border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-40";
const labels: Record<string, string> = {
  disabled: "Sync is off",
  "signed-out": "Sign into sync",
  local: "Saved on this device",
  syncing: "Syncing",
  synced: "Synced",
  waiting: "Saved locally, waiting to sync",
  conflict: "Both versions need review",
  error: "Saved locally, sync needs attention",
};
function Inventory({ label, value }: { label: string; value: SyncInventory }) {
  return (
    <div className="min-w-0 rounded border border-border p-3 text-sm">
      <p className="font-medium">{label}</p>
      <p>
        {value.sessions} sessions · {value.notes} notes · {value.attachments}{" "}
        attachments
      </p>
      <p>
        {value.graphNodes} graph nodes · {value.completedJobs} completed jobs
      </p>
      <details className="mt-2">
        <summary>Preview sessions</summary>
        <ul className="mt-2 space-y-1">
          {value.sessionPreview.map((c) => (
            <li key={c.id} className="break-words">
              {c.title} · {c.messages} messages
            </li>
          ))}
        </ul>
        {value.sessions > value.sessionPreview.length && (
          <p>Showing the first {value.sessionPreview.length} sessions.</p>
        )}
      </details>
    </div>
  );
}
export function SyncSection() {
  const [status, setStatus] = useState<Status>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [projectUrl, setProjectUrl] = useState(""),
    [publishableKey, setKey] = useState(""),
    [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [sent, setSent] = useState(false),
    [configure, setConfigure] = useState(false),
    [libraries, setLibraries] = useState<Array<{ id: string; name: string }>>(
      [],
    ),
    [library, setLibrary] = useState(""),
    [name, setName] = useState("My learning library"),
    [recovery, setRecovery] = useState("");
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/sync", { cache: "no-store" });
      const b = await r.json();
      if (!r.ok) throw Error(b.error);
      setStatus(b);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync status unavailable");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useServerEvent("sync-changed", () => void load());
  useServerResync(() => void load());
  async function act(op: string, fields: Record<string, unknown> = {}) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op, ...fields }),
      });
      const b = await r.json();
      if (!r.ok) throw Error(b.error);
      if (op === "libraries") setLibraries(b.libraries);
      else await load();
      return b;
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Sync failed; learning remains saved locally.",
      );
      return null;
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (status?.signedIn)
      void act(
        "libraries",
      ); /* Auth transitions fetch the account's library inventory once. */
  }, [status?.signedIn]);
  return (
    <section className="space-y-4 px-6 py-5" data-testid="section-sync">
      <h2 className="text-sm uppercase tracking-widest">Progress sync</h2>
      <p role="status" data-testid="sync-phase">
        {status ? labels[status.phase] : "Reading sync status…"}
      </p>
      {status?.message && <p className="text-sm">{status.message}</p>}
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Learning stays available offline. Model-provider sign-ins stay on each
        device.
      </p>
      {!status?.configured || configure ? (
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act("configure", { projectUrl, publishableKey }))
              setConfigure(false);
          }}
        >
          <label className="block text-sm">
            Supabase project URL
            <input
              aria-label="Supabase project URL"
              className={input}
              type="url"
              value={projectUrl}
              onChange={(e) => setProjectUrl(e.target.value)}
              placeholder="https://your-project.supabase.co"
              required
            />
          </label>
          <label className="block text-sm">
            Publishable key
            <input
              aria-label="Supabase publishable key"
              className={input}
              value={publishableKey}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sb_publishable_…"
              required
              autoComplete="off"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Use the project configured with the LearnHarness sync migration.
            Learning content is private to your account and readable by your
            hosting provider.
          </p>
          <button className={button} disabled={busy}>
            Save project
          </button>
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">
          {status.projectUrl}{" "}
          <button
            className="underline"
            onClick={() => {
              setProjectUrl(status.projectUrl || "");
              setConfigure(true);
            }}
          >
            Change project
          </button>
        </p>
      )}
      {status?.configured && !status.signedIn && (
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (sent) {
              if (await act("verify-code", { email, code })) {
                setCode("");
                setSent(false);
              }
            } else if (await act("request-code", { email })) setSent(true);
          }}
        >
          <label className="block text-sm">
            Sync account email
            <input
              className={input}
              type="email"
              aria-label="Sync email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </label>
          {sent && (
            <label className="block text-sm">
              Email code or sign-in link
              <input
                className={input}
                aria-label="Sync email code or sign-in link"
                type="password"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            </label>
          )}
          <button className={button} disabled={busy}>
            {sent ? "Sign in" : "Send sign-in email"}
          </button>
          {sent && (
            <p className="text-xs text-muted-foreground">
              Copy the sign-in link from the email without opening it, then
              paste it here. If your email contains a code, enter that instead.
              No localhost website or custom email template is needed.
            </p>
          )}
          {sent && (
            <button
              className={button}
              type="button"
              disabled={busy}
              onClick={() => setSent(false)}
            >
              Use another email
            </button>
          )}
        </form>
      )}
      {status?.signedIn && (
        <>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>{status.email}</span>
            <button
              className={button}
              disabled={busy}
              onClick={() => void act("sign-out")}
            >
              Sign out of sync
            </button>
          </div>
          <p className="text-xs">
            This device: {status.deviceName}. {status.localChanges} local
            changes.
          </p>
          {!status.libraryId && (
            <div className="space-y-3">
              <label className="block text-sm">
                Create a shared library
                <input
                  className={input}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <button
                className={button}
                disabled={busy}
                onClick={() => void act("create-library", { name })}
              >
                Create library from this device
              </button>
              <label className="block text-sm">
                Or join your other device’s library
                <select
                  className={input}
                  value={library}
                  onChange={(e) => setLibrary(e.target.value)}
                >
                  <option value="">Select a shared library</option>
                  {libraries.map((l) => (
                    <option value={l.id} key={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className={button}
                disabled={busy || !library}
                onClick={() => void act("join-library", { libraryId: library })}
              >
                Join library
              </button>
              <button
                className={button}
                disabled={busy}
                onClick={() => void act("libraries")}
              >
                Refresh list
              </button>
            </div>
          )}
          {status.libraryId && (
            <button
              className={button}
              disabled={busy}
              onClick={() => void act("leave-library")}
            >
              Change shared library
            </button>
          )}
          {status.libraryId && (
            <button
              className={button}
              data-testid="sync-now"
              disabled={busy}
              onClick={() => void act("sync")}
            >
              {busy ? "Working…" : "Sync now"}
            </button>
          )}
          {status.lastSyncedAt && (
            <p className="text-xs text-muted-foreground">
              Last synced: {new Date(status.lastSyncedAt).toLocaleString()}
            </p>
          )}
          {status.review &&
            (status.initialChoiceRequired || status.conflict) && (
              <div
                className="grid gap-2 sm:grid-cols-2"
                data-testid="sync-inventory-preview"
              >
                <Inventory label="This device" value={status.review.local} />
                <Inventory
                  label="Shared library"
                  value={status.review.remote}
                />
              </div>
            )}
          {status.initialChoiceRequired && (
            <div className="space-y-2 rounded border border-border p-3">
              <p className="text-sm">
                Both libraries have data. A recovery copy of both versions will
                be retained.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => void act("sync", { initialChoice: "remote" })}
                >
                  Use shared library here
                </button>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => void act("sync", { initialChoice: "local" })}
                >
                  Use this device’s library
                </button>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => void act("sync", { initialChoice: "merge" })}
                >
                  Combine non-conflicting changes
                </button>
              </div>
            </div>
          )}
          {status.conflict && (
            <div
              className="space-y-2 rounded border border-border p-3"
              data-testid="sync-conflict"
            >
              <p className="text-sm">
                Concurrent changes: {status.conflict.keys.join(", ")}
              </p>
              <p className="text-xs">
                Choose a complete library version. The other remains in recovery
                snapshots.
              </p>
              <button
                className={button}
                disabled={busy}
                onClick={() => void act("sync", { resolution: "local" })}
              >
                Keep this device’s version
              </button>
              <button
                className={button}
                disabled={busy}
                onClick={() => void act("sync", { resolution: "remote" })}
              >
                Use the other device’s version
              </button>
            </div>
          )}
        </>
      )}
      {!!status?.fileReferences?.some((f) => !f.bound) && (
        <details>
          <summary className="cursor-pointer text-sm">
            Files that need relinking
          </summary>
          <div className="space-y-2 py-2">
            {status.fileReferences
              .filter((f) => !f.bound)
              .map((f) => (
                <div
                  key={f.id}
                  className="flex flex-wrap items-center gap-2 text-sm"
                >
                  <span>{f.name}</span>
                  <button
                    className={button}
                    disabled={busy}
                    onClick={async () => {
                      const native = (
                        window.lh as typeof window.lh & {
                          documents?: {
                            pick: (kind: string) => Promise<{
                              handle: string;
                              kind: string;
                            } | null>;
                          };
                        }
                      )?.documents;
                      if (!native) {
                        setError(
                          "Choose a local file in the desktop or Android app.",
                        );
                        return;
                      }
                      const picked = await native.pick("attachment");
                      if (picked)
                        await act("relink-file", { fileId: f.id, ...picked });
                    }}
                  >
                    Choose local file
                  </button>
                </div>
              ))}
          </div>
        </details>
      )}
      {!!status?.recoveries?.length && (
        <details>
          <summary className="cursor-pointer text-sm">
            Recovery snapshots
          </summary>
          <div className="mt-2 space-y-2">
            <select
              aria-label="Recovery snapshot"
              className={input}
              value={recovery}
              onChange={(e) => setRecovery(e.target.value)}
            >
              <option value="">Select a snapshot</option>
              {status.recoveries.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {new Date(r.createdAt).toLocaleString()}
                </option>
              ))}
            </select>
            <p className="text-xs">
              Restoring changes the local library and preserves the current
              version first.
            </p>
            <button
              className={button}
              disabled={busy || !recovery}
              onClick={() => void act("restore-recovery", { id: recovery })}
            >
              Restore locally
            </button>
          </div>
        </details>
      )}
    </section>
  );
}
