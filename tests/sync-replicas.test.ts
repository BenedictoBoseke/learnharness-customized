import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LibraryReplica, bytesHash } from "../src/store/library-replica.ts";
import { SyncEngine } from "../src/server/sync/engine.ts";
import { atomicWrite } from "../src/store/atomic-json.ts";
import {
  RevisionConflictError,
  reconcile,
  type RemoteRevision,
  type SyncManifest,
  type SyncTransport,
} from "../src/core/sync/types.ts";
class Cloud implements SyncTransport {
  revisions: RemoteRevision[] = [];
  blobs = new Map<string, Uint8Array>();
  loseNextReply = false;
  calls = 0;
  uploads = 0;
  async head() {
    return structuredClone(this.revisions.at(-1) || null);
  }
  async listLibraries() {
    return [{ id: "11111111-1111-4111-8111-111111111111", name: "Fixture" }];
  }
  async createLibrary() {
    return "11111111-1111-4111-8111-111111111111";
  }
  async getBlob(hash: string) {
    const b = this.blobs.get(hash);
    if (!b) throw Error("Missing fixture blob");
    return b;
  }
  async putBlob(hash: string, bytes: Uint8Array) {
    this.uploads++;
    assert.equal(bytesHash(bytes), hash);
    this.blobs.set(hash, bytes);
  }
  async commit(
    _library: string,
    parentId: string | null,
    operationId: string,
    deviceId: string,
    manifest: SyncManifest,
  ) {
    this.calls++;
    const prior = this.revisions.find((r) => r.operationId === operationId);
    if (prior) return structuredClone(prior);
    if ((this.revisions.at(-1)?.id || null) !== parentId)
      throw new RevisionConflictError();
    const r = {
      id: crypto.randomUUID(),
      parentId,
      operationId,
      deviceId,
      manifest: structuredClone(manifest),
      createdAt: new Date().toISOString(),
    };
    this.revisions.push(r);
    if (this.loseNextReply) {
      this.loseNextReply = false;
      throw Error("Invented lost response after remote commit");
    }
    return structuredClone(r);
  }
}
function fixture(fn: (root: string) => Promise<void>) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-"));
    try {
      await fn(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
function device(root: string, name: string, busy = () => false) {
  const dataDir = path.join(root, name, "data"),
    replica = new LibraryReplica({
      dataDir,
      attachmentsDir: path.join(root, name, "attachments"),
      deviceId: name,
    });
  const engine = new SyncEngine({
    replica,
    deviceId: name,
    deviceName: name,
    isBusy: busy,
  });
  engine.join("11111111-1111-4111-8111-111111111111");
  return { dataDir, replica, engine };
}
function chat(
  d: { dataDir: string },
  id = "chat_fixture",
  text = "A question",
) {
  const c = {
    id,
    version: 1,
    title: "Original title",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    messages: [
      { id: "user_original", role: "user", content: text, timestamp: 1 },
    ],
    tree: { nodes: [] },
  };
  atomicWrite(path.join(d.dataDir, "chats", id + ".json"), JSON.stringify(c));
  return c;
}
const read = (d: { dataDir: string }, id = "chat_fixture") =>
  JSON.parse(
    fs.readFileSync(path.join(d.dataDir, "chats", id + ".json"), "utf8"),
  );
test(
  "PC to Android preserves native identity, plan and pending question; imported sessions require explicit resume",
  fixture(async (root) => {
    const a = device(root, "pc"),
      b = device(root, "android"),
      cloud = new Cloud();
    const c = chat(a);
    c.messages.push({
      id: "assistant_original",
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "quiz_original",
          name: "quiz",
          arguments: {
            question: "Why?",
            options: [{ label: "A" }, { label: "B" }],
            correctAnswer: "A",
            explanation: "Hidden until answered",
          },
        },
      ],
      timestamp: 2,
    } as never);
    atomicWrite(
      path.join(a.dataDir, "chats/chat_fixture.json"),
      JSON.stringify(c),
    );
    assert.equal((await a.engine.sync(cloud)).phase, "synced");
    assert.equal((await b.engine.sync(cloud)).phase, "synced");
    assert.deepEqual(read(b), c);
    assert.equal(b.engine.requiresResume(c.id), true);
    b.engine.resume(c.id);
    assert.equal(b.engine.requiresResume(c.id), false);
    assert.equal(cloud.revisions.length, 1);
  }),
);
test(
  "offline changes and a rename with unchanged updatedAt sync without duplication",
  fixture(async (root) => {
    const a = device(root, "pc"),
      b = device(root, "android"),
      cloud = new Cloud();
    chat(a);
    await a.engine.sync(cloud);
    await b.engine.sync(cloud);
    const c = read(b);
    c.title = "Changed offline";
    c.messages.push({
      id: "user_new",
      role: "user",
      content: "I understand",
      timestamp: 3,
    });
    atomicWrite(
      path.join(b.dataDir, "chats/chat_fixture.json"),
      JSON.stringify(c),
    );
    await b.engine.sync(cloud);
    await b.engine.sync(cloud);
    await a.engine.sync(cloud);
    assert.deepEqual(read(a), c);
    assert.equal(
      read(a).messages.filter((m: any) => m.id === "user_new").length,
      1,
    );
    assert.equal(cloud.revisions.length, 2);
  }),
);
test(
  "divergent conversation edits keep both candidates and restore the unselected version",
  fixture(async (root) => {
    const a = device(root, "pc"),
      b = device(root, "android"),
      cloud = new Cloud();
    chat(a);
    await a.engine.sync(cloud);
    await b.engine.sync(cloud);
    const ca = read(a),
      cb = read(b);
    ca.title = "PC choice";
    cb.title = "Android choice";
    atomicWrite(
      path.join(a.dataDir, "chats/chat_fixture.json"),
      JSON.stringify(ca),
    );
    atomicWrite(
      path.join(b.dataDir, "chats/chat_fixture.json"),
      JSON.stringify(cb),
    );
    await a.engine.sync(cloud);
    const s = await b.engine.sync(cloud);
    assert.equal(s.phase, "conflict");
    assert.deepEqual(s.conflict?.keys, ["chat/chat_fixture"]);
    assert.equal(read(b).title, "Android choice");
    const preserved = b.engine
      .recoveries()
      .find((r) => r.name === "Local conflict candidate")!;
    assert.ok(preserved);
    assert.equal(
      (await b.engine.sync(cloud, { resolution: "remote" })).phase,
      "synced",
    );
    assert.equal(read(b).title, "PC choice");
    await b.engine.restoreRecovery(preserved.id);
    assert.equal(read(b).title, "Android choice");
    assert.equal(cloud.revisions.length, 2);
  }),
);
test(
  "graph ledgers are one conflict unit and are not unioned by timestamp",
  fixture(async (root) => {
    const a = device(root, "pc"),
      b = device(root, "android"),
      cloud = new Cloud();
    chat(a);
    await a.engine.sync(cloud);
    await b.engine.sync(cloud);
    atomicWrite(
      path.join(a.dataDir, "graph/nodes.jsonl"),
      JSON.stringify({ id: "n_pc", provenance: [{ chatId: "chat_fixture" }] }) +
        "\n",
    );
    atomicWrite(
      path.join(b.dataDir, "graph/nodes.jsonl"),
      JSON.stringify({
        id: "n_android",
        provenance: [{ chatId: "chat_fixture" }],
      }) + "\n",
    );
    await a.engine.sync(cloud);
    const s = await b.engine.sync(cloud);
    assert.equal(s.phase, "conflict");
    assert.deepEqual(s.conflict?.keys, ["graph/family"]);
    assert.match(
      fs.readFileSync(path.join(b.dataDir, "graph/nodes.jsonl"), "utf8"),
      /n_android/,
    );
  }),
);
test(
  "lost commit response survives process restart with the same operation ID",
  fixture(async (root) => {
    const a = device(root, "pc"),
      cloud = new Cloud();
    chat(a);
    cloud.loseNextReply = true;
    assert.equal((await a.engine.sync(cloud)).phase, "error");
    assert.equal(cloud.revisions.length, 1);
    const restarted = new SyncEngine({
      replica: new LibraryReplica(a.replica.options),
      deviceId: "pc",
      deviceName: "PC",
      isBusy: () => false,
    });
    assert.equal((await restarted.sync(cloud)).phase, "synced");
    assert.equal(cloud.revisions.length, 1);
    assert.ok(cloud.calls >= 2);
  }),
);
test(
  "deletion beats an unchanged offline copy, while delete-versus-edit is explicit conflict",
  fixture(async (root) => {
    const a = device(root, "pc"),
      b = device(root, "android"),
      cloud = new Cloud();
    chat(a);
    await a.engine.sync(cloud);
    await b.engine.sync(cloud);
    fs.unlinkSync(path.join(a.dataDir, "chats/chat_fixture.json"));
    await a.engine.sync(cloud);
    await b.engine.sync(cloud);
    assert.equal(
      fs.existsSync(path.join(b.dataDir, "chats/chat_fixture.json")),
      false,
    );
    chat(a, "chat_new");
    await a.engine.sync(cloud);
    await b.engine.sync(cloud);
    const c = read(b, "chat_new");
    c.title = "Offline edit";
    atomicWrite(path.join(b.dataDir, "chats/chat_new.json"), JSON.stringify(c));
    fs.unlinkSync(path.join(a.dataDir, "chats/chat_new.json"));
    await a.engine.sync(cloud);
    assert.equal((await b.engine.sync(cloud)).phase, "conflict");
    assert.equal(
      (await cloud.head())?.manifest.entries["chat/chat_new"],
      undefined,
    );
  }),
);
test(
  "first synchronization previews two populated libraries and preserves both",
  fixture(async (root) => {
    const a = device(root, "pc"),
      b = device(root, "android"),
      cloud = new Cloud();
    chat(a, "chat_pc");
    chat(b, "chat_android");
    await a.engine.sync(cloud);
    const preview = await b.engine.sync(cloud);
    assert.equal(preview.initialChoiceRequired, true);
    assert.equal(preview.review?.local.sessions, 1);
    assert.equal(preview.review?.remote.sessions, 1);
    assert.equal(preview.review?.local.sessionPreview[0]?.id, "chat_android");
    assert.equal(preview.review?.remote.sessionPreview[0]?.id, "chat_pc");
    assert.ok(read(b, "chat_android"));
    await b.engine.sync(cloud, { initialChoice: "remote" });
    assert.ok(read(b, "chat_pc"));
    assert.equal(
      fs.existsSync(path.join(b.dataDir, "chats/chat_android.json")),
      false,
    );
    assert.ok(b.engine.recoveries().length >= 3);
  }),
);
test(
  "future session schema, corrupt transfer, and interrupted local apply cannot erase canonical data",
  fixture(async (root) => {
    const a = device(root, "pc"),
      cloud = new Cloud();
    const c = chat(a);
    (c as any).version = 99;
    atomicWrite(
      path.join(a.dataDir, "chats/chat_fixture.json"),
      JSON.stringify(c),
    );
    assert.equal((await a.engine.sync(cloud)).phase, "error");
    assert.equal(cloud.revisions.length, 0);
    assert.equal(read(a).version, 99);
    assert.throws(
      () => a.replica.acceptBlob("a".repeat(64), Buffer.from("wrong")),
      /checksum/,
    );
    const journal = {
      phase: "prepared",
      files: [
        {
          name: "chats/chat_fixture.json",
          before: Buffer.from(JSON.stringify(c)).toString("base64"),
          after: null,
        },
      ],
    };
    atomicWrite(
      path.join(a.replica.localDir, "apply-journal.json"),
      JSON.stringify(journal),
    );
    fs.unlinkSync(path.join(a.dataDir, "chats/chat_fixture.json"));
    new LibraryReplica(a.replica.options);
    assert.equal(read(a).version, 99);
  }),
);
test(
  "attachments transfer in verified chunks with native path rebinding, not a PC path",
  fixture(async (root) => {
    const a = device(root, "pc"),
      b = device(root, "android"),
      cloud = new Cloud();
    const source = path.join(root, "invented-note.md");
    fs.writeFileSync(source, "Invented private attachment\n".repeat(200000));
    a.replica.register(source);
    chat(a, "chat_fixture", "Read `" + source + "`");
    await a.engine.sync(cloud);
    for (const bytes of cloud.blobs.values())
      assert.equal(Buffer.from(bytes).includes(Buffer.from(source)), false);
    await b.engine.sync(cloud);
    const content = read(b).messages[0].content;
    assert.ok(!content.includes(source));
    const local = content.slice(
      content.indexOf("`") + 1,
      content.lastIndexOf("`"),
    );
    assert.equal(
      fs.readFileSync(local, "utf8"),
      fs.readFileSync(source, "utf8"),
    );
    assert.ok(cloud.blobs.size >= 4);
  }),
);
test(
  "sync never publishes or imports running execution state",
  fixture(async (root) => {
    const a = device(root, "pc"),
      b = device(root, "android"),
      cloud = new Cloud();
    chat(a);
    atomicWrite(
      path.join(a.dataDir, "jobs/job_running.json"),
      JSON.stringify({
        id: "job_running",
        chatId: "chat_fixture",
        status: "running",
      }),
    );
    atomicWrite(
      path.join(a.dataDir, "jobs/job_done.json"),
      JSON.stringify({
        id: "job_done",
        chatId: "chat_fixture",
        status: "done",
        result: { text: "Invented result" },
      }),
    );
    await a.engine.sync(cloud);
    await b.engine.sync(cloud);
    assert.equal(
      fs.existsSync(path.join(b.dataDir, "jobs/job_running.json")),
      false,
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(b.dataDir, "jobs/job_done.json"), "utf8"),
      ).ownerDeviceId,
      "pc",
    );
  }),
);
test(
  "a busy replica waits without writing to the cloud",
  fixture(async (root) => {
    let busy = false;
    const a = device(root, "pc", () => busy),
      cloud = new Cloud();
    chat(a);
    busy = true;
    assert.equal((await a.engine.sync(cloud)).phase, "waiting");
    assert.equal(cloud.calls, 0);
  }),
);

