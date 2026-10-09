// Failure modes P1-P8 in docs/failure-modes.md.
import { describe, expect, it } from "vitest";
import { createFoxgate, type Action, type ToolSpec } from "../src/index.js";

const total: ToolSpec = { scope: "pay", amount: (args) => ({ value: args.total as number, currency: "USD" }) };
const TOOLS: Record<string, ToolSpec> = { read_page: "read", click_buy_now: total, buy: total };

const reason = (d: { decision: string; reason?: string }) => (d.decision === "deny" ? d.reason : d.decision);
const domain = "shop.example.com";

describe("the tool registry", () => {
  it("P1: refuses a lower scope than the registry", async () => {
    const { gate, host } = createFoxgate({ tools: TOOLS });
    await host.addGrant({ scope: "read", domains: [domain] });
    expect(reason(await gate.check({ tool: "click_buy_now", args: { total: 5 }, domain, scope: "read" }))).toBe("wrong-scope");
    expect(reason(await gate.check({ tool: "read_page", args: {}, domain, scope: "read" }))).toBe("allow");
  });

  it("P2: refuses a tool that the host did not register", async () => {
    const { gate, host } = createFoxgate({ tools: TOOLS });
    await host.addGrant({ scope: "read", domains: [domain] });
    expect(reason(await gate.check({ tool: "read_cookies", args: {}, domain, scope: "read" }))).toBe("unknown-tool");
  });

  it("P3: refuses a lower amount than the args, and caps the real amount", async () => {
    const { gate, host } = createFoxgate({ tools: TOOLS });
    await host.addGrant({ scope: "pay", domains: [domain], approval: "never", spendCap: { value: 100, currency: "USD" } });
    const lie: Action = { tool: "buy", args: { total: 99999 }, domain, scope: "pay", amount: { value: 1, currency: "USD" } };
    expect(reason(await gate.check(lie))).toBe("wrong-amount");
    expect(reason(await gate.check({ tool: "buy", args: { total: 99999 }, domain, scope: "pay" }))).toBe("spend-cap");
    expect(reason(await gate.check({ tool: "buy", args: { total: 60 }, domain, scope: "pay", amount: { value: 60, currency: "USD" } }))).toBe("allow");
    expect((await host.grants())[0]?.spent).toBe(60);
  });

  it("P4: puts the host amount into the action", async () => {
    const { gate, host } = createFoxgate({ tools: TOOLS });
    await host.addGrant({ scope: "pay", domains: [domain] });
    expect(reason(await gate.check({ tool: "buy", args: { total: 42 }, domain, scope: "pay" }))).toBe("ask");
    expect((await host.pending())[0]?.text).toBe('{"amount":{"currency":"USD","value":42},"args":{"total":42},"domain":"shop.example.com","scope":"pay","tool":"buy"}');
  });

  it("P5: refuses an amount for a tool that has no amount function", async () => {
    const { gate, host } = createFoxgate({ tools: TOOLS });
    await host.addGrant({ scope: "read", domains: [domain] });
    expect(reason(await gate.check({ tool: "read_page", args: {}, domain, scope: "read", amount: { value: 0, currency: "USD" } }))).toBe("wrong-amount");
  });

  it("P6: refuses a bad registry", () => {
    const bad: unknown[] = [undefined, {}, { a: "own" }, { a: "pay" }, { a: { scope: "pay" } }, { a: { scope: "fill", amount: 5 } }, []];
    for (const tools of bad) expect(() => createFoxgate({ tools } as never), JSON.stringify(tools)).toThrowError(expect.objectContaining({ code: "bad-tools" }));
  });

  it("P7: denies when the amount function fails", async () => {
    const { gate, host } = createFoxgate({ tools: TOOLS });
    await host.addGrant({ scope: "pay", domains: [domain], approval: "never" });
    for (const total of [12.5, -1, "5", undefined]) {
      expect(reason(await gate.check({ tool: "buy", args: { total }, domain, scope: "pay" })), String(total)).toBe("bad-action");
    }
    const throwing = createFoxgate({ tools: { buy: { scope: "pay", amount: () => { throw new Error("no price"); } } } });
    await throwing.host.addGrant({ scope: "pay", domains: [domain], approval: "never" });
    expect(reason(await throwing.gate.check({ tool: "buy", args: {}, domain, scope: "pay" }))).toBe("bad-action");
  });

  it("P8: names that every object has are not tools", async () => {
    const { gate, host } = createFoxgate({ tools: TOOLS });
    await host.addGrant({ scope: "read", domains: [domain] });
    for (const tool of ["toString", "__proto__", "constructor", "hasOwnProperty"]) {
      expect(reason(await gate.check({ tool, args: {}, domain, scope: "read" })), tool).toBe("unknown-tool");
    }
  });
});
