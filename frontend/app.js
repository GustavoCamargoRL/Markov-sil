/* ==========================================================================
   Markov-SIL — editor de cadeia de Markov + chamada ao solver
   ========================================================================== */
const R = 30;                    // raio dos estados (px)
const API = "";                  // mesma origem (a API serve o frontend)

/* --------------------------------- estado ------------------------------- */
let states = [];   // {id, x, y, label, fail, init}
let edges  = [];   // {id, from, to, rate}
let params = [
  { name: "lD", value: "5.0e-7" },
  { name: "lP", value: "5.0e-8" },
  { name: "lS", value: "2.5e-6" },
];
let sid = 0, eid = 0;
let mode = "select";
let selected = null;             // {type:'node'|'edge', id}
let drag = null;                 // {id, dx, dy, moved}
let link = null;                 // {from, mx, my}

const svg      = document.getElementById("svg");
const statusEl = document.getElementById("status");

/* ------------------------------ utilidades ------------------------------ */
const byId  = (arr, id) => arr.find(o => o.id === id);
const idx   = id => states.findIndex(s => s.id === id);
const label = s => s.label || ("S" + idx(s.id));

function svgPoint(evt) {
  const r = svg.getBoundingClientRect();
  const t = evt.touches ? evt.touches[0] : evt;
  return { x: t.clientX - r.left, y: t.clientY - r.top };
}
function toast(msg, kind = "", spin = false) {
  statusEl.className = "status show " + kind;
  statusEl.innerHTML = (spin ? '<span class="spin"></span>' : "") + msg;
  if (!spin && kind !== "hold") setTimeout(() => statusEl.classList.remove("show"), 2600);
}

