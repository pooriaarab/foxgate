// The shapes foxgate works with. All stored values are plain JSON, so any
// key-value storage can hold them.

/** What an action does. A grant for one scope allows only that scope. */
export type Scope = "read" | "fill" | "submit" | "pay";

/** Money in minor units (cents for USD) and an ISO 4217 currency code. */
export interface Money {
  value: number;
  currency: string;
}

/**
 * How the host registers a tool: its scope, and for a tool that costs money,
 * a function that reads the amount from the args. The planner cannot change it.
 */
export type ToolSpec = Scope | { scope: Scope; amount?: (args: Record<string, unknown>) => Money };

/** One thing an agent wants to do. Approval tokens bind to all of it. */
export interface Action {
  tool: string;
  args: Record<string, unknown>;
  domain: string;
  scope: Scope;
  amount?: Money;
}

/** What the host allows. Only the host can add a grant. */
export interface GrantInput {
  scope: Scope;
  /** Exact hosts (`shop.example.com`) or subdomain patterns (`*.example.com`). */
  domains: string[];
  /** Tool names. Leave it out to allow every tool. */
  tools?: string[];
  /** The most this grant can spend, for all actions together. */
  spendCap?: Money;
  /** Time in ms since 1970. The grant stops at this time. */
  expiresAt?: number;
  maxUses?: number;
  /** "always" makes check() answer "ask". Default: "always" for submit and pay, else "never". */
  approval?: "always" | "never";
  /** true lets an "allow" user rule skip this grant's approval. Default false. Leave it out after the run holds private data. */
  rules?: boolean;
}

export interface Grant extends GrantInput {
  id: string;
  createdAt: number;
  approval: "always" | "never";
  rules: boolean;
  uses: number;
  /** Minor units spent so far against spendCap. */
  spent: number;
}

/** An action that waits for a human. `text` is the exact canonical JSON to show. */
export interface ApprovalRequest {
  id: string;
  grantId: string;
  action: Action;
  text: string;
  digest: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "used" | "rejected";
  /** Set when approved. It must match the token nonce. */
  nonce?: string;
}

/** The scopes a user rule can cover. Payments and fills always follow their grants. */
export type RuleScope = "read" | "submit";

/**
 * A standing answer from the user for one site. A rule changes only the
 * approval step of a grant that already matches; it never adds a grant.
 */
export interface RuleInput {
  /** A registrable domain (`example.com`). The rule covers it and its subdomains. */
  site: string;
  scope: RuleScope;
  /** One tool name. Leave it out to cover every tool of the scope. */
  tool?: string;
  /** "allow" skips the human (only on grants with `rules: true`), "ask" adds one, "deny" refuses. */
  effect: "allow" | "ask" | "deny";
  /** Time in ms since 1970. The rule stops at this time. */
  expiresAt?: number;
}

export interface Rule extends RuleInput {
  id: string;
  createdAt: number;
}

export type DenyReason =
  | "bad-action"
  | "unknown-tool"
  | "wrong-scope"
  | "wrong-amount"
  | "no-grant"
  | "expired"
  | "used-up"
  | "spend-cap"
  | "currency"
  | "too-many-requests"
  | "bad-token"
  | "token-expired"
  | "token-used"
  | "action-changed"
  | "rejected"
  | "hook-failed"
  | "storage-error"
  | "clock-error"
  | "rule";

/** `ruleId` is set only when a user rule changed the answer. */
export type Decision =
  /** `action` is the normalized action that foxgate judged. Run this object, not your own copy. */
  | { decision: "allow"; grantId: string; action: Action; ruleId?: string }
  | { decision: "ask"; grantId: string; requestId: string; expiresAt: number; ruleId?: string }
  | { decision: "deny"; reason: DenyReason; message: string; ruleId?: string };

/** What onDecision receives, one time for each decision. */
export interface DecisionEvent {
  kind: "check" | "redeem" | "approve" | "reject";
  at: number;
  /** The normalized action, when it was valid. */
  action?: Action;
  requestId?: string;
  decision: Decision;
}

/** Key-value storage for foxgate state. Values are plain JSON. */
export interface Store {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}
