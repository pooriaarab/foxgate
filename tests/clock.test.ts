// Failure modes K1-K3 in docs/failure-modes.md.
import { describe, expect, it } from "vitest";
import { createFoxgate, memoryStore, type Action } from "../src/index.js";

const tools = { fill: "fill", submit: "submit" } as const;
const fill: Action = { tool: "fill", args: {}, domain: "a.example.com", scope: "fill" };
const reason = (d: { decision: string; reason?: string }) => (d.decision === "deny" ? d.reason : d.decision);
const code = (p: Promise<unknown>) => p.then(() => "no error", (e: { code?: string }) => e.code ?? String(e));

describe("the clock", () => {
  it("K1: a clock that is not a finite number refuses every decision", async () => {
    for (const bad of [Number.NaN, Infinity, -Infinity, "5", undefined]) {
      let time: unknown = 1_000;
      const { gate, host } = createFoxgate({ tools, now: () => time as number });
      await host.addGrant({ scope: "fill", domains: ["a.example.com"], expiresAt: 2_000 });
      await host.addGrant({ scope: "submit", domains: ["a.example.com"] });
      const asked = await gate.check({ ...fill, tool: "submit", scope: "submit" });
      time = bad;
      expect(reason(await gate.check(fill)), String(bad)).toBe("clock-error");
      expect(reason(await gate.redeem("fgt1.x.y", fill)), String(bad)).toBe("clock-error");
      expect(await code(host.addGrant({ scope: "fill", domains: ["b.example.com"] })), String(bad)).toBe("bad-state");
      expect(await code(host.pending()), String(bad)).toBe("bad-state");
      if (asked.decision !== "ask") throw new Error("expected ask");
      expect(await code(host.approve(asked.requestId)), String(bad)).toBe("bad-state");
      expect(await code(host.reject(asked.requestId)), String(bad)).toBe("bad-state");
    }
  });

  it("K2: a stored time that is not finite is a storage error", async () => {
    const store = memoryStore();
    const { gate, host } = createFoxgate({ tools, store, now: () => 1_000 });
    await host.addGrant({ scope: "fill", domains: ["a.example.com"] });
    const state = (await store.get("foxgate")) as Record<string, unknown>;
    for (const time of [Number.NaN, Infinity, null]) {
      await store.set("foxgate", { ...state, time });
      expect(reason(await gate.check(fill)), String(time)).toBe("storage-error");
    }
  });

  it("K3: one bad clock call does not undo expiry", async () => {
    let time = 1_000;
    const { gate, host } = createFoxgate({ tools, now: () => time });
    await host.addGrant({ scope: "fill", domains: ["a.example.com"], expiresAt: 2_000 });
    time = 2_000;
    expect(reason(await gate.check(fill))).toBe("expired");
    time = Number.NaN;
    expect(reason(await gate.check(fill))).toBe("clock-error");
    time = 1_500;
    expect(reason(await gate.check(fill))).toBe("expired");
  });
});
