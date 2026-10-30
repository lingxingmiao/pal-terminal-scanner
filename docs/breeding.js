// 给你配了 · 幻兽帕鲁自动配种工具（多方案 / 正查 / 反查 / 多代）
const SIZE = 96, CONF_TH = 0.35, EMPTY = "__empty__", PAGE = 12;
const state = {
  img: null, imgScale: 1, session: null, backend: "",
  labels: null, zh: null, icons: null,
  breed: null, pairIndex: null,
  owned: new Set(), ownedConf: new Map(),
  depth: 2, target: null, mode: "rev",
  plans: [], planPage: 0, selected: null,
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
    const dl = $("pallist");
    dl.innerHTML = Object.keys(breed).map(id => `<option value="${nameOf(id)}">${id}</option>`).join("");
    const def = state.breed["SheepBall"] ? "SheepBall" : Object.keys(breed)[0];
    setTarget(def);
    state.icons = await fetch("icons.json").then(r => r.json());
    generatePlans();
    const demo = new URLSearchParams(location.search).get("demo");
    if (demo) await loadImage(demo);
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

// ---------------- recognition ----------------
function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => { state.img = im; state.imgScale = im.naturalWidth / 1920; autoGrid(); recognize().then(res).catch(rej); };
    im.onerror = rej; im.src = src;
  });
}
function autoGrid() {
  const W = state.img.naturalWidth;
  if (W > 1200) return;
  const s = Math.min(1, 960 / Math.max(W, state.img.naturalHeight));
  const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(state.img.naturalHeight * s));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"); g.drawImage(state.img, 0, 0, w, h);
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
async function recognize() {
  if (!state.img || !state.session) return;
  const g = state.grid, im = state.img, sc = state.imgScale;
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
  $("status").textContent = `识别 ${g.cols}×${g.rows} 格…`;
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
  state.owned = new Set(); state.ownedConf = new Map();
  for (const r of best.values()) {
    if (r.label === EMPTY || r.conf < CONF_TH) continue;
    state.owned.add(r.label);
    state.ownedConf.set(r.label, Math.max(state.ownedConf.get(r.label) || 0, r.conf));
  }
  renderOwned();
  $("status").textContent = `识别完成：${state.owned.size} 种（${state.backend}）`;
  if (state.target) generatePlans();
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
  $("recs").querySelectorAll(".rec").forEach(b => b.onclick = () => { setTarget(b.dataset.id); generatePlans(); });
}

// ---------------- plans ----------------
function planScore(p) {
  const o = (state.owned.has(p[0]) ? 0 : 1) + (state.owned.has(p[1]) ? 0 : 1);
  const b = (isBoss(p[0]) ? 1 : 0) + (isBoss(p[1]) ? 1 : 0);
  const t = (p[0] === state.target ? 1 : 0) + (p[1] === state.target ? 1 : 0);
  return o * 100 + b * 10 + t * 5;
}
function generatePlans() {
  if (!state.target) return;
  const onlyOwned = $("onlyOwned").checked, noBoss = $("noBoss").checked;
  let pairs = (state.breed[state.target] || []).filter(p => !(p[0] === state.target && p[1] === state.target));
  if (onlyOwned) pairs = pairs.filter(p => state.owned.has(p[0]) && state.owned.has(p[1]));
  if (noBoss) pairs = pairs.filter(p => !isBoss(p[0]) && !isBoss(p[1]));
  pairs = pairs.slice().sort((a, b) => planScore(a) - planScore(b) || (a[0] + a[1]).localeCompare(b[0] + b[1]));
  state.plans = pairs; state.planPage = 0; state.selected = pairs[0] || null;
  $("planCount").textContent = `共 ${pairs.length} 种方案`;
  $("treeFor").textContent = `目标：${nameOf(state.target)}`;
  renderPlans();
  renderTree();
}
function planCard(p, idx) {
  const icA = state.icons && state.icons[p[0]] ? `<img src="${state.icons[p[0]]}">` : "";
  const icB = state.icons && state.icons[p[1]] ? `<img src="${state.icons[p[1]]}">` : "";
  const own = (state.owned.has(p[0]) ? 1 : 0) + (state.owned.has(p[1]) ? 1 : 0);
  const badge = own === 2 ? `<span class="tag ok">父母都已有</span>` : own === 1 ? `<span class="tag mid">有一个</span>` : `<span class="tag">需捕捉</span>`;
  return `<div class="plan${state.selected === p ? " sel" : ""}" data-i="${idx}">
    <span class="p">${icA}${nameOf(p[0])}</span><span class="x">×</span><span class="p">${icB}${nameOf(p[1])}</span>${badge}
  </div>`;
}
function renderPlans() {
  const end = (state.planPage + 1) * PAGE;
  const list = state.plans.slice(0, end);
  $("plans").innerHTML = list.length ? list.map((p, i) => planCard(p, i)).join("") : `<p class="hint">没有符合条件的方案。</p>`;
  if (state.plans.length > end) {
    $("plans").insertAdjacentHTML("beforeend", `<button id="more" class="more">加载更多（剩余 ${state.plans.length - end}）</button>`);
    $("more").onclick = () => { state.planPage++; renderPlans(); };
  }
  $("plans").querySelectorAll(".plan").forEach(el => el.onclick = () => {
    state.selected = state.plans[+el.dataset.i];
    renderPlans(); renderTree();
  });
}

