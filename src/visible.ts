// What an approval card shows for an action: the lines a human reads
// before Approve. Failure modes V1-V7 in docs/failure-modes.md.
//
// The token binds the exact action, so each value must read as itself.
// Control characters (Cc), format characters (Cf: bidi controls, zero
// width, soft hyphen, BOM) and the line and paragraph separators can make
// one string look like another, so each one shows as a visible escape.
import type { Action } from "./types.js";

const HIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

const escape = (text: string) => text.replace(HIDDEN, (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`);

/** A value as the card shows it: a string as it is (`""` when empty), anything else as its JSON. */
export function visibleValue(value: unknown): string {
  if (typeof value === "string") return value === "" ? '""' : escape(value);
  return escape(JSON.stringify(value) ?? String(value));
}

const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The card's lines: the site, the tool with its form, one row per field and arg, and the scope. */
export function visibleAction(action: Action): { site: string; what: string; rows: Array<[string, string]>; scope: string } {
  const { fields, form, ...rest } = action.args;
  const verb = action.tool.replaceAll("_", " ");
  const entries: Array<[string, unknown]> = [];
  if (plainObject(fields)) entries.push(...Object.entries(fields));
  else if (fields !== undefined) entries.push(["fields", fields]);
  entries.push(...Object.entries(rest));
  return {
    site: visibleValue(action.domain),
    what: `${escape(verb[0]?.toUpperCase() ?? "")}${escape(verb.slice(1))}${form === undefined ? "" : ` ${visibleValue(form)}`}.`,
    rows: entries.map(([key, value]) => [escape(key), visibleValue(value)]),
    scope: `Scope: ${visibleValue(action.scope)}.${action.amount ? ` Amount: ${visibleValue(action.amount)}.` : ""}`,
  };
}
