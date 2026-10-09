// The public API of foxgate.
export { FoxgateError, type FoxgateErrorCode } from "./errors.js";
export { canonicalJson } from "./canonical.js";
export { matchesPattern, normalizeHost, parsePattern, type DomainPattern, type PublicSuffix } from "./domain.js";
export { createFoxgate, type FoxgateOptions, type Gate, type Host } from "./gate.js";
export { memoryStore } from "./store.js";
export type { Action, ApprovalRequest, Decision, DecisionEvent, DenyReason, Grant, GrantInput, Scope, Store } from "./types.js";
