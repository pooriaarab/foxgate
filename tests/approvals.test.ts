// Failure modes A1-A14 and T1 in docs/failure-modes.md.
import { describe, expect, it } from "vitest";
import { FoxgateError, createFoxgate, memoryStore, storageAreaStore, type Action, type FoxgateOptions } from "../src/index.js";

async function setup(options: Partial<FoxgateOptions> = {}) {
  let time = 1_000_000;
  const store = options.store ?? memoryStore();
  const fox = createFoxgate({ store, now: () => time, ...options });
  await fox.host.addGrant({ scope: "pay", domains: ["shop.example.com"], spendCap: { value: 1000, currency: "USD" }, maxUses: 5 });
  return { ...fox, store, setTime: (t: number) => (time = t) };
}

const action: Action = { tool: "pay", args: { order: "A-1", items: [1, 2] }, domain: "shop.example.com", scope: "pay", amount: { value: 600, currency: "USD" } };
const reason = (d: { decision: string; reason?: string }) => (d.decision === "deny" ? d.reason : d.decision);

async function approved(fox: Awaited<ReturnType<typeof setup>>, a: Action = action) {
  const asked = await fox.gate.check(a);
  if (asked.decision !== "ask") throw new Error(`expected ask, got ${JSON.stringify(asked)}`);
  return fox.host.approve(asked.requestId);
}

const code = (p: Promise<unknown>) => p.then(() => "no error", (e: unknown) => (e instanceof FoxgateError ? e.code : String(e)));
const b64 = (text: string) => Buffer.from(text).toString("base64url");

