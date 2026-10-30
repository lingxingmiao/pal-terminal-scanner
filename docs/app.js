// Palworld terminal pal scanner — auto-labeling (Chinese), ONNX Runtime Web
const SIZE = 96;
const EMPTY_LABEL = "__empty__";
const CONF_TH = 0.35;

const state = {
  img: null,
  imgScale: 1,
  grids: [
    { name: "盒子", on: true,  x0: 700, y0: 245, dx: 80, dy: 78, size: 66, cols: 6, rows: 5 },
    { name: "据点", on: true,  x0: 700, y0: 722, dx: 80, dy: 78, size: 66, cols: 6, rows: 3 },
    { name: "队伍", on: false, x0: 515, y0: 200, dx: 0,  dy: 87, size: 64, cols: 1, rows: 5 },
  ],
  active: 0,
  labels: null,
  zh: null,
  icons: null,
  session: null,
  backend: "",
  results: [],
};

const $ = (id) => document.getElementById(id);
const cv = $("cv"), ctx = cv.getContext("2d");
const setStatus = (t) => { $("status").textContent = t; };
const nameOf = (id) => (state.zh && state.zh[id]) || id;

async function init() {
  try {
    ort.env.wasm.wasmPaths = "vendor/";
    ort.env.wasm.numThreads = 1;
    const candidates = [
      { model: "models/pal_classifier_fp16.onnx", ep: "webgpu", label: "FP16 · WebGPU" },
      { model: "models/pal_classifier.onnx",      ep: "webgpu", label: "FP32 · WebGPU" },
      { model: "models/pal_classifier.onnx",      ep: "webgl",  label: "FP32 · WebGL" },
      { model: "models/pal_classifier.onnx",      ep: "wasm",   label: "FP32 · WASM" },
    ];
    for (const c of candidates) {
      try {
        state.session = await ort.InferenceSession.create(c.model, { executionProviders: [c.ep] });
        state.backend = c.label; break;
      } catch (e) { console.warn("backend failed", c.label, e); }
    }
    if (!state.session) throw new Error("所有推理后端都初始化失败");
    $("backend").textContent = state.backend;
    state.labels = (await (await fetch("models/labels.json")).json()).labels;
    state.zh = await (await fetch("models/zh_names.json")).json();
    state.icons = await (await fetch("icons.json")).json();
    setStatus("就绪，选择一张终端截图");
    $("file").disabled = false;
    const demo = new URLSearchParams(location.search).get("demo");
    if (demo) await loadImage(demo);
  } catch (e) {
    setStatus("初始化失败: " + e.message);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      state.img = img;
      state.imgScale = img.naturalWidth / 1920;
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      state.results = [];
      draw();
      $("run").disabled = false;
      setStatus(`已载入 ${img.naturalWidth}×${img.naturalHeight}`);
      autoGrid();
      runDetection();
      resolve();
    };
    img.onerror = reject;
    img.src = src;
  });
}

$("file").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) loadImage(URL.createObjectURL(f));
});

function gridCells(g) {
  const cells = [];
  for (let r = 0; r < g.rows; r++)
    for (let c = 0; c < g.cols; c++)
      cells.push({ r, c, x: g.x0 * state.imgScale + c * g.dx * state.imgScale, y: g.y0 * state.imgScale + r * g.dy * state.imgScale, size: g.size * state.imgScale });
  return cells;
}

