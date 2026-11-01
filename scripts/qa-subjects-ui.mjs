import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
const root = fs.mkdtempSync(path.resolve("../../subject-ui-qa-"));
fs.mkdirSync(root, { recursive: true });fs.writeFileSync(path.resolve("../../subject-ui-qa-latest.txt"),root);
const folder = path.join(root, "Chinese");
fs.mkdirSync(folder, { recursive: true });
for (const name of [
  "HSK 1.md",
  "HSK 1 - Checkpoint.md",
  "HSK 1 - Lesson Log.md",
])
  fs.writeFileSync(
    path.join(folder, name),
    "---\ntags: [中文]\n---\n# Transport\nPractise 你怎么去医院？\n",
  );
const grant = "grant_" + "b".repeat(32),
  stat = fs.statSync(folder);
fs.writeFileSync(
  path.join(root, "document-grants.json"),
  JSON.stringify({
    [grant]: {
      path: fs.realpathSync(folder),
      name: "Chinese",
      directory: true,
      writable: true,
      identity: `${stat.dev}:${stat.ino}`,
    },
  }),
);
const listener = net.createServer();
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const base = "http://127.0.0.1:" + port;
const server = spawn(
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
let browser;
const issues = [],
  passed = [];
let modelCalls = 0;
const mock = http.createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          {
            id: "a-very-long-chinese-learning-model-name",
            context_window: 32768,
            max_tokens: 4096,
          },
        ],
      }),
    );
    return;
  }
  modelCalls++;
  res.writeHead(500).end("Unexpected inference in layout audit");
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const api = async (route, body, method = "POST", headers = {}) => {
  const r = await fetch(base + route, {
    method: body ? method : "GET",
    headers: {
      origin: base,
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const b = await r.json();
  if (!r.ok) throw Error(b.error || JSON.stringify(b));
  return b;
};
try {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const config = await fetch(base + "/api/custom-provider");
  await api(
    "/api/custom-provider",
    {
      baseUrl: "http://127.0.0.1:" + mock.address().port + "/v1",
      authMode: "keyless",
    },
    "POST",
    { "if-match": config.headers.get("etag") },
  );
  const slot = {
    model: {
      provider: "custom",
      id: "a-very-long-chinese-learning-model-name",
    },
  };
  await api(
    "/api/settings/models",
    { strong: slot, cheap: slot, vision: slot },
    "PUT",
  );
  browser = await puppeteer.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
    args: ["--no-first-run", "--disable-background-networking"],
  });
  const p = await browser.newPage();
  p.setDefaultTimeout(30000);
  p.setDefaultNavigationTimeout(60000);
  await p.setViewport({
    width: 411,
    height: 801,
    isMobile: true,
    deviceScaleFactor: 1,
  });
  p.on("pageerror", (e) => issues.push(e.message));
  await p.evaluateOnNewDocument(
    (selection) => {
      window.lh = {
        platform: "android",
        expandWindow() {},
        documents: { pick: async () => selection },
      };
    },
    { handle: grant, name: "Chinese", kind: "desktop", writable: true },
  );
  await p.goto(base, { waitUntil: "domcontentloaded" });
  await p.waitForSelector("[data-testid=stats-model]");
  await new Promise((r) => setTimeout(r, 1500));
  const mobileStyle = await p.addStyleTag({
    content: fs.readFileSync("mobile/mobile.css", "utf8"),
  });
  if (
    await p.$eval(
      "aside.sidebar-motion",
      (e) => e.getBoundingClientRect().width > 0,
    )
  )
    await p.click('[aria-label="Close sidebar"]');
  await new Promise((r) => setTimeout(r, 400));
  for (const width of [320, 360, 393, 411]) {
    await p.setViewport({
      width,
      height: 801,
      isMobile: true,
      deviceScaleFactor: 1,
    });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(
      await p.evaluate(() => innerWidth),
      width,
      "Actual viewport must not expand",
    );
    const dictate = await p.$eval("[data-testid=dictation-toggle]", (e) => {
      const r = e.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    assert.ok(
      dictate.w >= 48 && dictate.h >= 48,
      "Dictate target must not collapse",
    );
    console.log(
      "Viewport",
      width,
      await p.$eval("[data-testid=stats-model]", (e) => {
        const r = e.getBoundingClientRect();
        return {
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
          hit: document
            .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
            ?.outerHTML.slice(0, 180),
        };
      }),
    );
    await p.screenshot({
      path: path.join(root, "before-menu-" + width + ".png"),
    });
    await p.click("[data-testid=stats-model]");
    await new Promise((r) => setTimeout(r, 250));
    console.log(
      "Menu state",
      await p.$eval("[data-testid=stats-model]", (e) =>
        e.getAttribute("aria-expanded"),
      ),
    );
    await p.screenshot({
      path: path.join(root, "after-menu-" + width + ".png"),
    });
    await p.waitForSelector("[data-testid=model-menu]", { visible: true });
    await new Promise((r) => setTimeout(r, 200));
    const bounds = await p.$eval("[data-testid=model-menu]", (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, right: r.right };
    });
    assert.ok(
      bounds.x >= 7 && bounds.right <= width - 7,
      JSON.stringify({ width, bounds }),
    );
    await p.evaluate(() => window.lhDismissTop());
    assert.equal(await p.$("[data-testid=model-menu]"), null);
    passed.push(width + "px toolbar/menu bounds");
  }
  if (
    await p.$eval(
      "aside.sidebar-motion",
      (e) => e.getBoundingClientRect().width === 0,
    )
  )
    await p.click('[aria-label="Open sidebar"]');
  await new Promise((r) => setTimeout(r, 350));
  await p.click("[data-testid=subjects-open]");
  await p.waitForSelector("[data-testid=subjects-dialog]");
  await p.$$eval("[data-testid=subjects-dialog] button", (els) =>
    els.find((e) => e.textContent.trim() === "Link subject folder").click(),
  );
  await p.waitForFunction(() =>
    document
      .querySelector("[data-testid=subjects-dialog]")
      ?.textContent.includes("3 of 3 Markdown notes"),
  );
  await (
    await p.$$("[data-testid=subjects-dialog] select")
  )[1].select("external");
  await p.$$eval("[data-testid=subjects-dialog] button", (els) =>
    els
      .find((e) => e.textContent.trim() === "Link and index selected notes")
      .click(),
  );
  await p.waitForFunction(() =>
    document
      .querySelector("[data-testid=subjects-dialog]")
      ?.textContent.includes("3 notes indexed"),
  );
  passed.push(
    "Actual subject picker preview, explicit mode choice and background indexing",
  );
  await p.screenshot({ path: path.join(root, "subject-folder.png") });
  const subject = (await api("/api/subjects")).subjects.find(
    (s) => s.name === "Chinese",
  );
  assert.ok(subject);
  assert.equal(subject.logging, false);
  assert.equal(subject.notes.length, 3);
  for (const n of subject.notes) {
    const d = await api("/api/documents?id=" + n.id);
    assert.equal(d.document.logging, false);
  }
  passed.push("Folder selection does not enable any note logger");
  await mobileStyle.dispose();
  await p.evaluate(()=>[...document.querySelectorAll('style')].find(s=>s.textContent.includes('Android touch surfaces'))?.remove());
  await p.setViewport({width:1280,height:900,isMobile:false,deviceScaleFactor:1});
  await p.waitForSelector('[data-testid=stats-model]');
  if(!await p.$('[data-testid=subjects-dialog]')) {
    if(await p.$eval('aside.sidebar-motion',e=>e.getBoundingClientRect().width===0))await p.click('[aria-label="Open sidebar"]');
    await new Promise(r=>setTimeout(r,350));await p.click('[data-testid=subjects-open]');await p.waitForSelector('[data-testid=subjects-dialog]');
  }
  await new Promise(r=>setTimeout(r,400));
  const desktop=await p.$eval('[data-testid=subjects-dialog]',e=>{const r=e.getBoundingClientRect();return {w:r.width,x:r.x,right:r.right,scroll:e.scrollWidth,client:e.clientWidth};});
  assert.ok(desktop.w<=1000&&desktop.x>=0&&desktop.right<=1280&&desktop.scroll<=desktop.client+1,JSON.stringify(desktop));
  await p.screenshot({path:path.join(root,'desktop-subject.png')});
  passed.push('1280px desktop subject layout without Android styles');
  assert.equal(modelCalls, 0);
  assert.deepEqual(issues, []);
  fs.writeFileSync(
    path.join(root, "result.json"),
    JSON.stringify({ passed, issues, modelCalls }, null, 2),
  );
  console.log(JSON.stringify({ passed, issues, modelCalls }, null, 2));
} finally {
  await browser?.close();
  server.kill();
  await new Promise((r) => mock.close(r));
}
