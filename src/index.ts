// The public API of foxgate.
export { FoxgateError, type FoxgateErrorCode } from "./errors.js";
export { canonicalJson } from "./canonical.js";
export { matchesPattern, normalizeHost, parsePattern, type DomainPattern, type PublicSuffix } from "./domain.js";
