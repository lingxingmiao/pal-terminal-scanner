// 给你配了 · 幻兽帕鲁自动配种工具
const SIZE = 96, CONF_TH = 0.35, EMPTY = "__empty__";
const state = {
  img: null, imgScale: 1, session: null, backend: "",
  labels: null, zh: null, icons: null,
  breed: null, pairIndex: null,
  owned: new Set(), ownedConf: new Map(),
  resultCells: [], depth: 2, target: null,
  grid: { x0: 700, y0: 245, dx: 80, dy: 78, size: 66, cols: 6, rows: 5 },
};
const $ = (id) => document.getElementById(id);
const nameOf = (id) => (state.zh && state.zh[id]) || id;

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
    // pair -> children
    state.pairIndex = new Map();
    for (const [child, pairs] of Object.entries(breed)) {
      for (const [a, b] of pairs) {
        const k = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (!state.pairIndex.has(k)) state.pairIndex.set(k, []);
        state.pairIndex.get(k).push(child);
      }
    }
    // target datalist
    const dl = $("pallist");
    dl.innerHTML = Object.keys(breed).map(id => {
      const nm = nameOf(id);
      return `<option value="${nm}">${id}</option>`;
    }).join("");
    // default target
    const def = state.breed["SheepBall"] ? "SheepBall" : Object.keys(breed)[0];
    setTarget(def);
    state.icons = await fetch("icons.json").then(r => r.json());
    generate();
    const demo = new URLSearchParams(location.search).get("demo");
    if (demo) await loadImage(demo);
  } catch (e) { $("status").textContent = "初始化失败：" + e.message; }
}

function resolveId(text) {
  text = (text || "").trim(); if (!text) return null;
  if (state.breed[text]) return text;
  for (const id of Object.keys(state.breed)) {
    if (nameOf(id) === text) return id;
  }
  const low = text.toLowerCase();
  for (const id of Object.keys(state.breed)) if (id.toLowerCase() === low) return id;
  for (const id of Object.keys(state.breed)) if (nameOf(id).includes(text)) return id;
  return null;
}
function setTarget(id) {
  state.target = id;
  const nm = nameOf(id);
  $("target").value = nm;
}

// ---------------- recognition ----------------
function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => {
      state.img = im; state.imgScale = im.naturalWidth / 1920;
      autoGrid();
      recognize().then(res).catch(rej);
    };
    im.onerror = rej; im.src = src;
  });
}

function autoGrid() {
  const W = state.img.naturalWidth;
  if (W > 1200) { return; } // full-screen: keep default terminal layout
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
    const x0 = foldCenter(arr, bestStep);
    return { x0, step: bestStep };
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
      const t = cv.getContext("2d");
      t.imageSmoothingQuality = "high";
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
    let bi = 0;
    const off = i * 300;
    for (let k = 1; k < 300; k++) if (logits[off + k] > logits[off + bi]) bi = k;
    let sum = 0; const ex = [];
    for (let k = 0; k < 300; k++) { const e = Math.exp(logits[off + k] - logits[off + bi]); ex.push(e); sum += e; }
    const conf = ex[bi] / sum;
    const key = cells[i].join(":");
    const cur = best.get(key);
    if (!cur || conf > cur.conf) best.set(key, { label: state.labels[bi], conf });
  }
  state.resultCells = [...best.values()];
  state.owned = new Set(); state.ownedConf = new Map();
  for (const r of state.resultCells) {
    if (r.label === EMPTY || r.conf < CONF_TH) continue;
    state.owned.add(r.label);
    state.ownedConf.set(r.label, Math.max(state.ownedConf.get(r.label) || 0, r.conf));
  }
  renderOwned();
  $("status").textContent = `识别完成：${state.owned.size} 种 / ${state.resultCells.filter(r => r.label !== EMPTY && r.conf >= CONF_TH).length} 只（${state.backend}）`;
  generate();
}

