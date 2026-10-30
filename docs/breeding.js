// 给你配了 · 幻兽帕鲁自动配种工具（多截图 / 可展开完整方案树 / 正查 / 反查）
const SIZE = 96, CONF_TH = 0.35, EMPTY = "__empty__", PAGE = 10;
const state = {
  shots: [],                 // {name, src, owned:Set, conf:Map}
  img: null, imgScale: 1,
  session: null, backend: "",
  labels: null, zh: null, icons: null,
  breed: null, pairIndex: null,
  owned: new Set(), ownedConf: new Map(),
  target: null, mode: "rev",
  expanded: new Map(),
  grid: { x0: 700, y0: 245, dx: 80, dy: 78, size: 66, cols: 6, rows: 5 },
};
const $ = (id) => document.getElementById(id);
const nameOf = (id) => (state.zh && state.zh[id]) || id;
const isBoss = (id) => /Boss|RAID|GYM/i.test(id);

async function init() {
  try {
    ort.env.wasm.wasmPaths = "vendor/";
    ort.env.wasm.numThreads = 1;
    for (const c of [
      { m: "models/pal_classifier_fp16.onnx", ep: "webgpu", n: "FP16 · WebGPU" },
      { m: "models/pal_classifier.onnx", ep: "webgpu", n: "FP32 · WebGPU" },
      { m: "models/pal_classifier.onnx", ep: "webgl", n: "FP32 · WebGL" },
      { m: "models/pal_classifier.onnx", ep: "wasm", n: "FP32 · WASM" },
    ]) {
      try { state.session = await ort.InferenceSession.create(c.m, { executionProviders: [c.ep] }); state.backend = c.n; break; } catch (e) {}
    }
    if (!state.session) throw new Error("推理后端初始化失败");
    $("status").textContent = `模型就绪（${state.backend}），等待截图…`;
    const [labels, zh, breed] = await Promise.all([
      fetch("models/labels.json").then(r => r.json()),
      fetch("models/zh_names.json").then(r => r.json()),
      fetch("breeding.json").then(r => r.json()),
    ]);
    state.labels = labels.labels; state.zh = zh; state.breed = breed;
    state.pairIndex = new Map();
    for (const [child, pairs] of Object.entries(breed)) for (const [a, b] of pairs) {
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!state.pairIndex.has(k)) state.pairIndex.set(k, []);
      state.pairIndex.get(k).push(child);
    }
    $("pallist").innerHTML = Object.keys(breed).map(id => `<option value="${nameOf(id)}">${id}</option>`).join("");
    setTarget(state.breed["SheepBall"] ? "SheepBall" : Object.keys(breed)[0]);
    state.icons = await fetch("icons.json").then(r => r.json());
    openTarget();
    const params = new URLSearchParams(location.search);
    const demos = params.getAll("demo");
    for (const d of demos) await addImage(d, d);
    const open = params.get("open");
    if (open) { const id = resolveId(open); if (id) { state.expanded.set(id, { page: 0 }); renderExplorer(); } }
  } catch (e) { $("status").textContent = "初始化失败：" + e.message; }
}

function resolveId(text) {
  text = (text || "").trim(); if (!text) return null;
  if (state.breed[text]) return text;
  for (const id of Object.keys(state.breed)) if (nameOf(id) === text) return id;
  const low = text.toLowerCase();
  for (const id of Object.keys(state.breed)) if (id.toLowerCase() === low) return id;
  for (const id of Object.keys(state.breed)) if (nameOf(id).includes(text)) return id;
  return null;
}
function setTarget(id) { state.target = id; $("target").value = nameOf(id); }

