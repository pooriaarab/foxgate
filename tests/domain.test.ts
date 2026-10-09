// Failure modes D1-D12 in docs/failure-modes.md.
import { describe, expect, it } from "vitest";
import { FoxgateError, matchesPattern, normalizeHost, parsePattern, type PublicSuffix } from "../src/index.js";

// A small stand-in for the public suffix list. The demo extension uses the
// real list from Firefox (browser.publicSuffix), and the E2E test checks it.
const SUFFIXES = new Set(["com", "uk", "co.uk", "de", "io", "github.io"]);
const psl: PublicSuffix = {
  getDomain(host) {
    const labels = host.split(".");
    // The longest suffix wins, as in the real list.
    for (let i = 0; i < labels.length; i += 1) {
      if (SUFFIXES.has(labels.slice(i).join("."))) return i === 0 ? null : labels.slice(i - 1).join(".");
    }
    return null;
  },
};

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof FoxgateError ? error.code : `not a FoxgateError: ${String(error)}`;
  }
  return "no error";
};
const match = (host: string, pattern: string) => matchesPattern(normalizeHost(host), parsePattern(pattern, psl));

describe("domains", () => {
  it("D1: matches whole labels only", () => {
    expect(match("evil-example.com", "example.com")).toBe(false);
    expect(match("evil-example.com", "*.example.com")).toBe(false);
    expect(match("evilexample.com", "*.example.com")).toBe(false);
  });

  it("D2: does not match the allowed name at the start of a longer host", () => {
    expect(match("example.com.evil.com", "example.com")).toBe(false);
    expect(match("example.com.evil.com", "*.example.com")).toBe(false);
  });

  it("D3: a *. pattern allows subdomains only", () => {
    expect(match("example.com", "*.example.com")).toBe(false);
    expect(match("a.example.com", "*.example.com")).toBe(true);
    expect(match("a.b.example.com", "*.example.com")).toBe(true);
    expect(match("example.com", "example.com")).toBe(true);
    expect(match("a.example.com", "example.com")).toBe(false);
  });

  it("D4: normalizes case and a trailing dot", () => {
    expect(normalizeHost("EXAMPLE.com.")).toBe("example.com");
    expect(match("Shop.Example.COM", "shop.example.com.")).toBe(true);
  });

  it("D5: converts internationalized names to punycode", () => {
    expect(normalizeHost("bücher.de")).toBe("xn--bcher-kva.de");
    expect(match("xn--bcher-kva.de", "bücher.de")).toBe(true);
    expect(match("bücher.de", "xn--bcher-kva.de")).toBe(true);
    expect(match("shop.bücher.de", "*.bücher.de")).toBe(true);
  });

  it("D6: a look-alike letter from another script does not match", () => {
    expect(normalizeHost("аpple.com")).toBe("xn--pple-43d.com");
    expect(match("аpple.com", "apple.com")).toBe(false);
  });

  it("D7: refuses input that is more than a host", () => {
    for (const bad of ["https://example.com", "example.com:443", "example.com/x", "user@example.com", "exa mple.com", "example.com\\x", "ex%61mple.com", "example.com?q", "example.com#f"]) {
      expect(code(() => normalizeHost(bad)), bad).toBe("bad-domain");
      expect(code(() => parsePattern(bad, psl)), bad).toBe("bad-domain");
    }
  });

  it("D8: refuses empty and incomplete input", () => {
    for (const bad of ["", "*", "*.", "a..b", ".", ".example.com"]) {
      expect(code(() => parsePattern(bad, psl)), bad).toBe("bad-domain");
    }
    for (const bad of ["", "a..b", "."]) expect(code(() => normalizeHost(bad)), bad).toBe("bad-domain");
  });

  it("D9: refuses * in a wrong place", () => {
    for (const bad of ["a.*.com", "*example.com", "**.example.com", "*.*.example.com", "example.*"]) {
      expect(code(() => parsePattern(bad, psl)), bad).toBe("bad-domain");
    }
    expect(code(() => normalizeHost("*.example.com"))).toBe("bad-domain");
  });

  it("D10: refuses a *. pattern on a public suffix", () => {
    for (const bad of ["*.com", "*.co.uk", "*.github.io", "*.uk"]) {
      expect(code(() => parsePattern(bad, psl)), bad).toBe("bad-domain");
    }
    expect(code(() => parsePattern("*.example.co.uk", psl))).toBe("no error");
    expect(code(() => parsePattern("*.me.github.io", psl))).toBe("no error");
  });

  it("D11: refuses every *. pattern without a working public suffix list", () => {
    expect(code(() => parsePattern("*.example.com"))).toBe("bad-domain");
    const broken: PublicSuffix = {
      getDomain() {
        throw new Error("no list");
      },
    };
    expect(code(() => parsePattern("*.example.com", broken))).toBe("bad-domain");
    expect(code(() => parsePattern("example.com"))).toBe("no error");
  });

  it("D12: an IP address matches exactly, never by *.", () => {
    expect(match("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(match("127.0.0.2", "127.0.0.1")).toBe(false);
    expect(code(() => parsePattern("*.0.0.1", psl))).toBe("bad-domain");
    expect(code(() => parsePattern("*.127.0.0.1", psl))).toBe("bad-domain");
  });
});
