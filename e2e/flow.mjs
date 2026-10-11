// The popup flow e2e/run.mjs drives, on the real popup and on the preview
// page. It checks failure modes E1-E3, E6 and E7 in
// docs/failure-modes.md. check(name, expected, actual) records one result.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { poll } from "create-foxkit/e2e";

export const EXPECTED_TEXT = '{"args":{"fields":{"email":"sam@example.com","plan":"basic"},"form":"#checkout"},"domain":"checkout.example.com","scope":"submit","tool":"submit_form"}';

const click = (page, selector) => page.evaluate((s) => document.querySelector(s).click(), selector);
// Click a button, wait until the output counts one more answer, and return
// the answer. The count (data-runs) changes even when the same text repeats.
async function press(page, button, output) {
  const before = await page.evaluate((o) => Number(document.getElementById(o).dataset.runs ?? 0), output);
  await click(page, button);
  await poll(page, ([o, b]) => Number(document.getElementById(o).dataset.runs ?? 0) > b, [output, before]);
  return page.evaluate((o) => document.getElementById(o).textContent, output);
}
// Approve, then wait until the agent holds the token for that request.
async function approve(page, id) {
  await click(page, `#pending li[data-id="${id}"] .approve`);
  await poll(page, (i) => document.body.dataset.token === i, id);
}
const pendingIds = (page) => page.evaluate(() => [...document.querySelectorAll("#pending li")].map((li) => li.dataset.id));

// Ask, then wait for the request to show. Returns its ID.
async function ask(page) {
  const before = await pendingIds(page);
  await press(page, "#ask", "asked");
  return poll(page, (b) => [...document.querySelectorAll("#pending li")].map((li) => li.dataset.id).find((id) => !b.includes(id)), before);
}

export async function flow(page, name, check, shot = async () => {}) {
  await poll(page, () => document.body.dataset.ready === "1");
  let id = await ask(page);
  check(`${name} E1: the request shows the exact action`, EXPECTED_TEXT, await page.evaluate((i) => document.querySelector(`#pending li[data-id="${i}"] pre`).textContent, id));
  await shot("approval-waiting.png");
  await approve(page, id);
  check(`${name} E2: a changed action is refused`, "deny: action-changed", await press(page, "#tamper", "result"));
  await shot("changed-action-refused.png");
  check(`${name} E2: the token is used up after a changed try`, "deny: token-used", await press(page, "#redeem", "result"));
  id = await ask(page);
  check(`${name} E7: no token for a new request before the approval`, null, await page.evaluate(() => document.body.dataset.token ?? null));
  await approve(page, id);
  check(`${name} E3: the approved action runs`, "allow", await press(page, "#redeem", "result"));
  check(`${name} E3: the approved action runs only one time`, "deny: token-used", await press(page, "#redeem", "result"));
  id = await ask(page);
  await click(page, `#pending li[data-id="${id}"] .reject`);
  await poll(page, (i) => !document.querySelector(`#pending li[data-id="${i}"]`), id);
  check(`${name} E6: a rejected action is not asked again`, "deny: rejected", await press(page, "#ask", "asked"));
}

// A copy of dist-ext/ with preview.html: the same popup and background on a
// plain web page, with the stub browser object in e2e/stub.js. Returns the directory.
export function previewDir() {
  const dir = mkdtempSync(join(tmpdir(), "foxgate-preview-"));
  cpSync("dist-ext", dir, { recursive: true });
  cpSync("e2e/stub.js", join(dir, "stub.js"));
  const html = readFileSync(join(dir, "popup.html"), "utf8").replace('<script src="popup.js">', '<script src="stub.js"></script><script src="background.js"></script><script src="popup.js">');
  writeFileSync(join(dir, "preview.html"), html);
  return dir;
}
