// The demo popup: the human side. It shows each waiting request with the
// exact JSON that a token will be bound to, and Approve and Deny buttons.
const send = (type, extra = {}) => browser.runtime.sendMessage({ type, ...extra });
const $ = (id) => document.getElementById(id);

// A letter avatar for the site. The hue comes from the name, so one site
// keeps one color. style.setProperty is CSSOM, which the CSP allows.
function siteIcon(site) {
  const box = Object.assign(document.createElement("span"), { className: "site-icon", textContent: (site[0] ?? "?").toUpperCase() });
  let hue = 0;
  for (const c of site) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  box.style.setProperty("--hue", String(hue));
  box.setAttribute("aria-hidden", "true");
  return box;
}

const shown = new Set();
const el = (tag, className, textContent) => Object.assign(document.createElement(tag), { className, textContent });

async function render() {
  const state = await send("host:state");
  $("none").hidden = state.pending.length > 0;
  $("pending").replaceChildren(
    ...state.pending.map((request) => {
      const li = document.createElement("li");
      li.dataset.id = request.id;
      // Only a new card animates in; a re-render keeps the others still.
      if (!shown.has(request.id)) li.classList.add("new");
      shown.add(request.id);
      const head = el("div", "ask-head");
      head.append(siteIcon(request.action.domain), el("span", "site", request.action.domain));
      const what = el("div", "what", `Wants to ${request.action.tool.replaceAll("_", " ")}. Scope: ${request.action.scope}.`);
      const text = el("pre", "", request.text);
      const approve = el("button", "approve primary", "Approve");
      const reject = el("button", "reject ghost", "Deny");
      approve.addEventListener("click", () => send("host:approve", { id: request.id }).then(render));
      reject.addEventListener("click", () => send("host:reject", { id: request.id }).then(render));
      const answers = el("div", "answers");
      answers.append(reject, approve);
      li.append(head, what, el("p", "caption", "The token binds to this exact action:"), text, answers);
      return li;
    }),
  );
  $("log").replaceChildren(
    ...state.log.map((line) => {
      const [kind, ...rest] = line.split(": ");
      const li = el("li", rest.join(": ").startsWith("deny") ? "bad" : "", ` ${rest.join(": ")}`);
      li.prepend(el("span", "kind", kind));
      return li;
    }),
  );
  $("redeem").disabled = $("tamper").disabled = !state.tokenFor;
  if (state.tokenFor) document.body.dataset.token = state.tokenFor;
  else delete document.body.dataset.token;
}

// Show an answer and count it in data-runs, so a repeated answer is still
// a new answer (E8).
function answer(output, text) {
  output.textContent = text;
  output.dataset.runs = String(Number(output.dataset.runs ?? 0) + 1);
}

$("ask").addEventListener("click", async () => {
  const text = await send("agent:ask");
  await render();
  answer($("asked"), text);
});
for (const [id, changed] of [["redeem", false], ["tamper", true]]) {
  $(id).addEventListener("click", async () => {
    const text = await send("agent:redeem", { changed });
    await render();
    answer($("result"), text);
  });
}
render().then(() => (document.body.dataset.ready = "1"));
