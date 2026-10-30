// Palworld terminal pal classifier — ONNX Runtime Web (WebGPU → WebGL → WASM)
const SIZE = 96;
const EMPTY_LABEL = "__empty__";
const CONF_TH = 0.35;

const state = {
  img: null,
  imgScale: 1,          // design(1920) -> image px
  grids: [
    { name: "盒子", on: true,  x0: 700, y0: 245, dx: 80, dy: 78, size: 66, cols: 6, rows: 5 },
    { name: "据点", on: true,  x0: 700, y0: 722, dx: 80, dy: 78, size: 66, cols: 6, rows: 3 },
    { name: "队伍", on: false, x0: 515, y0: 200, dx: 0,  dy: 87, size: 64, cols: 1, rows: 5 },
  ],
  active: 0,
  labels: null,
  icons: null,
  session: null,
  backend: "",
  results: [],          // {grid, r, c, x, y, size, label, conf}
};

const $ = (id) => document.getElementById(id);
const cv = $("cv"), ctx = cv.getContext("2d");

function setStatus(t) { $("status").textContent = t; }

async function init() {
  try {
    ort.env.wasm.wasmPaths = "vendor/";
    ort.env.wasm.numThreads = 1;   // GitHub Pages has no COOP/COEP -> single-thread wasm
    const candidates = [
      { model: "models/pal_classifier_fp16.onnx", ep: "webgpu", label: "FP16 · WebGPU" },
      { model: "models/pal_classifier.onnx",      ep: "webgpu", label: "FP32 · WebGPU" },
      { model: "models/pal_classifier.onnx",      ep: "webgl",  label: "FP32 · WebGL" },
      { model: "models/pal_classifier.onnx",      ep: "wasm",   label: "FP32 · WASM" },
    ];
    for (const c of candidates) {
      try {
        state.session = await ort.InferenceSession.create(c.model, { executionProviders: [c.ep] });
        state.backend = c.label;
        break;
      } catch (e) {
        console.warn("backend failed", c.label, e);
      }
    }
    if (!state.session) throw new Error("所有后端都初始化失败");
    $("backend").textContent = state.backend;
    state.labels = (await (await fetch("models/labels.json")).json()).labels;
    state.icons = await (await fetch("icons.json")).json();
    setStatus("就绪，选择一张终端截图");
    $("file").disabled = false;
    if (new URLSearchParams(location.search).has("demo")) {
      await loadImage("screenshot.png");
      $("run").click();
    }
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
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      state.results = [];
      draw();
      $("run").disabled = false;
      setStatus(`已载入 ${img.naturalWidth}×${img.naturalHeight}`);
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
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      cells.push({
        r, c,
        x: g.x0 * state.imgScale + c * g.dx * state.imgScale,
        y: g.y0 * state.imgScale + r * g.dy * state.imgScale,
        size: g.size * state.imgScale,
      });
    }
  }
  return cells;
}

function draw() {
  if (!state.img) return;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(state.img, 0, 0);
  const showGrid = $("showGrid").checked;
  const s = state.imgScale;
  const fs = Math.max(10, 13 * s);
  for (let gi = 0; gi < state.grids.length; gi++) {
    const g = state.grids[gi];
    if (!g.on) continue;
    const cells = gridCells(g);
    for (const cell of cells) {
      const res = state.results.find(r => r.grid === gi && r.r === cell.r && r.c === cell.c);
      let color = "rgba(120,140,160,.55)";
      if (res) color = res.label === EMPTY_LABEL ? "rgba(150,160,170,.45)" : (res.conf >= CONF_TH ? "#38d47a" : "#ff6b5e");
      if (showGrid || res) {
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, 2 * s);
        ctx.strokeRect(cell.x - cell.size / 2, cell.y - cell.size / 2, cell.size, cell.size);
      }
      if (res && res.label !== EMPTY_LABEL) {
        const txt = res.label + " " + Math.round(res.conf * 100) + "%";
        ctx.font = `${fs}px "Microsoft YaHei",sans-serif`;
        const w = ctx.measureText(txt).width;
        const bx = cell.x - cell.size / 2, by = cell.y + cell.size / 2 + 2 * s;
        ctx.fillStyle = "rgba(0,0,0,.65)";
        ctx.fillRect(bx, by, w + 8, fs + 6);
        ctx.fillStyle = color;
        ctx.fillText(txt, bx + 4, by + fs);
      }
    }
  }
}

