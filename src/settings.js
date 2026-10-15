// "Data sources & API keys" dialog: one card per provider, plus per-market source routing.
import { api, esc, modal, toast, bus } from "./util.js";

export async function openSettings() {
  const m = modal("Data sources & API keys", `<div id="st-body" class="muted">Loading…</div>`, { wide: true });
  const body = m.el.querySelector("#st-body");

  const render = (data) => {
    const configurable = data.providers.filter((p) => !p.builtIn);
    const builtIn = data.providers.filter((p) => p.builtIn);
    body.className = "";
    body.innerHTML = `
      <p class="muted">Free sources work out of the box. Add your own keys to use a provider. Keys are saved only on this computer
      (<code>market-app/data/config.json</code>) and never sent anywhere except to that provider.</p>
      <h4>Built-in (free, no key)</h4>
      <div class="prov-grid">${builtIn.map((p) => `<div class="prov on"><div class="prov-head"><b>${esc(p.name)}</b><span class="pill ok">Always on</span>${p.live ? `<span class="pill live">Live</span>` : ""}</div>
        <div class="muted small">${esc(p.note)}</div><div class="small">Markets: ${p.markets.map((k) => esc(data.markets[k].split(" (")[0])).join(", ")}</div></div>`).join("")}</div>
      <h4>Your API keys</h4>
      <div class="prov-grid">${configurable.map((p) => `<form class="prov ${p.configured ? "on" : ""}" data-id="${p.id}">
        <div class="prov-head"><b>${esc(p.name)}</b>${p.configured ? `<span class="pill ok">Connected</span>` : `<span class="pill">Not set</span>`}</div>
        <div class="muted small">${esc(p.note)}</div>
        <div class="small">Markets: ${p.markets.map((k) => esc(data.markets[k].split(" (")[0])).join(", ")}</div>
        ${p.fields.map((f) => `<label class="field"><span>${esc(f.label)}</span>
          <input name="${f.key}" ${f.secret ? 'type="password" autocomplete="off"' : ""} placeholder="${esc(f.placeholder || "")}" value="${esc(f.value)}" /></label>`).join("")}
        <div class="row-end"><span class="test-result small"></span>
          ${p.configured ? `<button type="button" data-act="remove" class="danger">Remove</button><button type="button" data-act="test">Test</button>` : ""}
          <button type="submit" class="primary">Save</button></div>
      </form>`).join("")}</div>
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
        if (act === "remove" && confirm("Remove this provider's saved keys?")) {
          render(await api(`/api/providers/${id}`, { method: "DELETE" }));
          bus.emit("sources-changed");
        }
      };
    });
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
