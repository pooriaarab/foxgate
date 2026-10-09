// The demo background (an MV3 event page). It runs foxgate with the real
// browser.storage.local and browser.publicSuffix. A simulated agent asks to
// submit a checkout form. The popup is the human side: it approves or rejects.
// The signing key lives only in this page's memory. If Firefox unloads the
// page, old tokens stop working (they fail closed).
import { createFoxgate, storageAreaStore } from "../src/index.ts";

const log = [];
const { gate, host } = createFoxgate({
  store: storageAreaStore(browser.storage.local),
  publicSuffix: browser.publicSuffix,
  onDecision: (event) => {
    const d = event.decision;
    log.unshift(`${event.kind}: ${d.decision === "deny" ? `deny ${d.reason}` : d.decision}`);
    log.length = Math.min(log.length, 12);
  },
});

const DEMO_ACTION = {
  tool: "submit_form",
  args: { form: "#checkout", fields: { email: "sam@example.com", plan: "basic" } },
  domain: "checkout.example.com",
  scope: "submit",
};
// The agent's copy. It changes the plan after the human said yes.
const CHANGED_ACTION = { ...DEMO_ACTION, args: { ...DEMO_ACTION.args, fields: { ...DEMO_ACTION.args.fields, plan: "pro" } } };

// What the simulated agent holds: its last request and the token for it.
const agent = { requestId: undefined, token: undefined };

let ready;
// The host adds the demo grant one time. The agent cannot add grants.
const setup = () =>
  (ready ??= host.grants().then((grants) => grants.length > 0 || host.addGrant({ scope: "submit", domains: ["*.example.com"], tools: ["submit_form"] })));

const show = (d) => (d.decision === "deny" ? `deny: ${d.reason}` : d.decision === "ask" ? `ask: ${d.requestId}` : "allow");

const handlers = {
  async "agent:ask"() {
    const decision = await gate.check(DEMO_ACTION);
    if (decision.decision === "ask") agent.requestId = decision.requestId;
    return show(decision);
  },
  async "agent:redeem"({ changed }) {
    return show(await gate.redeem(agent.token ?? "", changed ? CHANGED_ACTION : DEMO_ACTION));
  },
  async "host:approve"({ id }) {
    const token = await host.approve(id);
    // The host gives the token to the agent. The agent never sees the key.
    if (id === agent.requestId) agent.token = token;
    return { tokenFor: id };
  },
  async "host:reject"({ id }) {
    await host.reject(id);
  },
  async "host:state"() {
    return { pending: await host.pending(), log, tokenFor: agent.token ? agent.requestId : undefined };
  },
  async "host:grant"({ domains }) {
    try {
      await host.addGrant({ scope: "read", domains });
      return { error: null };
    } catch (error) {
      return { error: error.code ?? String(error) };
    }
  },
};

browser.runtime.onMessage.addListener((message) => {
  const handler = handlers[message?.type];
  return handler ? setup().then(() => handler(message)) : undefined;
});
