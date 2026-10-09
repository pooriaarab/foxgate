# Failure modes

This file lists every way a foxgate part can fail. Each failure mode has a
test or an E2E check. The test comes first, then the code.

foxgate stands between an AI agent and the actions it wants to do. A failure
here lets an agent do something that the user did not allow. So every part
fails closed: when foxgate is not sure, the answer is "deny".

## Canonical JSON

An approval token is bound to the canonical JSON of one action. Two actions
that mean the same thing must give the same text. Two actions that differ in
any way must give different text.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| C1 | The same object has its keys in a different order. | The canonical text is the same. Key order has no meaning in JSON. | `tests/canonical.test.ts` |
| C2 | An array has the same items in a different order. | The canonical text is different. Array order has a meaning. | `tests/canonical.test.ts` |
| C3 | A value changes type but looks the same (`1` and `"1"`, `true` and `"true"`). | The canonical text is different. | `tests/canonical.test.ts` |
| C4 | A value is not JSON: `undefined`, `NaN`, `Infinity`, a BigInt, a function, a symbol, a `Date`, a `Map`, or a class instance. | Throw a `FoxgateError` with code `not-json`. Never drop the value or turn it into `null`. | `tests/canonical.test.ts` |
| C5 | An array has a hole (`[1, , 3]`). | Throw `not-json`. `JSON.stringify` writes `null` there, which changes the action. | `tests/canonical.test.ts` |
| C6 | The value has a cycle, or it is nested more than 32 levels deep. | Throw `not-json`. Do not overflow the stack. | `tests/canonical.test.ts` |
| C7 | The canonical text is larger than 64 KiB. | Throw `too-large`. A human cannot check an action that size. | `tests/canonical.test.ts` |
| C8 | Two strings look the same but have different bytes (NFC `é` and NFD `e` + accent). | The canonical text is different. foxgate does not normalize strings, so the bytes that the human approves are the bytes that run. | `tests/canonical.test.ts` |
| C9 | An object has the key `__proto__` as data (from `JSON.parse`). | Keep the key in the canonical text. `{"__proto__": 1}` is not equal to `{}`. | `tests/canonical.test.ts` |
| C10 | The canonical text is not valid JSON. | `JSON.parse` of the text gives back an equal value. | `tests/canonical.test.ts` |

## Domains and domain patterns

A grant allows an exact host (`shop.example.com`) or all subdomains of a host
(`*.example.com`). An agent can try to reach a host that only looks allowed.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| D1 | The host has the allowed name inside a longer label: `evil-example.com` against `example.com` or `*.example.com`. | No match. Matching is by whole labels only. | `tests/domain.test.ts` |
| D2 | The allowed name is at the start of a longer host: `example.com.evil.com` against `example.com`. | No match. | `tests/domain.test.ts` |
| D3 | `*.example.com` and the host `example.com`. | No match. A `*.` pattern allows subdomains only. Add `example.com` too to allow it. `a.example.com` and `a.b.example.com` match. | `tests/domain.test.ts` |
| D4 | The host has uppercase letters or a trailing dot (`EXAMPLE.com.`). | Normalize to `example.com`. Then match. | `tests/domain.test.ts` |
| D5 | The host or the pattern is an internationalized name (`bücher.de`). | Convert both to punycode (`xn--bcher-kva.de`). The Unicode and punycode forms match each other. | `tests/domain.test.ts` |
| D6 | The host uses a letter from another script that looks like a Latin letter (Cyrillic `а` in `аpple.com`). | The punycode form is different (`xn--pple-43d.com`), so there is no match with `apple.com`. | `tests/domain.test.ts` |
| D7 | The input is not only a host: it has a scheme, a port, a path, a user name, a space, a backslash, or a `%`. | Throw a `FoxgateError` with code `bad-domain`. Never guess the host from a URL. | `tests/domain.test.ts` |
| D8 | The input is empty, `*`, `*.`, or has an empty label (`a..b`). | Throw `bad-domain`. | `tests/domain.test.ts` |
| D9 | The pattern puts `*` in a wrong place (`a.*.com`, `*example.com`, `**.example.com`). | Throw `bad-domain`. | `tests/domain.test.ts` |
| D10 | A `*.` pattern is on a public suffix (`*.com`, `*.co.uk`, `*.github.io`). Such a pattern allows sites that many different owners control. | Throw `bad-domain`. Use the public suffix list to decide. | `tests/domain.test.ts` |
| D11 | There is no public suffix list, or the list throws. | Refuse every `*.` pattern with `bad-domain`. Exact hosts still work. | `tests/domain.test.ts` |
| D12 | The host is an IP address. | An exact IP pattern matches the same IP. A `*.` pattern on an IP throws `bad-domain`. | `tests/domain.test.ts` |

## Grants and the policy check

