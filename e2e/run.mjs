// The E2E test: install the built demo extension (dist-ext/) in a real
// Firefox, drive its popup, and write artifacts/e2e-<date>.json. It checks
// failure modes E1-E6 in docs/failure-modes.md.
// Usage: pnpm e2e [--headed] [--screenshots <dir>]. Env: FIREFOX (the Firefox binary).
//
// WebDriver BiDi cannot take a screenshot of a moz-extension: page. With
// --screenshots, the test also serves the same popup over http with a stub
// browser object (e2e/stub.js) and takes the screenshots there.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, poll, serve, writeArtifact } from "create-foxkit/e2e";

const shotsAt = process.argv.indexOf("--screenshots");
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : undefined;
const record = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: JSON.stringify(actual) === JSON.stringify(expected) });
const EXPECTED_TEXT = '{"args":{"fields":{"email":"sam@example.com","plan":"basic"},"form":"#checkout"},"domain":"checkout.example.com","scope":"submit","tool":"submit_form"}';

const click = (page, selector) => page.evaluate((s) => document.querySelector(s).click(), selector);
// Wait until an output shows a new text, and return it.
const changed = (page, id, previous) => poll(page, ([i, p]) => { const t = document.getElementById(i).textContent; return t && t !== p ? t : null; }, [id, previous]);
const result = (page, previous) => changed(page, "result", previous);
// Approve, then wait until the agent holds the token for that request.
async function approve(page, id) {
  await click(page, `#pending li[data-id="${id}"] .approve`);
  await poll(page, (i) => document.body.dataset.token === i, id);
}
const pendingIds = (page) => page.evaluate(() => [...document.querySelectorAll("#pending li")].map((li) => li.dataset.id));

// Ask, then wait for the request to show. Returns its ID.
async function ask(page) {
  const before = await pendingIds(page);
  await click(page, "#ask");
  return poll(page, (b) => [...document.querySelectorAll("#pending li")].map((li) => li.dataset.id).find((id) => !b.includes(id)), before);
}

async function flow(page, name) {
  const shot = async (file) => shots && (await page.screenshot({ path: join(shots, file) }));
  await poll(page, () => document.body.dataset.ready === "1");
  let id = await ask(page);
  check(`${name} E1: the request shows the exact action`, EXPECTED_TEXT, await page.evaluate((i) => document.querySelector(`#pending li[data-id="${i}"] pre`).textContent, id));
  await shot("approval-waiting.png");
  await approve(page, id);
  await click(page, "#tamper");
  let last = await result(page, "");
  check(`${name} E2: a changed action is refused`, "deny: action-changed", last);
  await shot("changed-action-refused.png");
  await click(page, "#redeem");
  check(`${name} E2: the token is used up after a changed try`, "deny: token-used", (last = await result(page, last)));
  id = await ask(page);
  await approve(page, id);
  await click(page, "#redeem");
  check(`${name} E3: the approved action runs`, "allow", (last = await result(page, last)));
  await click(page, "#redeem");
  check(`${name} E3: the approved action runs only one time`, "deny: token-used", (last = await result(page, last)));
  id = await ask(page);
  await click(page, `#pending li[data-id="${id}"] .reject`);
  await poll(page, (i) => !document.querySelector(`#pending li[data-id="${i}"]`), id);
  const asked = await page.evaluate(() => document.getElementById("asked").textContent);
  await click(page, "#ask");
  check(`${name} E6: a rejected action is not asked again`, "deny: rejected", await changed(page, "asked", asked));
}

let fox;
let site;
try {
  fox = await launch({ extension: "dist-ext", headless: !process.argv.includes("--headed") });
  record.firefox = await fox.browser.version();
  const popup = await fox.openExtensionPage("popup.html");
  await flow(popup, "Firefox");
  const grant = (domains) => popup.evaluate((d) => browser.runtime.sendMessage({ type: "host:grant", domains: d }), domains);
  check("E4: the real public suffix list refuses *.co.uk", "bad-domain", (await grant(["*.co.uk"])).error);
  check("E4: the real public suffix list takes *.example.co.uk", null, (await grant(["*.example.co.uk"])).error);
  const stored = await popup.evaluate(() => browser.storage.local.get(null));
  check("E5: storage.local holds the foxgate state and nothing else", ["foxgate"], Object.keys(stored));
  check("E5: the stored requests reached each status", ["rejected", "used", "used"], stored.foxgate.requests.map((r) => r.status).toSorted());
  check("E5: no key in storage", false, /key/i.test(JSON.stringify(Object.keys(stored.foxgate))));
  if (shots) {
    // The same popup over http, with a stub browser object, for screenshots.
    mkdirSync(shots, { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "foxgate-preview-"));
    cpSync("dist-ext", dir, { recursive: true });
    cpSync("e2e/stub.js", join(dir, "stub.js"));
    const html = readFileSync(join(dir, "popup.html"), "utf8").replace('<script src="popup.js">', '<script src="stub.js"></script><script src="background.js"></script><script src="popup.js">');
    writeFileSync(join(dir, "preview.html"), html);
    site = await serve(dir);
    await flow(await fox.open(`${site.url}/preview.html`), "Preview");
    rmSync(dir, { recursive: true, force: true });
  }
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  await fox?.close();
  await site?.close();
}
record.passed = !record.error && record.checks.length >= 11 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
