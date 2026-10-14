// The E2E test: install the built demo extension (dist-ext/) in a real
// Firefox, drive its popup, and write artifacts/e2e-<date>.json. It checks
// failure modes E1-E6 in docs/failure-modes.md.
// Usage: pnpm e2e [--headed] [--screenshots <dir>]. Env: FIREFOX (the Firefox
// binary), or FOXKIT_BROWSER=ichabod with ICHABOD_API_KEY (and ICHABOD_GECKO)
// to run on Ichabod, as CI does.
//
// WebDriver BiDi cannot take a screenshot of a moz-extension: page. With
// --screenshots, the test also serves the same popup over http with a stub
// browser object (e2e/stub.js) and takes the screenshots there.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { launch, serve, writeArtifact } from "create-foxkit/e2e";
import { flow, previewDir } from "./flow.mjs";

const shotsAt = process.argv.indexOf("--screenshots");
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : undefined;
const record = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: JSON.stringify(actual) === JSON.stringify(expected) });
let fox;
let site;
try {
  fox = await launch({ extension: "dist-ext", headless: !process.argv.includes("--headed") });
  record.firefox = await fox.browser.version();
  const popup = await fox.openExtensionPage("popup.html");
  await flow(popup, "Firefox", check);
  const grant = (domains) => popup.evaluate((d) => browser.runtime.sendMessage({ type: "host:grant", domains: d }), domains);
  check("E4: the real public suffix list refuses *.co.uk", "bad-domain", (await grant(["*.co.uk"])).error);
  check("E4: the real public suffix list takes *.example.co.uk", null, (await grant(["*.example.co.uk"])).error);
  const stored = await popup.evaluate(() => browser.storage.local.get(null));
  check("E5: storage.local holds the foxgate state and nothing else", ["foxgate"], Object.keys(stored));
  check("E5: the stored requests reached each status", ["rejected", "rejected", "used", "used"], stored.foxgate.requests.map((r) => r.status).toSorted());
  check("E5: no key in storage", false, /"key"|CryptoKey/i.test(JSON.stringify(stored)));
  if (shots) {
    // The same popup over http, with a stub browser object, for screenshots.
    mkdirSync(shots, { recursive: true });
    const dir = previewDir();
    site = await serve(dir);
    const page = await fox.open(`${site.url}/preview.html`);
    await flow(page, "Preview", check, (file) => page.screenshot({ path: join(shots, file) }));
    // On Ichabod a session slows with each open tab, so close it.
    await page.close();
    rmSync(dir, { recursive: true, force: true });
  }
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  await fox?.close();
  await site?.close();
}
record.passed = !record.error && record.checks.length >= 12 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