function cropToTensor(cell) {
  const tmp = document.createElement("canvas");
  tmp.width = tmp.height = SIZE;
  const tctx = tmp.getContext("2d");
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = "high";
  tctx.drawImage(state.img, cell.x - cell.size / 2, cell.y - cell.size / 2, cell.size, cell.size, 0, 0, SIZE, SIZE);
  const d = tctx.getImageData(0, 0, SIZE, SIZE).data;
  const out = new Float32Array(3 * SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    out[i] = (d[i * 4] / 255 - 0.5) / 0.5;
    out[SIZE * SIZE + i] = (d[i * 4 + 1] / 255 - 0.5) / 0.5;
    out[2 * SIZE * SIZE + i] = (d[i * 4 + 2] / 255 - 0.5) / 0.5;
  }
  return out;
}

function softmax(logits) {
  let mx = -Infinity;
  for (const v of logits) mx = Math.max(mx, v);
  let sum = 0; const e = new Array(logits.length);
  for (let i = 0; i < logits.length; i++) { e[i] = Math.exp(logits[i] - mx); sum += e[i]; }
  for (let i = 0; i < e.length; i++) e[i] /= sum;
  return e;
}

async function runBatch(tensors) {
  const n = tensors.length;
  const data = new Float32Array(n * 3 * SIZE * SIZE);
  for (let i = 0; i < n; i++) data.set(tensors[i], i * 3 * SIZE * SIZE);
  const input = new ort.Tensor("float32", data, [n, 3, SIZE, SIZE]);
  const out = await state.session.run({ input });
  const logits = out.logits.data;           // [n, 300]
  const probs = [];
  for (let i = 0; i < n; i++) probs.push(softmax(logits.subarray(i * 300, (i + 1) * 300)));
  return probs;
}

$("run").addEventListener("click", async () => {
  if (!state.img || !state.session) return;
  $("run").disabled = true;
  try {
    const jobs = [];
    for (let gi = 0; gi < state.grids.length; gi++) {
      const g = state.grids[gi];
      if (!g.on) continue;
      for (const cell of gridCells(g)) jobs.push({ gi, cell, tensor: cropToTensor(cell) });
    }
    setStatus(`推理 ${jobs.length} 格…`);
    const t0 = performance.now();
    let probs;
    try {
      probs = await runBatch(jobs.map(j => j.tensor));
    } catch (e) {
      // static-batch ONNX fallback: one by one
      probs = [];
      for (const j of jobs) probs.push((await runBatch([j.tensor]))[0]);
    }
    state.results = jobs.map((j, i) => {
      const p = probs[i];
      let best = 0;
      for (let k = 1; k < p.length; k++) if (p[k] > p[best]) best = k;
      return { grid: j.gi, r: j.cell.r, c: j.cell.c, x: j.cell.x, y: j.cell.y,
               size: j.cell.size, label: state.labels[best], conf: p[best] };
    });
    draw();
    renderResults();
    setStatus(`完成：${jobs.length} 格，${Math.round(performance.now() - t0)} ms（${state.backend}）`);
  } catch (e) {
    console.error(e);
    setStatus("识别失败: " + e.message);
  } finally {
    $("run").disabled = false;
  }
});

function renderResults() {
  const counts = new Map();
  const unknown = [];
  for (const r of state.results) {
    if (r.label === EMPTY_LABEL) continue;
    if (r.conf < CONF_TH) { unknown.push(r); continue; }
    counts.set(r.label, (counts.get(r.label) || 0) + 1);
  }
  const arr = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  $("total").textContent = `共 ${arr.reduce((s, x) => s + x[1], 0)} 只 / ${arr.length} 种`;
  $("list").innerHTML = arr.map(([name, n]) => {
    const icon = state.icons[name] || "";
    return `<li>${icon ? `<img src="${icon}">` : ""}<span class="name">${name}</span><span class="cnt">×${n}</span></li>`;
  }).join("");
  $("unknowns").innerHTML = unknown.slice(0, 30).map(r => {
    const icon = state.icons[r.label] || "";
    return `<li>${icon ? `<img src="${icon}">` : ""}<span class="name">${r.label} (${Math.round(r.conf * 100)}%)</span></li>`;
  }).join("");
}

// grid editor
function buildSliders() {
  const g = state.grids[state.active];
  const defs = [
    ["x0", "起点X", 0, 1900, 1], ["y0", "起点Y", 0, 1060, 1],
    ["dx", "列距", 0, 200, 1], ["dy", "行距", 0, 200, 1],
    ["size", "格大小", 20, 140, 1], ["cols", "列数", 1, 12, 1],
    ["rows", "行数", 1, 8, 1],
  ];
  const box = $("sliders");
  box.innerHTML = "";
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

init().then(buildSliders);
