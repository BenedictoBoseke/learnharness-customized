import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DocumentService } from "../src/store/documents.ts";
import { atomicWrite } from "../src/store/atomic-json.ts";
import { liveDocumentBlocks } from "../src/core/documents/live-markdown.ts";
import { linkedDocumentTools } from "../src/agent/tools/linked-document.ts";
import type { ChatRecord } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
function fixture(
  fn: (context: {
    service: DocumentService;
    file: string;
    root: string;
    chat: ChatRecord;
    link: () => Promise<any>;
  }) => Promise<void>,
) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-documents-")),
      file = path.join(root, "existing.md"),
      grants = path.join(root, "private/grants.json");
    const chat: ChatRecord = {
      id: "chat_fixture",
      title: "Learning",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      messages: [
        {
          id: "u_original",
          role: "user",
          content: "Why do independent errors cancel?",
          timestamp: 1,
        } as LhMessage,
      ],
    };
    fs.writeFileSync(
      file,
      "---\r\ntitle: Human note\r\n---\r\n\r\nMy untouched introduction.\r\n",
    );
    atomicWrite(
      grants,
      JSON.stringify({
        handle_fixture: { path: file, name: "existing.md", writable: true },
      }),
    );
    const service = new DocumentService({
      dataDir: path.join(root, "data"),
      grantsFile: grants,
      readChat: () => chat,
    });
    try {
      await fn({
        service,
        file,
        root,
        chat,
        link: () =>
          service.link({
            chatId: chat.id,
            name: "existing.md",
            handle: "handle_fixture",
            kind: "desktop",
            writable: true,
            mode: "app",
          }),
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
const assistant = (id: string, content: unknown[]): LhMessage =>
  ({
    id,
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
    timestamp: 2,
  }) as never;
test("the native agent read tool preserves the note identity and revision alongside its text", async () => {
  const expected = {
    documentId: "doc_fixture",
    revision: "a".repeat(64),
    text: "Existing learning material.",
  };
  const [read] = linkedDocumentTools({
    read: async () => expected,
    propose: async () => {
      throw Error("Read must not edit");
    },
  });
  const result = await read!.execute("read_fixture", {});
  const text = result.content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
  assert.deepEqual(JSON.parse(text), expected);
});
test(
  "linking and live logging update the same original file, retain frontmatter/EOL and resume idempotently",
  fixture(async ({ service, file, root, chat, link }) => {
    const before = fs.readFileSync(file, "utf8"),
      d = await link();
    await service.logSession(chat.id);
    const text = fs.readFileSync(file, "utf8");
    assert.ok(text.startsWith(before));
    assert.match(text, /Why do independent errors cancel/);
    await service.logSession(chat.id);
    assert.equal(fs.readFileSync(file, "utf8"), text);
    const restarted = new DocumentService({
      dataDir: path.join(root, "data"),
      grantsFile: path.join(root, "private/grants.json"),
      readChat: () => chat,
    });
    await restarted.logSession(chat.id);
    assert.equal(fs.readFileSync(file, "utf8"), text);
    assert.equal((await restarted.read(d.id)).text, text);
  }),
);
test(
  "agent edit is a proposal until Apply, then safe Undo restores the original prose",
  fixture(async ({ service, file, chat, link }) => {
    const d = await link(),
      r = await service.read(d.id);
    const p = await service.propose(
      d.id,
      chat.id,
      r.document.revision,
      "My untouched introduction.",
      "A clearer introduction.",
      "Clarify the opening",
    );
    assert.match(fs.readFileSync(file, "utf8"), /untouched/);
    await service.review(d.id, p.id, "apply");
    assert.match(fs.readFileSync(file, "utf8"), /clearer/);
    await service.review(d.id, p.id, "undo");
    assert.match(fs.readFileSync(file, "utf8"), /untouched/);
  }),
);
test(
  "selecting the same native document again retains one logical note and logging identity",
  fixture(async ({ service, file, chat, link }) => {
    const first = await link();
    await service.logSession(chat.id);
    const before = fs.readFileSync(file, "utf8");
    const again = await link();
    assert.equal(again.id, first.id);
    assert.equal(service.records().length, 1);
    await service.logSession(chat.id);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }),
);
test(
  "external editor revisions invalidate stale proposals and are not overwritten",
  fixture(async ({ service, file, chat, link }) => {
    const d = await link(),
      r = await service.read(d.id);
    const p = await service.propose(
      d.id,
      chat.id,
      r.document.revision,
      "My untouched introduction.",
      "Proposed wording.",
      "Improve",
    );
    fs.appendFileSync(file, "\r\nHuman addition from another editor.\r\n");
    await assert.rejects(service.review(d.id, p.id, "apply"), /changed/);
    assert.match(fs.readFileSync(file, "utf8"), /Human addition/);
    assert.match(fs.readFileSync(file, "utf8"), /untouched/);
    await service.logSession(chat.id);
    assert.match(fs.readFileSync(file, "utf8"), /Human addition/);
  }),
);
test(
  "authorized live appends preserve a pending scoped edit and its later Undo",
  fixture(async ({ service, file, chat, link }) => {
    const d = await link();
    await service.logSession(chat.id);
    const read = await service.read(d.id);
    const p = await service.propose(
      d.id,
      chat.id,
      read.document.revision,
      "My untouched introduction.",
      "A reviewed introduction.",
      "Clarify",
    );
    chat.messages.push(
      assistant("live_explanation", [
        { type: "text", text: "A new lesson explanation." },
      ]),
    );
    await service.logSession(chat.id);
    await service.review(d.id, p.id, "apply");
    assert.match(fs.readFileSync(file, "utf8"), /reviewed introduction/);
    chat.messages.push(
      assistant("later_explanation", [
        { type: "text", text: "A later lesson explanation." },
      ]),
    );
    await service.logSession(chat.id);
    await service.review(d.id, p.id, "undo");
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /My untouched introduction/);
    assert.match(text, /A new lesson explanation/);
    assert.match(text, /A later lesson explanation/);
  }),
);
test(
  "ambiguous replacements and unlinked session capabilities are rejected",
  fixture(async ({ service, file, chat, link }) => {
    const d = await link();
    fs.appendFileSync(file, "duplicate duplicate");
    const r = await service.read(d.id);
    await assert.rejects(
      service.propose(
        d.id,
        chat.id,
        r.document.revision,
        "duplicate",
        "one",
        "Improve",
      ),
      /ambiguous/,
    );
    await assert.rejects(service.read(d.id, "chat_other"), /not linked/);
  }),
);
test(
  "revoked/deleted selected file retains its cache and reports unavailable without making a replacement",
  fixture(async ({ service, file, link }) => {
    const d = await link();
    fs.unlinkSync(file);
    const r = await service.read(d.id);
    assert.ok(r.document.error);
    assert.match(r.text, /untouched introduction/);
    assert.equal(fs.existsSync(file), false);
  }),
);
test(
  "pending quiz exposes displayed options, never correct answer, explanation or thinking",
  fixture(async ({ service, file, chat, link }) => {
    chat.messages.push(
      assistant("a_quiz", [
        { type: "thinking", thinking: "PRIVATE_THINKING" },
        {
          type: "toolCall",
          id: "q_stable",
          name: "quiz",
          arguments: {
            question: "What cancels?",
            options: [
              { label: "Independent zero-mean errors", value: "independent" },
              { label: "Shared bias", value: "bias" },
            ],
            correctAnswer: "independent",
            explanation: "PRIVATE_FEEDBACK",
          },
        },
      ]),
    );
    await link();
    await service.logSession(chat.id);
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /What cancels/);
    assert.match(text, /Independent zero-mean errors/);
    assert.doesNotMatch(
      text,
      /PRIVATE_THINKING|PRIVATE_FEEDBACK|correctAnswer/,
    );
    chat.messages.push({
      id: "answer_1",
      role: "toolResult",
      toolCallId: "q_stable",
      toolName: "quiz",
      details: {
        kind: "quiz",
        questionText: "What cancels?",
        correct: true,
        answers: [
          {
            index: 1,
            label: "Independent zero-mean errors",
            value: "independent",
          },
        ],
        readingThinking: "They vary independently.",
      },
      content: [{ type: "text", text: "Answered" }],
      isError: false,
      timestamp: 3,
    } as never);
    await service.logSession(chat.id);
    const answered = fs.readFileSync(file, "utf8");
    assert.match(answered, /PRIVATE_FEEDBACK/);
    assert.match(answered, /They vary independently/);
    assert.equal((answered.match(/PRIVATE_FEEDBACK/g) || []).length, 1);
  }),
);
test(
  "practice model solution remains hidden at pose time and appears only on conclude",
  fixture(async ({ chat }) => {
    chat.kind = "practice";
    chat.messages = [
      assistant("pose", [
        {
          type: "toolCall",
          id: "problem_1",
          name: "problem",
          arguments: {
            statement: "Compute the mean",
            modelSolution: "PRIVATE_SOLUTION",
            targets: [],
          },
        },
      ]),
      {
        id: "posed",
        role: "toolResult",
        toolCallId: "problem_1",
        toolName: "problem",
        content: [],
        details: {},
        isError: false,
        timestamp: 3,
      } as never,
    ];
    assert.doesNotMatch(
      liveDocumentBlocks(chat)
        .map((b) => b.markdown)
        .join("\n"),
      /PRIVATE_SOLUTION/,
    );
    chat.messages.push(
      assistant("conclude", [
        {
          type: "toolCall",
          id: "conclude_1",
          name: "conclude",
          arguments: { outcome: "solved" },
        },
      ]),
      {
        id: "concluded",
        role: "toolResult",
        toolCallId: "conclude_1",
        toolName: "conclude",
        content: [],
        details: {},
        isError: false,
        timestamp: 4,
      } as never,
    );
    assert.match(
      liveDocumentBlocks(chat)
        .map((b) => b.markdown)
        .join("\n"),
      /PRIVATE_SOLUTION/,
    );
  }),
);

test(
  "interrupted provider writes preserve cached prose and recover without treating partial bytes as human edits",
  fixture(async ({ root, chat }) => {
    let bytes = "Human original note",
      fail = true,
      writes = 0;
    const service = new DocumentService({
      dataDir: path.join(root, "provider-data"),
      grantsFile: path.join(root, "unused"),
      readChat: () => chat,
      nativeAdapter: {
        read: async () => bytes,
        write: async (_h, text) => {
          writes++;
          if (fail) {
            bytes = "PARTIAL";
            throw Error("Invented provider disconnection");
          }
          bytes = text;
        },
      },
    });
    const d = await service.link({
      chatId: chat.id,
      name: "provider.md",
      handle: "provider_fixture",
      kind: "android",
      writable: true,
      mode: "app",
    });
    const read = await service.read(d.id);
    const p = await service.propose(
      d.id,
      chat.id,
      read.document.revision,
      "Human original",
      "Edited original",
      "Improve",
    );
    await assert.rejects(service.review(d.id, p.id, "apply"), /disconnection/);
    const after = await service.read(d.id);
    assert.equal(after.text, "Human original note");
    assert.match(after.document.error || "", /interrupted/);
    fail = false;
    await service.resolveFile(d.id, "synced");
    assert.equal(bytes, "Human original note");
    await service.review(d.id, p.id, "apply");
    assert.equal(bytes, "Edited original note");
    assert.equal(writes, 3);
  }),
);
test(
  "a lost save response commits the recovered revision once instead of reverting or appending again",
  fixture(async ({ root, chat }) => {
    let bytes = "Original paragraph",
      writes = 0;
    const service = new DocumentService({
      dataDir: path.join(root, "lost-response"),
      grantsFile: path.join(root, "unused"),
      readChat: () => chat,
      nativeAdapter: {
        read: async () => bytes,
        write: async (_h, text) => {
          bytes = text;
          writes++;
          throw Error("Invented lost response");
        },
      },
    });
    const d = await service.link({
      chatId: chat.id,
      name: "note.md",
      handle: "fixture_handle",
      kind: "android",
      writable: true,
      mode: "app",
    });
    const p = await service.propose(
      d.id,
      chat.id,
      d.revision,
      "Original paragraph",
      "Updated paragraph",
      "Improve",
    );
    await assert.rejects(service.review(d.id, p.id, "apply"));
    const recovered = await service.read(d.id);
    assert.equal(recovered.text, "Updated paragraph");
    assert.equal(recovered.document.proposals[0]?.status, "applied");
    assert.equal(writes, 1);
  }),
);
test(
  "binding a differing existing file never overwrites it before the user resolves the difference",
  fixture(async ({ service, file, root, chat, link }) => {
    const d = await link();
    const different = path.join(root, "different.md");
    fs.writeFileSync(different, "Other human note");
    const grants = path.join(root, "private/grants.json");
    const all = JSON.parse(fs.readFileSync(grants, "utf8"));
    all.handle_other = {
      path: different,
      name: "different.md",
      writable: true,
    };
    atomicWrite(grants, JSON.stringify(all));
    await service.link({
      documentId: d.id,
      chatId: chat.id,
      name: "different.md",
      handle: "handle_other",
      kind: "desktop",
      writable: true,
      mode: "app",
    });
    const r = await service.read(d.id);
    assert.ok(r.document.error);
    assert.equal(fs.readFileSync(different, "utf8"), "Other human note");
    await service.resolveFile(d.id, "local");
    assert.equal((await service.read(d.id)).text, "Other human note");
    assert.match(fs.readFileSync(file, "utf8"), /untouched introduction/);
  }),
);
test(
  "accepted human changes to a generated block remain frozen while later learning continues to append",
  fixture(async ({ service, file, chat, link }) => {
    const d = await link();
    await service.logSession(chat.id);
    let text = fs
      .readFileSync(file, "utf8")
      .replace(
        "Why do independent errors cancel?",
        "Human correction to this question.",
      );
    fs.writeFileSync(file, text);
    await service.logSession(chat.id);
    await service.resolveFile(d.id, "local");
    chat.messages.push({
      id: "u_later",
      role: "user",
      content: "A later thought",
      timestamp: 10,
    } as LhMessage);
    await service.logSession(chat.id);
    text = fs.readFileSync(file, "utf8");
    assert.match(text, /Human correction/);
    assert.match(text, /A later thought/);
    assert.doesNotMatch(text, /Why do independent errors cancel/);
  }),
);
