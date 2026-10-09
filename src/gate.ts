// The gate: grants, the policy check, and spend caps. All state changes run
// one at a time (docs/failure-modes.md S3) and every answer goes through the
// onDecision hook before foxgate saves it (G14).
import { canonicalJson } from "./canonical.js";
import { matchesPattern, normalizeHost, parsePattern, type PublicSuffix } from "./domain.js";
import { FoxgateError, type FoxgateErrorCode } from "./errors.js";
import { memoryStore } from "./store.js";
import { checkKey, newKey, readToken, signToken } from "./token.js";
import type { Action, ApprovalRequest, Decision, DecisionEvent, DenyReason, Grant, GrantInput, Money, Store } from "./types.js";

export interface FoxgateOptions {
  /** Where grants, requests, and spend live. Default: memoryStore(). */
  store?: Store;
  /** The clock, in ms since 1970. Default: Date.now. */
  now?: () => number;
  /** Needed for "*." domain patterns. In Firefox 153+, pass browser.publicSuffix. */
  publicSuffix?: PublicSuffix;
  /** Called for each decision before it takes effect. If it throws, the answer is "deny". */
  onDecision?: (event: DecisionEvent) => void | Promise<void>;
  /** How long a request waits for a human. Default: 10 minutes. */
  requestTtlMs?: number;
  /** The most requests that can wait at one time. Default: 20. */
  maxPending?: number;
  /** How long an approval token is valid. Default: 2 minutes. */
  tokenTtlMs?: number;
  /** Signs approval tokens. A non-exportable HMAC SHA-256 key. Default: a new key in memory. */
  key?: CryptoKey;
}

/** The planner side. Give only this object to the AI agent. */
export interface Gate {
  check(action: Action): Promise<Decision>;
  redeem(token: string, action: Action): Promise<Decision>;
}

/** The host side. Keep this object away from the AI agent. */
export interface Host {
  addGrant(input: GrantInput): Promise<Grant>;
  revokeGrant(id: string): Promise<boolean>;
  grants(): Promise<Grant[]>;
  pending(): Promise<ApprovalRequest[]>;
  /** A human said yes. Returns the token for this exact action. */
  approve(requestId: string): Promise<string>;
  /** A human said no. The same action gets "rejected" until the request expires. */
  reject(requestId: string): Promise<void>;
}

interface State {
  time: number;
  grants: Grant[];
  requests: ApprovalRequest[];
}

interface Outcome {
  decision: Decision;
  action?: Action;
  requestId?: string;
}

const KEY = "foxgate";
const SCOPES = ["read", "fill", "submit", "pay"];
const ACTION_KEYS = new Set(["tool", "args", "domain", "scope", "amount"]);
const GRANT_KEYS = new Set(["scope", "domains", "tools", "spendCap", "expiresAt", "maxUses", "approval"]);

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export const randomId = () => hex(crypto.getRandomValues(new Uint8Array(16)));
export const sha256 = async (text: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
export const deny = (reason: DenyReason, message: string): Decision => ({ decision: "deny", reason, message });
const badAction = (why: string) => new FoxgateError("bad-action", `The action is not valid: ${why}.`);
const badGrant = (why: string) => new FoxgateError("bad-grant", `The grant is not valid: ${why}.`);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

function parseMoney(value: unknown, code: FoxgateErrorCode): Money {
  const ok = isPlain(value) && Object.keys(value).every((k) => k === "value" || k === "currency") && Number.isSafeInteger(value.value) && (value.value as number) >= 0 && typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency);
  if (!ok) throw new FoxgateError(code, "An amount must be { value, currency }: whole minor units from 0, and a 3-letter uppercase currency code.");
  return { value: value.value as number, currency: value.currency as string };
}

