// Failure modes U1-U17 in docs/failure-modes.md.
import { describe, expect, it } from "vitest";
import { createFoxgate, memoryStore, type Action, type Decision, type DecisionEvent, type FoxgateOptions, type ToolSpec } from "../src/index.js";

const TOOLS: Record<string, ToolSpec> = {
  snapshot: "read",
  act: "fill",
  click: "submit",
  browser_task: "submit",
  pay: { scope: "pay", amount: (args) => ({ value: args.price as number, currency: "USD" }) },
};

// A small public suffix list: the registrable domain is the last two labels, and co.uk is a suffix.
const psl = {
  getDomain: (host: string) => {
    const labels = host.split(".");
    if (/^\d+(\.\d+){3}$/.test(host) || host === "co.uk") return null;
    if (host.endsWith(".co.uk")) return labels.length >= 3 ? labels.slice(-3).join(".") : null;
    return labels.length >= 2 ? labels.slice(-2).join(".") : null;
  },
};

function setup(options: Partial<FoxgateOptions> = {}) {
  let time = 1_000_000;
  const events: DecisionEvent[] = [];
  const ruleStore = options.ruleStore ?? memoryStore();
  const fox = createFoxgate({ tools: TOOLS, publicSuffix: psl, ruleStore, now: () => time, onDecision: (e) => void events.push(e), ...options });
  return { ...fox, ruleStore, events, setTime: (t: number) => (time = t) };
}

const click = (domain = "shop.example.com", controlId = "buy"): Action => ({ tool: "click", args: { controlId }, domain, scope: "submit" });
const read = (domain = "shop.example.com"): Action => ({ tool: "snapshot", args: {}, domain, scope: "read" });
const result = (d: Decision) => (d.decision === "deny" ? d.reason : d.decision);
const ruleOf = (d: Decision) => ("ruleId" in d ? d.ruleId : undefined);