// ---------------- screenshots ----------------
function loadIm(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
}
async function addImage(src, name) {
  const im = await loadIm(src);
  state.img = im; state.imgScale = im.naturalWidth / 1920;
  autoGrid();
  $("status").textContent = `识别第 ${state.shots.length + 1} 张（${im.naturalWidth}×${im.naturalHeight}）…`;
  const res = await recognizeImage(im);
  state.shots.push({ name, src, owned: res.owned, conf: res.conf });
  mergeOwned(); renderShots(); renderOwned();
  $("status").textContent = `第 ${state.shots.length} 张识别完成：${res.owned.size} 种 · 合计 ${state.owned.size} 种（${state.backend}）`;
  if (state.target) openTarget();
}
function mergeOwned() {
  state.owned = new Set(); state.ownedConf = new Map();
  for (const s of state.shots) for (const id of s.owned) {
    state.owned.add(id);
    state.ownedConf.set(id, Math.max(state.ownedConf.get(id) || 0, s.conf.get(id) || 0));
  }
}
function renderShots() {
  $("shots").innerHTML = state.shots.map((s, i) => {
    return `<div class="shot"><img src="${s.src}"><span>${s.owned.size} 种</span><button data-i="${i}" class="rm">×</button></div>`;
  }).join("");
  $("shots").querySelectorAll(".rm").forEach(b => b.onclick = () => {
    state.shots.splice(+b.dataset.i, 1);
    mergeOwned(); renderShots(); renderOwned(); openTarget();
  });
}
function autoGrid() {
  const im = state.img, W = im.naturalWidth;
  if (W > 1200) {
    state.grid = { x0: 700, y0: 245, dx: 80, dy: 78, size: 66, cols: 6, rows: 5 };
    return;
  }
  const s = Math.min(1, 960 / Math.max(W, im.naturalHeight));
  const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(im.naturalHeight * s));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"); g.drawImage(im, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const colp = new Float32Array(w), rowp = new Float32Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, r = d[i], gg = d[i + 1], b = d[i + 2];
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
    if (mx > 90 && mx - mn > 25) { colp[x]++; rowp[y]++; }
  }
  const foldCenter = (arr, step) => {
    const a = new Array(step).fill(0);
    for (let ph = 0; ph < step; ph++) { let s2 = 0, n = 0; for (let i = ph; i < arr.length; i += step) { s2 += arr[i]; n++; } a[ph] = n ? s2 / n : 0; }
    const mx = Math.max(...a), mn = Math.min(...a), thr = (mx + mn) / 2;
    const runs = []; let st = -1;
    for (let i = 0; i < step; i++) { if (a[i] >= thr) { if (st < 0) st = i; } else if (st >= 0) { runs.push([st, i - 1]); st = -1; } }
    if (st >= 0) runs.push([st, step - 1]);
    if (!runs.length) return 0;
    const best = runs.reduce((x, y) => (y[1] - y[0] > x[1] - x[0] ? y : x));
    return (best[0] + best[1]) / 2;
  };
  const det = (arr) => {
    const len = arr.length;
    const diff = new Float32Array(len - 1);
    for (let i = 1; i < len; i++) diff[i - 1] = Math.abs(arr[i] - arr[i - 1]);
    const dm = diff.reduce((a, b) => a + b, 0) / diff.length;
    const dq = Array.from(diff, v => v - dm);
    let bestStep = 0, bestScore = -1;
    for (let lag = 22; lag <= Math.min(110, Math.floor(len / 2)); lag++) {
      let sc = 0, n = 0;
      for (let i = 0; i + lag < dq.length; i++) { sc += dq[i] * dq[i + lag]; n++; }
      sc /= Math.max(1, n);
      if (sc > bestScore) { bestScore = sc; bestStep = lag; }
    }
    if (!bestStep) return null;
    return { x0: foldCenter(arr, bestStep), step: bestStep };
  };
  const cx = det(colp), cy = det(rowp);
  if (!cx || !cy) return;
  const inv = 1 / state.imgScale;
  state.grid = {
    x0: (cx.x0 / s) * inv, dx: (cx.step / s) * inv,
    y0: (cy.x0 / s) * inv, dy: (cy.step / s) * inv,
    size: (Math.min(cx.step, cy.step) / s) * inv * 0.86,
    cols: Math.min(12, Math.max(2, Math.round(w / cx.step))),
    rows: Math.min(8, Math.max(2, Math.round(h / cy.step))),
  };
}
async function recognizeImage(im) {
  const g = state.grid, sc = state.imgScale;
  const VARS = [[0, 0], [0.16, 0], [-0.16, 0], [0, 0.16], [0, -0.16]];
  const jobs = [], cells = [];
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
    const x = (g.x0 + c * g.dx) * sc, y = (g.y0 + r * g.dy) * sc, size = g.size * sc;
    for (const [vx, vy] of VARS) {
      const cv = document.createElement("canvas"); cv.width = cv.height = SIZE;
      const t = cv.getContext("2d"); t.imageSmoothingQuality = "high";
      t.drawImage(im, x - size / 2 + vx * size, y - size / 2 + vy * size, size, size, 0, 0, SIZE, SIZE);
      const d = t.getImageData(0, 0, SIZE, SIZE).data;
      const arr = new Float32Array(3 * SIZE * SIZE);
      for (let i = 0; i < SIZE * SIZE; i++) {
        arr[i] = (d[i * 4] / 255 - 0.5) / 0.5;
        arr[SIZE * SIZE + i] = (d[i * 4 + 1] / 255 - 0.5) / 0.5;
        arr[2 * SIZE * SIZE + i] = (d[i * 4 + 2] / 255 - 0.5) / 0.5;
      }
      jobs.push(arr); cells.push([r, c]);
    }
  }
  const n = jobs.length, data = new Float32Array(n * 3 * SIZE * SIZE);
  jobs.forEach((a, i) => data.set(a, i * 3 * SIZE * SIZE));
  const out = await state.session.run({ input: new ort.Tensor("float32", data, [n, 3, SIZE, SIZE]) });
  const logits = out.logits.data;
  const best = new Map();
  for (let i = 0; i < n; i++) {
    let bi = 0; const off = i * 300;
    for (let k = 1; k < 300; k++) if (logits[off + k] > logits[off + bi]) bi = k;
    let sum = 0; const ex = [];
    for (let k = 0; k < 300; k++) { const e = Math.exp(logits[off + k] - logits[off + bi]); ex.push(e); sum += e; }
    const conf = ex[bi] / sum, key = cells[i].join(":");
    const cur = best.get(key);
    if (!cur || conf > cur.conf) best.set(key, { label: state.labels[bi], conf });
  }
  const owned = new Set(), conf = new Map();
  for (const r of best.values()) {
    if (r.label === EMPTY || r.conf < CONF_TH) continue;
    owned.add(r.label);
    conf.set(r.label, Math.max(conf.get(r.label) || 0, r.conf));
  }
  return { owned, conf };
}
function renderOwned() {
  const arr = [...state.owned];
  $("ownCount").textContent = arr.length ? `${arr.length} 种` : "";
  $("chips").innerHTML = arr.map(id => {
    const ic = state.icons && state.icons[id] ? `<img src="${state.icons[id]}">` : "";
    return `<span class="chip">${ic}${nameOf(id)}</span>`;
  }).join("");
  const rec = new Map();
  const own = arr.slice().sort();
  for (let i = 0; i < own.length; i++) for (let j = i; j < own.length; j++) {
    const ch = state.pairIndex.get(`${own[i]}|${own[j]}`);
    if (ch) for (const c of ch) rec.set(c, (rec.get(c) || 0) + 1);
  }
  const top = [...rec.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  $("recs").innerHTML = top.length ? `<h3>你现有的帕鲁可以直接配出：</h3><div class="rec-row">` +
    top.map(([id]) => `<button class="rec" data-id="${id}">${nameOf(id)}</button>`).join("") + `</div>` : "";
  $("recs").querySelectorAll(".rec").forEach(b => b.onclick = () => { setTarget(b.dataset.id); openTarget(); });
}

// ---------------- plans / explorer ----------------
function planScore(p, id) {
  const o = (state.owned.has(p[0]) ? 2 : 0) + (state.owned.has(p[1]) ? 2 : 0);
  const b = (isBoss(p[0]) ? 1 : 0) + (isBoss(p[1]) ? 1 : 0);
  const t = (p[0] === id ? 1 : 0) + (p[1] === id ? 1 : 0);
  return o * 10 - b * 3 - t * 6;
}
function plansFor(id) {
  let pairs = (state.breed[id] || []).filter(p => !(p[0] === id && p[1] === id));
  if ($("noBoss").checked) pairs = pairs.filter(p => !isBoss(p[0]) && !isBoss(p[1]));
  if ($("onlyOwned").checked) pairs = pairs.filter(p => state.owned.has(p[0]) || state.owned.has(p[1]));
  return pairs.slice().sort((a, b) => planScore(b, id) - planScore(a, id) || (a[0] + a[1]).localeCompare(b[0] + b[1]));
}
function openTarget() {
  state.expanded = new Map([[state.target, { page: 0 }]]);
  renderExplorer();
}
function renderExplorer() {
  if (!state.target) return;
  const ex = $("explorer");
  const keep = ex.scrollTop;
  const plans = plansFor(state.target);
  $("planCount").textContent = `「${nameOf(state.target)}」共 ${plans.length} 种直接方案（可逐层展开）`;
  ex.innerHTML = `<div class="explorer-tree">${enodeHTML(state.target, [], "root")}</div>`;
  ex.scrollTop = keep;
}
function isTerminal(id, role) {
  return $("skipOwned").checked && state.owned.has(id) && role !== "root";
}
function cardHTML(id, chain, role) {
  const owned = state.owned.has(id);
  const terminal = isTerminal(id, role);
  const cyc = chain.includes(id);
  const expanded = state.expanded.has(id) && !cyc && !terminal;
  const icon = state.icons && state.icons[id] ? `<img src="${state.icons[id]}">` : "";
  const count = plansFor(id).length;
  const badge = owned ? `<span class="tag ok">✓ 已有</span>` : (cyc ? `<span class="tag">↺ 循环</span>` : "");
  const cls = `card${owned ? " owned" : ""}${expanded ? " open" : ""}${terminal ? " terminal" : ""}`;
  const arrow = (cyc || terminal) ? "" : (expanded ? "▾" : "▸");
  const cntShow = terminal ? "" : `<span class="cnt">${count ? count : "需捕捉"}</span>`;
  return `<div class="${cls}" data-id="${id}" data-role="${role}">
    ${icon}<span class="nm">${nameOf(id)}<span class="sub"> ${id}</span></span>
    ${badge}${cntShow}<span class="arrow">${arrow}</span>
  </div>`;
}
function enodeHTML(id, chain, role) {
  const cyc = chain.includes(id);
  const terminal = isTerminal(id, role);
  const expanded = terminal ? null : state.expanded.get(id);
  let html = `<div class="enode">${cardHTML(id, chain, role)}`;
  if (expanded && !cyc) {
    const pairs = plansFor(id);
    const end = (expanded.page + 1) * PAGE;
    html += `<div class="kids">`;
    if (!pairs.length) html += `<p class="hint">没有符合条件的方案。</p>`;
    pairs.slice(0, end).forEach((p, i) => {
      const n = chain.concat(id);
      html += `<div class="plan-block"><span class="idx">#${i + 1}</span>${enodeHTML(p[0], n, "a")}<span class="x">×</span>${enodeHTML(p[1], n, "b")}</div>`;
    });
    if (pairs.length > end) html += `<button class="more" data-id="${id}">加载更多（剩余 ${pairs.length - end}）</button>`;
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}
$("explorer").addEventListener("click", (e) => {
  const more = e.target.closest(".more");
  if (more) {
    const id = more.dataset.id;
    const cur = state.expanded.get(id) || { page: 0 };
    state.expanded.set(id, { page: cur.page + 1 });
    renderExplorer(); return;
  }
  const card = e.target.closest(".card");
  if (!card) return;
  if (card.classList.contains("terminal")) return;
  const id = card.dataset.id;
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.set(id, { page: 0 });
  renderExplorer();
});

// ---------------- forward lookup ----------------
$("fwdGo").onclick = () => {
  const a = resolveId($("p1").value), b = resolveId($("p2").value);
  if (!a || !b) { $("fwdOut").innerHTML = `<span class="hint">父母没识别出来。</span>`; return; }
  const k = a < b ? `${a}|${b}` : `${b}|${a}`;
  let kids = state.pairIndex.get(k) || [];
  if (!kids.length) kids = [a === b ? a : "__none__"];
  $("fwdOut").innerHTML = kids.map(c => c === "__none__" ? `<span class="hint">这对父母没有记录（可能不在可配种池）。</span>` :
    `<button class="rec" data-id="${c}">${nameOf(c)}</button>`).join("");
  $("fwdOut").querySelectorAll(".rec").forEach(btn => btn.onclick = () => {
    setTarget(btn.dataset.id); switchMode("rev"); openTarget();
  });
};

// ---------------- events ----------------
async function addFiles(files) {
  for (const f of files) {
    if (!f || !f.type.startsWith("image/")) continue;
    await addImage(URL.createObjectURL(f), f.name);
  }
}
$("file").addEventListener("change", e => { addFiles([...e.target.files]); e.target.value = ""; });
document.addEventListener("paste", e => {
  const files = [];
  for (const it of e.clipboardData.items) if (it.type.startsWith("image/")) files.push(it.getAsFile());
  if (files.length) { e.preventDefault(); addFiles(files); }
});
const drop = $("drop");
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); addFiles([...e.dataTransfer.files]); });
$("gen").onclick = () => { const id = resolveId($("target").value); if (!id) return; setTarget(id); openTarget(); };
$("target").addEventListener("keydown", e => { if (e.key === "Enter") $("gen").click(); });
$("collapse").onclick = () => { state.expanded = new Map(); renderExplorer(); };
$("onlyOwned").addEventListener("change", renderExplorer);
$("noBoss").addEventListener("change", renderExplorer);
$("skipOwned").addEventListener("change", renderExplorer);
function switchMode(mode) {
  state.mode = mode;
  [...document.querySelectorAll(".mode-tabs button")].forEach(b => b.classList.toggle("on", b.dataset.mode === mode));
  $("revPanel").hidden = mode !== "rev";
  $("fwdPanel").hidden = mode !== "fwd";
}
document.querySelectorAll(".mode-tabs button").forEach(b => b.onclick = () => switchMode(b.dataset.mode));

init();