// ---------------- tree ----------------
function choosePair(child) {
  const pairs = (state.breed[child] || []).filter(p => !(p[0] === child && p[1] === child));
  if (!pairs.length) return null;
  let best = null, bestScore = 1e9;
  pairs.forEach((p, i) => {
    const o = (state.owned.has(p[0]) ? 0 : 1) + (state.owned.has(p[1]) ? 0 : 1);
    const b = (isBoss(p[0]) ? 1 : 0) + (isBoss(p[1]) ? 1 : 0);
    const t = (p[0] === child ? 1 : 0) + (p[1] === child ? 1 : 0);
    const sc = o * 10 + b * 3 + t * 2 + i * 0.01;
    if (sc < bestScore) { bestScore = sc; best = p; }
  });
  return best;
}
function buildNode(id, depth) {
  const node = { id, pair: null, kids: [], owned: state.owned.has(id), leaf: depth <= 0 };
  if (depth <= 0) return node;
  const pair = choosePair(id);
  if (!pair) return node;
  node.pair = pair;
  node.kids = [buildNode(pair[0], depth - 1), buildNode(pair[1], depth - 1)];
  return node;
}
function buildFromPair(child, pair, depth) {
  const node = { id: child, pair, kids: [], owned: state.owned.has(child), leaf: depth <= 1 };
  if (depth > 1) node.kids = [buildNode(pair[0], depth - 1), buildNode(pair[1], depth - 1)];
  return node;
}
function renderTree() {
  if (!state.selected) { $("tree").innerHTML = `<p class="hint">没有可用方案。</p>`; return; }
  const depth = +$("depth").value;
  const node = buildFromPair(state.target, state.selected, depth);
  $("tree").innerHTML = `<ul class="tree-tree">${nodeHTML(node)}</ul>`;
}
function nodeHTML(node) {
  const ic = state.icons && state.icons[node.id] ? `<img src="${state.icons[node.id]}">` : "";
  const cls = node.owned ? "node owned" : (node.pair ? "node" : "node self");
  const badge = node.owned ? `<span class="ok">✓ 已有</span>` : (node.pair || node.leaf ? "" : `<span class="warn">需要捕捉</span>`);
  const kids = node.kids.length ? `<ul>${node.kids.map(nodeHTML).join("")}</ul>` : "";
  return `<li><div class="${cls}">${ic}<span class="nm">${nameOf(node.id)}<span class="sub"> ${node.id}</span></span>${badge}</div>${kids}</li>`;
}

// ---------------- forward lookup ----------------
$("fwdGo").onclick = () => {
  const a = resolveId($("p1").value), b = resolveId($("p2").value);
  if (!a || !b) { $("fwdOut").innerHTML = `<span class="hint">父母没识别出来。</span>`; return; }
  const k = a < b ? `${a}|${b}` : `${b}|${a}`;
  let kids = state.pairIndex.get(k) || [];
  if (kids.length === 0) kids = [a === b ? a : "__none__"];
  $("fwdOut").innerHTML = kids.map(c => c === "__none__" ? `<span class="hint">这对父母没有记录（可能不在可配种池）。</span>` :
    `<button class="rec" data-id="${c}">${nameOf(c)}</button>`).join("");
  $("fwdOut").querySelectorAll(".rec").forEach(btn => btn.onclick = () => {
    setTarget(btn.dataset.id); switchMode("rev"); generatePlans();
  });
};

// ---------------- events ----------------
$("file").addEventListener("change", e => { const f = e.target.files[0]; if (f) loadImage(URL.createObjectURL(f)); });
document.addEventListener("paste", e => {
  for (const it of e.clipboardData.items) if (it.type.startsWith("image/")) { loadImage(URL.createObjectURL(it.getAsFile())); e.preventDefault(); break; }
});
const drop = $("drop");
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) loadImage(URL.createObjectURL(f)); });
$("gen").onclick = () => { const id = resolveId($("target").value); if (!id) return; setTarget(id); generatePlans(); };
$("target").addEventListener("keydown", e => { if (e.key === "Enter") $("gen").click(); });
$("depth").addEventListener("change", renderTree);
$("onlyOwned").addEventListener("change", generatePlans);
$("noBoss").addEventListener("change", generatePlans);
function switchMode(mode) {
  state.mode = mode;
  [...document.querySelectorAll(".mode-tabs button")].forEach(b => b.classList.toggle("on", b.dataset.mode === mode));
  $("revPanel").hidden = mode !== "rev";
  $("fwdPanel").hidden = mode !== "fwd";
}
document.querySelectorAll(".mode-tabs button").forEach(b => b.onclick = () => switchMode(b.dataset.mode));

init();
