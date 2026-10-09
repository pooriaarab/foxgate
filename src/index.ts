// The public API of foxgate.
export { FoxgateError, type FoxgateErrorCode } from "./errors.js";
export { canonicalJson } from "./canonical.js";
export { matchesPattern, normalizeHost, parsePattern, type DomainPattern, type PublicSuffix } from "./domain.js";
export { createFoxgate, type FoxgateOptions, type Gate, type Host } from "./gate.js";
export { memoryStore, storageAreaStore, type StorageAreaLike } from "./store.js";
export type { Action, ApprovalRequest, Decision, DecisionEvent, DenyReason, Grant, GrantInput, Money, Scope, Store, ToolSpec } from "./types.js";
