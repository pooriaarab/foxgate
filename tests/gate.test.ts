// Failure modes G1-G16 and S1-S6 in docs/failure-modes.md.
import { describe, expect, it } from "vitest";
import { FoxgateError, createFoxgate, memoryStore, type Action, type DecisionEvent, type FoxgateOptions, type Store, type ToolSpec } from "../src/index.js";

// The host registers each tool with its scope. A pay tool reads its amount from the args.
const TOOLS: Record<string, ToolSpec> = {
  fill: "fill",
  click: "fill",
  submit: "submit",
  pay: { scope: "pay", amount: (args) => ({ value: args.price as number, currency: args.currency as string }) },
};

const psl = { getDomain: (host: string) => (host.split(".").length >= 2 && host !== "co.uk" ? host : null) };

function setup(options: Partial<FoxgateOptions> = {}) {
  let time = 1_000_000;
  const events: DecisionEvent[] = [];
  const store = options.store ?? memoryStore();
  const fox = createFoxgate({ tools: TOOLS, store, publicSuffix: psl, now: () => time, onDecision: (e) => void events.push(e), ...options });
  return { ...fox, store, events, setTime: (t: number) => (time = t) };
}

const fill: Action = { tool: "fill", args: { field: "email", value: "a@b.c" }, domain: "shop.example.com", scope: "fill" };
const pay = (value: number, currency = "USD"): Action => ({ tool: "pay", args: { order: 1, price: value, currency }, domain: "shop.example.com", scope: "pay" });
const reason = (d: { decision: string; reason?: string }) => (d.decision === "deny" ? d.reason : d.decision);

describe("grants and the policy check", () => {
  it("G1: denies by default", async () => {
    const { gate } = setup();
    expect(reason(await gate.check(fill))).toBe("no-grant");
  });

  it("G2, G3: scope, domain, and tool must all match", async () => {
    const { gate, host } = setup();
    await host.addGrant({ scope: "fill", domains: ["*.example.com"], tools: ["fill"] });
    expect(reason(await gate.check(fill))).toBe("allow");
    expect(reason(await gate.check({ ...fill, scope: "submit" }))).toBe("wrong-scope");
    expect(reason(await gate.check({ ...fill, domain: "evil-example.com" }))).toBe("no-grant");
    expect(reason(await gate.check({ ...fill, tool: "click" }))).toBe("no-grant");
  });

  it("G4: refuses a grant or an approval inside the action", async () => {
    const { gate, host } = setup();
    await host.addGrant({ scope: "fill", domains: ["shop.example.com"] });
    for (const extra of [{ grant: { scope: "pay" } }, { grantId: "x" }, { approved: true }]) {
      expect(reason(await gate.check({ ...fill, ...extra } as Action))).toBe("bad-action");
    }
  });

  it("G5: the gate object cannot add grants or approve", () => {
    const { gate } = setup();
    expect(Object.keys(gate).toSorted()).toEqual(["check", "redeem"]);
    expect(Object.isFrozen(gate)).toBe(true);
  });

  it("G6: a bad action shape is denied, never thrown", async () => {
    const { gate, host } = setup();
    await host.addGrant({ scope: "pay", domains: ["shop.example.com"] });
    const bad: unknown[] = [null, "x", {}, { ...fill, tool: "" }, { ...fill, args: [] }, { ...fill, args: { f: () => 1 } }, { ...fill, domain: "https://x.com" }, { ...fill, scope: "admin" }];
    for (const action of bad) expect(reason(await gate.check(action as Action))).toBe("bad-action");
  });

  it("G7, G8: an expired grant stays expired when the clock goes back", async () => {
    const { gate, host, setTime } = setup();
    await host.addGrant({ scope: "fill", domains: ["shop.example.com"], expiresAt: 2_000_000 });
    expect(reason(await gate.check(fill))).toBe("allow");
    setTime(2_000_000);
    expect(reason(await gate.check(fill))).toBe("expired");
    setTime(1_500_000);
    expect(reason(await gate.check(fill))).toBe("expired");
  });

  it("G9: only allow uses a grant", async () => {
    const { gate, host } = setup();
    await host.addGrant({ scope: "fill", domains: ["shop.example.com"], maxUses: 2 });
    expect(reason(await gate.check({ ...fill, domain: "other.com" }))).toBe("no-grant");
    expect(reason(await gate.check(fill))).toBe("allow");
    expect(reason(await gate.check(fill))).toBe("allow");
    expect(reason(await gate.check(fill))).toBe("used-up");
  });

  it("G10: a grant that needs approval asks, and the same action gives the same request", async () => {
    const { gate, host } = setup();
    const grant = await host.addGrant({ scope: "submit", domains: ["shop.example.com"], maxUses: 1 });
    const submit: Action = { tool: "submit", args: { form: "#checkout" }, domain: "shop.example.com", scope: "submit" };
    const first = await gate.check(submit);
    const second = await gate.check({ ...submit, args: { form: "#checkout" } });
    expect(first.decision).toBe("ask");
    expect(second).toEqual(first);
    const pending = await host.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.text).toBe('{"args":{"form":"#checkout"},"domain":"shop.example.com","scope":"submit","tool":"submit"}');
    expect((await host.grants()).find((g) => g.id === grant.id)?.uses).toBe(0);
  });

  it("G11: stops at 20 waiting requests", async () => {
    const { gate, host } = setup();
    await host.addGrant({ scope: "submit", domains: ["shop.example.com"] });
    const ask = (n: number) => gate.check({ tool: "submit", args: { n }, domain: "shop.example.com", scope: "submit" });
    for (let n = 0; n < 20; n += 1) expect(reason(await ask(n))).toBe("ask");
    expect(reason(await ask(20))).toBe("too-many-requests");
  });

  it("G12: refuses a bad grant from the host", async () => {
    const { host } = setup();
    const bad: unknown[] = [{ scope: "fill", domains: [] }, { scope: "fill", domains: ["*.co.uk"] }, { scope: "fill", domains: ["a.com"], expiresAt: 5 }, { scope: "fill", domains: ["a.com"], maxUses: 0 }, { scope: "fill", domains: ["a.com"], extra: 1 }, { scope: "own", domains: ["a.com"] }];
    for (const grant of bad) await expect(host.addGrant(grant as never)).rejects.toBeInstanceOf(FoxgateError);
  });

  it("G13: lost, broken, or failing storage never allows", async () => {
    const lost = setup();
    await lost.host.addGrant({ scope: "fill", domains: ["shop.example.com"] });
    await lost.store.set("foxgate", undefined);
    expect(reason(await lost.gate.check(fill))).toBe("no-grant");
    await lost.store.set("foxgate", { grants: "nope" });
    expect(reason(await lost.gate.check(fill))).toBe("storage-error");
    const failing: Store = { get: () => Promise.reject(new Error("disk")), set: () => Promise.reject(new Error("disk")) };
    expect(reason(await setup({ store: failing }).gate.check(fill))).toBe("storage-error");
  });

  it("G14: a failing hook denies and counts nothing", async () => {
    let fail = true;
    const { gate, host, events } = setup({ onDecision: () => { if (fail) throw new Error("log full"); } });
    const grant = await host.addGrant({ scope: "fill", domains: ["shop.example.com"], maxUses: 1 });
    expect(reason(await gate.check(fill))).toBe("hook-failed");
    fail = false;
    expect(reason(await gate.check(fill))).toBe("allow");
    expect((await host.grants())[0]?.id).toBe(grant.id);
    expect(events).toHaveLength(0);
    const counted = setup();
    await counted.gate.check(fill);
    expect(counted.events).toHaveLength(1);
    expect(counted.events[0]).toMatchObject({ kind: "check", action: { domain: "shop.example.com" }, decision: { decision: "deny", reason: "no-grant" } });
  });

  it("G15: a revoked grant is gone", async () => {
    const { gate, host } = setup();
    const grant = await host.addGrant({ scope: "fill", domains: ["shop.example.com"] });
    expect(await host.revokeGrant(grant.id)).toBe(true);
    expect(reason(await gate.check(fill))).toBe("no-grant");
  });

  it("G16: falls through to the next matching grant", async () => {
    const { gate, host } = setup();
    await host.addGrant({ scope: "fill", domains: ["shop.example.com"], maxUses: 1 });
    const second = await host.addGrant({ scope: "fill", domains: ["*.example.com"] });
    await gate.check(fill);
    expect(await gate.check(fill)).toMatchObject({ decision: "allow", grantId: second.id });
  });
});