The host (your app, not the AI planner) adds grants. `gate.check(action)`
answers `allow`, `deny` with a reason, or `ask`. The planner holds only the
`gate` object. It cannot add grants or approve requests.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| G1 | No grant matches the action, or there are no grants at all. | `deny` with reason `no-grant`. Deny is the default. | `tests/gate.test.ts` |
| G2 | The action scope is not the scope that the host registered for the tool, or no grant has the scope of the action. | `deny` `wrong-scope` for the first. `deny` `no-grant` for the second. A scope allows only itself. | `tests/gate.test.ts` |
| G3 | The action domain or tool is not in the grant. | `deny` `no-grant`. | `tests/gate.test.ts` |
| G4 | The planner puts its own grant or approval into the action (`grant`, `grantId`, `approved: true`). | `deny` `bad-action`. An action has five known fields and no others. | `tests/gate.test.ts` |
| G5 | The planner tries to add a grant or approve a request through the `gate` object. | The `gate` object has only `check` and `redeem`, and it is frozen. | `tests/gate.test.ts` |
| G6 | The action has a bad shape: no tool, `args` that are not a JSON object, a bad domain, an unknown scope. | `deny` `bad-action`. `check` never throws for a bad action. | `tests/gate.test.ts` |
| G7 | The grant has expired (`now >= expiresAt`). | `deny` `expired`. | `tests/gate.test.ts` |
| G8 | The clock goes back after a grant expired. | The grant stays expired. foxgate stores the latest time it saw and never uses an earlier one. | `tests/gate.test.ts` |
| G9 | The grant has no uses left (`maxUses`). | `deny` `used-up`. Only `allow` uses a grant. `ask` and `deny` do not. | `tests/gate.test.ts` |
| G10 | The grant needs approval (the default for `submit` and `pay`). | `ask` with a request ID. The same action again, while the request waits, gives the same request ID. | `tests/gate.test.ts` |
| G11 | The planner floods the user with approval requests. | After 20 waiting requests, `deny` `too-many-requests`. | `tests/gate.test.ts` |
| G12 | The host gives a bad grant: no domains, a `*.` pattern on a public suffix, `expiresAt` in the past, `maxUses` of 0, an unknown field. | `addGrant` throws a `FoxgateError`. | `tests/gate.test.ts` |
| G13 | The storage lost its data, holds data in a wrong shape, or throws. | Lost data: `deny` `no-grant`. Wrong shape or a throw: `deny` `storage-error`. Never `allow`. | `tests/gate.test.ts` |
| G14 | The `onDecision` hook throws (for example, the audit log is full). | `deny` `hook-failed`, and the grant use is not counted. Each decision calls the hook one time. | `tests/gate.test.ts` |
| G15 | The host revokes a grant. | The next check gives `deny` `no-grant`. | `tests/gate.test.ts` |
| G16 | Two grants match and the first one has no uses left. | foxgate uses the second grant. | `tests/gate.test.ts` |

## The tool registry

The planner writes the action, so it can lie about the scope and the amount.
The host registers each tool with its scope. For a tool that costs money, the
host also gives a function that reads the amount from the args. foxgate uses
the registry, not the planner, for both.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| P1 | The planner gives a lower scope for a tool (`click_buy_now` as `read`) to pass a `read` grant. | `deny` `wrong-scope`. | `tests/tools.test.ts` |
| P2 | The planner uses a tool that the host did not register, also when a grant has no `tools` list. | `deny` `unknown-tool`. A new tool is blocked until the host registers it. | `tests/tools.test.ts` |
| P3 | The planner gives a lower `amount` than the args (`args.total` 99999, `amount` 1). | `deny` `wrong-amount`. The spend cap counts the amount from the host function. | `tests/tools.test.ts` |
| P4 | The planner leaves out the amount. | foxgate puts the host amount into the action. The approval text shows it, and the spend cap counts it. | `tests/tools.test.ts` |
| P5 | The planner gives an amount for a tool that has no amount function. | `deny` `wrong-amount`. | `tests/tools.test.ts` |
| P6 | The registry is bad: empty, an unknown scope, or a `pay` tool with no amount function. | `createFoxgate` throws a `FoxgateError` with code `bad-tools`. | `tests/tools.test.ts` |
| P7 | The amount function throws or returns an amount that is not whole minor units. | `deny` `bad-action`. | `tests/tools.test.ts` |
| P8 | The tool name is a name that every object has, such as `toString` or `__proto__`. | `deny` `unknown-tool`. Only names that the host wrote count. | `tests/tools.test.ts` |

## The clock

foxgate compares times to decide expiry. A clock value that is not a number
makes every comparison false, so nothing would ever expire.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| K1 | The `now` option returns `NaN`, `Infinity`, or something that is not a number. | `check` and `redeem` give `deny` `clock-error`. `addGrant`, `approve`, `reject`, and `pending` throw a `FoxgateError` with code `bad-state`. | `tests/clock.test.ts` |
| K2 | The stored time is not a finite number. | `deny` `storage-error`. Never use that time. | `tests/clock.test.ts` |
| K3 | The clock is bad for one call, then good again. | The bad call saves nothing. Grants that expired before stay expired. | `tests/clock.test.ts` |

## Spend caps