/* --------------------------- geometria das setas ------------------------ */
function edgeGeometry(e) {
  const a = byId(states, e.from), b = byId(states, e.to);
  if (!a || !b) return null;
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L;
  const px = -uy, py = ux;                          // perpendicular
  const hasReverse = edges.some(o => o.from === e.to && o.to === e.from);
  const curv = hasReverse ? 26 : 0;
  const mx = (a.x + b.x) / 2 + px * curv;
  const my = (a.y + b.y) / 2 + py * curv;

  let sx, sy, ex, ey, tx, ty;
  if (curv === 0) {
    sx = a.x + ux * R; sy = a.y + uy * R;
    ex = b.x - ux * R; ey = b.y - uy * R;
    tx = ux; ty = uy;                                // tangente na chegada
  } else {
    let d1x = mx - a.x, d1y = my - a.y, l1 = Math.hypot(d1x, d1y) || 1;
    let d2x = mx - b.x, d2y = my - b.y, l2 = Math.hypot(d2x, d2y) || 1;
    sx = a.x + (d1x / l1) * R; sy = a.y + (d1y / l1) * R;
    ex = b.x + (d2x / l2) * R; ey = b.y + (d2y / l2) * R;
    tx = ex - mx; ty = ey - my;
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
  }
  const path = `M${sx.toFixed(1)} ${sy.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
  // ponto do rótulo (t=0.5 do bezier) + deslocamento perpendicular
  const lx = 0.25 * sx + 0.5 * mx + 0.25 * ex + px * 12;
  const ly = 0.25 * sy + 0.5 * my + 0.25 * ey + py * 12;
  // cabeça da seta
  const ah = 9, aw = 5;
  const bx = ex - tx * ah, by = ey - ty * ah;
  const head = `M${ex.toFixed(1)} ${ey.toFixed(1)} L${(bx + py * aw).toFixed(1)} ${(by - px * aw).toFixed(1)} L${(bx - py * aw).toFixed(1)} ${(by + px * aw).toFixed(1)} Z`;
  return { path, head, lx, ly };
}

/* --------------------------------- render ------------------------------- */
function render() {
  document.getElementById("emptyHint").style.display = states.length ? "none" : "";
  let s = "";

  // arestas primeiro (ficam atrás dos nós)
  for (const e of edges) {
    const g = edgeGeometry(e);
    if (!g) continue;
    const sel = selected && selected.type === "edge" && selected.id === e.id ? " selected" : "";
    s += `<g class="edge${sel}" data-edge="${e.id}">
      <path d="${g.path}"/>
      <path d="${g.head}" fill="${sel ? "var(--teal)" : "var(--text-dim)"}" stroke="none"/>
      <text class="lbl" x="${g.lx.toFixed(1)}" y="${g.ly.toFixed(1)}" text-anchor="middle">${escapeHtml(e.rate)}</text>
    </g>`;
  }
  // preview de ligação
  if (link) {
    const a = byId(states, link.from);
    s += `<g class="linking"><path d="M${a.x} ${a.y} L${link.mx} ${link.my}"/></g>`;
  }
  // nós
  for (const st of states) {
    const sel = selected && selected.type === "node" && selected.id === st.id ? " selected" : "";
    const fail = st.fail ? " fail" : "";
    const initMark = st.init > 0
      ? `<path class="init-mark" d="M${st.x - R - 16} ${st.y} l12 -7 l0 14 z"/>` : "";
    const pulse = st.fail ? `<circle class="pulse" cx="${st.x}" cy="${st.y}" r="26"/>` : "";
    s += `<g class="node${fail}${sel}" data-node="${st.id}" transform="translate(0,0)">
      ${pulse}${initMark}
      <circle cx="${st.x}" cy="${st.y}" r="${R}"/>
      <text x="${st.x}" y="${st.y}">${escapeHtml(label(st))}</text>
    </g>`;
  }
  svg.innerHTML = s;
}
function escapeHtml(t) {
  return String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ------------------------------ modos / toolbar ------------------------- */
const modeNames = { select: "selecionar", state: "adicionar estado", edge: "adicionar transição", delete: "apagar" };
function setMode(m) {
  mode = m; link = null;
  document.querySelectorAll(".mode").forEach(b => b.classList.toggle("active", b.dataset.mode === m));
  document.getElementById("modeBadge").textContent = "modo: " + modeNames[m];
  render();
}
document.getElementById("modes").addEventListener("click", e => {
  const b = e.target.closest(".mode"); if (b) setMode(b.dataset.mode);
});
document.addEventListener("keydown", e => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
  const map = { v: "select", s: "state", t: "edge", d: "delete" };
  if (map[e.key.toLowerCase()]) setMode(map[e.key.toLowerCase()]);
  if ((e.key === "Delete" || e.key === "Backspace") && selected) deleteSelected();
});

/* --------------------------- interação no palco ------------------------- */
svg.addEventListener("pointerdown", e => {
  const p = svgPoint(e);
  const nodeEl = e.target.closest("[data-node]");
  const edgeEl = e.target.closest("[data-edge]");

  if (mode === "state" && !nodeEl) { addState(p.x, p.y); return; }

  if (mode === "delete") {
    if (nodeEl) deleteState(+nodeEl.dataset.node);
    else if (edgeEl) deleteEdge(+edgeEl.dataset.edge);
    return;
  }

  if (mode === "edge" && nodeEl) {
    const nid = +nodeEl.dataset.node;
    if (link == null) { link = { from: nid, mx: p.x, my: p.y }; render(); }
    else { if (link.from !== nid) createEdge(link.from, nid); link = null; render(); }
    return;
  }

  // modo selecionar
  if (nodeEl) {
    const nid = +nodeEl.dataset.node;
    select("node", nid);
    const st = byId(states, nid);
    drag = { id: nid, dx: p.x - st.x, dy: p.y - st.y, moved: false };
    svg.setPointerCapture(e.pointerId);
  } else if (edgeEl) {
    select("edge", +edgeEl.dataset.edge);
  } else {
    select(null);
  }
});
svg.addEventListener("pointermove", e => {
  const p = svgPoint(e);
  if (link) { link.mx = p.x; link.my = p.y; render(); return; }
  if (drag) {
    const st = byId(states, drag.id);
    st.x = Math.max(R, p.x - drag.dx);
    st.y = Math.max(R, p.y - drag.dy);
    drag.moved = true;
    render();
  }
});
svg.addEventListener("pointerup", () => { drag = null; });
svg.addEventListener("dblclick", e => {
  if (mode === "select" && !e.target.closest("[data-node]")) {
    const p = svgPoint(e); addState(p.x, p.y);
  }
});

/* ------------------------------- operações ------------------------------ */
function addState(x, y) {
  states.push({ id: ++sid, x, y, label: "", fail: false, init: states.length === 0 ? 1 : 0 });
  select("node", sid); render(); updateLive();
}
function createEdge(from, to) {
  const rate = prompt(`Taxa da transição ${label(byId(states, from))} → ${label(byId(states, to))}\n(ex.: 3*lD, lP+lS, 2.5e-6)`, "");
  if (rate === null || rate.trim() === "") return;
  edges.push({ id: ++eid, from, to, rate: rate.trim() });
  select("edge", eid); render();
}
function deleteState(id) {
  states = states.filter(s => s.id !== id);
  edges = edges.filter(e => e.from !== id && e.to !== id);
  if (states.length && !states.some(s => s.init > 0)) states[0].init = 1;
  if (selected && selected.id === id) select(null);
  render(); updateLive();
}
function deleteEdge(id) {
  edges = edges.filter(e => e.id !== id);
  if (selected && selected.type === "edge" && selected.id === id) select(null);
  render();
}
function deleteSelected() {
  if (!selected) return;
  selected.type === "node" ? deleteState(selected.id) : deleteEdge(selected.id);
}
function select(type, id) {
  selected = type ? { type, id } : null;
  render(); renderInspector();
}

/* ------------------------------- inspetor ------------------------------- */
function renderInspector() {
  const box = document.getElementById("inspector");
  let h = "<h2>Inspetor</h2>";
  if (!selected) {
    h += `<p class="none">Nada selecionado. Clique num estado ou numa transição.</p>`;
  } else if (selected.type === "node") {
    const st = byId(states, selected.id);
    h += `
      <div class="field"><label>Rótulo</label>
        <input id="iLabel" value="${escapeHtml(label(st))}"></div>
      <div class="field"><label>P(0) — prob. inicial</label>
        <input id="iInit" class="mono" value="${st.init}"></div>
      <label class="toggle ${st.fail ? "on" : ""}" id="iFailWrap">
        <input type="checkbox" id="iFail" ${st.fail ? "checked" : ""}>
        estado indisponível (falho)
      </label>
      <button class="del" id="iDel">Apagar estado</button>`;
  } else {
    const e = byId(edges, selected.id);
    h += `
      <div class="field"><label>Transição</label>
        <input value="${escapeHtml(label(byId(states, e.from)))} → ${escapeHtml(label(byId(states, e.to)))}" disabled></div>
      <div class="field"><label>Taxa (expressão)</label>
        <input id="iRate" class="mono" value="${escapeHtml(e.rate)}"></div>
      <button class="del" id="iDel">Apagar transição</button>`;
  }
  box.innerHTML = h;

  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  on("iLabel", "input", e => { byId(states, selected.id).label = e.target.value; render(); });
  on("iInit", "input", e => { byId(states, selected.id).init = parseFloat(e.target.value) || 0; render(); });
  on("iFail", "change", e => {
    byId(states, selected.id).fail = e.target.checked;
    document.getElementById("iFailWrap").classList.toggle("on", e.target.checked);
    render(); updateLive();
  });
  on("iRate", "input", e => { byId(edges, selected.id).rate = e.target.value; render(); });
  on("iDel", "click", deleteSelected);
}

/* ------------------------------ parâmetros ------------------------------ */
function renderParams() {
  const box = document.getElementById("params");
  box.innerHTML = params.map((p, i) => `
    <div class="prow">
      <input value="${escapeHtml(p.name)}" data-i="${i}" data-f="name" placeholder="nome">
      <input value="${escapeHtml(p.value)}" data-i="${i}" data-f="value" placeholder="valor">
      <button class="x" data-i="${i}" title="remover">×</button>
    </div>`).join("");
  box.querySelectorAll("input").forEach(inp =>
    inp.addEventListener("input", e => { params[+e.target.dataset.i][e.target.dataset.f] = e.target.value; }));
  box.querySelectorAll(".x").forEach(b =>
    b.addEventListener("click", e => { params.splice(+e.target.dataset.i, 1); renderParams(); }));
}
document.getElementById("addParam").addEventListener("click", () => { params.push({ name: "", value: "" }); renderParams(); });

/* ---------------------------- montar payload ---------------------------- */
function payload() {
  const order = states.map(s => s.id);
  const map = Object.fromEntries(order.map((id, i) => [id, i]));
  const pobj = {};
  params.forEach(p => { if (p.name.trim()) pobj[p.name.trim()] = p.value; });
  let inicial = states.map(s => s.init || 0);
  if (inicial.every(v => v === 0) && states.length) inicial[0] = 1;
  return {
    n_estados: states.length,
    transicoes: edges.map(e => ({ origem: map[e.from], destino: map[e.to], taxa: e.rate })),
    params: pobj,
    inicial,
    indisponiveis: states.filter(s => s.fail).map(s => map[s.id]),
    sil_alvo: +document.getElementById("silAlvo").value,
    T_missao: parseFloat(document.getElementById("tMissao").value) || 8760,
    varredura: true,
  };
}

/* ------------------------------- análise -------------------------------- */
document.getElementById("btnRun").addEventListener("click", analyze);
async function analyze() {
  if (states.length === 0) return toast("Desenhe ao menos um estado.", "err");
  if (!states.some(s => s.fail)) return toast("Marque ao menos um estado como indisponível.", "err");
  toast("Calculando (alta precisão)…", "hold", true);
  try {
    const r = await fetch(API + "/api/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload()),
    });
    const d = await r.json();
    if (!d.ok) { toast("Erro: " + (d.erros?.[0] || "grafo inválido"), "err"); return; }
    renderResults(d); statusEl.classList.remove("show");
  } catch (err) {
    toast("Falha ao contatar o servidor. Ele está rodando?", "err");
  }
}

function silText(n) { return n >= 4 ? "SIL 4" : n <= 0 ? "< SIL 1" : "SIL " + n; }

function renderResults(d) {
  const box = document.getElementById("results");
  const alvo = +document.getElementById("silAlvo").value;
  const atende = d.ti_max !== null && d.ti_max >= (parseFloat(document.getElementById("tMissao").value) || 0);
  const fmt = x => x == null ? "—" : Number(x).toExponential(3);

  let h = "";
  if (d.erros && d.erros.length)
    h += `<div class="warn">⚠ ${d.erros.map(escapeHtml).join("<br>⚠ ")}</div>`;

  h += `<div class="metric hero">
      <div class="k">PFDavg no T de missão</div>
      <div class="v">${fmt(d.pfdavg_missao)} <small>→ ${silText(d.sil_missao)}</small></div>
    </div>`;
  h += `<div class="metric">
      <div class="k">T&#8202;<sub>I</sub> máximo p/ ${silText(alvo)}</div>
      <div class="v">${d.ti_max == null ? "não atinge" : Math.round(d.ti_max).toLocaleString("pt-BR") + " h"} ${d.ti_max == null ? "" : `<small>≈ ${(d.ti_max / 730).toFixed(1)} meses</small>`}</div>
    </div>`;
  h += `<div class="metric">
      <div class="k">validação vs exp(Λt)·P(0)</div>
      <div class="v">${fmt(d.validacao)} <small>erro abs. máx.</small></div>
    </div>`;

  // matriz Λ
  h += `<div class="matx"><table>` + d.lambda.map((row, i) =>
    "<tr>" + row.map((v, j) =>
      `<td class="${i === j ? "diag" : ""}">${v === 0 ? "0" : Number(v).toExponential(2)}</td>`).join("") + "</tr>"
  ).join("") + `</table></div>`;

  box.innerHTML = h;

  // badge de SIL no topo
  const live = document.getElementById("silLive");
  live.className = "sil-live " + (atende ? "ok" : "bad");
  live.innerHTML = `<span class="dot"></span><span>${silText(d.sil_missao)} <b>${atende ? "atende" : "abaixo do alvo"}</b></span>`;

  drawCharts(d);
}

/* -------------------------------- gráficos ------------------------------ */
const PLOT_LAYOUT = {
  paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
  font: { color: "#8ca0b2", family: "JetBrains Mono, monospace", size: 11 },
  margin: { l: 62, r: 16, t: 10, b: 42 },
  xaxis: { gridcolor: "#15283a", zerolinecolor: "#15283a", linecolor: "#25394c" },
  yaxis: { gridcolor: "#15283a", zerolinecolor: "#15283a", linecolor: "#25394c" },
  showlegend: false,
};
const PLOT_CFG = { displayModeBar: false, responsive: true };

function drawCharts(d) {
  document.getElementById("charts").classList.add("open");

  // PFD(t)
  Plotly.react("plotPfd", [{
    x: d.pfd_t.t, y: d.pfd_t.pfd, mode: "lines+markers",
    line: { color: "#2fb9a6", width: 2.4 }, marker: { size: 5, color: "#2fb9a6" },
  }], {
    ...PLOT_LAYOUT,
    xaxis: { ...PLOT_LAYOUT.xaxis, title: "t (h)" },
    yaxis: { ...PLOT_LAYOUT.yaxis, title: "PFD(t)" },
  }, PLOT_CFG);

  // PFDavg × T_I com faixas de SIL
  if (d.varredura) {
    const T = d.varredura.T, Y = d.varredura.pfdavg;
    const xmin = T[0], xmax = T[T.length - 1];
    const bands = [
      [1e-2, 1e-1, "rgba(224,83,59,.10)"],   // SIL 1
      [1e-3, 1e-2, "rgba(57,184,120,.10)"],  // SIL 2
      [1e-4, 1e-3, "rgba(59,130,246,.10)"],  // SIL 3
      [1e-5, 1e-4, "rgba(139,92,246,.12)"],  // SIL 4
    ];
    const shapes = bands.map(([lo, hi, c]) => ({
      type: "rect", xref: "x", yref: "y", x0: xmin, x1: xmax, y0: lo, y1: hi,
      fillcolor: c, line: { width: 0 }, layer: "below",
    }));
    shapes.push({
      type: "line", xref: "x", yref: "y", x0: xmin, x1: xmax,
      y0: d.limite_sil, y1: d.limite_sil,
      line: { color: "#e0533b", width: 1.6, dash: "dash" },
    });
    const ann = [];
    if (d.ti_max != null) {
      shapes.push({
        type: "line", xref: "x", yref: "y", x0: d.ti_max, x1: d.ti_max,
        y0: Math.min(...Y), y1: Math.max(...Y),
        line: { color: "#e0533b", width: 1.6, dash: "dash" },
      });
      ann.push({
        x: Math.log10(d.ti_max), y: Math.log10(d.limite_sil), xref: "x", yref: "y",
        text: `T_I,máx ≈ ${Math.round(d.ti_max)} h`, showarrow: true, arrowcolor: "#e0533b",
        font: { color: "#f2b45f", size: 10 }, ax: 30, ay: -26,
      });
    }
    Plotly.react("plotSweep", [{
      x: T, y: Y, mode: "lines", line: { color: "#e7eef4", width: 2.4 },
    }], {
      ...PLOT_LAYOUT, shapes, annotations: ann,
      xaxis: { ...PLOT_LAYOUT.xaxis, title: "T_I (h)" },
      yaxis: { ...PLOT_LAYOUT.yaxis, title: "PFDavg", type: "log" },
    }, PLOT_CFG);
  }
}
window.addEventListener("resize", () => {
  ["plotPfd", "plotSweep"].forEach(id => { const el = document.getElementById(id); if (el && el.data) Plotly.Plots.resize(el); });
});

/* --------------------------- badge de SIL ao vivo ----------------------- */
function updateLive() {
  const live = document.getElementById("silLive");
  const nFail = states.filter(s => s.fail).length;
  if (!states.length) { live.className = "sil-live"; live.innerHTML = `<span class="dot"></span><span>SIL <b>—</b></span>`; return; }
  live.className = "sil-live";
  live.innerHTML = `<span class="dot"></span><span>${states.length} estados · ${nFail} falho(s) <b>· pronto p/ analisar</b></span>`;
}

/* ------------------------------- exemplo A ------------------------------ */
document.getElementById("btnExample").addEventListener("click", loadExampleA);
function loadExampleA() {
  params = [{ name: "lD", value: "5.0e-7" }, { name: "lP", value: "5.0e-8" }, { name: "lS", value: "2.5e-6" }];
  states = [
    { id: 1, x: 170, y: 340, label: "S0", fail: false, init: 1 },
    { id: 2, x: 430, y: 130, label: "S1", fail: false, init: 0 },
    { id: 3, x: 690, y: 340, label: "F",  fail: true,  init: 0 },
  ];
  edges = [
    { id: 1, from: 1, to: 2, rate: "3*lD" },
    { id: 2, from: 1, to: 3, rate: "lP+lS" },
    { id: 3, from: 2, to: 3, rate: "2*lD+lP+lS" },
  ];
  sid = 3; eid = 3; select(null);
  document.getElementById("silAlvo").value = "2";
  renderParams(); render(); updateLive();
  toast("Problema A carregado — clique em Analisar.");
}

/* --------------------------------- limpar ------------------------------- */
document.getElementById("btnClear").addEventListener("click", () => {
  states = []; edges = []; sid = 0; eid = 0; select(null);
  document.getElementById("results").innerHTML =
    `<p class="none" style="color:var(--text-faint);font-size:12.5px">Monte a cadeia e clique <b>Analisar</b>.</p>`;
  document.getElementById("charts").classList.remove("open");
  render(); updateLive();
});

/* ---------------------------------- init -------------------------------- */
renderParams(); renderInspector(); render(); updateLive();
