// Failure modes C1-C10 in docs/failure-modes.md.
import { describe, expect, it } from "vitest";
import { FoxgateError, canonicalJson } from "../src/index.js";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof FoxgateError ? error.code : `not a FoxgateError: ${String(error)}`;
  }
  return "no error";
};

describe("canonicalJson", () => {
  it("C1: gives the same text for a different key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("C2: gives different text for a different array order", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("C3: gives different text when the type changes", () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
    expect(canonicalJson({ a: true })).not.toBe(canonicalJson({ a: "true" }));
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
  });

  it("C4: refuses values that are not JSON", () => {
    class Thing {
      x = 1;
    }
    const bad: unknown[] = [undefined, Number.NaN, Infinity, -Infinity, 1n, () => 1, Symbol("s"), new Date(0), new Map(), new Thing()];
    for (const value of bad) {
      expect(code(() => canonicalJson(value))).toBe("not-json");
      expect(code(() => canonicalJson({ a: value }))).toBe("not-json");
      expect(code(() => canonicalJson([value]))).toBe("not-json");
    }
  });

  it("C5: refuses an array with a hole", () => {
    // oxlint-disable-next-line no-sparse-arrays
    expect(code(() => canonicalJson([1, , 3]))).toBe("not-json");
  });

  it("C6: refuses a cycle and very deep nesting", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(code(() => canonicalJson(cycle))).toBe("not-json");
    let deep: unknown = 1;
    for (let i = 0; i < 40; i += 1) deep = [deep];
    expect(code(() => canonicalJson(deep))).toBe("not-json");
    let ok: unknown = 1;
    for (let i = 0; i < 30; i += 1) ok = [ok];
    expect(code(() => canonicalJson(ok))).toBe("no error");
  });

  it("C7: refuses text larger than 64 KiB", () => {
    expect(code(() => canonicalJson({ a: "x".repeat(70_000) }))).toBe("too-large");
    expect(code(() => canonicalJson({ a: "x".repeat(60_000) }))).toBe("no error");
  });

  it("C8: does not normalize strings", () => {
    expect(canonicalJson({ name: "café" })).not.toBe(canonicalJson({ name: "café" }));
  });

  it("C9: keeps __proto__ as a data key", () => {
    const value = JSON.parse('{"__proto__": 1, "a": 2}') as unknown;
    expect(canonicalJson(value)).toBe('{"__proto__":1,"a":2}');
    expect(canonicalJson(value)).not.toBe(canonicalJson({ a: 2 }));
  });

  it("C10: writes valid JSON that parses back to an equal value", () => {
    const value = { s: 'quote " slash \\ line\n   emoji \u{1F98A}', n: [0, -1.5, 1e21], t: true, z: null, o: {} };
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
    expect(canonicalJson(-0)).toBe("0");
  });
});
