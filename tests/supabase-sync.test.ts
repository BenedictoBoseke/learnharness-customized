import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SupabaseConnection } from "../src/server/sync/supabase.ts";
import { RevisionConflictError } from "../src/core/sync/types.ts";
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "fixture@example.com",
};
const session = (access = "fixture-access", expires = 3600) => ({
  access_token: access,
  refresh_token: "fixture-refresh",
  expires_in: expires,
  user,
});
test(
  "default Free-plan email links verify directly without following redirects or exposing hashes",
  fixture(async (file) => {
    const hash = "a".repeat(64);
    const requests: string[] = [];
    const c = new SupabaseConnection(file, (async (url, init) => {
      requests.push(String(url));
      assert.deepEqual(JSON.parse(String(init?.body)), {
        token_hash: hash,
        type: "email",
      });
      return Response.json(session());
    }) as typeof fetch);
    c.configure("https://fixture.supabase.co", "sb_publishable_fixture");
    await c.verifyCode(
      user.email,
      `https://fixture.supabase.co/auth/v1/verify?token=${hash}&type=magiclink&redirect_to=http%3A%2F%2Flocalhost%3A3000`,
    );
    assert.deepEqual(requests, ["https://fixture.supabase.co/auth/v1/verify"]);
    assert.ok(!JSON.stringify(c.status()).includes(hash));
    assert.ok(!fs.readFileSync(file, "utf8").includes(hash));
    for (const link of [
      `https://another.supabase.co/auth/v1/verify?token=${hash}&type=magiclink`,
      `https://fixture.supabase.co/auth/v1/verify?token=${hash}&type=recovery`,
      `https://fixture.supabase.co/auth/v1/verify?token=${hash}&type=magiclink&token=other`,
      "http://localhost:3000/#access_token=do-not-import",
    ])
      await assert.rejects(
        c.verifyCode(user.email, link),
        /original sign-in link/,
      );
    assert.equal(requests.length, 1);
  }),
);
test(
  "a pasted sign-in link cannot silently sign into a different email account",
  fixture(async (file) => {
    const c = new SupabaseConnection(file, (async () =>
      Response.json(session())) as typeof fetch);
    c.configure("https://fixture.supabase.co", "sb_publishable_fixture");
    await assert.rejects(
      c.verifyCode(
        "different@example.com",
        `https://fixture.supabase.co/auth/v1/verify?token=${"a".repeat(64)}&type=signup`,
      ),
      /different account/,
    );
    assert.equal(c.status().signedIn, false);
  }),
);
function fixture(fn: (file: string) => Promise<void>) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-supabase-"));
    try {
      await fn(path.join(root, "private/sync-auth.json"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
test(
  "only a publishable project key is accepted; account credentials never enter public status",
  fixture(async (file) => {
    const c = new SupabaseConnection(file, (async () =>
      Response.json(session())) as typeof fetch);
    for (const key of ["sb_secret_do_not_ship", "service_role", "eyJfixture"])
      assert.throws(
        () => c.configure("https://fixture.supabase.co", key),
        /publishable/,
      );
    assert.throws(
      () => c.configure("http://fixture.supabase.co", "sb_publishable_fixture"),
      /HTTPS/,
    );
    c.configure("https://fixture.supabase.co", "sb_publishable_fixture");
    await c.verifyCode(user.email, "123456");
    const status = JSON.stringify(c.status());
    assert.ok(!status.includes("fixture-access"));
    assert.ok(!status.includes("fixture-refresh"));
    assert.equal(c.status().email, user.email);
    c.signOut();
    assert.equal(c.status().signedIn, false);
  }),
);
test(
  "concurrent refreshes share one token rotation and keep the account identity",
  fixture(async (file) => {
    let refreshes = 0;
    const c = new SupabaseConnection(file, (async (url) => {
      if (String(url).includes("grant_type")) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 10));
        return Response.json(session("refreshed-access"));
      }
      return Response.json(session("expired-access", -1));
    }) as typeof fetch);
    c.configure("https://fixture.supabase.co", "sb_publishable_fixture");
    await c.verifyCode(user.email, "123456");
    const [a, b] = await Promise.all([c.session(), c.session()]);
    assert.equal(refreshes, 1);
    assert.equal(a.accessToken, b.accessToken);
    assert.equal(a.userId, user.id);
  }),
);
test(
  "Storage duplicate responses are idempotent while RPC conflicts retain their conflict type",
  fixture(async (file) => {
    const c = new SupabaseConnection(file, (async (url, init) => {
      if (String(url).includes("/auth/")) return Response.json(session());
      if (String(url).includes("/storage/")) {
        assert.equal(
          (init?.headers as Record<string, string>).authorization,
          "Bearer fixture-access",
        );
        return Response.json(
          {
            statusCode: "409",
            error: "Duplicate",
            message: "The resource already exists",
          },
          { status: 400 },
        );
      }
      return Response.json(
        { message: "LH_REVISION_CONFLICT" },
        { status: 400 },
      );
    }) as typeof fetch);
    c.configure("https://fixture.supabase.co", "sb_publishable_fixture");
    await c.verifyCode(user.email, "123456");
    const t = await c.transport();
    await t.putBlob("a".repeat(64), Buffer.from("fixture"));
    await assert.rejects(
      t.commit("fixture", null, crypto.randomUUID(), "pc", {
        version: 1,
        entries: {},
      }),
      RevisionConflictError,
    );
  }),
);
test(
  "revoked refresh sessions show sign-in controls and retain the bound account identity",
  fixture(async (file) => {
    const c = new SupabaseConnection(file, (async (url) =>
      String(url).includes("grant_type")
        ? Response.json(
            { error_code: "refresh_token_not_found" },
            { status: 400 },
          )
        : Response.json(session("expired-access", -1))) as typeof fetch);
    c.configure("https://fixture.supabase.co", "sb_publishable_fixture");
    await c.verifyCode(user.email, "123456");
    await assert.rejects(c.session(), /Sync sign-in expired/);
    assert.equal(c.status().signedIn, false);
    assert.equal(c.config()?.boundUserId, user.id);
  }),
);
test(
  "expired verification codes name the sync sign-in problem without asking for a model API key",
  fixture(async (file) => {
    const c = new SupabaseConnection(file, (async () =>
      Response.json(
        { msg: "Token has expired or is invalid" },
        { status: 403 },
      )) as typeof fetch);
    c.configure("https://fixture.supabase.co", "sb_publishable_fixture");
    await assert.rejects(
      c.verifyCode(user.email, "123456"),
      /email code is invalid or expired/,
    );
  }),
);
test(
  "email throttling preserves project settings and explains existing-link recovery",
  fixture(async (file) => {
    const c = new SupabaseConnection(file, (async () =>
      Response.json(
        { msg: "email rate limit exceeded" },
        { status: 429 },
      )) as typeof fetch);
    c.configure("https://fixture.supabase.co", "sb_publishable_fixture");
    const before = fs.readFileSync(file, "utf8");
    await assert.rejects(
      c.requestCode(user.email),
      /Paste an unused sign-in link/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }),
);
