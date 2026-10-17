// Themes: each one sets the UI's CSS variables and the chart palette (background, grid, candle/volume colors).
// A few themes also add a body class for effects that variables alone can't express (glass blur, focus dimming).
import { store, esc, bus, modal } from "./util.js";

const base = {
  "--bg": "#0f1115", "--panel": "#161a20", "--panel2": "#1d222a", "--panel3": "#242a33", "--line": "#2a3039",
  "--text": "#e6e8eb", "--muted": "#8a919c", "--up": "#22ab94", "--down": "#f23645", "--accent": "#2962ff", "--accent2": "#5b8cff",
  "--warn": "#f7c948", "--font": "Inter, system-ui, sans-serif", "--radius": "6px", "--accent-ink": "#ffffff",
  "--on-up": "#ffffff", "--on-down": "#ffffff", // text on Buy/Sell buttons
};

/** chart: bg, text, grid, up, down, line (line/area series), crosshair. grid: false hides gridlines. */
export const THEMES = [
  {
    id: "midnight", name: "Midnight", group: "Classic", isDefault: true,
    tagline: "The classic dark trading desk. Easy on the eyes for long sessions.",
    vars: base,
    chart: { bg: "#0f1115", text: "#9aa1ac", grid: "#1a1f26", up: "#22ab94", down: "#f23645", line: "#2962ff", crosshair: "#758696" },
  },
  {
    id: "daylight", name: "Daylight", group: "Classic",
    tagline: "Clean light mode for bright rooms and daytime trading.",
    vars: { ...base, "--bg": "#ffffff", "--panel": "#f6f7f9", "--panel2": "#eceef2", "--panel3": "#e2e5ea", "--line": "#d9dde3", "--text": "#131722", "--muted": "#6a7280", "--accent": "#2962ff", "--accent2": "#1e53e5", "--warn": "#c98a00" },
    chart: { bg: "#ffffff", text: "#4b5563", grid: "#f0f2f5", up: "#089981", down: "#f23645", line: "#2962ff", crosshair: "#9aa1ac" },
  },
  {
    id: "glass", name: "Glossy Glass", group: "Style", bodyClass: "theme-glass",
    tagline: "Frosted glass panels floating over a slow-moving aurora gradient.",
    vars: { ...base, "--bg": "#0b1020", "--panel": "rgba(255,255,255,0.07)", "--panel2": "rgba(255,255,255,0.10)", "--panel3": "rgba(255,255,255,0.16)", "--line": "rgba(255,255,255,0.14)", "--text": "#f2f5ff", "--muted": "#aab3d0", "--up": "#3ee0b5", "--down": "#ff6b8b", "--accent": "#7c5cff", "--accent2": "#a99bff", "--radius": "12px", "--on-up": "#04221a", "--menu-bg": "#1a1d42" }, // menus need a solid colour
    chart: { bg: "rgba(0,0,0,0)", text: "#c8cfea", grid: "rgba(255,255,255,0.06)", up: "#3ee0b5", down: "#ff6b8b", line: "#a99bff", crosshair: "#c8cfea" },
  },
  {
    id: "aesthetic", name: "Aesthetic", group: "Style", bodyClass: "theme-aesthetic",
    tagline: "Soft pastel lavender and peach with rounded, friendly type.",
    vars: { ...base, "--bg": "#fbf7ff", "--panel": "#f4ecff", "--panel2": "#ebe0fb", "--panel3": "#e1d3f7", "--line": "#e0d4f2", "--text": "#3d2f55", "--muted": "#8a7aa6", "--up": "#5cc9a7", "--down": "#f28fad", "--accent": "#b48cf2", "--accent2": "#9a6ee8", "--warn": "#f2b880", "--font": "Quicksand, Inter, sans-serif", "--radius": "14px" },
    chart: { bg: "#fffaff", text: "#7d6c99", grid: "#f3ebfd", up: "#5cc9a7", down: "#f28fad", line: "#b48cf2", crosshair: "#b8a7d4" },
  },
  {
    id: "mono", name: "Black & White", group: "Style",
    tagline: "Pure monochrome. Hollow candles go up, solid candles go down — no color at all.",
    vars: { ...base, "--bg": "#000000", "--panel": "#0a0a0a", "--panel2": "#151515", "--panel3": "#202020", "--line": "#2c2c2c", "--text": "#ffffff", "--muted": "#9a9a9a", "--up": "#ffffff", "--down": "#8a8a8a", "--accent": "#ffffff", "--accent2": "#ffffff", "--warn": "#ffffff", "--accent-ink": "#000000", "--on-up": "#000000", "--on-down": "#000000" },
    chart: { bg: "#000000", text: "#bdbdbd", grid: "#141414", up: "#ffffff", down: "#7a7a7a", line: "#ffffff", crosshair: "#9a9a9a", hollowUp: true },
  },
  {
    id: "paper", name: "White & Black", group: "Style",
    tagline: "The reverse of Black & White: a pure white page in black ink. Outlined candles go up, solid black candles go down.",
    vars: { ...base, "--bg": "#ffffff", "--panel": "#ffffff", "--panel2": "#f2f2f2", "--panel3": "#e6e6e6", "--line": "#d0d0d0", "--text": "#000000", "--muted": "#666666", "--up": "#000000", "--down": "#6b6b6b", "--accent": "#000000", "--accent2": "#000000", "--warn": "#000000", "--accent-ink": "#ffffff", "--on-up": "#ffffff", "--on-down": "#ffffff" },
    chart: { bg: "#ffffff", text: "#333333", grid: "#f0f0f0", up: "#000000", down: "#000000", line: "#000000", crosshair: "#888888", hollowUp: true },
  },
  {
    id: "terminal", name: "Terminal", group: "Style", bodyClass: "theme-terminal",
    tagline: "Old-school green phosphor on black, monospace everything.",
    vars: { ...base, "--bg": "#020a02", "--panel": "#061206", "--panel2": "#0b1d0b", "--panel3": "#102810", "--line": "#143314", "--text": "#7dff7d", "--muted": "#3fa83f", "--up": "#39ff14", "--down": "#ff5555", "--accent": "#39ff14", "--accent2": "#7dff7d", "--warn": "#ffd700", "--font": "'JetBrains Mono', Consolas, monospace", "--radius": "2px", "--accent-ink": "#001a00", "--on-up": "#001a00" },
    chart: { bg: "#020a02", text: "#3fa83f", grid: "#082008", up: "#39ff14", down: "#ff5555", line: "#39ff14", crosshair: "#3fa83f" },
  },
  {
    id: "sunset", name: "Sunset", group: "Style",
    tagline: "Warm dusk tones — deep plum with amber and coral highlights.",
    vars: { ...base, "--bg": "#1a1020", "--panel": "#24152b", "--panel2": "#2e1b36", "--panel3": "#3a2243", "--line": "#43294d", "--text": "#ffe9df", "--muted": "#c39aa8", "--up": "#ffb347", "--down": "#ff5e78", "--accent": "#ff7a59", "--accent2": "#ffa07f", "--warn": "#ffd166", "--on-up": "#2a1500" },
    chart: { bg: "#1a1020", text: "#c39aa8", grid: "#24152b", up: "#ffb347", down: "#ff5e78", line: "#ff7a59", crosshair: "#c39aa8" },
  },
  {
    id: "calm", name: "Calm Mind", group: "Trading psychology",
    tagline: "No alarm-red. Falling prices are a calm slate-blue and the grid is gone, so losses don't trigger panic selling or revenge trades.",
    why: "Bright red is wired to read as danger; seeing it on every down-candle raises stress and pushes impulsive exits. Muted blue keeps the information without the alarm.",
    vars: { ...base, "--bg": "#121821", "--panel": "#17202b", "--panel2": "#1d2834", "--panel3": "#24313f", "--line": "#2a3746", "--text": "#dfe7ef", "--muted": "#8796a6", "--up": "#6fbfa6", "--down": "#7f93b8", "--accent": "#6fa3c7", "--accent2": "#8fbad8", "--warn": "#d9b86c" },
    chart: { bg: "#121821", text: "#8796a6", grid: false, up: "#6fbfa6", down: "#7f93b8", line: "#6fa3c7", crosshair: "#6b7c8f" },
  },
  {
    id: "focus", name: "Focus", group: "Trading psychology", bodyClass: "theme-focus",
    tagline: "Dims everything except the chart until you hover it. Fewer flickering numbers, less overtrading.",
    why: "Constantly moving watchlist prices and P&L pull attention away from your plan. Dimming the periphery keeps the chart — and your setup — in focus.",
    vars: { ...base, "--bg": "#0c0d10", "--panel": "#111216", "--panel2": "#17191e", "--panel3": "#1e2026", "--line": "#23262d", "--text": "#e9eaee", "--muted": "#6f7480", "--accent": "#e9eaee", "--accent2": "#ffffff", "--accent-ink": "#0c0d10" },
    chart: { bg: "#0c0d10", text: "#8b909b", grid: false, up: "#2fbf9b", down: "#e5525e", line: "#e9eaee", crosshair: "#5d626c" },
  },
  {
    id: "colorblind", name: "Colour-blind safe", group: "Trading psychology",
    tagline: "Blue for up, orange for down — readable with red-green colour blindness (about 1 in 12 men).",
    vars: { ...base, "--up": "#3b8cff", "--down": "#ff9b26", "--accent": "#3b8cff", "--accent2": "#6aa8ff" },
    chart: { bg: "#0f1115", text: "#9aa1ac", grid: "#1a1f26", up: "#3b8cff", down: "#ff9b26", line: "#3b8cff", crosshair: "#758696" },
  },
];

