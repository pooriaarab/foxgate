// The demo popup: the human side. It shows each waiting request with the
// exact JSON that a token will be bound to, and Approve and Deny buttons.
const send = (type, extra = {}) => browser.runtime.sendMessage({ type, ...extra });
const $ = (id) => document.getElementById(id);

async function render() {
  const state = await send("host:state");
  $("none").hidden = state.pending.length > 0;
  $("pending").replaceChildren(
    ...state.pending.map((request) => {
      const li = document.createElement("li");
      li.dataset.id = request.id;
      const what = document.createElement("div");
      what.textContent = `${request.action.tool} on ${request.action.domain} (scope ${request.action.scope})`;
      const text = document.createElement("pre");
      text.textContent = request.text;
      const approve = Object.assign(document.createElement("button"), { className: "approve", textContent: "Approve" });
      const reject = Object.assign(document.createElement("button"), { className: "reject", textContent: "Deny" });
      approve.addEventListener("click", () => send("host:approve", { id: request.id }).then(render));
      reject.addEventListener("click", () => send("host:reject", { id: request.id }).then(render));
      li.append(what, text, approve, reject);
      return li;
    }),
  );
  $("log").replaceChildren(...state.log.map((line) => Object.assign(document.createElement("li"), { textContent: line })));
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