// ---------- automatic grid detection (projection + autocorrelation) ----------
function autoGrid() {
  if (!state.img) return;
  if (state.img.naturalWidth > 1200) { setStatus("大图使用默认终端布局（可手动微调）"); return; }
  const W = state.img.naturalWidth, H = state.img.naturalHeight;
  const s = Math.min(1, 960 / Math.max(W, H));
  const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"); g.drawImage(state.img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const colp = new Float32Array(w), rowp = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      if (mx > 90 && mx - mn > 25) { colp[x]++; rowp[y]++; }
    }
  }
  const foldCenter = (arr, step) => {
    const a = new Array(step).fill(0);
    for (let ph = 0; ph < step; ph++) {
      let sum = 0, n = 0;
      for (let i = ph; i < arr.length; i += step) { sum += arr[i]; n++; }
      a[ph] = n ? sum / n : 0;
    }
    const mx = Math.max(...a), mn = Math.min(...a), thr = (mx + mn) / 2;
    const runs = [];
    let st = -1;
    for (let i = 0; i < step; i++) {
      if (a[i] >= thr) { if (st < 0) st = i; }
      else if (st >= 0) { runs.push([st, i - 1]); st = -1; }
    }
    if (st >= 0) runs.push([st, step - 1]);
    if (!runs.length) return 0;
    const best = runs.reduce((x, y) => (y[1] - y[0] > x[1] - x[0] ? y : x));
    return (best[0] + best[1]) / 2;
  };
  const det = (p, len) => {
    const arr = Array.from(p);
    const mean = arr.reduce((a, b) => a + b, 0) / len;
    const diff = new Float32Array(Math.max(1, len - 1));
    for (let i = 1; i < len; i++) diff[i - 1] = Math.abs(arr[i] - arr[i - 1]);
    const dmean = diff.reduce((a, b) => a + b, 0) / diff.length;
    const dq = Array.from(diff, v => v - dmean);
    const minLag = 22, maxLag = Math.min(110, Math.floor(len / 2));
    const cands = [];
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sc = 0, n = 0;
      for (let i = 0; i + lag < dq.length; i++) { sc += dq[i] * dq[i + lag]; n++; }
      sc /= Math.max(1, n);
      cands.push({ lag, score: sc });
    }
    if (!cands.length) return null;
    const top = Math.max(...cands.map(c => c.score));
    if (top <= 0) return null;
    const step = cands.filter(c => c.score >= top * 0.8).sort((a, b) => a.lag - b.lag)[0].lag;
    const x0 = foldCenter(arr, step);
    const count = Math.floor((len - 1 - x0) / step) + 1;
    return { x0, step, count };
  };
  const cx = det(colp, w), cy = det(rowp, h);
  if (!cx || !cy || cx.count < 2 || cy.count < 2 || cx.step < 24 || cy.step < 24 || cx.count > 10 || cy.count > 8) {
    setStatus("自动网格失败，请手动调滑块"); return;
  }
  const g0 = state.grids[0];
  const inv = 1 / state.imgScale;
  g0.x0 = (cx.x0 / s) * inv; g0.dx = (cx.step / s) * inv; g0.cols = Math.min(cx.count, 12);
  g0.y0 = (cy.x0 / s) * inv; g0.dy = (cy.step / s) * inv; g0.rows = Math.min(cy.count, 8);
  g0.size = Math.min(g0.dx, g0.dy) * 0.86;
  g0.on = true;
  state.grids[1].on = false; state.grids[2].on = false;
  buildSliders(); draw();
  setStatus(`自动网格：${g0.cols}×${g0.rows}，格距 ${Math.round(g0.dx)}×${Math.round(g0.dy)}`);
}

function draw() {
  if (!state.img) return;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(state.img, 0, 0);
  const showGrid = $("showGrid").checked;
  const s = state.imgScale, fs = Math.max(12, 14 * s);
  for (let gi = 0; gi < state.grids.length; gi++) {
    const g = state.grids[gi];
    if (!g.on) continue;
    for (const cell of gridCells(g)) {
      const res = state.results.find(r => r.grid === gi && r.r === cell.r && r.c === cell.c);
      let color = "rgba(120,140,160,.55)";
      if (res) color = res.label === EMPTY_LABEL ? "rgba(150,160,170,.45)" : (res.conf >= CONF_TH ? "#38d47a" : "#ff6b5e");
      if (showGrid || res) {
        ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, 2 * s);
        ctx.strokeRect(cell.x - cell.size / 2, cell.y - cell.size / 2, cell.size, cell.size);
      }
      if (res && res.label !== EMPTY_LABEL) {
        const txt = `${nameOf(res.label)} ${Math.round(res.conf * 100)}%`;
        ctx.font = `${fs}px "Microsoft YaHei", "PingFang SC", sans-serif`;
        const w = ctx.measureText(txt).width;
        const bx = cell.x - cell.size / 2, by = cell.y + cell.size / 2 + 2 * s;
        ctx.fillStyle = "rgba(0,0,0,.72)";
        ctx.fillRect(bx, by, w + 8, fs + 6);
        ctx.fillStyle = color;
        ctx.fillText(txt, bx + 4, by + fs);
      }
    }
  }
}

function cropToTensor(cell, ox = 0, oy = 0) {
  const tmp = document.createElement("canvas");
  tmp.width = tmp.height = SIZE;
  const t = tmp.getContext("2d");
  t.imageSmoothingEnabled = true; t.imageSmoothingQuality = "high";
  t.drawImage(state.img, cell.x - cell.size / 2 + ox, cell.y - cell.size / 2 + oy, cell.size, cell.size, 0, 0, SIZE, SIZE);
  const d = t.getImageData(0, 0, SIZE, SIZE).data;
  const out = new Float32Array(3 * SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    out[i] = (d[i * 4] / 255 - 0.5) / 0.5;
    out[SIZE * SIZE + i] = (d[i * 4 + 1] / 255 - 0.5) / 0.5;
    out[2 * SIZE * SIZE + i] = (d[i * 4 + 2] / 255 - 0.5) / 0.5;
  }
  return out;
}

function softmax(a) {
  let mx = -Infinity; for (const v of a) mx = Math.max(mx, v);
  let sum = 0; const e = new Array(a.length);
  for (let i = 0; i < a.length; i++) { e[i] = Math.exp(a[i] - mx); sum += e[i]; }
  for (let i = 0; i < e.length; i++) e[i] /= sum;
  return e;
}

