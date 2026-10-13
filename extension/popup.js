// The demo popup: the human side. Each waiting request is one card: the
// site, one line of what happens, the exact JSON that a token binds to
// behind Details, and Deny and Approve. An answered card keeps one line.
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
// Cards that got an answer here. They stay, with one line instead of the buttons.
const answered = new Map();
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
      const exact = visibleAction(request.action);
      const text = el("pre", "", request.text);
      const approve = el("button", "approve primary", "Approve");
      const reject = el("button", "reject ghost", "Deny");
      approve.addEventListener("click", () => send("host:approve", { id: request.id }).then(() => settle(li, "Approved.")));
      reject.addEventListener("click", () => send("host:reject", { id: request.id }).then(() => settle(li, "Denied.")));
      const answers = el("div", "answers");
      answers.append(reject, approve);
      const details = el("details", "raw");
      details.append(el("summary", "", "Details"), el("p", "caption", "The token binds to this exact action:"), text);
      li.append(head, ...exact, details, answers);
      return li;
    }),
    ...answered.values(),
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

// What the token binds, in view: the tool and form, every field and its
// value, the scope and any amount. Details adds only the raw JSON. The
// user must see each value that changes the effect before Approve.
function visibleAction(action) {
  const { fields = {}, form, ...rest } = action.args ?? {};
  const verb = action.tool.replaceAll("_", " ");
  const lines = [el("p", "what", `${verb[0].toUpperCase()}${verb.slice(1)}${form ? ` ${form}` : ""}.`)];
  const values = [...Object.entries(fields), ...Object.entries(rest)];
  if (values.length) {
    const list = el("ul", "fields");
    list.setAttribute("aria-label", "Values the token binds");
    for (const [key, value] of values) list.append(el("li", "", `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`));
    lines.push(list);
  }
  lines.push(el("p", "scope", `Scope: ${action.scope}${action.amount ? `. Amount: ${JSON.stringify(action.amount)}` : ""}.`));
  return lines;
}

// An answered card: no buttons, one line, a quiet frame. It drops data-id,
// so a test or a re-render does not take it for a waiting request.
function settle(li, text) {
  answered.set(li.dataset.id, li);
  delete li.dataset.id;
  li.classList.remove("new");
  li.classList.add("settled");
  // The answer takes the focus from the pressed button and is announced.
  const done = el("p", "answered", text);
  done.tabIndex = -1;
  done.setAttribute("role", "status");
  li.querySelector(".answers").replaceWith(done);
  done.focus();
  return render();
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
