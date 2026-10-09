/** Why foxgate refused an input. Callers can switch on `code`. */
export type FoxgateErrorCode = "not-json" | "too-large" | "bad-domain" | "bad-grant" | "bad-action" | "not-found" | "bad-state" | "bad-key" | "hook-failed" | "bad-tools";

export class FoxgateError extends Error {
  readonly code: FoxgateErrorCode;

  constructor(code: FoxgateErrorCode, message: string) {
    super(message);
    this.name = "FoxgateError";
    this.code = code;
  }
}
