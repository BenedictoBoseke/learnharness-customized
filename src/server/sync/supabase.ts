import { atomicWrite, readJson } from "../../store/atomic-json.ts";
import {
  RevisionConflictError,
  validateManifest,
  type RemoteRevision,
  type SyncManifest,
  type SyncTransport,
} from "../../core/sync/types.ts";
interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
  email: string;
}
interface Config {
  version: 1;
  projectUrl: string;
  publishableKey: string;
  boundUserId?: string;
  session?: Session;
}
interface RevisionRow {
  id: string;
  parent_id: string | null;
  device_id: string;
  manifest: SyncManifest;
  operation_id: string;
  created_at: string;
}
export class SupabaseConnection {
  constructor(
    private file: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  config() {
    const c = readJson<Config | null>(this.file, null);
    if (
      c &&
      (c.version !== 1 ||
        typeof c.projectUrl !== "string" ||
        typeof c.publishableKey !== "string")
    )
      throw new Error(
        "The sync connection file requires a newer app or recovery.",
      );
    return c;
  }
  private save(value: Config) {
    atomicWrite(this.file, JSON.stringify(value));
  }
  configure(projectUrl: string, publishableKey: string) {
    const u = new URL(projectUrl);
    if (
      u.protocol !== "https:" ||
      !u.hostname.endsWith(".supabase.co") ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/"
    )
      throw new Error("Enter the HTTPS project URL shown in Supabase Connect.");
    if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey))
      throw new Error(
        "Use the publishable key (sb_publishable_…), not a secret or service-role key.",
      );
    const old = this.config();
    this.save({
      version: 1,
      projectUrl: u.origin,
      publishableKey,
      ...(old?.projectUrl === u.origin && old.publishableKey === publishableKey
        ? { session: old.session, boundUserId: old.boundUserId }
        : {}),
    });
  }
  status() {
    const c = this.config();
    return {
      configured: Boolean(c),
      projectUrl: c?.projectUrl,
      email: c?.session?.email,
      signedIn: Boolean(c?.session),
      userId: c?.session?.userId,
    };
  }
  private async request(
    path: string,
    init: RequestInit = {},
    session?: Session,
  ): Promise<Response> {
    const c = this.config();
    if (!c) throw new Error("Configure your Supabase project first.");
    const r = await this.fetcher(c.projectUrl + path, {
      ...init,
      redirect: "error",
      headers: {
        apikey: c.publishableKey,
        ...(session ? { authorization: `Bearer ${session.accessToken}` } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) {
      if (r.status === 409) throw new RevisionConflictError();
      let message = "";
      try {
        const b = await r.json();
        message = String(
          b.msg || b.error_description || b.message || b.error || "",
        );
        if (
          path.startsWith("/storage/") &&
          (b.statusCode === "409" ||
            b.statusCode === 409 ||
            b.error === "Duplicate")
        )
          throw new RevisionConflictError();
      } catch (e) {
        if (e instanceof RevisionConflictError) throw e;
      }
      if (
        path.startsWith("/auth/v1/verify") &&
        [400, 401, 403].includes(r.status)
      )
        throw new Error(
          "The email code is invalid or expired. Request a fresh sign-in email and paste its code or unopened sign-in link.",
        );
      if (path === "/auth/v1/otp" && r.status === 401)
        throw new Error(
          "Supabase rejected the project connection. Check its URL and publishable key in Sync settings.",
        );
      if (
        path.startsWith("/auth/v1/token?") &&
        [400, 401, 403].includes(r.status)
      ) {
        this.signOut();
        throw new Error(
          "Sync sign-in expired. Sign into sync again; your local library and model-provider connection are preserved.",
        );
      }
      if (r.status === 401)
        throw new Error(
          "Sync sign-in expired. Sign into sync again; your model-provider connection is unchanged.",
        );
      if (message.includes("LH_REVISION_CONFLICT"))
        throw new RevisionConflictError();
      if (
        path.startsWith("/auth/") &&
        message &&
        !/token|key|secret/i.test(message)
      )
        throw new Error(message.slice(0, 240));
      if (r.status === 404 || message.includes("lh_"))
        throw new Error(
          "The sync database is not ready. Apply the LearnHarness Supabase migration, then retry.",
        );
      throw new Error(
        `Sync service returned HTTP ${r.status}. Your local data is preserved.`,
      );
    }
    return r;
  }
  async requestCode(email: string) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      throw new Error("Enter your email address.");
    await this.request("/auth/v1/otp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, create_user: true }),
    });
  }
  private storeSession(data: Record<string, any>) {
    if (
      typeof data.access_token !== "string" ||
      typeof data.refresh_token !== "string" ||
      !data.user?.id
    )
      throw new Error("Sync sign-in did not return a complete session.");
    const c = this.config()!;
    c.session = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
      userId: data.user.id,
      email: data.user.email || "",
    };
    c.boundUserId = c.session.userId;
    this.save(c);
    return c.session;
  }
  async verifyCode(email: string, token: string) {
    token = token.trim();
    let verification: Record<string, string>;
    if (/^[0-9]{6,10}$/.test(token)) {
      verification = { email, token, type: "email" };
    } else {
      let link: URL;
      try {
        link = new URL(token);
      } catch {
        throw new Error(
          "Paste the code or copy the original sign-in link from the email.",
        );
      }
      const hash =
        link.searchParams.get("token_hash") || link.searchParams.get("token");
      if (
        link.origin !== this.config()?.projectUrl ||
        link.pathname !== "/auth/v1/verify" ||
        link.username ||
        link.password ||
        link.hash ||
        !["email", "magiclink", "signup"].includes(
          link.searchParams.get("type") || "",
        ) ||
        !hash ||
        !/^[A-Za-z0-9_-]{20,512}$/.test(hash) ||
        link.searchParams.getAll("token").length +
          link.searchParams.getAll("token_hash").length !==
          1
      )
        throw new Error(
          "Copy the original sign-in link from this project's email, before opening it in a browser.",
        );
      // Verify only with the configured project. Never follow the email's redirect URL.
      verification = { token_hash: hash, type: "email" };
    }
    const data = await (
      await this.request("/auth/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(verification),
      })
    ).json();
    if (
      typeof data.user?.email !== "string" ||
      data.user.email.toLowerCase() !== email.trim().toLowerCase()
    )
      throw new Error(
        "This sign-in email belongs to a different account. Enter that account's email before continuing.",
      );
    return this.storeSession(data);
  }
  private refreshing: Promise<Session> | null = null;
  async session(): Promise<Session> {
    const c = this.config();
    if (!c?.session) throw new Error("Sign into sync to connect this device.");
    if (c.session.expiresAt > Date.now() + 60000) return c.session;
    if (!this.refreshing)
      this.refreshing = (async () => {
        const data = await (
          await this.request("/auth/v1/token?grant_type=refresh_token", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ refresh_token: c.session!.refreshToken }),
          })
        ).json();
        if (data.user?.id !== c.session!.userId)
          throw new Error(
            "The sync account changed. Sign in again before continuing.",
          );
        return this.storeSession(data);
      })().finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }
  signOut() {
    const c = this.config();
    if (c) {
      delete c.session;
      this.save(c);
    }
  }
  async transport(): Promise<SyncTransport> {
    const session = await this.session();
    const request = (path: string, init: RequestInit = {}) =>
      this.request(path, init, session);
    const row = (r: RevisionRow): RemoteRevision => ({
      id: r.id,
      parentId: r.parent_id,
      deviceId: r.device_id,
      manifest: validateManifest(r.manifest),
      operationId: r.operation_id,
      createdAt: r.created_at,
    });
    return {
      listLibraries: async () => {
        const r = await (
          await request(
            "/rest/v1/lh_libraries?select=id,name&order=created_at.asc",
          )
        ).json();
        return r.map((v: { id: string; name: string }) => ({
          id: v.id,
          name: v.name,
        }));
      },
      createLibrary: async (name) => {
        const rows = await (
          await request("/rest/v1/lh_libraries", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              prefer: "return=representation",
            },
            body: JSON.stringify({
              name: name.slice(0, 120) || "My learning library",
              owner_id: session.userId,
            }),
          })
        ).json();
        if (!rows[0]?.id) throw new Error("Library creation failed");
        return rows[0].id;
      },
      head: async (id) => {
        const libs = await (
          await request(
            "/rest/v1/lh_libraries?id=eq." +
              encodeURIComponent(id) +
              "&select=head_id",
          )
        ).json();
        if (!libs[0])
          throw new Error("Library not found for this sync account.");
        if (!libs[0].head_id) return null;
        const rows = await (
          await request(
            "/rest/v1/lh_revisions?id=eq." +
              encodeURIComponent(libs[0].head_id) +
              "&select=*",
          )
        ).json();
        if (!rows[0])
          throw new Error("The shared library revision is unavailable");
        return row(rows[0]);
      },
      getBlob: async (hash) => {
        if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid sync blob");
        const r = await request(
          `/storage/v1/object/authenticated/learnharness-sync/${session.userId}/${hash}`,
        );
        const size = Number(r.headers.get("content-length") || 0);
        if (size > 50 * 1024 * 1024)
          throw new Error("Sync payload exceeds the supported size");
        const reader = r.body?.getReader();
        if (!reader) throw new Error("Empty sync payload");
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.length;
          if (total > 50 * 1024 * 1024) {
            await reader.cancel();
            throw new Error("Sync payload exceeds the supported size");
          }
          chunks.push(next.value);
        }
        return Buffer.concat(chunks);
      },
      putBlob: async (hash, bytes) => {
        if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid sync blob");
        try {
          await request(
            `/storage/v1/object/learnharness-sync/${session.userId}/${hash}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/octet-stream",
                "x-upsert": "false",
              },
              body: Buffer.from(bytes),
            },
          );
        } catch (e) {
          if (e instanceof RevisionConflictError) return;
          throw e;
        }
      },
      commit: async (libraryId, parentId, operationId, deviceId, manifest) => {
        const result = await (
          await request("/rest/v1/rpc/lh_sync_commit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              p_library_id: libraryId,
              p_parent_id: parentId,
              p_operation_id: operationId,
              p_device_id: deviceId,
              p_manifest: manifest,
            }),
          })
        ).json();
        return row(result);
      },
    };
  }
}
