// The shapes foxgate works with. All stored values are plain JSON, so any
// key-value storage can hold them.

/** What an action does. A grant for one scope allows only that scope. */
export type Scope = "read" | "fill" | "submit" | "pay";

/** Money in minor units (cents for USD) and an ISO 4217 currency code. */
export interface Money {
  value: number;
  currency: string;
}

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
}

export interface Grant extends GrantInput {
  id: string;
  createdAt: number;
  approval: "always" | "never";
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
  status: "pending";
}

export type DenyReason =
  | "bad-action"
  | "no-grant"
  | "expired"
  | "used-up"
  | "spend-cap"
  | "currency"
  | "too-many-requests"
  | "bad-token"
  | "hook-failed"
  | "storage-error";

export type Decision =
  | { decision: "allow"; grantId: string }
  | { decision: "ask"; grantId: string; requestId: string; expiresAt: number }
  | { decision: "deny"; reason: DenyReason; message: string };

/** What onDecision receives, one time for each decision. */
export interface DecisionEvent {
  kind: "check" | "redeem";
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