/** Check an action and return it normalized, with its canonical JSON text. */
export function parseAction(input: unknown): { action: Action; text: string } {
  const fail = badAction;
  if (!isPlain(input)) throw fail("it is not an object");
  const extra = Object.keys(input).find((key) => !ACTION_KEYS.has(key));
  if (extra !== undefined) throw fail(`it has the unknown field ${JSON.stringify(extra)}`);
  const { tool, args, domain, scope, amount } = input;
  if (typeof tool !== "string" || tool === "" || tool.length > 128) throw fail("tool must be a string of 1 to 128 characters");
  if (!isPlain(args)) throw fail("args must be a JSON object");
  if (typeof scope !== "string" || !SCOPES.includes(scope)) throw fail(`scope must be one of ${SCOPES.join(", ")}`);
  if (scope === "pay" && amount === undefined) throw fail("a pay action needs an amount");
  const action = { tool, args, domain: normalizeHost(domain as string), scope, ...(amount === undefined ? {} : { amount: parseMoney(amount, "bad-action") }) };
  const text = canonicalJson(action);
  return { action: JSON.parse(text) as Action, text };
}

function parseGrant(input: unknown, now: number, publicSuffix?: PublicSuffix): Grant {
  const fail = badGrant;
  if (!isPlain(input)) throw fail("it is not an object");
  const extra = Object.keys(input).find((key) => !GRANT_KEYS.has(key));
  if (extra !== undefined) throw fail(`it has the unknown field ${JSON.stringify(extra)}`);
  const { scope, domains, tools, spendCap, expiresAt, maxUses, approval } = input;
  if (typeof scope !== "string" || !SCOPES.includes(scope)) throw fail(`scope must be one of ${SCOPES.join(", ")}`);
  if (!Array.isArray(domains) || domains.length === 0) throw fail("domains must be a list with at least one domain");
  if (tools !== undefined && (!Array.isArray(tools) || !tools.every((t) => typeof t === "string" && t !== ""))) throw fail("tools must be a list of names");
  if (expiresAt !== undefined && (typeof expiresAt !== "number" || !(expiresAt > now))) throw fail("expiresAt must be a time in the future");
  if (maxUses !== undefined && (!Number.isSafeInteger(maxUses) || (maxUses as number) < 1)) throw fail("maxUses must be a whole number from 1");
  if (approval !== undefined && approval !== "always" && approval !== "never") throw fail('approval must be "always" or "never"');
  const patterns = domains.map((d) => parsePattern(d as string, publicSuffix));
  return {
    id: randomId(),
    createdAt: now,
    scope: scope as Grant["scope"],
    domains: patterns.map((p) => (p.kind === "subdomains" ? `*.${p.host}` : p.host)),
    ...(tools === undefined ? {} : { tools: tools as string[] }),
    ...(spendCap === undefined ? {} : { spendCap: parseMoney(spendCap, "bad-grant") }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(maxUses === undefined ? {} : { maxUses: maxUses as number }),
    approval: approval ?? (scope === "submit" || scope === "pay" ? "always" : "never"),
    uses: 0,
    spent: 0,
  };
}

const allows = (pattern: string, host: string) =>
  pattern.startsWith("*.") ? matchesPattern(host, { kind: "subdomains", host: pattern.slice(2) }) : host === pattern;

/** Why a grant cannot allow the action now, or undefined when it can. */
export function blockedBy(grant: Grant, action: Action, now: number): Decision | undefined {
  if (grant.expiresAt !== undefined && now >= grant.expiresAt) return deny("expired", `Grant ${grant.id} expired.`);
  if (grant.maxUses !== undefined && grant.uses >= grant.maxUses) return deny("used-up", `Grant ${grant.id} has no uses left.`);
  const cap = grant.spendCap;
  if (cap && action.amount) {
    if (action.amount.currency !== cap.currency) return deny("currency", `Grant ${grant.id} spends ${cap.currency}, not ${action.amount.currency}.`);
    if (grant.spent + action.amount.value > cap.value) return deny("spend-cap", `This takes grant ${grant.id} over its cap: ${grant.spent} + ${action.amount.value} > ${cap.value} ${cap.currency}.`);
  }
  return undefined;
}

/** Count one use of the grant, and the amount against its cap. */
export function use(grant: Grant, action: Action): void {
  grant.uses += 1;
  if (grant.spendCap && action.amount) grant.spent += action.amount.value;
}

export function createFoxgate(options: FoxgateOptions = {}): { gate: Gate; host: Host } {
  const store = options.store ?? memoryStore();
  const clock = options.now ?? Date.now;
  const requestTtl = options.requestTtlMs ?? 10 * 60_000;
  const maxPending = options.maxPending ?? 20;
  const tokenTtl = options.tokenTtlMs ?? 2 * 60_000;
  const givenKey = options.key && checkKey(options.key);
  let keyPromise: Promise<CryptoKey> | undefined;
  const key = () => (keyPromise ??= givenKey ? Promise.resolve(givenKey) : newKey());
  let tail: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };

  async function load(): Promise<State> {
    const raw = await store.get(KEY);
    if (raw === undefined || raw === null) return { time: 0, grants: [], requests: [] };
    if (!isPlain(raw) || typeof raw.time !== "number" || !Array.isArray(raw.grants) || !Array.isArray(raw.requests)) throw new FoxgateError("bad-state", "The stored foxgate state has a wrong shape.");
    return raw as unknown as State;
  }

  async function notify(event: DecisionEvent) {
    try {
      await options.onDecision?.(event);
    } catch (error) {
      throw new FoxgateError("hook-failed", `The onDecision hook failed: ${messageOf(error)}`);
    }
  }

  // Load, decide, tell the hook, then save. A failed hook or store saves nothing.
  const decide = (kind: DecisionEvent["kind"], work: (state: State, now: number) => Promise<Outcome>) =>
    locked(async (): Promise<Decision> => {
      let state: State;
      try {
        state = await load();
      } catch (error) {
        return deny("storage-error", `Cannot read the foxgate state: ${messageOf(error)}`);
      }
      // Never use a time earlier than one already seen (G8).
      const now = Math.max(clock(), state.time);
      state.time = now;
      const out = await work(state, now);
      try {
        await notify({ kind, at: now, ...(out.action && { action: out.action }), ...(out.requestId && { requestId: out.requestId }), decision: out.decision });
      } catch (error) {
        return deny("hook-failed", messageOf(error));
      }
      try {
        await store.set(KEY, state);
      } catch (error) {
        return deny("storage-error", `Cannot save the foxgate state: ${messageOf(error)}`);
      }
      return out.decision;
    });

  async function checkWork(state: State, now: number, input: unknown): Promise<Outcome> {
    let parsed: { action: Action; text: string };
    try {
      parsed = parseAction(input);
    } catch (error) {
      return { decision: deny("bad-action", messageOf(error)) };
    }
    const { action, text } = parsed;
    const matching = state.grants.filter((g) => g.scope === action.scope && (!g.tools || g.tools.includes(action.tool)) && g.domains.some((p) => allows(p, action.domain)));
    let blocked: Decision = deny("no-grant", `No grant allows ${action.scope} with ${action.tool} on ${action.domain}.`);
    for (const grant of matching) {
      const why = blockedBy(grant, action, now);
      if (why) {
        if (blocked.decision === "deny" && blocked.reason === "no-grant") blocked = why;
        continue;
      }
      if (grant.approval === "never") {
        use(grant, action);
        return { action, decision: { decision: "allow", grantId: grant.id } };
      }
      const digest = await sha256(text);
      state.requests = state.requests.filter((r) => r.expiresAt > now);
      let request = state.requests.find((r) => r.grantId === grant.id && r.digest === digest && r.status !== "used");
      if (request?.status === "rejected") return { action, requestId: request.id, decision: deny("rejected", "A human rejected this action.") };
      if (!request) {
        if (state.requests.filter((r) => r.status === "pending").length >= maxPending) return { action, decision: deny("too-many-requests", `${maxPending} requests already wait for a human.`) };
        request = { id: randomId(), grantId: grant.id, action, text, digest, createdAt: now, expiresAt: now + requestTtl, status: "pending" };
        state.requests.push(request);
      }
      return { action, requestId: request.id, decision: { decision: "ask", grantId: grant.id, requestId: request.id, expiresAt: request.expiresAt } };
    }
    return { action, decision: blocked };
  }

  async function redeemWork(state: State, now: number, token: string, input: unknown): Promise<Outcome> {
    const payload = await readToken(await key(), token);
    if (!payload) return { decision: deny("bad-token", "The token is not valid.") };
    const requestId = payload.rid;
    if (now >= payload.exp) return { requestId, decision: deny("token-expired", "The token has expired.") };
    const request = state.requests.find((r) => r.id === requestId && r.nonce === payload.nonce && r.digest === payload.dig);
    if (request?.status === "used") return { requestId, decision: deny("token-used", "The token was already used.") };
    if (request?.status !== "approved") return { requestId, decision: deny("bad-token", "No approved request matches the token.") };
    // Any try uses the token up, also a try with a changed action (A13).
    request.status = "used";
    let parsed: { action: Action; text: string };
    try {
      parsed = parseAction(input);
    } catch (error) {
      return { requestId, decision: deny("bad-action", messageOf(error)) };
    }
    const { action, text } = parsed;
    if ((await sha256(text)) !== payload.dig) return { action, requestId, decision: deny("action-changed", "This is not the action that the human approved.") };
    const grant = state.grants.find((g) => g.id === request.grantId);
    if (!grant) return { action, requestId, decision: deny("no-grant", `Grant ${request.grantId} no longer exists.`) };
    const why = blockedBy(grant, action, now);
    if (why) return { action, requestId, decision: why };
    use(grant, action);
    return { action, requestId, decision: { decision: "allow", grantId: grant.id } };
  }

  // Approve or reject one waiting request. The hook runs before the save (A14).
  const answer = <T>(id: string, work: (request: ApprovalRequest, now: number) => Promise<{ event: DecisionEvent; result: T }>) =>
    locked(async () => {
      const state = await load();
      const now = Math.max(clock(), state.time);
      const request = state.requests.find((r) => r.id === id && r.status === "pending" && r.expiresAt > now);
      if (!request) throw new FoxgateError("not-found", `No waiting request has the ID ${JSON.stringify(id)}.`);
      const { event, result } = await work(request, now);
      await notify(event);
      state.time = now;
      await store.set(KEY, state);
      return result;
    });

  const host: Host = {
    addGrant: (input) =>
      locked(async () => {
        const state = await load();
        const grant = parseGrant(input, Math.max(clock(), state.time), options.publicSuffix);
        state.grants.push(grant);
        await store.set(KEY, state);
        return grant;
      }),
    revokeGrant: (id) =>
      locked(async () => {
        const state = await load();
        const before = state.grants.length;
        state.grants = state.grants.filter((g) => g.id !== id);
        state.requests = state.requests.filter((r) => r.grantId !== id || r.status !== "pending");
        await store.set(KEY, state);
        return state.grants.length < before;
      }),
    grants: () => locked(async () => (await load()).grants),
    pending: () =>
      locked(async () => {
        const state = await load();
        const now = Math.max(clock(), state.time);
        return state.requests.filter((r) => r.status === "pending" && r.expiresAt > now);
      }),
    approve: (id) =>
      answer(id, async (request, now) => {
        const nonce = randomId();
        const exp = now + tokenTtl;
        const result = await signToken(await key(), { v: 1, rid: request.id, nonce, exp, dig: request.digest });
        const event: DecisionEvent = { kind: "approve", at: now, action: request.action, requestId: request.id, decision: { decision: "allow", grantId: request.grantId } };
        Object.assign(request, { status: "approved", nonce, expiresAt: exp });
        return { event, result };
      }),
    reject: (id) =>
      answer(id, async (request, now) => {
        request.status = "rejected";
        return { event: { kind: "reject", at: now, action: request.action, requestId: request.id, decision: deny("rejected", "A human rejected this action.") }, result: undefined };
      }),
  };

  const gate: Gate = {
    check: (action) => decide("check", (state, now) => checkWork(state, now, action)),
    redeem: (token, action) => decide("redeem", (state, now) => redeemWork(state, now, token, action)),
  };
  return { gate: Object.freeze(gate), host: Object.freeze(host) };
}