const byId = (id) => THEMES.find((t) => t.id === id) || THEMES[0];
export const currentTheme = () => byId(store.get("theme", "midnight"));

/** Applies a theme to the page; listeners (chart, trading lines) receive "theme" with the palette. */
export function applyTheme(id) {
  const t = byId(id);
  const root = document.documentElement;
  // Clear variables set by the previous theme that this one doesn't define (e.g. Glass's --menu-bg).
  for (const k of new Set(THEMES.flatMap((x) => Object.keys(x.vars)))) if (!(k in t.vars)) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
  document.body.classList.remove(...THEMES.map((x) => x.bodyClass).filter(Boolean));
  if (t.bodyClass) document.body.classList.add(t.bodyClass);
  root.dataset.theme = t.id;
  root.style.colorScheme = ["daylight", "aesthetic", "paper"].includes(t.id) ? "light" : "dark";
  store.set("theme", t.id);
  bus.emit("theme", t);
  return t;
}

// ---------------- picker ----------------

/** A small mock of the app drawn in the theme's own colors. */
function thumbnail(t) {
  const v = t.vars, c = t.chart;
  // A fixed little price path so every thumbnail shows the same shape.
  const bars = [[50, 44, 52, 42], [44, 47, 49, 40], [47, 40, 48, 38], [40, 43, 45, 37], [43, 36, 44, 34], [36, 39, 41, 33], [39, 33, 40, 30], [33, 37, 38, 31], [37, 30, 38, 28], [30, 26, 32, 24], [26, 29, 30, 23], [29, 22, 30, 20]];
  const candles = bars.map(([o, cl, h, l], i) => {
    const x = 8 + i * 9, up = cl < o; // svg y grows downward: lower value = higher price
    const col = up ? c.up : c.down;
    const top = Math.min(o, cl), hgt = Math.max(1.5, Math.abs(o - cl));
    const body = up && c.hollowUp
      ? `<rect x="${x - 2.5}" y="${top}" width="5" height="${hgt}" fill="none" stroke="${col}" stroke-width="1"/>`
      : `<rect x="${x - 2.5}" y="${top}" width="5" height="${hgt}" fill="${col}"/>`;
    return `<line x1="${x}" x2="${x}" y1="${l}" y2="${h}" stroke="${col}" stroke-width="1"/>${body}`;
  }).join("");
  const grid = c.grid ? [20, 35, 50].map((y) => `<line x1="0" x2="120" y1="${y}" y2="${y}" stroke="${c.grid}" stroke-width="0.6"/>`).join("") : "";
  const glass = t.id === "glass";
  const outerBg = glass ? "linear-gradient(135deg,#1b1f4b,#3a1c5c 45%,#0f4c5c)" : t.id === "aesthetic" ? "linear-gradient(135deg,#fde7f3,#ece4ff 50%,#ffe9d6)" : v["--bg"];
  const panel = v["--panel"], line = v["--line"];
  return `<div class="th-thumb" style="background:${outerBg};font-family:${esc(v["--font"])}">
    <div class="th-head" style="background:${panel};border-bottom:1px solid ${line}"><i style="background:${v["--accent"]}"></i><span style="color:${v["--text"]}">AAPL</span><span style="color:${v["--up"]}">+1.2%</span></div>
    <div class="th-body">
      <div class="th-side" style="background:${panel};border-right:1px solid ${line}">${[0, 1, 2, 3].map(() => `<b style="background:${v["--muted"]}"></b>`).join("")}</div>
      <svg class="th-chart" viewBox="0 0 120 60" preserveAspectRatio="none" style="background:${c.bg === "rgba(0,0,0,0)" ? "transparent" : c.bg}">${grid}${candles}</svg>
      <div class="th-side right" style="background:${panel};border-left:1px solid ${line}">${[["up", 1], ["down", 0], ["up", 1]].map(([k]) => `<b style="background:${v["--" + k]}"></b>`).join("")}</div>
    </div>
  </div>`;
}

