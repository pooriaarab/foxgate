// The E2E test on Ichabod, Mozilla's cloud browser, instead of a Firefox on
// the runner. It installs the built extension (dist-ext/) in an Ichabod
// Firefox and drives the popup flow on the preview page (e2e/flow.mjs), which
// a Cloudflare quick tunnel makes reachable from the cloud browser.
// Usage: pnpm e2e:ichabod. Env: ICHABOD_API_KEY, ICHABOD_WS_URL (wss://<host>),
// ICHABOD_GECKO (155, 156, 157 or latest; default latest), CLOUDFLARED.
//
// What it cannot check yet: Ichabod's Firefox runs without
// -remote-allow-system-access, so BiDi cannot script a moz-extension: page.
// E4 and E5 need the real popup, so they run only in e2e/run.mjs.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { serve, writeArtifact } from "create-foxkit/e2e";
import { flow, previewDir } from "./flow.mjs";

const key = process.env.ICHABOD_API_KEY;
const host = process.env.ICHABOD_WS_URL;
if (!key || !host) throw new Error("Set ICHABOD_API_KEY and ICHABOD_WS_URL.");
const gecko = process.env.ICHABOD_GECKO ?? "latest";
const redact = (text) => String(text).replaceAll(key, "***");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const started = performance.now();
const record = { startedAt: new Date().toISOString(), browser: "ichabod", gecko, ms: {}, checks: [] };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: JSON.stringify(actual) === JSON.stringify(expected) });
const timed = async (name, fn) => {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    record.ms[name] = Math.round(performance.now() - start);
  }
};

// A quick tunnel to 127.0.0.1:<port>. Resolves with its URL once cloudflared
// has registered a connection.
function tunnel(port) {
  const child = spawn(process.env.CLOUDFLARED ?? "cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const url = new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`cloudflared did not open a tunnel in 60 s:\n${output.slice(-1500)}`)), 60_000);
    const read = (chunk) => {
      output += chunk;
      const found = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(output)?.[0];
      if (found && output.includes("Registered tunnel connection")) {
        clearTimeout(timer);
        done(found);
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", fail);
    child.on("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`cloudflared exited with code ${code}:\n${output.slice(-1500)}`));
    });
  });
  return { url, close: () => child.kill("SIGTERM") };
}

// Ichabod has few sessions at once. When all are in use, the WebSocket opens
// and session.new never answers, so each try has a time limit.
async function connect() {
  const endpoint = `${host}/gecko/${gecko}`;
  const authorization = `Basic ${Buffer.from(`api:${key}`).toString("base64")}`;
  const errors = [];
  for (let attempt = 1; attempt <= 4; attempt++) {
    const ws = new WebSocket(endpoint, { headers: { authorization } });
    try {
      const browser = await Promise.race([
        (async () => {
          await new Promise((done, fail) => {
            ws.addEventListener("open", () => done());
            ws.addEventListener("error", () => fail(new Error("the WebSocket failed")));
          });
          const transport = { send: (message) => ws.send(message), close: () => ws.close() };
          ws.addEventListener("message", (event) => {
            const message = String(event.data);
            if (!record.sessionId && message.includes('"sessionId"')) record.sessionId = JSON.parse(message).result?.sessionId;
            transport.onmessage?.(message);
          });
          ws.addEventListener("close", () => transport.onclose?.());
          return puppeteer.connect({ transport, protocol: "webDriverBiDi", defaultViewport: null });
        })(),
        sleep(45_000).then(() => Promise.reject(new Error("no session in 45 s (all sessions in use?)"))),
      ]);
      record.connectAttempts = attempt;
      return { browser, close: () => browser.close().catch(() => {}).finally(() => ws.close()) };
    } catch (error) {
      ws.close();
      errors.push(`try ${attempt}: ${redact(error.message)}`);
      await sleep(15_000 * attempt);
    }
  }
  throw new Error(`Cannot start an Ichabod session:\n${errors.join("\n")}`);
}

let site;
let tun;
let ichabod;
const dir = previewDir();
try {
  site = await serve(dir);
  tun = tunnel(Number(new URL(site.url).port));
  // The tunnel and the session start at the same time; both take seconds.
  const [url, session] = await Promise.allSettled([timed("tunnel", () => tun.url), timed("connect", connect)]);
  if (session.status === "fulfilled") ichabod = session.value;
  for (const failed of [url, session]) if (failed.status === "rejected") throw failed.reason;
  record.firefox = await ichabod.browser.version();

  const zip = join(dir, "..", `foxgate-ichabod-${process.pid}.zip`);
  execFileSync("zip", ["-qr", zip, "."], { cwd: "dist-ext" });
  const installed = await timed("install", () =>
    ichabod.browser.connection.send("webExtension.install", { extensionData: { type: "base64", value: readFileSync(zip).toString("base64") } }),
  );
  rmSync(zip, { force: true });
  check("Ichabod installs the extension from base64", "foxgate@pooriaarab", installed.result.extension);

  const page = await ichabod.browser.newPage();
  // A new quick tunnel can answer 530 or 502 for a few seconds.
  await timed("firstLoad", async () => {
    for (let i = 0; ; i++) {
      const response = await page.goto(`${url.value}/preview.html`).catch((error) => ({ status: () => redact(error.message) }));
      if (response.status() === 200) return;
      if (i === 20) throw new Error(`The tunnel did not serve preview.html: ${response.status()}`);
      await sleep(3000);
    }
  });
  await timed("flow", () => flow(page, `Ichabod Firefox ${gecko}`, check));
} catch (error) {
  record.error = redact(error instanceof Error ? error.message : String(error));
} finally {
  // Never wait long on teardown: Ichabod frees the session on its own.
  await timed("close", () => Promise.race([ichabod?.close(), sleep(5000)]));
  tun?.close();
  await site?.close();
  rmSync(dir, { recursive: true, force: true });
}
record.ms.total = Math.round(performance.now() - started);
record.passed = !record.error && record.checks.length >= 8 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", `e2e-ichabod-${gecko}`, record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
console.log(`timings (ms): ${JSON.stringify(record.ms)} | ${record.firefox ?? "no browser"} | session ${record.sessionId ?? "none"}`);
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
// A WebSocket or a child process left open must not hold the job.
process.exit(record.passed ? 0 : 1);