describe("spend caps", () => {
  it("S1: denies, never asks, over the cap", async () => {
    const { gate, host } = setup();
    await host.addGrant({ scope: "pay", domains: ["shop.example.com"], spendCap: { value: 1000, currency: "USD" }, approval: "never" });
    expect(reason(await gate.check(pay(600)))).toBe("allow");
    expect(reason(await gate.check(pay(401)))).toBe("spend-cap");
    expect(reason(await gate.check(pay(400)))).toBe("allow");
    expect(reason(await gate.check(pay(1)))).toBe("spend-cap");
    const asking = setup();
    await asking.host.addGrant({ scope: "pay", domains: ["shop.example.com"], spendCap: { value: 1000, currency: "USD" } });
    expect(reason(await asking.gate.check(pay(1001)))).toBe("spend-cap");
    expect(reason(await asking.gate.check(pay(1000)))).toBe("ask");
  });

  it("S2: refuses another currency", async () => {
    const { gate, host } = setup();
    await host.addGrant({ scope: "pay", domains: ["shop.example.com"], spendCap: { value: 1000, currency: "USD" }, approval: "never" });
    expect(reason(await gate.check(pay(1, "EUR")))).toBe("currency");
  });

  it("S3: two actions at the same time cannot pass the cap together", async () => {
    const { gate, host } = setup();
    await host.addGrant({ scope: "pay", domains: ["shop.example.com"], spendCap: { value: 1000, currency: "USD" }, approval: "never" });
    const results = await Promise.all([gate.check(pay(600)), gate.check(pay(600)), gate.check(pay(600))]);
    expect(results.map(reason).toSorted()).toEqual(["allow", "spend-cap", "spend-cap"]);
  });

  it("S4: refuses an amount that is not whole minor units", async () => {
    const { gate, host } = setup();
    await host.addGrant({ scope: "pay", domains: ["shop.example.com"], approval: "never" });
    for (const value of [12.5, -1, 2 ** 53, Number.NaN]) expect(reason(await gate.check(pay(value)))).toBe("bad-action");
    expect(reason(await gate.check(pay(1, "usd")))).toBe("bad-action");
  });

  it("S6: refuses a bad spend cap", async () => {
    const { host } = setup();
    await expect(host.addGrant({ scope: "pay", domains: ["a.com"], spendCap: { value: 1.5, currency: "USD" } })).rejects.toBeInstanceOf(FoxgateError);
  });

  it("S5: a new gate on the same storage sees what was spent", async () => {
    const first = setup();
    await first.host.addGrant({ scope: "pay", domains: ["shop.example.com"], spendCap: { value: 1000, currency: "USD" }, approval: "never" });
    await first.gate.check(pay(700));
    const second = setup({ store: first.store });
    expect(reason(await second.gate.check(pay(400)))).toBe("spend-cap");
    expect((await second.host.grants())[0]?.spent).toBe(700);
  });
});