/** Opens the theme picker. `startup` adds the "show when LinkCharts opens" option. */
export function openThemePicker({ startup = false } = {}) {
  const groups = [...new Set(THEMES.map((t) => t.group))];
  const m = modal("Choose a theme", `
    <p class="muted th-intro">Pick how LinkCharts looks. You can change it any time from the 🎨 button in the top bar.</p>
    ${groups.map((g) => `<h4>${esc(g)}${g === "Trading psychology" ? ` <span class="muted small">— designed to help you trade calmer and more deliberately</span>` : ""}</h4>
      <div class="th-grid">${THEMES.filter((t) => t.group === g).map((t) => `
        <button class="th-card" data-theme-id="${t.id}" title="${esc(t.why || t.tagline)}">
          ${thumbnail(t)}
          <div class="th-meta"><b>${esc(t.name)}</b>${t.isDefault ? `<span class="pill">Default</span>` : ""}<span class="th-check">✓ Selected</span></div>
          <div class="muted small th-tag">${esc(t.tagline)}</div>
        </button>`).join("")}</div>`).join("")}
    <div class="row-end th-foot">
      <span class="spacer"></span>
      <button class="primary" data-close-picker>${startup ? "Start charting" : "Done"}</button>
    </div>`, { wide: true });
  const mark = () => m.el.querySelectorAll(".th-card").forEach((c) => c.classList.toggle("selected", c.dataset.themeId === currentTheme().id));
  m.el.closest(".modal")?.classList.add("theme-modal");
  mark();
  m.el.addEventListener("click", (e) => {
    const card = e.target.closest("[data-theme-id]");
    if (card) { applyTheme(card.dataset.themeId); mark(); return; }
    if (e.target.closest("[data-close-picker]")) m.close();
  });
  return m;
}
