// "Data sources & API keys" dialog: one card per provider, plus per-market source routing.
import { api, esc, modal, toast, bus, askConfirm } from "./util.js";

export async function openSettings() {
  const m = modal("Data sources & API keys", `<div id="st-body" class="muted">Loading…</div>`, { wide: true });
  const body = m.el.querySelector("#st-body");

  const render = (data) => {
    const markets = (p) => p.markets.map((k) => esc(data.markets[k].split(" (")[0])).join(", ");
    const optionalOnly = (p) => p.fields.length && p.fields.every((f) => f.optional);
    const status = (p) => p.builtIn ? `<span class="pill ok">Always on</span>`
      : optionalOnly(p) ? `<span class="pill ok">Ready · key optional</span>`
      : p.configured ? `<span class="pill ok">Connected</span>` : `<span class="pill">Not set</span>`;
    const card = (p) => p.builtIn
      ? `<div class="prov on"><div class="prov-head"><b>${esc(p.name)}</b>${status(p)}${p.live ? `<span class="pill live">Live</span>` : ""}</div>
          <div class="muted small">${esc(p.note)}</div><div class="small">Markets: ${markets(p)}</div></div>`
      : `<form class="prov ${p.configured ? "on" : ""}" data-id="${p.id}">
          <div class="prov-head"><b>${esc(p.name)}</b>${status(p)}</div>
          <div class="muted small">${esc(p.note)}</div>
          <div class="small">Markets: ${markets(p)}</div>
          ${p.fields.map((f) => `<label class="field"><span>${esc(f.label)}</span>
            <input name="${f.key}" ${f.secret ? 'type="password" autocomplete="off"' : ""} placeholder="${esc(f.placeholder || "")}" value="${esc(f.value)}" /></label>`).join("")}
          <div class="row-end"><span class="test-result small"></span>
            ${p.configured ? `${optionalOnly(p) ? "" : `<button type="button" data-act="remove" class="danger">Remove</button>`}<button type="button" data-act="test">Test</button>` : ""}
            <button type="submit" class="primary">Save</button></div>
        </form>`;
    const isBroker = (p) => !p.builtIn && !optionalOnly(p) && p.markets.length === 1 && p.markets[0] === "india";
    const groups = [
      ["Free — no key needed", data.providers.filter((p) => p.builtIn || optionalOnly(p))],
      ["Indian brokers (your own account)", data.providers.filter(isBroker)],
      ["Global data APIs (your own key)", data.providers.filter((p) => !p.builtIn && !optionalOnly(p) && !isBroker(p))],
    ];
    const connected = data.providers.filter((p) => !p.builtIn && !optionalOnly(p) && p.configured).length;
    body.className = "";
    body.innerHTML = `
      <p class="muted">${data.providers.length} data sources. Free ones work out of the box; add your own keys to use the others
      (${connected} connected). Keys are saved only on this computer (<code>market-app/data/config.json</code>) and are only ever sent to that provider.</p>
      <input class="wide-input" id="st-filter" placeholder="Filter providers… (e.g. India, crypto, Alpaca)" autocomplete="off" />
      ${groups.map(([title, list]) => `<h4>${esc(title)} · ${list.length}</h4><div class="prov-grid">${list.map(card).join("")}</div>`).join("")}
      <h4>Which source to use for each market</h4>
      <table class="tbl route"><tr><th>Market</th><th>Source</th></tr>
      ${Object.entries(data.markets).map(([mk, label]) => {
        const options = data.providers.filter((p) => p.markets.includes(mk));
        return `<tr><td>${esc(label)}</td><td><select data-market="${mk}">
          <option value="auto" ${data.routing[mk] === "auto" ? "selected" : ""}>Automatic (best connected source)</option>
          ${options.map((p) => `<option value="${p.id}" ${data.routing[mk] === p.id ? "selected" : ""} ${p.configured ? "" : "disabled"}>${esc(p.name)}${p.configured ? "" : " — add key first"}</option>`).join("")}
        </select></td></tr>`;
      }).join("")}</table>
      <p class="muted small">If the chosen source fails (expired token, rate limit, unsupported symbol) the app falls back to Yahoo and shows why next to the source badge.</p>`;

    body.querySelectorAll("form.prov").forEach((form) => {
      const id = form.dataset.id;
      const result = form.querySelector(".test-result");
      form.onsubmit = async (e) => {
        e.preventDefault();
        const values = Object.fromEntries(new FormData(form));
        try {
          render(await api(`/api/providers/${id}`, { body: values }));
          toast("Saved. Click Test to check the connection.", "ok");
          bus.emit("sources-changed");
        } catch (err) { result.textContent = err.message; result.className = "test-result small down"; }
      };
      form.onclick = async (e) => {
        const act = e.target.dataset.act;
        if (act === "test") {
          result.textContent = "Testing…"; result.className = "test-result small muted";
          try {
            const r = await api(`/api/providers/${id}/test`, {});
            result.textContent = `✓ Works — ${r.candles} daily bars for ${r.symbol} in ${r.ms} ms`;
            result.className = "test-result small up";
          } catch (err) { result.textContent = "✕ " + err.message; result.className = "test-result small down"; }
        }
        if (act === "remove" && await askConfirm("Remove keys", "Remove this provider's saved keys from this computer?", { okText: "Remove", danger: true })) {
          render(await api(`/api/providers/${id}`, { method: "DELETE" }));
          bus.emit("sources-changed");
        }
      };
    });
    const filter = body.querySelector("#st-filter");
    filter.oninput = () => {
      const q = filter.value.toLowerCase();
      body.querySelectorAll(".prov").forEach((el) => (el.hidden = !!q && !el.textContent.toLowerCase().includes(q)));
    };
    body.querySelectorAll("select[data-market]").forEach((sel) => {
      sel.onchange = async () => {
        render(await api("/api/routing", { body: { [sel.dataset.market]: sel.value } }));
        toast("Source updated", "ok");
        bus.emit("sources-changed");
      };
    });
  };

  try { render(await api("/api/providers")); } catch (err) { body.textContent = err.message; }
}