A grant can have a spend cap: an amount in minor units (cents) and a currency.
The cap is for all actions together, not for each action.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| S1 | The action amount takes the total over the cap. | `deny` `spend-cap`, also on a grant that needs approval. Never `ask` for an action that cannot be allowed. | `tests/gate.test.ts` |
| S2 | The action currency is not the cap currency. | `deny` `currency`. foxgate does not convert money. | `tests/gate.test.ts` |
| S3 | Two actions run at the same time. Each one is under the cap, but both together are over it. | Exactly one `allow`. Checks run one at a time. | `tests/gate.test.ts` |
| S4 | The amount is not a whole number of minor units (`12.5`, `-1`, more than 2^53). | `deny` `bad-action`. | `tests/gate.test.ts` |
| S5 | The app restarts. | A new gate on the same storage sees the amount already spent. | `tests/gate.test.ts` |
| S6 | The host gives a spend cap that is not whole minor units. | `addGrant` throws a `FoxgateError`. | `tests/gate.test.ts` |

## Exact-action approvals

When `check` answers `ask`, a human sees the exact canonical JSON of the
action. `host.approve(id)` mints a token. The token holds a SHA-256 digest of
that text, an expiry time, and a one-time nonce, signed with an HMAC-SHA256
key that JavaScript cannot export. `gate.redeem(token, action)` allows the
action only if every byte of it is the same.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| A1 | The planner uses a token a second time (replay). | `deny` `token-used`. | `tests/approvals.test.ts` |
| A2 | The planner uses a token for a different action: one changed arg (also the arg that sets the amount), domain, or tool. | `deny` `action-changed`. | `tests/approvals.test.ts` |
| A3 | The planner sends the same action with the args keys in a different order, or the domain in uppercase. | `allow`. Canonical JSON and the domain rules make them the same action. | `tests/approvals.test.ts` |
| A4 | The token is changed (a later expiry, a different request ID, a changed signature) or is not a token at all. | `deny` `bad-token`. | `tests/approvals.test.ts` |
| A5 | The planner signs its own token with its own key. | `deny` `bad-token`. Only the gate key can sign, and the gate never shows it. | `tests/approvals.test.ts` |
| A6 | The token has expired, also when the clock goes back after the expiry. | `deny` `token-expired`. | `tests/approvals.test.ts` |
| A7 | The host approves a request that does not exist, has expired, or is not waiting. | `approve` throws a `FoxgateError` with code `not-found`. | `tests/approvals.test.ts` |
| A8 | The human rejects a request, and the planner asks again with the same action. | `deny` `rejected` until the request expires. | `tests/approvals.test.ts` |
| A9 | After the approval, the host revokes the grant, or other actions use up the spend cap. | `redeem` checks the grant again: `deny` `no-grant` or `spend-cap`. An approval never skips the grant rules. | `tests/approvals.test.ts` |
| A10 | The planner redeems one token twice at the same time. | Exactly one `allow`. | `tests/approvals.test.ts` |
| A11 | The storage lost its data after the approval. | `deny` `bad-token`. foxgate keeps a list of valid nonces, not of used ones, so lost data cannot make a token valid. | `tests/approvals.test.ts` |
| A12 | The app gives a key that JavaScript can export, or a key that is not HMAC. | `createFoxgate` throws a `FoxgateError` with code `bad-key`. | `tests/approvals.test.ts` |
| A13 | The planner tries a changed action first, then the approved one. | The first try uses the token up. The second gets `deny` `token-used`. A planner that changes an approved action is not trusted again. | `tests/approvals.test.ts` |
| A14 | The `onDecision` hook throws during `approve`. | `approve` throws. The request still waits, and no token exists. | `tests/approvals.test.ts` |

## Storage adapters

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| T1 | A `browser.storage.local` style area returns `{ key: value }` from `get`, not the value. | `storageAreaStore(area)` returns the value, and `undefined` for a missing key. The demo extension E2E test runs it on the real `browser.storage.local`. | `tests/approvals.test.ts` |

## The demo extension in Firefox

`pnpm e2e` loads the built demo extension in a real Firefox and drives its
popup. The checks below need a real browser, so the E2E test covers them.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| E1 | The approval view does not show the exact action, so a human approves something they did not see. | The waiting request shows the full canonical JSON, byte for byte. | `e2e/run.mjs` |
| E2 | The agent changes the action after the human approves it. | The popup shows `deny: action-changed`. The token is then used up: the approved action gets `deny: token-used`. | `e2e/run.mjs` |
| E3 | The approved action runs two times. | The first redeem shows `allow`. The second shows `deny: token-used`. | `e2e/run.mjs` |
| E4 | The real Firefox public suffix list (`browser.publicSuffix`, Firefox 153+) is missing or not used. | The background refuses a `*.co.uk` grant with `bad-domain` and takes `*.example.co.uk`. | `e2e/run.mjs` |
| E5 | The state does not reach `browser.storage.local`, or the signing key goes there. | `storage.local` holds the grants and requests. It holds no key. | `e2e/run.mjs` |
| E6 | The human clicks Deny. | The request leaves the list, and the same action gets `deny: rejected`. | `e2e/run.mjs` |
