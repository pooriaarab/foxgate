// Approval tokens: "fgt1.<payload>.<mac>", both parts base64url. The MAC is
// HMAC-SHA256 over the payload text with a key that JavaScript cannot export.
import { FoxgateError } from "./errors.js";

export interface TokenPayload {
  v: 1;
  /** The approval request ID. */
  rid: string;
  /** One-time value. foxgate stores it while the token is valid. */
  nonce: string;
  /** Expiry, in ms since 1970. */
  exp: number;
  /** SHA-256 of the canonical JSON of the approved action. */
  dig: string;
}

const PREFIX = "fgt1";

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

function fromB64(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[\w-]+$/.test(text)) return undefined;
  try {
    return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/** Throws FoxgateError `bad-key` unless the key is a non-exportable HMAC-SHA256 key for sign and verify. */
export function checkKey(key: CryptoKey): CryptoKey {
  const hash = (key.algorithm as HmacKeyAlgorithm).hash?.name;
  if (key.extractable || key.algorithm.name !== "HMAC" || hash !== "SHA-256" || !key.usages.includes("sign") || !key.usages.includes("verify")) {
    throw new FoxgateError("bad-key", "The key must be an HMAC SHA-256 CryptoKey with extractable false and the usages sign and verify.");
  }
  return key;
}

export const newKey = () => crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export async function signToken(key: CryptoKey, payload: TokenPayload): Promise<string> {
  const body = toB64(new TextEncoder().encode(JSON.stringify(payload)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${PREFIX}.${body}.${toB64(mac)}`;
}

/** The payload of a token that this key signed, or undefined. */
export async function readToken(key: CryptoKey, token: unknown): Promise<TokenPayload | undefined> {
  if (typeof token !== "string") return undefined;
  const [prefix, body, macText, ...rest] = token.split(".");
  if (prefix !== PREFIX || body === undefined || macText === undefined || rest.length > 0) return undefined;
  const bytes = fromB64(body);
  const mac = fromB64(macText);
  if (!bytes || !mac || !(await crypto.subtle.verify("HMAC", key, mac, new TextEncoder().encode(body)))) return undefined;
  try {
    const p = JSON.parse(new TextDecoder().decode(bytes)) as Partial<TokenPayload>;
    const ok = p.v === 1 && typeof p.rid === "string" && typeof p.nonce === "string" && typeof p.exp === "number" && typeof p.dig === "string";
    return ok ? (p as TokenPayload) : undefined;
  } catch {
    return undefined;
  }
}
