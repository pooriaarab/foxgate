// Failure modes V1-V7 in docs/failure-modes.md.
import { describe, expect, it } from "vitest";
import { visibleAction, visibleValue } from "../src/index.js";

const action = (args: Record<string, unknown>, domain = "checkout.example.com") => ({ tool: "submit_form", args, domain, scope: "submit" as const });

describe("visibleValue", () => {
  it("V1: shows bidi controls as escapes, so a reversed value cannot pass for another", () => {
    expect(visibleValue("\u202Emoc.live@mas")).toBe("⟨U+202E⟩moc.live@mas");
    for (const c of ["\u202A", "\u202B", "\u202C", "\u202D", "\u2066", "\u2067", "\u2068", "\u2069"]) {
      expect(visibleValue(`a${c}b`)).toBe(`a⟨U+${c.codePointAt(0)!.toString(16).toUpperCase()}⟩b`);
    }
  });

  it("V2: shows invisible characters as escapes", () => {
    expect(visibleValue("sam@exam\u200Bple.com")).toBe("sam@exam⟨U+200B⟩ple.com");
    for (const c of ["\u200C", "\u200D", "\u200E", "\u200F", "\u2060", "\uFEFF", "\u00AD"]) {
      expect(visibleValue(c)).toBe(`⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`);
    }
  });

  it("V3: shows control characters and line separators as escapes", () => {
    expect(visibleValue("pro\nplan: basic")).toBe("pro⟨U+000A⟩plan: basic");
    expect(visibleValue("a\u0000b\u007Fc\u0085d\u2028e\u2029f\tg")).toBe("a⟨U+0000⟩b⟨U+007F⟩c⟨U+0085⟩d⟨U+2028⟩e⟨U+2029⟩f⟨U+0009⟩g");
  });

  it("V4: shows a string as it is and anything else as its JSON", () => {
    expect(visibleValue("sam@example.com")).toBe("sam@example.com");
    expect(visibleValue("")).toBe('""');
    expect(visibleValue(0)).toBe("0");
    expect(visibleValue(false)).toBe("false");
    expect(visibleValue(null)).toBe("null");
    expect(visibleValue({ id: "#checkout" })).toBe('{"id":"#checkout"}');
    expect(visibleValue(["a", 1])).toBe('["a",1]');
    expect(visibleValue({ note: "x\u202Ey" })).toBe('{"note":"x⟨U+202E⟩y"}');
  });
});

describe("visibleAction", () => {
  it("shows the form, each field and the scope", () => {
    expect(visibleAction(action({ form: "#checkout", fields: { email: "sam@example.com", plan: "basic" } }))).toEqual({
      site: "checkout.example.com",
      what: "Submit form #checkout.",
      rows: [["email", "sam@example.com"], ["plan", "basic"]],
      scope: "Scope: submit.",
    });
  });

  it("V1, V2: escapes field keys and values", () => {
    const { rows } = visibleAction(action({ fields: { "em\u200Bail": "\u202Emoc.live@mas" } }));
    expect(rows).toEqual([["em⟨U+200B⟩ail", "⟨U+202E⟩moc.live@mas"]]);
  });

  it("V4: shows a form that is an object as its JSON", () => {
    expect(visibleAction(action({ form: { selector: "#checkout" } })).what).toBe('Submit form {"selector":"#checkout"}.');
  });

  it("V5: shows a falsy form", () => {
    expect(visibleAction(action({ form: 0 })).what).toBe("Submit form 0.");
    expect(visibleAction(action({ form: "" })).what).toBe('Submit form "".');
    expect(visibleAction(action({ form: false })).what).toBe("Submit form false.");
    expect(visibleAction(action({})).what).toBe("Submit form.");
  });

  it("V6: shows fields that are not a plain object as one row", () => {
    expect(visibleAction(action({ fields: null })).rows).toEqual([["fields", "null"]]);
    expect(visibleAction(action({ fields: "ab" })).rows).toEqual([["fields", "ab"]]);
    expect(visibleAction(action({ fields: ["a"] })).rows).toEqual([["fields", '["a"]']]);
  });

  it("shows other args as rows after the fields", () => {
    expect(visibleAction(action({ fields: { a: "1" }, note: "x" })).rows).toEqual([["a", "1"], ["note", "x"]]);
  });

  it("V7: escapes the domain", () => {
    expect(visibleAction(action({}, "chec\u200Bkout.example.com")).site).toBe("chec⟨U+200B⟩kout.example.com");
  });

  it("shows the amount with the scope", () => {
    expect(visibleAction({ ...action({}), amount: { value: 2600, currency: "USD" } }).scope).toBe('Scope: submit. Amount: {"value":2600,"currency":"USD"}.');
  });
});