describe("exact-action approvals", () => {
  it("A1: a token works one time", async () => {
    const fox = await setup();
    const token = await approved(fox);
    expect(reason(await fox.gate.redeem(token, action))).toBe("allow");
    expect(reason(await fox.gate.redeem(token, action))).toBe("token-used");
  });

  it("A2: any change to the action is refused", async () => {
    const changes: Action[] = [
      { ...action, args: { order: "A-2", items: [1, 2] } },
      { ...action, args: { order: "A-1", items: [2, 1] } },
      { ...action, args: { order: "A-1", items: [1, 2], extra: null } },
      { ...action, domain: "pay.example.com" },
      { ...action, tool: "pay2" },
      { ...action, amount: { value: 601, currency: "USD" } },
    ];
    for (const changed of changes) {
      const fox = await setup();
      const token = await approved(fox);
      expect(reason(await fox.gate.redeem(token, changed)), JSON.stringify(changed)).toBe("action-changed");
    }
  });

  it("A3: the same action in another key order or case is allowed", async () => {
    const fox = await setup();
    const token = await approved(fox);
    const same = { amount: { currency: "USD", value: 600 }, scope: "pay", domain: "SHOP.example.com.", args: { items: [1, 2], order: "A-1" }, tool: "pay" } as Action;
    expect(reason(await fox.gate.redeem(token, same))).toBe("allow");
  });

  it("A4: a changed or broken token is refused", async () => {
    const fox = await setup();
    const token = await approved(fox);
    const [prefix, payload, mac] = token.split(".") as [string, string, string];
    const body = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
    const later = `${prefix}.${b64(JSON.stringify({ ...body, exp: 9e15 }))}.${mac}`;
    const flipped = `${prefix}.${payload}.${mac.startsWith("A") ? "B" : "A"}${mac.slice(1)}`;
    for (const bad of [later, flipped, "", "fgt1", "fgt1.x.y", "nope.nope.nope", `${prefix}.${payload}`]) {
      expect(reason(await fox.gate.redeem(bad, action)), bad).toBe("bad-token");
    }
    expect(reason(await fox.gate.redeem(token, action))).toBe("allow");
  });

  it("A5: a token signed with another key is refused", async () => {
    const fox = await setup();
    const token = await approved(fox);
    const [prefix, payload] = token.split(".") as [string, string];
    const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))).toString("base64url");
    expect(reason(await fox.gate.redeem(`${prefix}.${payload}.${mac}`, action))).toBe("bad-token");
  });

  it("A6: an expired token stays expired when the clock goes back", async () => {
    const fox = await setup({ tokenTtlMs: 1000 });
    const token = await approved(fox);
    fox.setTime(1_001_000);
    expect(reason(await fox.gate.redeem(token, action))).toBe("token-expired");
    fox.setTime(1_000_500);
    expect(reason(await fox.gate.redeem(token, action))).toBe("token-expired");
  });

  it("A7: approve needs a waiting request", async () => {
    const fox = await setup({ requestTtlMs: 1000 });
    expect(await code(fox.host.approve("missing"))).toBe("not-found");
    const asked = await fox.gate.check(action);
    if (asked.decision !== "ask") throw new Error("expected ask");
    await fox.host.approve(asked.requestId);
    expect(await code(fox.host.approve(asked.requestId))).toBe("not-found");
    const other = await fox.gate.check({ ...action, args: { order: "B" } });
    if (other.decision !== "ask") throw new Error("expected ask");
    fox.setTime(1_001_000);
    expect(await code(fox.host.approve(other.requestId))).toBe("not-found");
  });

  it("A8: a rejected action is not asked again", async () => {
    const fox = await setup();
    const asked = await fox.gate.check(action);
    if (asked.decision !== "ask") throw new Error("expected ask");
    await fox.host.reject(asked.requestId);
    expect(await fox.host.pending()).toHaveLength(0);
    expect(reason(await fox.gate.check(action))).toBe("rejected");
  });

  it("A9: redeem checks the grant again", async () => {
    const revoked = await setup();
    const token = await approved(revoked);
    await revoked.host.revokeGrant((await revoked.host.grants())[0]?.id ?? "");
    expect(reason(await revoked.gate.redeem(token, action))).toBe("no-grant");
    const spent = await setup();
    const first = await approved(spent);
    const second = await approved(spent, { ...action, args: { order: "A-2" } });
    expect(reason(await spent.gate.redeem(first, action))).toBe("allow");
    expect(reason(await spent.gate.redeem(second, { ...action, args: { order: "A-2" } }))).toBe("spend-cap");
  });

  it("A10: two redeems at the same time give one allow", async () => {
    const fox = await setup();
    const token = await approved(fox);
    const results = await Promise.all([fox.gate.redeem(token, action), fox.gate.redeem(token, action)]);
    expect(results.map(reason).toSorted()).toEqual(["allow", "token-used"]);
  });

  it("A11: lost storage makes every token invalid", async () => {
    const fox = await setup();
    const token = await approved(fox);
    await fox.store.set("foxgate", undefined);
    expect(reason(await fox.gate.redeem(token, action))).toBe("bad-token");
  });

  it("A12: refuses an exportable or a wrong key", async () => {
    const exportable = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign", "verify"]);
    const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    for (const key of [exportable, aes]) {
      expect(() => createFoxgate({ key })).toThrowError(expect.objectContaining({ code: "bad-key" }));
    }
    const good = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    expect(() => createFoxgate({ key: good })).not.toThrow();
  });

  it("A13: a changed action uses the token up", async () => {
    const fox = await setup();
    const token = await approved(fox);
    expect(reason(await fox.gate.redeem(token, { ...action, amount: { value: 1, currency: "USD" } }))).toBe("action-changed");
    expect(reason(await fox.gate.redeem(token, action))).toBe("token-used");
  });

  it("A14: a failing hook during approve mints nothing", async () => {
    let fail = false;
    const fox = await setup({ onDecision: (e) => { if (fail && e.kind === "approve") throw new Error("log full"); } });
    const asked = await fox.gate.check(action);
    if (asked.decision !== "ask") throw new Error("expected ask");
    fail = true;
    await expect(fox.host.approve(asked.requestId)).rejects.toBeInstanceOf(FoxgateError);
    expect((await fox.host.pending()).map((r) => r.id)).toEqual([asked.requestId]);
    fail = false;
    expect(reason(await fox.gate.redeem(await fox.host.approve(asked.requestId), action))).toBe("allow");
  });
});

describe("storage adapters", () => {
  it("T1: storageAreaStore reads values out of { key: value }", async () => {
    const data: Record<string, unknown> = {};
    const area = {
      get: async (key: string) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
      set: async (items: Record<string, unknown>) => void Object.assign(data, structuredClone(items)),
    };
    const store = storageAreaStore(area);
    expect(await store.get("foxgate")).toBeUndefined();
    await store.set("foxgate", { a: [1] });
    expect(await store.get("foxgate")).toEqual({ a: [1] });
    expect(data).toEqual({ foxgate: { a: [1] } });
  });
});