async function runBatch(tensors) {
  const n = tensors.length;
  const data = new Float32Array(n * 3 * SIZE * SIZE);
  for (let i = 0; i < n; i++) data.set(tensors[i], i * 3 * SIZE * SIZE);
  const out = await state.session.run({ input: new ort.Tensor("float32", data, [n, 3, SIZE, SIZE]) });
  const logits = out.logits.data;
  const probs = [];
  for (let i = 0; i < n; i++) probs.push(softmax(logits.subarray(i * 300, (i + 1) * 300)));
  return probs;
}

async function runDetection() {
  if (!state.img || !state.session) return;
  $("run").disabled = true;
  try {
    const VARS = [[0, 0], [0.16, 0], [-0.16, 0], [0, 0.16], [0, -0.16]];
    const jobs = [];
    for (let gi = 0; gi < state.grids.length; gi++) {
      if (!state.grids[gi].on) continue;
      for (const cell of gridCells(state.grids[gi])) {
        for (const [vx, vy] of VARS) {
          jobs.push({ gi, cell, tensor: cropToTensor(cell, vx * cell.size, vy * cell.size) });
        }
      }
    }
    if (!jobs.length) { setStatus("没有可识别的格子"); return; }
    setStatus(`推理 ${jobs.length} 张（含偏移增强）…`);
    const t0 = performance.now();
    let probs;
    try { probs = await runBatch(jobs.map(j => j.tensor)); }
    catch (e) { probs = []; for (const j of jobs) probs.push((await runBatch([j.tensor]))[0]); }
    const perCell = new Map();
    jobs.forEach((j, i) => {
      const p = probs[i]; let best = 0;
      for (let k = 1; k < p.length; k++) if (p[k] > p[best]) best = k;
      const key = `${j.gi}:${j.cell.r}:${j.cell.c}`;
      const cur = perCell.get(key);
      if (!cur || p[best] > cur.conf) perCell.set(key, { grid: j.gi, r: j.cell.r, c: j.cell.c, label: state.labels[best], conf: p[best] });
    });
    state.results = [...perCell.values()];
    draw(); renderResults();
    setStatus(`完成：${jobs.length} 格，${Math.round(performance.now() - t0)} ms（${state.backend}）`);
  } catch (e) {
    console.error(e); setStatus("识别失败: " + e.message);
  } finally { $("run").disabled = false; }
}

$("run").addEventListener("click", runDetection);

function renderResults() {
  const counts = new Map(); const unknown = [];
  for (const r of state.results) {
    if (r.label === EMPTY_LABEL) continue;
    if (r.conf < CONF_TH) { unknown.push(r); continue; }
    counts.set(r.label, (counts.get(r.label) || 0) + 1);
  }
  const arr = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  $("total").textContent = `共 ${arr.reduce((s, x) => s + x[1], 0)} 只 / ${arr.length} 种`;
  $("list").innerHTML = arr.map(([name, n]) => {
    const icon = state.icons[name] || "";
    return `<li>${icon ? `<img src="${icon}">` : ""}<span class="name">${nameOf(name)}</span><span class="cnt">×${n}</span></li>`;
  }).join("");
  $("unknowns").innerHTML = unknown.slice(0, 30).map(r => {
    const icon = state.icons[r.label] || "";
    return `<li>${icon ? `<img src="${icon}">` : ""}<span class="name">${nameOf(r.label)} (${Math.round(r.conf * 100)}%)</span></li>`;
  }).join("");
}

// ---------- grid editor ----------
function buildSliders() {
  const g = state.grids[state.active];
  const defs = [
    ["x0", "起点X", 0, 1900, 1], ["y0", "起点Y", 0, 1060, 1],
    ["dx", "列距", 0, 200, 1], ["dy", "行距", 0, 200, 1],
    ["size", "格大小", 20, 140, 1], ["cols", "列数", 1, 12, 1],
    ["rows", "行数", 1, 8, 1],
  ];
  const box = $("sliders"); box.innerHTML = "";
  const on = document.createElement("label");
  on.innerHTML = `<input type="checkbox" ${g.on ? "checked" : ""}> 启用`;
  on.querySelector("input").onchange = (e) => { g.on = e.target.checked; draw(); };
  box.appendChild(on);
  for (const [key, label, min, max, step] of defs) {
    const lab = document.createElement("label");
    lab.innerHTML = `${label} <input type="range" min="${min}" max="${max}" step="${step}" value="${g[key]}"> <input type="number" value="${g[key]}" min="${min}" max="${max}">`;
    const [rng, num] = lab.querySelectorAll("input");
    const apply = (v) => { g[key] = +v; rng.value = v; num.value = v; draw(); };
    rng.oninput = () => apply(rng.value);
    num.onchange = () => apply(num.value);
    box.appendChild(lab);
  }
}

$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-g]");
  if (!b) return;
  state.active = +b.dataset.g;
  [...$("tabs").children].forEach(x => x.classList.toggle("on", x === b));
  buildSliders();
});

$("showGrid").addEventListener("change", draw);
$("autoGrid").addEventListener("click", autoGrid);
$("export").addEventListener("click", () => {
  if (!state.img) return;
  cv.toBlob((b) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = "pal_annotated.png";
    a.click();
  }, "image/png");
});

init().then(buildSliders);