test(
  "unchanged replicas do not retransmit immutable payloads",
  fixture(async (root) => {
    const a = device(root, "pc"),
      cloud = new Cloud();
    chat(a);
    await a.engine.sync(cloud);
    const uploads = cloud.uploads;
    await a.engine.sync(cloud);
    assert.equal(cloud.uploads, uploads);
  }),
);

test(
  "an unbound file reference stays stable until explicit relinking makes it readable",
  fixture(async (root) => {
    const a = device(root, "pc"),
      b = device(root, "android"),
      cloud = new Cloud();
    const source = path.join(root, "reference-only.md");
    fs.writeFileSync(source, "Original local note");
    chat(a, "chat_fixture", "Read `" + source + "`");
    await a.engine.sync(cloud);
    await b.engine.sync(cloud);
    const remoteCount = cloud.revisions.length;
    assert.match(read(b).messages[0].content, /lh-unbound:\/\//);
    const references = b.replica.references();
    assert.equal(references.length, 1);
    assert.equal(references[0]?.name, "reference-only.md");
    await b.engine.sync(cloud);
    assert.equal(cloud.revisions.length, remoteCount);
    const selected = path.join(root, "android-selected.md");
    fs.writeFileSync(selected, "Explicitly selected counterpart");
    b.replica.bind(references[0]!.id, selected);
    const message = read(b).messages[0].content;
    assert.ok(!message.includes("lh-unbound"));
    assert.match(
      fs.readFileSync(
        message.slice(message.indexOf("`") + 1, message.lastIndexOf("`")),
        "utf8",
      ),
      /counterpart/,
    );
  }),
);
test(
  "linked note revisions and pending proposals remain valid when file references change platform",
  fixture(async (root) => {
    const a = device(root, "pc"),
      b = device(root, "android"),
      cloud = new Cloud();
    const file = path.join(root, "reference.txt");
    fs.writeFileSync(file, "A referenced file");
    a.replica.register(file);
    chat(a);
    const text = "Read `" + file + "` and improve this paragraph.",
      revision = bytesHash(text);
    const doc = {
      version: 1,
      id: "doc_fixture",
      name: "Learning.md",
      mode: "app",
      chatIds: ["chat_fixture"],
      logging: true,
      text,
      revision,
      updatedAt: "2026-01-01",
      blockHashes: {},
      proposals: [
        {
          id: "edit_fixture",
          documentId: "doc_fixture",
          chatId: "chat_fixture",
          baseRevision: revision,
          before: "improve this paragraph",
          after: "a better paragraph",
          status: "pending",
          createdAt: "2026-01-01",
          reason: "Improve",
        },
      ],
    };
    atomicWrite(
      path.join(a.dataDir, "documents/doc_fixture.json"),
      JSON.stringify(doc),
    );
    await a.engine.sync(cloud);
    await b.engine.sync(cloud);
    const imported = JSON.parse(
      fs.readFileSync(
        path.join(b.dataDir, "documents/doc_fixture.json"),
        "utf8",
      ),
    );
    assert.notEqual(imported.text, text);
    assert.equal(imported.revision, bytesHash(imported.text));
    assert.equal(imported.proposals[0].baseRevision, imported.revision);
    const uploads = cloud.revisions.length;
    await b.engine.sync(cloud);
    assert.equal(cloud.revisions.length, uploads);
  }),
);