function renderOwned() {
  const arr = [...state.owned];
  $("ownCount").textContent = arr.length ? `${arr.length} 种` : "";
  $("chips").innerHTML = arr.map(id => {
    const ic = state.icons && state.icons[id] ? `<img src="${state.icons[id]}">` : "";
    return `<span class="chip">${ic}${nameOf(id)}</span>`;
  }).join("");
  // recommendations: children directly makeable from owned pairs
  const rec = new Map();
  const own = arr.slice().sort();
  for (let i = 0; i < own.length; i++) for (let j = i; j < own.length; j++) {
    const k = `${own[i]}|${own[j]}`;
    const ch = state.pairIndex.get(k);
    if (ch) for (const c of ch) rec.set(c, (rec.get(c) || 0) + 1);
  }
  const top = [...rec.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  $("recs").innerHTML = top.length ? `<h3>你现有的帕鲁可以直接配出：</h3><div class="rec-row">` +
    top.map(([id]) => `<button class="rec" data-id="${id}">${nameOf(id)}</button>`).join("") + `</div>` : "";
  $("recs").querySelectorAll(".rec").forEach(b => b.onclick = () => { setTarget(b.dataset.id); generate(); });
}

// ---------------- tree ----------------
function choosePair(child) {
  const pairs = (state.breed[child] || []).filter(p => !(p[0] === child && p[1] === child));
  if (!pairs.length) return null;
  let best = null, bestScore = 1e9;
  pairs.forEach((p, idx) => {
    const o = (state.owned.has(p[0]) ? 0 : 1) + (state.owned.has(p[1]) ? 0 : 1);
    const containsChild = (p[0] === child ? 1 : 0) + (p[1] === child ? 1 : 0);
    const score = o * 10 + containsChild * 4 + idx * 0.01;
    if (score < bestScore) { bestScore = score; best = p; }
  });
  return best;
}
function buildNode(id, depth) {
  const node = { id, depth, pair: null, kids: [], owned: state.owned.has(id), leaf: depth <= 0 };
  if (depth <= 0) return node;
  const pair = choosePair(id);
  if (!pair) return node;
  node.pair = pair;
  node.kids = [buildNode(pair[0], depth - 1), buildNode(pair[1], depth - 1)];
  return node;
}
function renderTree(node) {
  const ic = state.icons && state.icons[node.id] ? `<img src="${state.icons[node.id]}">` : "";
  const cls = node.owned ? "node owned" : (node.pair ? "node" : "node self");
  const badge = node.owned ? `<span class="ok">✓ 已有</span>` : (node.pair || node.leaf ? "" : `<span class="warn">需要捕捉</span>`);
  const selfPair = node.pair && node.pair[0] === node.id && node.pair[1] === node.id;
  const kids = node.kids.length ? `<ul>${node.kids.map(renderTree).join("")}</ul>` : "";
  return `<li><div class="${cls}">${ic}<span class="nm">${nameOf(node.id)}<span class="sub"> ${node.id}</span></span>${badge}</div>${kids}</li>`;
}
function generate() {
  if (!state.target) return;
  const depth = +$("depth").value;
  const node = buildNode(state.target, depth);
  $("tree").innerHTML = `<ul class="tree-tree">${renderTree(node)}</ul>`;
  // if root has no pair and not owned, hint
  if (!node.pair && !node.owned) {
    $("tree").insertAdjacentHTML("beforeend", `<p class="hint">这只帕鲁的表里没有可配组合（可能是固定/特殊获取）。</p>`);
  }
}

// ---------------- events ----------------
$("file").addEventListener("change", e => { const f = e.target.files[0]; if (f) loadImage(URL.createObjectURL(f)); });
document.addEventListener("paste", e => {
  for (const it of e.clipboardData.items) if (it.type.startsWith("image/")) { loadImage(URL.createObjectURL(it.getAsFile())); e.preventDefault(); break; }
});
const drop = $("drop");
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => {
  e.preventDefault(); drop.classList.remove("over");
  const f = e.dataTransfer.files[0]; if (f) loadImage(URL.createObjectURL(f));
});
$("gen").addEventListener("click", () => {
  const id = resolveId($("target").value);
  if (!id) { $("status").textContent = "没找到这只帕鲁，请从下拉里选。"; return; }
  setTarget(id); generate();
});
$("target").addEventListener("keydown", e => { if (e.key === "Enter") $("gen").click(); });
$("depth").addEventListener("change", () => { generate(); });

init();