describe("user rules", () => {
  it("U1: a rule matches its site and subdomains only", async () => {
    const { gate, host } = setup();
    await host.addGrant({ scope: "submit", domains: ["shop.example.com", "example.com", "evil-example.com", "example.com.evil.com", "b.com"], rules: true });
    const rule = await host.addRule({ site: "example.com", scope: "submit", effect: "allow" });
    expect(ruleOf(await gate.check(click()))).toBe(rule.id);
    expect(result(await gate.check(click("example.com")))).toBe("allow");
    for (const other of ["evil-example.com", "example.com.evil.com", "b.com"]) expect(result(await gate.check(click(other)))).toBe("ask");
  });

  it("U2: an allow rule never widens the grants", async () => {
    const { gate, host } = setup();
    await host.addRule({ site: "example.com", scope: "submit", effect: "allow" });
    expect(result(await gate.check(click()))).toBe("no-grant");
    await host.addGrant({ scope: "submit", domains: ["other.com"], rules: true });
    await host.addGrant({ scope: "submit", domains: ["shop.example.com"], tools: ["browser_task"], rules: true });
    expect(result(await gate.check(click()))).toBe("no-grant");
  });

  it("U3: refuses rules for pay and fill, with every effect", async () => {
    const { host } = setup();
    for (const scope of ["pay", "fill"] as const) {
      for (const effect of ["allow", "ask", "deny"] as const) {
        await expect(host.addRule({ site: "example.com", scope: scope as never, effect })).rejects.toMatchObject({ code: "bad-rule" });
      }
    }
  });

  it("U4: the site must be a registrable domain", async () => {
    const { gate, host } = setup();
    for (const site of ["mail.example.com", "co.uk", "10.0.0.1", "https://example.com", "example.com/x", "*.example.com", "", "localhost"]) {
      await expect(host.addRule({ site, scope: "submit", effect: "allow" })).rejects.toMatchObject({ code: "bad-rule" });
    }
    expect((await host.addRule({ site: "Shop.CO.UK", scope: "submit", effect: "allow" })).site).toBe("shop.co.uk");
    for (const [site, want] of [["Bank.COM.", "bank.com"], ["bücher.de", "xn--bcher-kva.de"], ["XN--BCHER-KVA.DE", "xn--bcher-kva.de"]] as const) expect((await host.addRule({ site, scope: "submit", effect: "allow" })).site).toBe(want);
    await host.addGrant({ scope: "submit", domains: ["shop.xn--bcher-kva.de"], rules: true });
    expect(result(await gate.check(click("SHOP.Bücher.de.")))).toBe("allow");
    const bare = createFoxgate({ tools: TOOLS });
    await expect(bare.host.addRule({ site: "example.com", scope: "submit", effect: "allow" })).rejects.toMatchObject({ code: "bad-rule" });
  });

  it("U5: an allow rule does not apply to a grant without rules: true", async () => {
    const { gate, host } = setup();
    await host.addGrant({ scope: "submit", domains: ["shop.example.com"] });
    await host.addRule({ site: "example.com", scope: "submit", effect: "allow" });
    expect(result(await gate.check(click()))).toBe("ask");
    await host.addGrant({ scope: "read", domains: ["shop.example.com"], approval: "always" });
    await host.addRule({ site: "example.com", scope: "read", effect: "allow" });
    expect(result(await gate.check(read()))).toBe("ask");
  });

  it("U6: an allow rule keeps the grant limits", async () => {
    const { gate, host, setTime } = setup();
    await host.addGrant({ scope: "submit", domains: ["shop.example.com"], maxUses: 1, expiresAt: 2_000_000, rules: true });
    await host.addRule({ site: "example.com", scope: "submit", effect: "allow" });
    expect(result(await gate.check(click()))).toBe("allow");
    expect(result(await gate.check(click()))).toBe("used-up");
    await host.addGrant({ scope: "submit", domains: ["a.example.com"], expiresAt: 1_500_000, rules: true });
    setTime(1_600_000);
    expect(result(await gate.check(click("a.example.com")))).toBe("expired");
  });

  it("U7: the strictest matching rule wins", async () => {
    const { gate, host } = setup();
    await host.addGrant({ scope: "submit", domains: ["shop.example.com"], rules: true });
    await host.addRule({ site: "example.com", scope: "submit", tool: "click", effect: "allow" });
    const ask = await host.addRule({ site: "example.com", scope: "submit", effect: "ask" });
    expect(ruleOf(await gate.check(click()))).toBe(ask.id);
    expect(result(await gate.check(click()))).toBe("ask");
    const no = await host.addRule({ site: "example.com", scope: "submit", tool: "click", effect: "deny" });
    const denied = await gate.check(click());
    expect(result(denied)).toBe("rule");
    expect(ruleOf(denied)).toBe(no.id);
  });

  it("U8: an expired rule does not apply and is not listed, also when the clock goes back", async () => {
    const { gate, host, setTime, ruleStore } = setup();
    await host.addGrant({ scope: "submit", domains: ["shop.example.com"], rules: true });
    await host.addRule({ site: "example.com", scope: "submit", effect: "allow", expiresAt: 1_500_000 });
    expect(result(await gate.check(click()))).toBe("allow");
    setTime(1_600_000);
    expect(result(await gate.check(click()))).toBe("ask");
    expect(await host.rules()).toEqual([]);
    setTime(1_400_000);
    expect(result(await gate.check(click()))).toBe("ask");
    const restarted = setup({ ruleStore, now: () => 1_400_000 });
    await restarted.host.addGrant({ scope: "submit", domains: ["shop.example.com"], rules: true });
    expect(result(await restarted.gate.check(click()))).toBe("ask");
    expect(await restarted.host.rules()).toEqual([]);
  });

  it("U9: a deny rule stops an approved request", async () => {
    const { gate, host } = setup();
    await host.addGrant({ scope: "submit", domains: ["shop.example.com"] });
    const asked = await gate.check(click());
    if (asked.decision !== "ask") throw new Error("expected ask");
    const token = await host.approve(asked.requestId);
    const rule = await host.addRule({ site: "example.com", scope: "submit", tool: "click", effect: "deny" });
    const redeemed = await gate.redeem(token, click());
    expect(result(redeemed)).toBe("rule");
    expect(ruleOf(redeemed)).toBe(rule.id);
  });

  it("U10: ask and deny rules apply to every grant", async () => {
    const { gate, host } = setup();
    await host.addGrant({ scope: "read", domains: ["shop.example.com", "bank.com"] });
    const ask = await host.addRule({ site: "example.com", scope: "read", effect: "ask" });
    const asked = await gate.check(read());
    expect(result(asked)).toBe("ask");
    expect(ruleOf(asked)).toBe(ask.id);
    if (asked.decision !== "ask") throw new Error("expected ask");
    expect(result(await gate.redeem(await host.approve(asked.requestId), read()))).toBe("allow");
    await host.addRule({ site: "bank.com", scope: "read", effect: "deny" });
    expect(result(await gate.check(read("bank.com")))).toBe("rule");
  });

  it("U11: rule decisions carry ruleId, in the decision and the event", async () => {
    const { gate, host, events } = setup();
    await host.addGrant({ scope: "submit", domains: ["shop.example.com"], rules: true });
    await host.addGrant({ scope: "read", domains: ["shop.example.com"] });
    const rule = await host.addRule({ site: "example.com", scope: "submit", tool: "click", effect: "allow" });
    const allowed = await gate.check(click());
    expect(ruleOf(allowed)).toBe(rule.id);
    expect(ruleOf(events.at(-1)!.decision)).toBe(rule.id);
    expect(ruleOf(await gate.check(read()))).toBeUndefined();
    await host.addRule({ site: "example.com", scope: "submit", tool: "browser_task", effect: "ask" });
    expect(ruleOf(await gate.check({ tool: "browser_task", args: { task: "x" }, domain: "shop.example.com", scope: "submit" }))).toBeUndefined();
  });

  it("U12: bad stored rules deny every check", async () => {
    const good = { id: "r1", createdAt: 1, site: "example.com", scope: "submit", effect: "allow" };
    for (const stored of [{}, [{ ...good, scope: "pay" }], [{ ...good, scope: "fill" }], [{ ...good, effect: "yes" }], [{ ...good, site: 5 }], ["x"], [{ ...good, extra: 1 }], [{ ...good, tool: "snapshot" }], [good, good], Array.from({ length: 501 }, (_, i) => ({ ...good, id: `r${i}` })), ...["com", "Bank.com", "bank.com.", "mail.example.com"].map((site) => [{ ...good, site }])]) {
      const ruleStore = memoryStore();
      await ruleStore.set("foxgate-rules", stored);
      const { gate, host } = setup({ ruleStore });
      await host.addGrant({ scope: "submit", domains: ["shop.example.com"], rules: true });
      expect(result(await gate.check(click()))).toBe("storage-error");
    }
  });

  it("U13: a failing rule store denies and throws", async () => {
    const broken = { get: async () => { throw new Error("disk"); }, set: async () => { throw new Error("disk"); } };
    const { gate, host } = setup({ ruleStore: broken });
    await host.addGrant({ scope: "read", domains: ["shop.example.com"] });
    expect(result(await gate.check(read()))).toBe("storage-error");
    await expect(host.addRule({ site: "example.com", scope: "submit", effect: "allow" })).rejects.toThrow();
    await expect(host.removeRule("x")).rejects.toThrow();
  });

  it("U14: refuses a bad rule input", async () => {
    const { host } = setup();
    const base = { site: "example.com", scope: "submit", effect: "allow" } as const;
    for (const bad of [{ ...base, extra: 1 }, { ...base, effect: "always" }, { ...base, expiresAt: 5 }, { ...base, tool: "snapshot" }, { ...base, tool: "nope" }, { ...base, scope: "write" }, null]) {
      await expect(host.addRule(bad as never)).rejects.toMatchObject({ code: "bad-rule" });
    }
    const { host: full, setTime } = setup();
    for (let i = 0; i < 500; i++) await full.addRule({ ...base, expiresAt: 2_000_000 });
    await expect(full.addRule(base)).rejects.toMatchObject({ code: "bad-rule" });
    setTime(2_000_000);
    expect(await full.addRule(base)).toMatchObject(base);
  });

  it("U15: a removed rule stops at once", async () => {
    const { gate, host } = setup();
    await host.addGrant({ scope: "submit", domains: ["shop.example.com"], rules: true });
    const rule = await host.addRule({ site: "example.com", scope: "submit", effect: "allow" });
    expect(result(await gate.check(click()))).toBe("allow");
    expect(await host.removeRule(rule.id)).toBe(true);
    expect(result(await gate.check(click()))).toBe("ask");
    expect(await host.removeRule(rule.id)).toBe(false);
  });

  it("U16: rules survive a restart on the same rule store", async () => {
    const ruleStore = memoryStore();
    const first = setup({ ruleStore });
    const rule = await first.host.addRule({ site: "example.com", scope: "submit", tool: "click", effect: "allow" });
    const second = setup({ ruleStore });
    expect(await second.host.rules()).toEqual([rule]);
    expect(await second.host.grants()).toEqual([]);
    await second.host.addGrant({ scope: "submit", domains: ["shop.example.com"], rules: true });
    expect(ruleOf(await second.gate.check(click()))).toBe(rule.id);
  });

  it("U17: the gate object has no rule methods", () => {
    const { gate } = setup();
    expect(Object.keys(gate).toSorted()).toEqual(["check", "redeem"]);
    expect(Object.isFrozen(gate)).toBe(true);
  });
});
