import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DocumentService } from "../src/store/documents.ts";
import { SubjectService } from "../src/store/subjects.ts";
import { createFolderPort, folderChild } from "../src/store/folder-access.ts";
import {
  resolveSubjectLink,
  validSubject,
  subjectTokenEstimate,
  subjectContextBudget,
} from "../src/core/subjects.ts";
import { subjectNoteIndex } from "../src/store/subject-index.ts";
import { LibraryReplica } from "../src/store/library-replica.ts";
import { validateManifest, reconcile } from "../src/core/sync/types.ts";
import { externalSubjectTranscript } from "../src/core/subject-sync.ts";
import { fitSubjectResult } from "../src/agent/tools/subject.ts";
test("retrieval trimming preserves IDs, revisions and usable pagination for Chinese notes", () => {
  const read = fitSubjectResult(
    {
      noteId: "doc_chinese",
      revision: "rev_current",
      offset: 300,
      text: "你怎么去医院？".repeat(800),
    },
    600,
  )!;
  assert.ok(read);
  assert.ok(read.tokens <= 600);
  assert.equal(read.value.noteId, "doc_chinese");
  assert.equal(read.value.revision, "rev_current");
  assert.equal(read.value.nextOffset, 300 + read.value.text.length);
  assert.ok(read.value.text.length > 0);
  const list = fitSubjectResult(
    {
      offset: 100,
      notes: Array.from({ length: 100 }, (_, i) => ({
        id: "doc_" + i,
        path: "中文资料" + i + ".md",
      })),
      total: 200,
    },
    300,
  )!;
  assert.ok(list.value.notes.length > 0 && list.value.notes.length < 100);
  assert.equal(list.value.nextOffset, 100 + list.value.notes.length);
});
test("retrieval accounting reserves conversation space without treating English characters as whole tokens", () => {
  assert.equal(subjectTokenEstimate("abcdef"), 2);
  assert.ok(subjectTokenEstimate("你好") > subjectTokenEstimate("abcdef"));
  assert.ok(
    subjectContextBudget(
      32768,
      "Teacher instructions. ".repeat(1800),
      "A learner question.",
    ) > 1000,
  );
  assert.equal(
    subjectContextBudget(
      4096,
      "Large system prompt. ".repeat(1800),
      "A question",
    ),
    0,
  );
});
test("source-position index ignores frontmatter and fenced examples, retains aliases and heading/block anchors", () => {
  const text =
    "---\naliases: [Transport, 交通]\n---\n# Real heading\nA paragraph. ^anchor\n```md\n# Fake heading\n```\n";
  const index = subjectNoteIndex(text);
  assert.deepEqual(
    index.headings.map((h) => h.title),
    ["Real heading"],
  );
  assert.equal(index.headings[0]!.offset, text.indexOf("# Real"));
  assert.deepEqual(index.aliases, ["Transport", "交通"]);
  assert.ok(index.anchors.includes("^anchor"));
});
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-subject-")),
    root = path.join(dir, "Chinese");
  fs.mkdirSync(root);
  const grant = "grant_" + "a".repeat(32),
    s = fs.statSync(root),
    grantsFile = path.join(dir, "grants.json");
  fs.writeFileSync(
    grantsFile,
    JSON.stringify({
      [grant]: {
        path: fs.realpathSync(root),
        name: "Chinese",
        directory: true,
        writable: true,
        identity: `${s.dev}:${s.ino}`,
      },
    }),
  );
  const chat: any = {
    id: "chat_a",
    title: "Chinese",
    createdAt: "2026-11-01",
    updatedAt: "2026-11-01",
    version: 1,
    messages: [
      {
        id: "m_a",
        role: "user",
        content: "Practised 你怎么去医院？",
        timestamp: 1,
      },
    ],
  };
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(path.join(dataDir, "chats"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "chats", "chat_a.json"),
    JSON.stringify(chat),
  );
  const docs = new DocumentService({
      dataDir,
      localDir: path.join(dir, "local", "documents"),
      grantsFile,
      readChat: (key) => (key === chat.id ? chat : null),
    }),
    folders = createFolderPort({ grantsFile }),
    service = new SubjectService({
      dataDir,
      localDir: path.join(dir, "local", "subjects"),
      documents: docs,
      folders,
      readChat: (key) => (key === chat.id ? chat : null),
    });
  return {
    dir,
    root,
    grant,
    grantsFile,
    dataDir,
    docs,
    service,
    chat,
    folders,
    selection: {
      handle: grant,
      name: "Chinese",
      kind: "desktop" as const,
      writable: true,
    },
  };
}
async function scanned(f: ReturnType<typeof fixture>, included?: string[]) {
  const preview = await f.service.preview(f.selection);
  const w = await f.service.link({
    previewId: preview.previewId,
    name: "Chinese",
    mode: "external",
    included: included || preview.paths,
  });
  for (let i = 0; i < 200 && f.service.busy; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(!f.service.busy, "Scanner completed");
  return f.service.view(w.id);
}
test("subject discovery excludes internal folders, preserves Unicode and never enables live logging", async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, ".pi"));
    fs.writeFileSync(path.join(f.root, ".pi", "private.md"), "not learning");
    fs.mkdirSync(path.join(f.root, "nested"));
    fs.writeFileSync(
      path.join(f.root, "HSK 1.md"),
      "---\r\ntags: [chinese]\r\n---\r\n# 中文\r\nNǐ zěnme qù?\r\n",
    );
    fs.writeFileSync(
      path.join(f.root, "nested", "中文.md"),
      "# 交通\nVocabulary",
    );
    fs.writeFileSync(path.join(f.root, "HSK.md.bak"), "backup");
    const w = await scanned(f);
    assert.equal(w.notes.length, 2);
    assert.equal(w.logging, false);
    assert.equal(w.scan.phase, "ready");
    for (const n of w.notes) assert.equal(f.docs.record(n.id).logging, false);
    assert.ok(w.scan.issues.some((i) => i.path === ".pi"));
    assert.equal(f.service.search(w.id, "交通")[0]!.path, "nested/中文.md");
    assert.equal(
      (
        await f.service.read(
          w.id,
          w.notes.find((n) => n.path === "HSK 1.md")!.id,
        )
      ).text.includes("\r\n"),
      true,
    );
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
test("folder grants reject traversal, absolute paths, junction escapes and a replaced root identity", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, "note.md"), "text");
    for (const p of [
      "../other.md",
      "/tmp/note.md",
      "C:/notes.md",
      "sub\\note.md",
      "sub/../note.md",
    ])
      assert.throws(() => folderChild(f.grantsFile, f.grant, p));
    const outside = path.join(f.dir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.md"), "private");
    fs.symlinkSync(outside, path.join(f.root, "escape"), "junction");
    assert.throws(() => folderChild(f.grantsFile, f.grant, "escape/secret.md"));
    fs.renameSync(f.root, f.root + "-old");
    fs.mkdirSync(f.root);
    assert.throws(
      () => folderChild(f.grantsFile, f.grant, ""),
      /folder changed/,
    );
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
test("subject checkpoint proposals modify originals only on Apply and safe Undo refuses later external changes", async () => {
  const f = fixture();
  try {
    const original =
      "---\ntags: [中文]\n---\n# Progress\nPractise transport.\n";
    fs.writeFileSync(path.join(f.root, "Checkpoint.md"), original);
    const w = await scanned(f),
      note = w.notes[0]!;
    f.service.associate(w.id, "chat_a");
    const r = await f.service.read(w.id, note.id, "chat_a");
    const p = await f.service.propose(
      w.id,
      "chat_a",
      note.id,
      r.revision,
      "Practise transport.",
      "Review 你怎么去……？",
      "Update checkpoint",
    );
    assert.equal(
      fs.readFileSync(path.join(f.root, note.path), "utf8"),
      original,
    );
    await f.docs.review(note.id, p.id, "apply");
    assert.match(
      fs.readFileSync(path.join(f.root, note.path), "utf8"),
      /Review 你/,
    );
    fs.appendFileSync(path.join(f.root, note.path), "Human annotation\n");
    await assert.rejects(() => f.docs.review(note.id, p.id, "undo"), /changed/);
    assert.match(
      fs.readFileSync(path.join(f.root, note.path), "utf8"),
      /Human annotation/,
    );
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
test("lesson completion logging is opt-in and repeated completion survives restart without duplicate blocks", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, "Log.md"), "# Human lesson log\n");
    const w = await scanned(f),
      note = w.notes[0]!;
    f.service.associate(w.id, "chat_a");
    f.service.update(w.id, { roles: { sources: [], log: note.id } });
    const lesson = await f.service.finish(w.id, "chat_a", "operation_a");
    await f.service.recordLesson(
      w.id,
      "chat_a",
      lesson.id,
      "Practised 你怎么去医院？. Next review: transport questions.",
    );
    assert.equal(
      fs.readFileSync(path.join(f.root, note.path), "utf8"),
      "# Human lesson log\n",
    );
    f.service.update(w.id, { logging: true });
    await f.service.applyLessonLog(w.id, lesson.id);
    for (let i = 0; i < 100 && f.service.busy; i++)
      await new Promise((r) => setTimeout(r, 10));
    await f.service.finish(w.id, "chat_a", "operation_a");
    const restarted = new SubjectService(f.service.options);
    const retried = await restarted.finish(w.id,"chat_a","fresh_operation_after_restart");
    assert.equal(retried.id,lesson.id);
    assert.equal(restarted.lessons(w.id).length,1);
    f.chat.messages.push({id:"finish_request",role:"user",content:retried.requestPrompt,timestamp:2});
    assert.equal((await restarted.finish(w.id,"chat_a","finish_request_retry")).id,lesson.id);
    f.chat.messages.push({id:"next_learning_question",role:"user",content:"Practise another direction question",timestamp:3});
    assert.notEqual((await restarted.finish(w.id,"chat_a","next_lesson")).id,lesson.id);
    const text = fs.readFileSync(path.join(f.root, note.path), "utf8");
    assert.equal((text.match(/<!--lh:lesson:/g) || []).length, 1);
    assert.match(text, /你怎么去医院/);
  } finally {
    for (let i = 0; i < 100 && f.service.busy; i++)
      await new Promise((r) => setTimeout(r, 10));
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
test("Obsidian references resolve only included unambiguous notes and preserve anchor metadata", () => {
  const notes = [
    { id: "a", path: "one/词汇.md" },
    { id: "b", path: "two/词汇.md" },
    { id: "c", path: "Checkpoint.md" },
  ];
  assert.equal(
    resolveSubjectLink(notes, "Checkpoint.md", "词汇").status,
    "ambiguous",
  );
  assert.deepEqual(
    resolveSubjectLink(notes, "one/词汇.md", "../Checkpoint#下一课"),
    { status: "resolved", noteId: "c", anchor: "下一课" },
  );
  assert.equal(
    resolveSubjectLink(notes, "Checkpoint.md", "../outside").status,
    "unsupported",
  );
  assert.equal(
    resolveSubjectLink(notes, "Checkpoint.md", "https://example.com").status,
    "unsupported",
  );
});
test("external source tool arguments/results are redacted, normal lesson quotes and tool IDs remain", () => {
  const chat: any = {
    messages: [
      {
        id: "a",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_a",
            name: "propose_subject_edit",
            arguments: {
              noteId: "doc_a",
              before: "SENTINEL_PRIVATE",
              after: "SECRET_EDIT",
            },
          },
        ],
      },
      {
        id: "b",
        role: "toolResult",
        toolCallId: "call_a",
        content: [{ type: "text", text: "SENTINEL_PRIVATE" }],
        details: { raw: "SECRET_EDIT" },
      },
      {
        id: "c",
        role: "assistant",
        content: [{ type: "text", text: "Ordinary lesson quotation 你好" }],
      },
    ],
  };
  const portable = externalSubjectTranscript(chat, new Set(["doc_a"]), true);
  assert.doesNotMatch(JSON.stringify(portable), /SENTINEL_PRIVATE|SECRET_EDIT/);
  assert.equal(portable.messages[0].content[0].id, "call_a");
  assert.match(JSON.stringify(portable), /Ordinary lesson/);
  assert.match(JSON.stringify(chat), /SENTINEL_PRIVATE/);
});
test("v2 replicas carry subject metadata with no source/index/private path blobs in external mode", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(
      path.join(f.root, "Source.md"),
      "SENTINEL_PRIVATE_ORIGINAL",
    );
    const w = await scanned(f);
    f.service.associate(w.id, "chat_a");
    const replica = new LibraryReplica({
      dataDir: f.dataDir,
      localDir: path.join(f.dir, "replica"),
      attachmentsDir: path.join(f.dir, "attachments"),
      deviceId: "desktop",
    });
    const manifest = replica.capture();
    assert.equal(manifest.version, 2);
    assert.ok(manifest.entries["workspace/" + w.id]);
    for (const hash of Object.values(manifest.entries)) {
      const text = replica.getBlob(hash).toString("utf8");
      assert.doesNotMatch(text, /SENTINEL_PRIVATE_ORIGINAL/);
      assert.ok(!text.includes(f.root));
    }
    assert.equal(validateManifest(manifest).version, 2);
    assert.throws(
      () => validateManifest({ ...manifest, version: 1 }),
      /entity/,
    );
    assert.equal(
      reconcile({ version: 1, entries: {} }, manifest, manifest).manifest
        .version,
      2,
    );
    const dest = path.join(f.dir, "phone"),
      phone = new LibraryReplica({
        dataDir: dest,
        localDir: path.join(f.dir, "phone-local"),
        attachmentsDir: path.join(f.dir, "phone-files"),
        deviceId: "phone",
      });
    for (const hash of Object.values(manifest.entries))
      phone.putBlob(replica.getBlob(hash));
    phone.apply(manifest);
    const imported = JSON.parse(
      fs.readFileSync(path.join(dest, "workspaces", w.id + ".json"), "utf8"),
    );
    assert.ok(validSubject(imported));
    assert.equal(imported.id, w.id);
    assert.equal(fs.existsSync(path.join(dest, ".local", "subjects")), false);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("app-managed destination preview never overwrites differences and rejects a file changed after preview", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, "Source.md"), "Remote source version");
    const w = await scanned(f);
    await f.service.transition(w.id, "app");
    const destination = path.join(f.dir, "destination");
    fs.mkdirSync(destination);
    fs.writeFileSync(
      path.join(destination, "Source.md"),
      "A local human version",
    );
    const handle = "grant_" + "c".repeat(32),
      s = fs.statSync(destination),
      registry = JSON.parse(fs.readFileSync(f.grantsFile, "utf8"));
    registry[handle] = {
      path: fs.realpathSync(destination),
      name: "Destination",
      directory: true,
      writable: true,
      identity: `${s.dev}:${s.ino}`,
    };
    fs.writeFileSync(f.grantsFile, JSON.stringify(registry));
    const preview = await f.service.preview({
        handle,
        name: "Destination",
        kind: "desktop",
        writable: true,
      }),
      rows = await f.service.materializationPreview(w.id, preview.previewId);
    assert.equal(rows.rows[0]!.status, "different");
    assert.equal(
      fs.readFileSync(path.join(destination, "Source.md"), "utf8"),
      "A local human version",
    );
    fs.appendFileSync(
      path.join(destination, "Source.md"),
      " plus newer annotation",
    );
    const result = await f.service.materialize(w.id, preview.previewId, [
      {
        id: w.notes[0]!.id,
        choice: "synced",
        localRevision: rows.rows[0]!.localRevision,
      },
    ]);
    assert.match(result.results[w.notes[0]!.id]!, /changed after preview/);
    assert.match(
      fs.readFileSync(path.join(destination, "Source.md"), "utf8"),
      /newer annotation/,
    );
  } finally {
    for (let i = 0; i < 100 && f.service.busy; i++)
      await new Promise((r) => setTimeout(r, 10));
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("app-managed materialization creates only explicitly chosen missing notes and retains identity on retry", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, "One.md"), "One");
    fs.writeFileSync(path.join(f.root, "Two.md"), "Two");
    const w = await scanned(f);
    await f.service.transition(w.id, "app");
    const destination = path.join(f.dir, "destination");
    fs.mkdirSync(destination);
    const handle = "grant_" + "d".repeat(32),
      s = fs.statSync(destination),
      registry = JSON.parse(fs.readFileSync(f.grantsFile, "utf8"));
    registry[handle] = {
      path: fs.realpathSync(destination),
      name: "Destination",
      directory: true,
      writable: true,
      identity: `${s.dev}:${s.ino}`,
    };
    fs.writeFileSync(f.grantsFile, JSON.stringify(registry));
    const preview = await f.service.preview({
        handle,
        name: "Destination",
        kind: "desktop",
        writable: true,
      }),
      first = w.notes[0]!,
      second = w.notes[1]!;
    const result = await f.service.materialize(w.id, preview.previewId, [
      { id: first.id, choice: "synced", localRevision: null },
      { id: second.id, choice: "skip", localRevision: null },
    ]);
    assert.equal(result.results[first.id], "bound");
    assert.equal(
      fs.readFileSync(path.join(destination, first.path), "utf8"),
      f.docs.record(first.id).text,
    );
    assert.equal(fs.existsSync(path.join(destination, second.path)), false);
    for (let i = 0; i < 100 && f.service.busy; i++)
      await new Promise((r) => setTimeout(r, 10));
    const repeated = await f.service.materialize(w.id, preview.previewId, [
      { id: first.id, choice: "synced", localRevision: null },
    ]);
    assert.equal(repeated.results[first.id], "bound");
    assert.equal(
      f.service.record(w.id).notes.find((n) => n.path === first.path)!.id,
      first.id,
    );
  } finally {
    for (let i = 0; i < 100 && f.service.busy; i++)
      await new Promise((r) => setTimeout(r, 10));
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("group review retains successful file outcomes, stops at conflict and never undoes newer annotations", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, "One.md"), "One original.");
    fs.writeFileSync(path.join(f.root, "Two.md"), "Two original.");
    const w = await scanned(f);
    f.service.associate(w.id, "chat_a");
    const group = f.service.createGroup(w.id, "chat_a", "Review two notes");
    for (const n of w.notes) {
      const read = await f.service.read(w.id, n.id, "chat_a");
      const p = await f.service.propose(
        w.id,
        "chat_a",
        n.id,
        read.revision,
        read.text,
        read.text + " Clearer.",
        "Improve this note",
      );
      f.service.addToGroup(w.id, group.id, n.id, p.id);
    }
    const second = w.notes[1]!;
    const originalReview = f.docs.review.bind(f.docs);
    let raced = false;
    f.docs.review = async (...args) => {
      if (args[0] === second.id && !raced) {
        raced = true;
        fs.appendFileSync(path.join(f.root, second.path), " Human addition.");
      }
      return originalReview(...args);
    };
    const result = await f.service.reviewGroup(w.id, group.id, "apply");
    assert.equal(
      result.results[
        group.items[0]?.proposalId ||
          f.service.groups(w.id)[0]!.items[0]!.proposalId
      ],
      "applied",
    );
    assert.match(
      fs.readFileSync(path.join(f.root, second.path), "utf8"),
      /Human addition/,
    );
    assert.ok(Object.values(result.results).some((s) => /changed/.test(s)));
  } finally {
    for (let i = 0; i < 100 && f.service.busy; i++)
      await new Promise((r) => setTimeout(r, 10));
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("refresh discovers added notes and an interrupted/cancelled index retains the last completed generation", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, "One.md"), "First");
    const w = await scanned(f);
    fs.writeFileSync(path.join(f.root, "Two.md"), "Second");
    f.service.refresh(w.id);
    for (let i = 0; i < 200 && f.service.busy; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.service.record(w.id).notes.length, 2);
    f.service.refresh(w.id);
    f.service.cancel(w.id);
    for (let i = 0; i < 200 && f.service.busy; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.service.view(w.id).scan.phase, "cancelled");
    assert.equal(f.service.search(w.id, "First").length, 1);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("atomic external saves retain note identity, exclusions revoke cached reads, and relink settles a foreground scan", async () => {
  const f = fixture();
  try {
    const file = path.join(f.root, "Source.md");
    fs.writeFileSync(file, "Old 中文 material");
    const w = await scanned(f),
      noteId = w.notes[0]!.id;
    fs.writeFileSync(file + ".tmp", "Updated 中文 material");
    fs.renameSync(file + ".tmp", file);
    f.service.refresh(w.id);
    for (let i = 0; i < 500 && f.service.busy; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.service.record(w.id).notes[0]!.id, noteId);
    assert.equal(
      (await f.service.read(w.id, noteId)).text,
      "Updated 中文 material",
    );
    f.service.update(w.id, { exclusions: ["Source.md"] });
    assert.equal(f.service.search(w.id, "Updated").length, 0);
    await assert.rejects(f.service.read(w.id, noteId), /not included/);
    f.service.update(w.id, { exclusions: [] });
    const preview = await f.service.preview(f.selection);
    f.service.refresh(w.id);
    await f.service.link({
      previewId: preview.previewId,
      workspaceId: w.id,
      name: w.name,
      mode: "external",
      included: preview.paths,
    });
    for (let i = 0; i < 500 && f.service.busy; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.service.record(w.id).notes[0]!.id, noteId);
    assert.equal(f.service.view(w.id).scan.phase, "ready");
  } finally {
    for (let i = 0; i < 500 && f.service.busy; i++)
      await new Promise((r) => setTimeout(r, 10));
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("v2 protocol follows the active library base rather than a previous subject library", () => {
  const f = fixture();
  try {
    const localDir = path.join(f.dir, "replica"),
      replica = new LibraryReplica({
        dataDir: f.dataDir,
        localDir,
        attachmentsDir: path.join(f.dir, "files"),
        deviceId: "pc",
      });
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(
      path.join(localDir, "state.json"),
      JSON.stringify({ base: { version: 2 } }),
    );
    assert.equal(replica.capture().version, 2);
    fs.writeFileSync(
      path.join(localDir, "state.json"),
      JSON.stringify({ base: { version: 1 } }),
    );
    assert.equal(replica.capture().version, 1);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a subject with many notes indexes asynchronously and returns bounded list/search windows", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 300; i++)
      fs.writeFileSync(
        path.join(f.root, "Vocabulary " + i + ".md"),
        "# 中文 " + i + "\nTransport vocabulary " + i,
      );
    const preview = await f.service.preview(f.selection),
      w = await f.service.link({
        previewId: preview.previewId,
        name: "Large subject",
        mode: "external",
        included: preview.paths,
      });
    assert.equal(w.scan.phase, "scanning");
    for (let i = 0; i < 2000 && f.service.busy; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.service.record(w.id).notes.length, 300);
    assert.equal(f.service.noteList(w.id).notes.length, 100);
    assert.equal(f.service.search(w.id, "vocabulary").length, 12);
  } finally {
    for (let i = 0; i < 100 && f.service.busy; i++)
      await new Promise((r) => setTimeout(r, 10));
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
