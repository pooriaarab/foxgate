// Failure modes G1-G16 in docs/failure-modes.md.
import { describe, expect, it } from "vitest";
import { FoxgateError, createFoxgate, memoryStore, type Action, type DecisionEvent, type FoxgateOptions, type Store } from "../src/index.js";

const psl = { getDomain: (host: string) => (host.split(".").length >= 2 && host !== "co.uk" ? host : null) };

function setup(options: Partial<FoxgateOptions> = {}) {
  let time = 1_000_000;
  const events: DecisionEvent[] = [];
  const store = options.store ?? memoryStore();
  const fox = createFoxgate({ store, publicSuffix: psl, now: () => time, onDecision: (e) => void events.push(e), ...options });
  return { ...fox, store, events, setTime: (t: number) => (time = t) };
}

const fill: Action = { tool: "fill", args: { field: "email", value: "a@b.c" }, domain: "shop.example.com", scope: "fill" };
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
    expect(reason(await gate.check({ ...fill, scope: "submit" }))).toBe("no-grant");
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
    const bad: unknown[] = [null, "x", {}, { ...fill, tool: "" }, { ...fill, args: [] }, { ...fill, args: { f: () => 1 } }, { ...fill, domain: "https://x.com" }, { ...fill, scope: "admin" }, { ...fill, scope: "pay" }];
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
    expect(await gate.check(fill)).toEqual({ decision: "allow", grantId: second.id });
  });
});
