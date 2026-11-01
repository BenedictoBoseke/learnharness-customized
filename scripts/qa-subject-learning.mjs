import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const root = fs.mkdtempSync(path.resolve("../../subject-agent-qa-"));
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.resolve("../../subject-agent-qa-latest.txt"), root);
const folder = path.join(root, "Chinese");
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(
  path.join(folder, "Source.md"),
  "---\ntags: [中文]\n---\n# Transport\nOriginal transport explanation.\n",
);
fs.writeFileSync(
  path.join(folder, "Checkpoint.md"),
  "# Checkpoint\nPractise transport next.\n",
);
fs.writeFileSync(path.join(folder, "Log.md"), "# Lesson log\n");
const stat = fs.statSync(folder),
  handle = "grant_" + "e".repeat(32);
fs.writeFileSync(
  path.join(root, "document-grants.json"),
  JSON.stringify({
    [handle]: {
      path: fs.realpathSync(folder),
      name: "Chinese",
      directory: true,
      writable: true,
      identity: `${stat.dev}:${stat.ino}`,
    },
  }),
);
let calls = 0,
  sourceId,
  checkpointId,
  lessonId,
  groupId;
const requests = [];
const model = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        data: [
          { id: "subject-fixture", context_window: 32768, max_tokens: 4096 },
        ],
      }),
    );
    return;
  }
  let raw = "";
  for await (const c of req) raw += c;
  const b = JSON.parse(raw);
  requests.push(b);
  calls++;
  const tool = (name, args) => ({
    role: "assistant",
    tool_calls: [
      {
        index: 0,
        id: "fixture_call_" + calls,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  let delta,
    finish = "tool_calls";
  try {
    if (calls === 1) {
      assert.match(JSON.stringify(b.messages), /Subject: Chinese/);
      assert.ok(b.tools.some((t) => t.function.name === "read_subject_note"));
      delta = tool("read_subject_note", { noteId: sourceId });
    } else if (calls === 2) {
      const result = JSON.parse(
        b.messages.find(
          (m) => m.role === "tool" && m.tool_call_id === "fixture_call_1",
        ).content,
      );
      assert.equal(result.noteId, sourceId);
      assert.match(result.text, /Original transport/);
      delta = tool("propose_subject_edit", {
        noteId: sourceId,
        baseRevision: result.revision,
        before: "Original transport explanation.",
        after: "Clearer transport explanation with 你怎么去医院？",
        reason: "Clarify the original note.",
      });
    } else if (calls === 3) {
      delta = {
        role: "assistant",
        content: "A focused source-note edit is ready for your review.",
      };
      finish = "stop";
    } else if (calls === 4)
      delta = tool("record_subject_lesson", {
        lessonId,
        summary:
          "Covered transport questions using 你怎么去医院？. Demonstrated progress: correct opening. Weak point: word order. Next review: two fresh examples.",
      });
    else if (calls === 5) {
      const result = JSON.parse(
        b.messages.find(
          (m) => m.role === "tool" && m.tool_call_id === "fixture_call_4",
        ).content,
      );
      groupId = result.groupId;
      assert.ok(groupId);
      delta = tool("read_subject_note", { noteId: checkpointId });
    } else if (calls === 6) {
      const result = JSON.parse(
        b.messages.find(
          (m) => m.role === "tool" && m.tool_call_id === "fixture_call_5",
        ).content,
      );
      delta = tool("propose_subject_edit", {
        noteId: checkpointId,
        baseRevision: result.revision,
        before: "Practise transport next.",
        after:
          "Next review: two fresh transport questions; reinforce word order.",
        reason: "Resume from this lesson checkpoint.",
        groupId,
      });
    } else {
      delta = {
        role: "assistant",
        content:
          "The lesson summary is logged. Checkpoint changes await your review.",
      };
      finish = "stop";
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [d, reason] of [
      [delta, null],
      [{}, finish],
    ])
      res.write(
        "data: " +
          JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "subject-fixture",
            choices: [{ index: 0, delta: d, finish_reason: reason }],
          }) +
          "\n\n",
      );
    res.end("data: [DONE]\n\n");
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
const listener = net.createServer();
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const base = "http://127.0.0.1:" + port,
  server = spawn(
    process.execPath,
    [path.resolve(".next/standalone/server.js")],
    {
      windowsHide: true,
      env: {
        ...process.env,
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        NODE_ENV: "production",
        LH_DATA_DIR: path.join(root, "data"),
        LH_LOCAL_STATE_DIR: path.join(root, "device-state"),
        LH_AUTH_FILE: path.join(root, "auth.json"),
      },
    },
  );
const log = fs.createWriteStream(path.join(root, "server.log"));
server.stdout.pipe(log);
server.stderr.pipe(log);
async function api(route, body, method = "POST", headers = {}) {
  const r = await fetch(base + route, {
    method: body ? method : "GET",
    headers: {
      origin: base,
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (route === "/api/chat") {
    const text = await r.text();
    if (!r.ok) throw Error(text);
    return text;
  }
  const b = await r.json();
  if (!r.ok) throw Error(b.error || JSON.stringify(b));
  return b;
}
try {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const current = await fetch(base + "/api/custom-provider");
  await api(
    "/api/custom-provider",
    {
      baseUrl: "http://127.0.0.1:" + model.address().port + "/v1",
      authMode: "keyless",
    },
    "POST",
    { "if-match": current.headers.get("etag") },
  );
  const slot = { model: { provider: "custom", id: "subject-fixture" } };
  await api(
    "/api/settings/models",
    { strong: slot, cheap: slot, vision: slot },
    "PUT",
  );
  await api("/api/settings/graph", { enabled: false }, "PUT");
  const p = await api("/api/subjects", {
      op: "preview",
      folder: { handle, name: "Chinese", kind: "desktop", writable: true },
    }),
    w = await api("/api/subjects", {
      op: "link",
      previewId: p.previewId,
      name: "Chinese",
      mode: "external",
      included: p.paths,
    });
  let detail;
  for (let i = 0; i < 200; i++) {
    detail = await api("/api/subjects?id=" + w.id);
    if (detail.subject.scan.phase !== "scanning") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  sourceId = detail.subject.notes.find((n) => n.path === "Source.md").id;
  checkpointId = detail.subject.notes.find(
    (n) => n.path === "Checkpoint.md",
  ).id;
  const logId = detail.subject.notes.find((n) => n.path === "Log.md").id;
  await api("/api/subjects", {
    op: "update",
    workspaceId: w.id,
    patch: {
      roles: { sources: [sourceId], checkpoint: checkpointId, log: logId },
      logging: true,
    },
  });
  const chat = await api("/api/subjects", {
    op: "new-session",
    workspaceId: w.id,
  });
  assert.equal(calls, 0, "Opening a subject session must not invoke inference");
  await api("/api/chat", {
    chatId: chat.chatId,
    input: {
      type: "text",
      text: "Improve the transport explanation in the source note.",
    },
  });
  for (let i = 0; i < 300; i++) {
    const c = await api("/api/chats/" + chat.chatId);
    if (calls >= 3 && !c.turnInFlight) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(calls, 3, "Initial mocked lesson turn completed");
  const doc = await api("/api/documents?id=" + sourceId);
  assert.equal(doc.document.proposals.length, 1);
  assert.match(
    fs.readFileSync(path.join(folder, "Source.md"), "utf8"),
    /Original transport/,
  );
  const proposal = doc.document.proposals[0];
  await api("/api/documents", {
    op: "review",
    documentId: sourceId,
    proposalId: proposal.id,
    action: "apply",
  });
  assert.match(
    fs.readFileSync(path.join(folder, "Source.md"), "utf8"),
    /Clearer transport/,
  );
  await api("/api/documents", {
    op: "review",
    documentId: sourceId,
    proposalId: proposal.id,
    action: "undo",
  });
  const completion = await api("/api/subjects", {
    op: "finish",
    workspaceId: w.id,
    chatId: chat.chatId,
    operationId: "agent_fixture_completion",
  });
  lessonId = completion.id;
  await api("/api/chat", {
    chatId: chat.chatId,
    input: { type: "text", text: completion.requestPrompt },
  });
  for (let i = 0; i < 300; i++) {
    const c = await api("/api/chats/" + chat.chatId);
    if (calls >= 7 && !c.turnInFlight) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(calls, 7, "Completion mocked lesson turn completed");
  detail = await api("/api/subjects?id=" + w.id);
  assert.match(
    fs.readFileSync(path.join(folder, "Log.md"), "utf8"),
    /Weak point: word order/,
  );
  assert.equal(
    (
      fs
        .readFileSync(path.join(folder, "Log.md"), "utf8")
        .match(/<!--lh:lesson:/g) || []
    ).length,
    1,
  );
  assert.ok(
    detail.groups.some((g) => g.id === groupId && g.items.length === 1),
  );
  assert.match(
    fs.readFileSync(path.join(folder, "Checkpoint.md"), "utf8"),
    /Practise transport next/,
  );
  await api("/api/subjects", {
    op: "review-group",
    workspaceId: w.id,
    groupId,
    action: "apply",
  });
  assert.match(
    fs.readFileSync(path.join(folder, "Checkpoint.md"), "utf8"),
    /two fresh transport questions/,
  );
  fs.writeFileSync(
    path.join(root, "result.json"),
    JSON.stringify(
      {
        passed: [
          "Actual keyless provider and teacher tools",
          "Bounded subject context and read identity/revision",
          "Proposal before original Apply and safe Undo",
          "Explicit finish through actual model tools",
          "One opt-in lesson log append",
          "Grouped reviewed checkpoint update",
        ],
        localMockCalls: calls,
        paidCalls: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS subject learning, original note review, explicit completion, log and grouped checkpoint; local mock calls " +
      calls,
  );
} finally {
  server.kill();
  model.closeAllConnections();
  await new Promise((r) => model.close(r));
}
