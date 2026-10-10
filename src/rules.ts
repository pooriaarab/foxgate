// User rules: a standing answer for one site (docs/failure-modes.md U1-U17).
// A rule changes only the approval step of a grant that already matches.
import { onSite, parseSite, type PublicSuffix } from "./domain.js";
import { FoxgateError } from "./errors.js";
import type { Action, Rule, RuleScope, Scope } from "./types.js";

export const RULES_KEY = "foxgate-rules";
const RULE_SCOPES: readonly string[] = ["read", "submit"] satisfies RuleScope[];
const EFFECTS: readonly string[] = ["allow", "ask", "deny"];
const RULE_KEYS = new Set(["site", "scope", "tool", "effect", "expiresAt"]);
export const MAX_RULES = 500;

const badRule = (why: string) => new FoxgateError("bad-rule", `The rule is not valid: ${why}.`);
const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Check a rule from the host and return it with its ID (U3, U4, U14). */
export function parseRule(input: unknown, now: number, id: string, tools: Map<string, { scope: Scope }>, publicSuffix?: PublicSuffix): Rule {
  if (!isPlain(input)) throw badRule("it is not an object");
  const extra = Object.keys(input).find((key) => !RULE_KEYS.has(key));
  if (extra !== undefined) throw badRule(`it has the unknown field ${JSON.stringify(extra)}`);
  const { site, scope, tool, effect, expiresAt } = input;
  if (scope === "pay" || scope === "fill") throw badRule(`a rule cannot change ${scope}: a human approves each one that needs it`);
  if (typeof scope !== "string" || !RULE_SCOPES.includes(scope)) throw badRule(`scope must be one of ${RULE_SCOPES.join(", ")}`);
  if (typeof effect !== "string" || !EFFECTS.includes(effect)) throw badRule(`effect must be one of ${EFFECTS.join(", ")}`);
  if (tool !== undefined && (typeof tool !== "string" || tools.get(tool)?.scope !== scope)) throw badRule(`the host did not register the tool ${JSON.stringify(tool)} with the scope ${scope}`);
  if (expiresAt !== undefined && (typeof expiresAt !== "number" || !(expiresAt > now))) throw badRule("expiresAt must be a time in the future");
  let host: string;
  try {
    host = parseSite(site as string, publicSuffix);
  } catch (error) {
    throw badRule(error instanceof Error ? error.message : String(error));
  }
  return { id, createdAt: now, site: host, scope: scope as RuleScope, ...(tool === undefined ? {} : { tool }), effect: effect as Rule["effect"], ...(expiresAt === undefined ? {} : { expiresAt }) };
}

/** Read the stored rules. A wrong shape, or a rule that addRule would refuse, throws `bad-state` (U12). */
export function readRules(raw: unknown, tools: Map<string, { scope: Scope }>, publicSuffix?: PublicSuffix): Rule[] {
  if (raw === undefined || raw === null) return [];
  try {
    if (!Array.isArray(raw) || raw.length > MAX_RULES) throw badRule(`the list is not an array of at most ${MAX_RULES}`);
    const rules = raw.map((r: unknown) => {
      const { id, createdAt, ...input } = isPlain(r) ? r : {};
      const rule = parseRule(input, -Infinity, id as string, tools, publicSuffix);
      if (typeof id !== "string" || !Number.isFinite(createdAt) || rule.site !== input.site) throw badRule("it is not in the form that addRule saves");
      return { ...rule, createdAt: createdAt as number };
    });
    if (new Set(rules.map((r) => r.id)).size < rules.length) throw badRule("two rules have the same id");
    return rules;
  } catch (error) {
    throw new FoxgateError("bad-state", `The stored foxgate rules are not valid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const live = (rule: Rule, now: number) => rule.expiresAt === undefined || now < rule.expiresAt;

/** The strictest live rule for the action: deny, then ask, then allow (U7). */
export function ruleFor(rules: Rule[], action: Action, now: number): Rule | undefined {
  const hits = rules.filter((r) => live(r, now) && r.scope === action.scope && (r.tool === undefined || r.tool === action.tool) && onSite(action.domain, r.site));
  return hits.find((r) => r.effect === "deny") ?? hits.find((r) => r.effect === "ask") ?? hits.find((r) => r.effect === "allow");
}
