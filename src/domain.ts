// Hosts and domain patterns (docs/failure-modes.md D1-D12). A pattern is an
// exact host or "*." plus a host for its subdomains. Matching is by whole
// labels, after both sides are lowercase punycode.
import { FoxgateError } from "./errors.js";

/** Finds the registrable domain (eTLD+1) of a host, or null for a public suffix. `browser.publicSuffix` in Firefox 153+ fits. */
export interface PublicSuffix {
  getDomain(host: string): string | null | undefined;
}

export interface DomainPattern {
  readonly kind: "exact" | "subdomains";
  /** Lowercase punycode host, with no trailing dot. */
  readonly host: string;
}

// The URL parser would drop tabs, read a port, or decode %, so refuse them first.
const NOT_HOST = /[\s/\\:@%?#*[\]]/;
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

const bad = (input: unknown, why: string) => new FoxgateError("bad-domain", `${JSON.stringify(input)} is not a valid domain: ${why}.`);

/** Lowercase punycode form of a host name. Throws FoxgateError `bad-domain` for anything that is not only a host. */
export function normalizeHost(input: string): string {
  if (typeof input !== "string" || input === "") throw bad(input, "it is empty");
  if (NOT_HOST.test(input)) throw bad(input, "give a host only, with no scheme, port, path, or *");
  const host = input.endsWith(".") ? input.slice(0, -1) : input;
  let parsed: string;
  try {
    parsed = new URL(`http://${host}/`).hostname;
  } catch {
    throw bad(input, "the host name is not valid");
  }
  if (host === "" || parsed === "" || parsed.split(".").includes("")) throw bad(input, "it has an empty label");
  return parsed;
}

/**
 * Parse a grant pattern. A "*." pattern needs a public suffix list, and it
 * cannot be on a public suffix (`*.com`, `*.github.io`) or an IP address.
 */
export function parsePattern(pattern: string, publicSuffix?: PublicSuffix): DomainPattern {
  if (typeof pattern !== "string" || !pattern.startsWith("*.")) return { kind: "exact", host: normalizeHost(pattern) };
  const host = normalizeHost(pattern.slice(2));
  if (IPV4.test(host)) throw bad(pattern, "a *. pattern cannot be on an IP address");
  let domain: string | null | undefined = null;
  try {
    domain = publicSuffix?.getDomain(host);
  } catch {
    domain = null;
  }
  if (!publicSuffix) throw bad(pattern, "a *. pattern needs a public suffix list (the publicSuffix option)");
  if (!domain) throw bad(pattern, "a *. pattern cannot be on a public suffix");
  return { kind: "subdomains", host };
}

/** True when a normalized host is allowed by the pattern. */
export function matchesPattern(host: string, pattern: DomainPattern): boolean {
  return pattern.kind === "exact" ? host === pattern.host : host.endsWith(`.${pattern.host}`);
}

/**
 * Check that a host is a registrable domain (eTLD+1), the "site" of a user
 * rule. Returns it normalized. Throws FoxgateError `bad-domain` for a
 * subdomain, a public suffix, an IP address, or no public suffix list.
 */
export function parseSite(site: string, publicSuffix?: PublicSuffix): string {
  const host = normalizeHost(site);
  if (IPV4.test(host)) throw bad(site, "a site cannot be an IP address");
  if (!publicSuffix) throw bad(site, "a site needs a public suffix list (the publicSuffix option)");
  let domain: string | null | undefined;
  try {
    domain = publicSuffix.getDomain(host);
  } catch {
    domain = null;
  }
  if (domain !== host) throw bad(site, domain ? `give the registrable domain ${domain}` : "it is a public suffix or has no registrable domain");
  return host;
}

/** True when a normalized host is the site or one of its subdomains. */
export const onSite = (host: string, site: string) => host === site || host.endsWith(`.${site}`);
