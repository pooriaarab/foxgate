// Canonical JSON: one text for one value. Object keys are sorted, nothing
// else changes. Approval tokens are bound to this text, so it refuses any
// value that JSON cannot hold exactly (docs/failure-modes.md C1-C10).
import { FoxgateError } from "./errors.js";

const MAX_DEPTH = 32;
const MAX_BYTES = 64 * 1024;

const notJson = (why: string) => new FoxgateError("not-json", `The value is not plain JSON: it ${why}.`);

function write(value: unknown, depth: number, seen: Set<object>): string {
  if (depth > MAX_DEPTH) throw notJson(`is nested more than ${MAX_DEPTH} levels deep`);
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw notJson(`has the number ${value}`);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw notJson(`has a ${typeof value}`);
  }
  if (seen.has(value)) throw notJson("has a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      // A hole reads as undefined, which write() refuses (C5).
      const items: string[] = [];
      for (let i = 0; i < value.length; i += 1) items.push(write(value[i], depth + 1, seen));
      return `[${items.join(",")}]`;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw notJson("has an object that is not a plain object");
    if (Object.getOwnPropertySymbols(value).length > 0) throw notJson("has a symbol key");
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${write(record[key], depth + 1, seen)}`);
    return `{${fields.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** The canonical JSON text of a value. Throws FoxgateError `not-json` or `too-large`. */
export function canonicalJson(value: unknown): string {
  const text = write(value, 0, new Set());
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_BYTES) throw new FoxgateError("too-large", `The value is ${bytes} bytes as JSON. The limit is ${MAX_BYTES}.`);
  return text;
}
