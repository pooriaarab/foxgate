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
| G2 | The action scope is not the grant scope (a `fill` grant and a `submit` action). | `deny` `no-grant`. A scope allows only itself. | `tests/gate.test.ts` |
| G3 | The action domain or tool is not in the grant. | `deny` `no-grant`. | `tests/gate.test.ts` |
| G4 | The planner puts its own grant or approval into the action (`grant`, `grantId`, `approved: true`). | `deny` `bad-action`. An action has five known fields and no others. | `tests/gate.test.ts` |
| G5 | The planner tries to add a grant or approve a request through the `gate` object. | The `gate` object has only `check` and `redeem`, and it is frozen. | `tests/gate.test.ts` |
| G6 | The action has a bad shape: no tool, `args` that are not a JSON object, a bad domain, an unknown scope, a `pay` action with no amount. | `deny` `bad-action`. `check` never throws for a bad action. | `tests/gate.test.ts` |
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
| S6 | The host gives a spend cap that is not whole minor units, or a `pay` action has no amount. | `addGrant` throws a `FoxgateError`. The action gets `deny` `bad-action`. | `tests/gate.test.ts` |
