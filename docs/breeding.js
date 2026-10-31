// 给你配了 · 幻兽帕鲁自动配种工具（多截图 / 可展开完整方案树 / 正查 / 反查）
const SIZE = 96, CONF_TH = 0.35, EMPTY = "__empty__", PAGE = 10;
const state = {
  shots: [],                 // {name, src, owned:Set, conf:Map}
  img: null, imgScale: 1,
  session: null, backend: "",
  labels: null, zh: null, icons: null,
  breed: null, pairIndex: null,
  owned: new Set(), ownedConf: new Map(), manualAdd: new Set(), manualRemove: new Set(),
  target: null, mode: "rev", backendMode: "gpu", meta: null, works: null, passives: null,
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
    const forceCpu = new URLSearchParams(location.search).get("backend") === "cpu";
    state.backendMode = forceCpu ? "cpu" : "gpu";
    if (!(await createSession(state.backendMode))) {
      state.backendMode = "cpu";
      if (!(await createSession("cpu"))) throw new Error("推理后端初始化失败");
    }
    updateBackendBtn();
    $("status").textContent = `模型就绪（${state.backend}），等待截图…`;
    const [labels, zh, breed, meta, works, passives] = await Promise.all([
      fetch("models/labels.json").then(r => r.json()),
      fetch("models/zh_names.json").then(r => r.json()),
      fetch("breeding.json").then(r => r.json()),
      fetch("meta.json").then(r => r.json()),
      fetch("works.json").then(r => r.json()),
      fetch("pal_passives.json").then(r => r.json()).catch(() => null),
    ]);
    state.labels = labels.labels; state.zh = zh; state.breed = breed; state.meta = meta; state.works = works; state.passives = passives || null;
    state.pairIndex = new Map();
    for (const [child, pairs] of Object.entries(breed)) for (const [a, b] of pairs) {
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!state.pairIndex.has(k)) state.pairIndex.set(k, []);
      state.pairIndex.get(k).push(child);
    }
    $("pallist").innerHTML = Object.keys(breed).map(id => {
      const dex = meta[id] ? meta[id].dex : "";
      return `<option value="${nameOf(id)}" label="${dex ? dex + " " : ""}${nameOf(id)}">${id}</option>`;
    }).join("");
    setTarget(state.breed["SheepBall"] ? "SheepBall" : Object.keys(breed)[0]);
    state.icons = await fetch("icons.json").then(r => r.json());
    renderGroupCards();
    renderNavPick();
    renderNavTargets();
    openTarget();
    const params = new URLSearchParams(location.search);
    const demos = params.getAll("demo");
    for (const d of demos) await addImage(d, d);
    const man = params.get("manual");
    if (man) { for (const t of man.split(",")) { const id = resolveId(t); if (id) { state.manualAdd.add(id); state.manualRemove.delete(id); } } mergeOwned(); renderOwned(); }
    if(params.get("owned")){
      for(const t of params.get("owned").split(",")){ const id=resolveId(t); if(id){ state.manualAdd.add(id); state.manualRemove.delete(id); } }
      mergeOwned(); renderOwned();
    }
    if(params.get("wq")){ $("target").value=params.get("wq"); $("target").dispatchEvent(new Event("input")); }
    if(params.get("detect")) setTimeout(()=>$("detectBtn").click(),700);
    if(params.get("mode")==="nav"){
      switchMode("nav");
      if(params.get("group")){ navGroups=[{name:params.get("group"),ids:[]}]; navGroupIdx=0; renderGroupCards(); }
      if(params.get("grp")){
        for(const part of params.get("grp").split(";")){
          const [nm,ids]=part.split(":");
          if(nm) navGroups.push({name:nm,ids:(ids||"").split("|").map(t=>resolveId(t)).filter(Boolean)});
        }
        navGroupIdx=0; renderGroupCards();
        if(params.get("reqgrp")) $("navAllGroups").checked=true;
      }
      if(params.get("navTargets")){ for(const t of params.get("navTargets").split(",")){ const id=resolveId(t); if(id) navTargets.push(id); } renderNavTargets(); setTimeout(()=>$("navGo").click(),300); }
      if(params.get("navTarget")) $("navTarget").value=params.get("navTarget");
      if(params.get("navTarget")) $("navGo").click();
      if(params.get("pop")){ const pid=resolveId(params.get("pop")); if(pid) setTimeout(()=>openNodePop(pid),400); }
      if(params.get("expand")){ const eid=resolveId(params.get("expand")); if(eid) setTimeout(()=>{ expandPlans(eid,6); openNodePop(eid); },500); }
      if(params.get("testclick")){
        setTimeout(()=>{
          const cv=$("navCanvas"); const n=navView.nodes.find(x=>x.type==="target")||navView.nodes[0];
          if(!cv||!n) return;
          const r=cv.getBoundingClientRect();
          const px=r.left+n.x*(r.width/navView.w), py=r.top+n.y*(r.height/navView.h);
          cv.dispatchEvent(new MouseEvent("mousedown",{clientX:px,clientY:py,bubbles:true}));
          window.dispatchEvent(new MouseEvent("mouseup",{clientX:px,clientY:py,bubbles:true}));
        },1500);
      }
    }
    const tq = params.get("target");
    if (tq) { const tid = resolveId(tq); if (tid) { setTarget(tid); openTarget(); } }
    for (const open of params.getAll("open")) {
      const id = resolveId(open);
      if (id) state.expanded.set(id, { page: 0 });
    }
    if (params.getAll("open").length) renderExplorer();
  } catch (e) { $("status").textContent = "初始化失败：" + e.message; }
}

function resolveId(text) {
  text = (text || "").trim(); if (!text) return null;
  if (state.breed[text]) return text;
  const low = text.toLowerCase();
  // 1) 图鉴编号：1 / 001 / 5B / No.001
  if (state.meta) {
    const m = low.match(/^(?:no\.?\s*)?(\d{1,3})([a-z])?$/i);
    if (m) {
      const num = +m[1], suf = (m[2] || "").toLowerCase();
      let hit = null;
      for (const id of Object.keys(state.meta)) {
        const dm = state.meta[id].dex.toLowerCase().match(/^(\d+)([a-z]?)$/);
        if (!dm || +dm[1] !== num) continue;
        if (suf) { if (dm[2] === suf) { hit = id; break; } }
        else if (!hit || !dm[2]) hit = id;
      }
      if (hit) return hit;
    }
    // 2) 拼音全拼 / 首字母
    for (const id of Object.keys(state.meta)) {
      const mt = state.meta[id];
      if (mt.py === low || mt.pyi === low) return id;
    }
  }
  // 3) 中文名 / 内部 ID
  for (const id of Object.keys(state.breed)) if (nameOf(id) === text) return id;
  for (const id of Object.keys(state.breed)) if (id.toLowerCase() === low) return id;
  for (const id of Object.keys(state.breed)) if (nameOf(id).includes(text)) return id;
  return null;
}
function setTarget(id) { state.target = id; $("target").value = nameOf(id); }

async function createSession(mode) {
  const cands = mode === "cpu"
    ? [{ m: "models/pal_classifier.onnx", ep: "wasm", n: "CPU · WASM" }]
    : [{ m: "models/pal_classifier_fp16.onnx", ep: "webgpu", n: "GPU · WebGPU FP16" },
       { m: "models/pal_classifier.onnx", ep: "webgpu", n: "GPU · WebGPU FP32" },
       { m: "models/pal_classifier.onnx", ep: "webgl", n: "GPU · WebGL" }];
  for (const c of cands) {
    try {
      state.session = await ort.InferenceSession.create(c.m, { executionProviders: [c.ep] });
      state.backend = c.n; return true;
    } catch (e) { console.warn("backend failed", c.n, e); }
  }
  return false;
}
function updateBackendBtn() {
  const b = $("backendToggle");
  if (!b) return;
  b.textContent = state.backendMode === "cpu" ? "推理：CPU" : "推理：GPU";
  b.title = "当前：" + state.backend + "（点击切换 CPU/GPU）";
}
async function rerunShots() {
  for (let i = 0; i < state.shots.length; i++) {
    const im = await loadIm(state.shots[i].src);
    state.img = im; state.imgScale = im.naturalWidth / 1920; autoGrid();
    const res = await recognizeImage(im);
    state.shots[i].owned = res.owned; state.shots[i].conf = res.conf;
  }
  mergeOwned(); renderShots(); renderOwned();
  if (state.target) openTarget();
}

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
  state.lastImg = im;
  state.shots.push({ name, src, owned: res.owned, conf: res.conf });
  mergeOwned(); renderShots(); renderOwned();
  $("status").textContent = `第 ${state.shots.length} 张识别完成：${res.owned.size} 种 · 合计 ${state.owned.size} 种（${state.backend}）`;
  if (state.target) openTarget();
}
function mergeOwned() {
  state.owned = new Set(); state.ownedConf = new Map();
  for (const s of state.shots) for (const id of s.owned) {
    if (state.manualRemove.has(id)) continue;
    state.owned.add(id);
    state.ownedConf.set(id, Math.max(state.ownedConf.get(id) || 0, s.conf.get(id) || 0));
  }
  for (const id of state.manualAdd) {
    if (state.manualRemove.has(id)) continue;
    state.owned.add(id);
    state.ownedConf.set(id, 1);
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
    if (!bestStep || bestScore <= 0) return null;
    return { x0: foldCenter(arr, bestStep), step: bestStep };
  };
  const runsOf = (arr) => {
    const mx = Math.max(...arr); if (!mx) return [];
    const thr = mx * 0.5, runs = []; let st = -1;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] >= thr) { if (st < 0) st = i; }
      else if (st >= 0) { runs.push([st, i - 1]); st = -1; }
    }
    if (st >= 0) runs.push([st, arr.length - 1]);
    return runs;
  };
  const cRuns = runsOf(colp), rRuns = runsOf(rowp);
  if (!cRuns.length && !rRuns.length) return;
  const runCenter = (r) => (r[0] + r[1]) / 2;
  const runStep = (runs) => runs.length > 1 ? (runCenter(runs[runs.length - 1]) - runCenter(runs[0])) / (runs.length - 1) : 0;
  const cx = cRuns.length > 1 ? det(colp) : null;
  const cy = rRuns.length > 1 ? det(rowp) : null;
  const inv = 1 / state.imgScale;
  const cols = cRuns.length || 1;
  const rows = rRuns.length || 1;
  const x0 = cx ? cx.x0 : runCenter(cRuns[0]);
  const y0 = cy ? cy.x0 : runCenter(rRuns[0]);
  const dx = cx ? cx.step : (runStep(cRuns) || w / cols);
  const dy = cy ? cy.step : (runStep(rRuns) || h / rows);
  const cell = cx && cy ? Math.min(cx.step, cy.step) : Math.min(dx, dy);
  state.grid = {
    x0: (x0 / s) * inv, dx: (dx / s) * inv,
    y0: (y0 / s) * inv, dy: (dy / s) * inv,
    size: (cell / s) * inv * 0.86,
    cols: Math.min(12, cols), rows: Math.min(8, rows),
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
    // 去红标（远征骷髅等）视图：红色像素替换为背景色
    {
      const cv = document.createElement("canvas"); cv.width = cv.height = SIZE;
      const t = cv.getContext("2d"); t.imageSmoothingQuality = "high";
      t.drawImage(im, x - size / 2, y - size / 2, size, size, 0, 0, SIZE, SIZE);
      const d = t.getImageData(0, 0, SIZE, SIZE).data;
      const arr = new Float32Array(3 * SIZE * SIZE);
      for (let i = 0; i < SIZE * SIZE; i++) {
        let rr = d[i * 4], gg = d[i * 4 + 1], bb = d[i * 4 + 2];
        if (rr > 100 && rr - gg > 40 && rr - bb > 40) { rr = 18; gg = 22; bb = 26; }
        arr[i] = (rr / 255 - 0.5) / 0.5;
        arr[SIZE * SIZE + i] = (gg / 255 - 0.5) / 0.5;
        arr[2 * SIZE * SIZE + i] = (bb / 255 - 0.5) / 0.5;
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
    return `<span class="chip">${ic}${nameOf(id)}<button class="chip-x" data-id="${id}" title="移除">×</button></span>`;
  }).join("");
  $("chips").querySelectorAll(".chip-x").forEach(b => b.onclick = () => {
    const id = b.dataset.id;
    if (state.manualAdd.has(id)) state.manualAdd.delete(id);
    else state.manualRemove.add(id);
    mergeOwned(); renderShots(); renderOwned();
    if (state.target) openTarget();
  });
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
  renderNavPick();
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

$("backendToggle").onclick = async () => {
  const b = $("backendToggle");
  if (b.classList.contains("busy")) return;
  const next = state.backendMode === "gpu" ? "cpu" : "gpu";
  b.classList.add("busy"); b.textContent = "切换中…";
  const ok = await createSession(next);
  if (!ok) {
    b.classList.remove("busy"); updateBackendBtn();
    $("status").textContent = "切换失败，继续使用 " + state.backend;
    return;
  }
  state.backendMode = next; updateBackendBtn();
  if (state.shots.length) {
    $("status").textContent = `已切到 ${state.backend}，重新识别 ${state.shots.length} 张…`;
    await rerunShots();
  }
  $("status").textContent = `推理后端：${state.backend}`;
  b.classList.remove("busy");
};

$("ownAdd").onclick = () => {
  const id = resolveId($("ownInput").value);
  if (!id) { $("status").textContent = "没找到这只帕鲁，试试中文名/拼音/编号"; return; }
  state.manualAdd.add(id); state.manualRemove.delete(id);
  $("ownInput").value = "";
  mergeOwned(); renderShots(); renderOwned();
  if (state.target) openTarget();
  $("status").textContent = `已手动加入 ${nameOf(id)}（当前共 ${state.owned.size} 种）`;
};
$("ownInput").addEventListener("keydown", e => { if (e.key === "Enter") $("ownAdd").click(); });


// ---------------- navigation ----------------
const NAV_PASSIVES = {"传说":"Legend","运动健将":"MoveSpeed_up_2","灵活":"MoveSpeed_up_1","永动机":"Stamina_Up_3"};
const navPick = new Set();
let navGroups = [];
try { navGroups = JSON.parse(localStorage.getItem("pal_nav_groups") || "[]"); } catch (e) { navGroups = []; }
function resolveIdPassive(t){ const low=(t||"").toLowerCase(); for(const k in NAV_PASSIVES) if(k===t||NAV_PASSIVES[k].toLowerCase()===low) return NAV_PASSIVES[k]; return null; }
function dexNum(id){const m=state.meta&&state.meta[id]&&state.meta[id].dex;const g=m&&m.match(/^(\d+)([a-z])?/i);if(!g)return 9999;const base=+g[1];const total=Object.keys(state.meta||{}).length;return (g[2]||"").toLowerCase()==="b"?base+total/2:base;}
function navEdges(){
  if(!state.edges){
    state.edges={};
    for(const [child,pairs] of Object.entries(state.breed)){
      for(const [a,b] of pairs){
        (state.edges[a]||(state.edges[a]=[])).push([child,b]);
        (state.edges[b]||(state.edges[b]=[])).push([child,a]);
      }
    }
  }
  return state.edges;
}
const distCache=new Map();
function reverseDist(target){
  if(distCache.has(target)) return distCache.get(target);
  const dist={[target]:0}, q=[target], rev={};
  for(const [child,pairs] of Object.entries(state.breed)) for(const [a,b] of pairs){(rev[child]||(rev[child]=[])).push(a,b);}
  while(q.length){const u=q.shift();for(const p of (rev[u]||[])){if(dist[p]===undefined){dist[p]=dist[u]+1;q.push(p);}}}
  distCache.set(target,dist);
  return dist;
}
function navSearch(inputs,target,passiveId,planned,groups){
  const edges=navEdges(), dist=reverseDist(target), inputSet=new Set(inputs);
  const groupOf=new Map();
  if(groups) groups.forEach((g,i)=>{ for(const id of g) if(!groupOf.has(id)) groupOf.set(id,i); });
  const fullMask=groups&&groups.length?(1<<groups.length)-1:0;
  if(inputs.every(p=>dist[p]===undefined)) return null;
  const pq=new Heap(); const best=new Map();
  let bestResult=null,bestKey=null,exp=0;
  for(const p of inputs){
    const m0=groupOf.has(p)?1<<groupOf.get(p):0;
    pq.push({pal:p,carry:!!passiveId,mask:m0,cost:0,prob:1,ext:0,dex:0,steps:0,path:[]},[0,0,0,0]);
  }
  while(pq.size&&exp<30000){
    const s=pq.pop(); exp++;
    if(s.pal===target&&(!passiveId||s.carry)&&(!fullMask||s.mask===fullMask)){
      const key=[s.cost,s.ext,s.dex,s.steps];
      if(!bestKey||key<bestKey){bestKey=key;bestResult=s;}
      continue;
    }
    if(s.steps>=6) continue;
    const cands=(edges[s.pal]||[]).filter(([child,other])=>child!==s.pal);
    cands.sort((x,y)=>{
      const hx=dist[x[0]]??999, hy=dist[y[0]]??999;
      if(hx!==hy) return hx-hy;
      const ex=inputSet.has(x[1])?0:1, ey=inputSet.has(y[1])?0:1;
      if(ex!==ey) return ex-ey;
      return dexNum(x[1])-dexNum(y[1]);
    });
    const seenChild=new Set(); let expanded=0;
    for(const [child,other] of cands){
      if(expanded>=8) break;
      if(seenChild.has(child)) continue;
      seenChild.add(child); expanded++;
      const otherIn=inputSet.has(other);
      const otherCarry=!!passiveId&&otherIn;
      let p=0;
      if(passiveId){
        if(s.carry&&otherCarry) p=0.75;
        else if(s.carry||otherCarry) p=0.5;
      }
      let stepCost=passiveId?(p>0?1/p:0):1;
      if(planned&&planned.has(child)) stepCost=0;
      let mask=s.mask||0;
      if(groupOf.has(other)) mask|=1<<groupOf.get(other);
      if(groupOf.has(child)) mask|=1<<groupOf.get(child);
      const ns={pal:child,carry:s.carry||otherCarry,mask,cost:s.cost+stepCost,
        prob:s.prob*(passiveId?p:1),ext:s.ext+(otherIn?0:1),
        dex:s.dex+(otherIn?0:dexNum(other)),steps:s.steps+1,
        path:s.path.concat([{from:s.pal,other,child,external:!otherIn,p:passiveId?p:1,stepCost}])};
      const key=child+"|"+(ns.carry?1:0)+"|"+mask;
      const prev=best.get(key);
      if(prev&&(prev[0]<ns.cost||(prev[0]===ns.cost&&prev[1]<ns.ext)||(prev[0]===ns.cost&&prev[1]===ns.ext&&prev[2]<=ns.dex))) continue;
      best.set(key,[ns.cost,ns.ext,ns.dex]);
      pq.push(ns,[ns.cost,ns.ext,ns.dex,navDist(ns.pal,target,dist)]);
    }
  }
  return bestResult;
}
function navDist(pal,target,dist){ return dist[pal]===undefined?999:dist[pal]; }

class Heap{
  constructor(){this.a=[];}
  get size(){return this.a.length;}
  push(item,key){this.a.push({item,key});this.up(this.a.length-1);}
  pop(){const top=this.a[0];const last=this.a.pop();if(this.a.length){this.a[0]=last;this.down(0);}return top.item;}
  less(i,j){const a=this.a[i].key,b=this.a[j].key;for(let k=0;k<a.length;k++){if(a[k]!==b[k])return a[k]<b[k];}return false;}
  up(i){while(i>0){const p=(i-1)>>1;if(this.less(i,p)){const t=this.a[i];this.a[i]=this.a[p];this.a[p]=t;i=p;}else break;}}
  down(i){const n=this.a.length;while(true){let l=i*2+1,r=l+1,m=i;if(l<n&&this.less(l,m))m=l;if(r<n&&this.less(r,m))m=r;if(m===i)break;const t=this.a[i];this.a[i]=this.a[m];this.a[m]=t;i=m;}}
}

function renderNav(result,inputs,target){
  if(!result){$("navSummary").textContent="没有找到可行路线（深度不够或图不连通）。";$("navTable").innerHTML="";return;}
  const pct=(result.prob*100).toFixed(1);
  $("navSummary").textContent = result.prob<1
    ? `总步数 ${result.steps} · 成功率 ${pct}% · 期望蛋糕 ${result.cost.toFixed(2)} · 外部帕鲁 ${result.ext} 只 · 外部 No 总和 ${result.dex}`
    : `总步数 ${result.steps} · 期望蛋糕 ${result.cost.toFixed(2)}（每步 1 个） · 外部帕鲁 ${result.ext} 只 · 外部 No 总和 ${result.dex}`;
  const rows=result.path.map((p,i)=>{
    const ext=p.external?`<span class="tag ext">外部 No.${dexNum(p.other)}</span>`:`<span class="tag in">输入</span>`;
    return `<tr><td>${i+1}</td><td>${nameOf(p.from)}<br><span class="mono">${p.from}</span></td>
      <td>${nameOf(p.other)}<br><span class="mono">${p.other}</span> ${ext}</td>
      <td>${nameOf(p.child)}<br><span class="mono">${p.child}</span></td>
      <td>${p.stepCost?p.stepCost.toFixed(2):"—"}</td></tr>`;
  }).join("");
  $("navTable").innerHTML=`<table><thead><tr><th>#</th><th>当前</th><th>另一亲本</th><th>子代</th><th>蛋糕</th></tr></thead><tbody>${rows}</tbody></table>`;
  drawNavGraph(result,inputs,target);
}

// ---- star graph ----
const navView={nodes:[],edges:[],w:900,h:520,drag:null,scale:1};
const navIconImg=new Map();
function getNavIcon(id){
  if(!state.icons||!state.icons[id]) return null;
  if(navIconImg.has(id)) return navIconImg.get(id);
  const im=new Image();
  im.onload=()=>{ try{ paintNavGraph(); }catch(e){} };
  im.src=state.icons[id];
  navIconImg.set(id,im);
  return im;
}
function buildNavGraph(result,inputs,target){
  const inputSet=new Set(inputs), nodes=new Map(), edges=[];
  const add=(id,type)=>{ if(!nodes.has(id)) nodes.set(id,{id,type,x:0,y:0}); const n=nodes.get(id); if(type==="target") n.type="target"; else if(n.type!=="target") n.type=type; return n; };
  add(target,"target");
  for(const p of result.path){
    const f=add(p.from,inputSet.has(p.from)?"owned":"external");
    const o=add(p.other,p.external?"external":"owned");
    const c=add(p.child,p.child===target?"target":"child");
    edges.push({a:f.id,b:c.id,kind:"path"});
    edges.push({a:o.id,b:c.id,kind:"path"});
  }
  navView.nodes=[...nodes.values()]; navView.edges=edges;
  navView.expandedPlans=new Map();
  layoutNav();
}
function layoutNav(){
  const {nodes,edges,w,h}=navView;
  const targetNode=nodes.find(n=>n.type==="target");
  nodes.forEach((n,i)=>{ const a=i/nodes.length*Math.PI*2; n.x=w/2+Math.cos(a)*Math.min(w,h)*0.34; n.y=h/2+Math.sin(a)*Math.min(w,h)*0.34; });
  if(targetNode){ targetNode.x=w/2; targetNode.y=h/2; }
  const k=Math.sqrt((w*h)/nodes.length)*0.52;
  for(let it=0;it<320;it++){
    for(let i=0;i<nodes.length;i++) for(let j=i+1;j<nodes.length;j++){
      if(nodes[i]===targetNode||nodes[j]===targetNode) continue;
      const a=nodes[i],b=nodes[j]; let dx=b.x-a.x,dy=b.y-a.y; let d2=dx*dx+dy*dy;
      if(d2<1){dx=Math.random()-0.5;dy=Math.random()-0.5;d2=1;}
      const f=k*k/d2, d=Math.sqrt(d2), fx=f*dx/d, fy=f*dy/d;
      a.x-=fx; a.y-=fy; b.x+=fx; b.y+=fy;
    }
    for(const e of edges){ const a=nodes.find(n=>n.id===e.a),b=nodes.find(n=>n.id===e.b); if(!a||!b)continue;
      let dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||1;
      const strength = e.kind==="path" ? 0.05 : 0.006;
      const f=(d-Math.min(w,h)*0.24)*strength;
      const fx=f*dx/d, fy=f*dy/d; a.x+=fx; a.y+=fy; b.x-=fx; b.y-=fy;
    }
    for(const n of nodes){ if(n===targetNode) continue; n.x+=(w/2-n.x)*0.01; n.y+=(h/2-n.y)*0.01; n.x=Math.max(60,Math.min(w-60,n.x)); n.y=Math.max(34,Math.min(h-34,n.y)); }
    if(targetNode){ targetNode.x=w/2; targetNode.y=h/2; }
  }
}
function syncCanvasSize(){
  const cv=$("navCanvas"); if(!cv) return;
  const r=cv.getBoundingClientRect();
  navView.w=Math.max(600,Math.round(r.width));
  navView.h=Math.max(420,Math.round(r.height));
}
window.addEventListener("resize",()=>{
  if(!$("navPanel").hidden && navView.nodes.length){
    const ow=navView.w, oh=navView.h;
    syncCanvasSize();
    const sx=navView.w/ow, sy=navView.h/oh;
    for(const n of navView.nodes){ n.x*=sx; n.y*=sy; }
    paintNavGraph();
  }
});
function drawNavGraph(result,inputs,target){
  syncCanvasSize();
  buildNavGraph(result,inputs,target);
  paintNavGraph();
  startNavAnim();
}
function startNavAnim(){
  if(navView.raf) return;
  const loop=()=>{
    navView.t=((navView.t||0)+0.6)%100000;
    if(!$("navPanel").hidden && navView.nodes.length) paintNavGraph();
    navView.raf=requestAnimationFrame(loop);
  };
  navView.raf=requestAnimationFrame(loop);
}
function paintNavGraph(){
  const cv=$("navCanvas"), ctx=cv.getContext("2d"), dpr=window.devicePixelRatio||1;
  cv.width=navView.w*dpr; cv.height=navView.h*dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const pos=new Map(navView.nodes.map(n=>[n.id,n]));
  ctx.clearRect(0,0,navView.w,navView.h);
  // edges (curved + animated flow on the path)
  for(const e of navView.edges){
    const a=pos.get(e.a),b=pos.get(e.b); if(!a||!b)continue;
    const dx=b.x-a.x, dy=b.y-a.y, len=Math.hypot(dx,dy)||1;
    const nx=-dy/len, ny=dx/len;
    const bend = e.kind==="path" ? 16 : 9;
    const mx=(a.x+b.x)/2+nx*bend, my=(a.y+b.y)/2+ny*bend;
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.quadraticCurveTo(mx,my,b.x,b.y);
    if(e.kind==="path"){
      ctx.strokeStyle="rgba(255,138,122,.9)"; ctx.lineWidth=2;
      ctx.setLineDash([8,8]); ctx.lineDashOffset=-(navView.t||0);
      ctx.stroke(); ctx.setLineDash([]);
      const t=((navView.t||0)/26)%1;
      const q={x:(1-t)*(1-t)*a.x+2*(1-t)*t*mx+t*t*b.x, y:(1-t)*(1-t)*a.y+2*(1-t)*t*my+t*t*b.y};
      ctx.beginPath(); ctx.arc(q.x,q.y,3,0,Math.PI*2); ctx.fillStyle="#ffd9cf"; ctx.fill();
    } else if(e.kind==="plan"){
      ctx.strokeStyle="rgba(127,209,255,.75)"; ctx.lineWidth=1.5; ctx.setLineDash([2,5]); ctx.stroke(); ctx.setLineDash([]);
    } else {
      ctx.strokeStyle="rgba(60,80,100,.5)"; ctx.lineWidth=1; ctx.setLineDash([4,4]); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  // nodes (round thumbnails)
  for(const n of navView.nodes){
    const r=n.type==="target"?24:18;
    let ring="#4a5a6a";
    if(n.type==="target") ring="#ff6b5e";
    else if(n.type==="owned") ring="#38d47a";
    else if(n.type==="external") ring="#ffb86b";
    else if(n.type==="child") ring="#7fd1ff";
    const img=getNavIcon(n.id);
    ctx.beginPath(); ctx.arc(n.x,n.y,r,0,Math.PI*2); ctx.closePath();
    if(img && img.complete && img.naturalWidth){
      ctx.save(); ctx.clip(); ctx.drawImage(img,n.x-r,n.y-r,2*r,2*r); ctx.restore();
    } else {
      ctx.fillStyle=ring; ctx.fill();
    }
    ctx.beginPath(); ctx.arc(n.x,n.y,r,0,Math.PI*2);
    ctx.strokeStyle=ring; ctx.lineWidth=n.type==="candidate"?2:3; ctx.stroke();
    const label=nameOf(n.id)+(n.type==="candidate"?"":` (${dexNum(n.id)})`);
    ctx.font="12px 'Microsoft YaHei',sans-serif";
    const tw=ctx.measureText(label).width;
    ctx.fillStyle="rgba(8,10,12,.78)"; ctx.fillRect(n.x-tw/2-3,n.y+r+4,tw+6,16);
    ctx.fillStyle="#dfe8f0"; ctx.fillText(label,n.x-tw/2,n.y+r+16);
  }
}
// plan toggling on the graph
function planKey(a,b){ return a<b ? a+"|"+b : b+"|"+a; }
function planSet(id){
  if(!navView.expandedPlans) navView.expandedPlans=new Map();
  if(!navView.expandedPlans.has(id)) navView.expandedPlans.set(id,new Set());
  return navView.expandedPlans.get(id);
}
function isPlanOpen(id,a,b){ return navView.expandedPlans && navView.expandedPlans.get(id) && navView.expandedPlans.get(id).has(planKey(a,b)); }
function cleanupOrphans(){
  const deg=new Map(navView.nodes.map(n=>[n.id,0]));
  for(const e of navView.edges){ deg.set(e.a,(deg.get(e.a)||0)+1); deg.set(e.b,(deg.get(e.b)||0)+1); }
  navView.nodes=navView.nodes.filter(n=> deg.get(n.id)>0 || n.type==="target");
}
function addPlan(id,a,b){
  const key=planKey(a,b);
  const set=planSet(id);
  if(set.has(key)) return;
  const newNodes=[a,b].filter(p=>!navView.nodes.some(n=>n.id===p)).length;
  if(navView.nodes.length+newNodes>500){
    $("status").textContent="展开的节点太多啦，先「收起全部分支」再选";
    return;
  }
  set.add(key);
  const ownedSet=new Set(navPick.size?navPick:state.owned);
  for(const p of [a,b]){
    if(!navView.nodes.some(n=>n.id===p)){
      navView.nodes.push({id:p,type:ownedSet.has(p)?"owned":"candidate",x:navView.w/2+(Math.random()-0.5)*160,y:navView.h/2+(Math.random()-0.5)*120});
    }
    navView.edges.push({a:id,b:p,kind:"plan",key,node:id});
  }
  layoutNav(); paintNavGraph();
}
function removePlan(id,a,b){
  const key=planKey(a,b);
  const set=planSet(id);
  if(!set.has(key)) return;
  set.delete(key);
  navView.edges=navView.edges.filter(e=>!(e.kind==="plan" && e.node===id && e.key===key));
  cleanupOrphans();
  layoutNav(); paintNavGraph();
}
function togglePlan(id,a,b){ isPlanOpen(id,a,b) ? removePlan(id,a,b) : addPlan(id,a,b); }
function expandPlans(id,limit=6){
  const pairs=(state.breed[id]||[]).filter(p=>!(p[0]===id&&p[1]===id)).slice(0,limit);
  const ownedSet=new Set(navPick.size?navPick:state.owned);
  let changed=false;
  for(const [a,b] of pairs){
    const key=planKey(a,b);
    if(planSet(id).has(key)) continue;
    if(navView.nodes.length+[a,b].filter(p=>!navView.nodes.some(n=>n.id===p)).length>500) break;
    planSet(id).add(key); changed=true;
    for(const p of [a,b]){
      if(!navView.nodes.some(n=>n.id===p)){
        navView.nodes.push({id:p,type:ownedSet.has(p)?"owned":"candidate",x:navView.w/2+(Math.random()-0.5)*160,y:navView.h/2+(Math.random()-0.5)*120});
      }
      navView.edges.push({a:id,b:p,kind:"plan",key,node:id});
    }
  }
  if(changed){ cleanupOrphans(); layoutNav(); paintNavGraph(); }
  return changed;
}

// node popup: all plans for a clicked pal
function openNodePop(id){
  const pop=$("nodePop"), body=$("npBody");
  $("npTitle").textContent=`${nameOf(id)} (No.${dexNum(id)})`;
  const pairs=(state.breed[id]||[]).filter(p=>!(p[0]===id&&p[1]===id));
  body.innerHTML = pairs.map((p,i)=>{
    const open=isPlanOpen(id,p[0],p[1]);
    return `<div class="np-plan" data-i="${i}">
      <img src="${(state.icons&&state.icons[p[0]])||""}"><span class="nm">${nameOf(p[0])}</span>
      <span class="dex">×</span>
      <img src="${(state.icons&&state.icons[p[1]])||""}"><span class="nm">${nameOf(p[1])}</span>
      <button class="np-toggle${open?" open":""}">${open?"收起":"展开"}</button>
    </div>`;
  }).join("") || '<span class="hint">没有配种记录</span>';
  body.querySelectorAll(".np-plan").forEach(el=>{
    const [a,b]=pairs[+el.dataset.i];
    el.querySelector(".np-toggle").onclick=(e)=>{
      e.stopPropagation();
      togglePlan(id,a,b);
      openNodePop(id);
    };
    el.onclick=(e)=>{ if(e.target.closest(".np-toggle")) return; togglePlan(id,a,b); openNodePop(id); };
  });
  const act=document.createElement("div"); act.className="np-actions";
  const bAuto=document.createElement("button"); bAuto.textContent="自动展开该节点";
  bAuto.title="自动把它的配种分支展开到图上（不改变目标）";
  bAuto.onclick=()=>{
    const ok=expandPlans(id,6);
    openNodePop(id);
    $("status").textContent=ok?`已展开 ${nameOf(id)} 的配种分支`:"没有更多可展开的方案";
  };
  const b1=document.createElement("button"); b1.textContent="以它为目标导航";
  b1.onclick=()=>{ $("navTarget").value=nameOf(id); pop.hidden=true; $("navGo").click(); };
  const b2=document.createElement("button"); b2.textContent="加入输入组";
  b2.onclick=()=>{ navPick.add(id); renderNavPick(); };
  act.appendChild(bAuto); act.appendChild(b1); act.appendChild(b2);
  body.insertBefore(act, body.firstChild);
  pop.hidden=false;
}
// drag + click
(function(){
  const cv=$("navCanvas");
  const toCanvas=(e)=>{const r=cv.getBoundingClientRect();return {x:(e.clientX-r.left)*(navView.w/r.width),y:(e.clientY-r.top)*(navView.h/r.height)};};
  let downAt=null, downNode=null, moved=false;
  cv.addEventListener("mousedown",e=>{
    const p=toCanvas(e);
    let hit=null;
    for(const n of navView.nodes){ if((n.x-p.x)**2+(n.y-p.y)**2<420){ hit=n; break; } }
    navView.drag=hit; downAt={x:e.clientX,y:e.clientY}; downNode=hit; moved=false;
    cv.style.cursor=hit?"grabbing":"grab";
  });
  window.addEventListener("mousemove",e=>{
    if(downAt && (Math.abs(e.clientX-downAt.x)>4 || Math.abs(e.clientY-downAt.y)>4)) moved=true;
    if(!navView.drag) return;
    const p=toCanvas(e); navView.drag.x=p.x; navView.drag.y=p.y; paintNavGraph();
  });
  window.addEventListener("mouseup",()=>{
    if(!moved && downNode){ openNodePop(downNode.id); }
    navView.drag=null; downAt=null; downNode=null; cv.style.cursor="grab";
  });
  $("npClose").onclick=()=>{ $("nodePop").hidden=true; };
})();

// ---------------- nav groups ----------------
let navGroupIdx = -1;
function saveGroups(){ try{ localStorage.setItem("pal_nav_groups", JSON.stringify(navGroups)); }catch(e){} }
function setPick(ids){ navPick.clear(); if(ids) for(const id of ids) navPick.add(id); }
function renderNavPick(){
  const el=$("navPick"); if(!el) return;
  const ids=[...state.owned].sort((a,b)=>dexNum(a)-dexNum(b));
  el.innerHTML=ids.length?ids.map(id=>`<label class="pick${navPick.has(id)?" on":""}"><input type="checkbox" data-id="${id}" ${navPick.has(id)?"checked":""}><img src="${(state.icons&&state.icons[id])||""}"><span>${nameOf(id)}</span></label>`).join(""):'<span class="hint">还没有已有帕鲁</span>';
  el.querySelectorAll("input").forEach(cb=>cb.onchange=()=>{
    const id=cb.dataset.id;
    if(cb.checked) navPick.add(id); else navPick.delete(id);
    renderNavPick();
  });
}
function renderGroupCards(){
  const el=$("groupCards"); if(!el) return;
  const cards=[{name:"全部已有",ids:null}].concat(navGroups);
  el.innerHTML=cards.map((g,i)=>{
    const idx=i-1, active=idx===navGroupIdx;
    const ids=g.ids||[...state.owned];
    const n=g.ids?g.ids.length:state.owned.size;
    const icons=ids.slice(0,5).map(id=>`<img src="${(state.icons&&state.icons[id])||""}">`).join("");
    return `<div class="gcard${active?" active":""}" data-i="${idx}">
      <div class="gname">${g.name}</div>
      <div class="gicons">${icons}<span class="gcount">${n} 只</span></div>
      ${g.ids!==null?`<button class="gdel" data-del="${idx}" title="删除分组">×</button>`:""}
    </div>`;
  }).join("");
  el.querySelectorAll(".gdel").forEach(b=>b.onclick=(e)=>{
    e.stopPropagation();
    const i=+b.dataset.del;
    if(!confirm("删除分组「"+navGroups[i].name+"」？")) return;
    navGroups.splice(i,1);
    if(navGroupIdx===i) navGroupIdx=-1; else if(navGroupIdx>i) navGroupIdx--;
    if(navGroupIdx<0) navPick.clear();
    saveGroups(); renderGroupCards(); renderNavPick();
  });
  el.querySelectorAll(".gcard").forEach(c=>c.onclick=()=>{
    navGroupIdx=+c.dataset.i;
    setPick(navGroupIdx<0?null:navGroups[navGroupIdx].ids);
    renderGroupCards(); renderNavPick();
  });
}
function openGroupModal(cb){
  $("groupModal").hidden=false;
  $("groupModalInput").value="";
  setTimeout(()=>$("groupModalInput").focus(),30);
  $("groupModalOk").onclick=()=>{
    const v=$("groupModalInput").value.trim();
    if(!v) return;
    $("groupModal").hidden=true;
    cb(v);
  };
  $("groupModalCancel").onclick=()=>{ $("groupModal").hidden=true; };
  $("groupModalInput").onkeydown=(e)=>{ if(e.key==="Enter") $("groupModalOk").click(); if(e.key==="Escape") $("groupModal").hidden=true; };
}
$("navGroupNew").onclick=()=>openGroupModal(name=>{
  navGroups.push({name,ids:[...navPick]});
  navGroupIdx=navGroups.length-1;
  saveGroups(); renderGroupCards(); renderNavPick();
});
$("navGroupSave").onclick=()=>{
  if(navGroupIdx>=0){
    navGroups[navGroupIdx].ids=[...navPick];
    saveGroups(); renderGroupCards();
    $("status").textContent="已更新分组「"+navGroups[navGroupIdx].name+"」";
  } else {
    openGroupModal(name=>{
      navGroups.push({name,ids:[...navPick]});
      navGroupIdx=navGroups.length-1;
      saveGroups(); renderGroupCards(); renderNavPick();
    });
  }
};
$("navPickAll").onclick=()=>{ for(const id of state.owned) navPick.add(id); renderNavPick(); if(navGroupIdx>=0){ navGroups[navGroupIdx].ids=[...navPick]; saveGroups(); renderGroupCards(); } };
$("navPickNone").onclick=()=>{ navPick.clear(); renderNavPick(); if(navGroupIdx>=0){ navGroups[navGroupIdx].ids=[]; saveGroups(); renderGroupCards(); } };
$("navCollapse").onclick=()=>{
  const r=navView.lastResult; if(!r) return;
  drawNavGraph(r,r._inputs,r._target);
  $("nodePop").hidden=true;
  $("status").textContent="已收起所有展开分支";
};

// ---------------- arbitrary screenshot detection ----------------
function regionActive(data,cw,x,y,size){
  let n=0,sum=0,sum2=0;
  const step=Math.max(2,Math.floor(size/8));
  for(let yy=y;yy<y+size;yy+=step)for(let xx=x;xx<x+size;xx+=step){
    const i=(yy*cw+xx)*4; const v=(data[i]+data[i+1]+data[i+2])/3;
    sum+=v; sum2+=v*v; n++;
  }
  const mean=sum/n, va=sum2/n-mean*mean;
  return mean>28 && va>120;
}
function cropTensorFrom(cv,x,y,size){
  const t=document.createElement("canvas"); t.width=t.height=SIZE;
  const g=t.getContext("2d"); g.imageSmoothingQuality="high";
  g.drawImage(cv,x,y,size,size,0,0,SIZE,SIZE);
  const d=g.getImageData(0,0,SIZE,SIZE).data;
  const arr=new Float32Array(3*SIZE*SIZE);
  for(let i=0;i<SIZE*SIZE;i++){arr[i]=(d[i*4]/255-.5)/.5;arr[SIZE*SIZE+i]=(d[i*4+1]/255-.5)/.5;arr[2*SIZE*SIZE+i]=(d[i*4+2]/255-.5)/.5;}
  return arr;
}
function iou(a,b){
  const x1=Math.max(a.x,b.x),y1=Math.max(a.y,b.y),x2=Math.min(a.x+a.size,b.x+b.size),y2=Math.min(a.y+a.size,b.y+b.size);
  const w=Math.max(0,x2-x1),h=Math.max(0,y2-y1),inter=w*h;
  return inter/(a.size*a.size+b.size*b.size-inter||1);
}
async function detectAll(img){
  const W=img.naturalWidth,H=img.naturalHeight;
  const scale=Math.min(1,1500/Math.max(W,H));
  const cw=Math.round(W*scale),ch=Math.round(H*scale);
  const cv=document.createElement("canvas"); cv.width=cw; cv.height=ch;
  const g=cv.getContext("2d"); g.drawImage(img,0,0,cw,ch);
  const data=g.getImageData(0,0,cw,ch).data;
  const minSide=Math.min(cw,ch);
  let sizes;
  if(minSide<300) sizes=[Math.round(minSide*0.6),Math.round(minSide*0.8)];
  else sizes=[Math.round(minSide*0.18),Math.round(minSide*0.28),Math.round(minSide*0.4)].filter(s=>s>=40&&s<=minSide*0.9);
  const cands=[];
  for(const size of sizes){
    const stride=Math.max(14,Math.round(size*0.7));
    for(let y=0;y+size<=ch;y+=stride)for(let x=0;x+size<=cw;x+=stride){
      if(regionActive(data,cw,x,y,size)) cands.push({x,y,size});
    }
    if(cands.length>1500) break;
  }
  if(cands.length>1200){
    for(let i=cands.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [cands[i],cands[j]]=[cands[j],cands[i]]; }
    cands.length=1200;
  }
  const scratch=document.createElement("canvas"); scratch.width=scratch.height=SIZE;
  const sctx=scratch.getContext("2d");
  function cropTensor(x,y,size){
    sctx.clearRect(0,0,SIZE,SIZE);
    sctx.imageSmoothingQuality="high";
    sctx.drawImage(cv,x,y,size,size,0,0,SIZE,SIZE);
    const d=sctx.getImageData(0,0,SIZE,SIZE).data;
    const arr=new Float32Array(3*SIZE*SIZE);
    for(let i=0;i<SIZE*SIZE;i++){arr[i]=(d[i*4]/255-.5)/.5;arr[SIZE*SIZE+i]=(d[i*4+1]/255-.5)/.5;arr[2*SIZE*SIZE+i]=(d[i*4+2]/255-.5)/.5;}
    return arr;
  }
  const results=[], BATCH=64;
  for(let i=0;i<cands.length;i+=BATCH){
    const batch=cands.slice(i,i+BATCH);
    const inp=new Float32Array(batch.length*3*SIZE*SIZE);
    batch.forEach((c,j)=>inp.set(cropTensor(c.x,c.y,c.size),j*3*SIZE*SIZE));
    const out=await state.session.run({input:new ort.Tensor("float32",inp,[batch.length,3,SIZE,SIZE])});
    const logits=out.logits.data;
    for(let j=0;j<batch.length;j++){
      let bi=0,off=j*300;
      for(let k=1;k<300;k++) if(logits[off+k]>logits[off+bi]) bi=k;
      let sum=0; for(let k=0;k<300;k++) sum+=Math.exp(logits[off+k]-logits[off+bi]);
      const conf=1/sum, label=state.labels[bi];
      if(label!=="__empty__"&&conf>0.5) results.push({...batch[j],label,conf});
    }
    await new Promise(r=>setTimeout(r,0));
  }
  results.sort((a,b)=>b.conf-a.conf);
  const kept=[];
  for(const r of results){
    const cx=r.x+r.size/2, cy=r.y+r.size/2;
    const dup=kept.some(k=>{
      const kx=k.x+k.size/2, ky=k.y+k.size/2;
      const d=Math.hypot(cx-kx,cy-ky);
      return d < (k.label===r.label?1.0:0.5)*Math.max(r.size,k.size);
    });
    if(!dup) kept.push(r);
    if(kept.length>=40) break;
  }
  // refine kept boxes (3x3 offsets)
  const offs=[-0.12,0,0.12];
  const jobs=[], meta=[];
  for(const k of kept) for(const ox of offs) for(const oy of offs){
    const x=Math.round(k.x+ox*k.size), y=Math.round(k.y+oy*k.size);
    if(x<0||y<0||x+k.size>cw||y+k.size>ch) continue;
    jobs.push(cropTensor(x,y,k.size)); meta.push({k,x,y});
  }
  for(let i=0;i<jobs.length;i+=BATCH){
    const batch=jobs.slice(i,i+BATCH);
    const inp=new Float32Array(batch.length*3*SIZE*SIZE);
    batch.forEach((a,j)=>inp.set(a,j*3*SIZE*SIZE));
    const out=await state.session.run({input:new ort.Tensor("float32",inp,[batch.length,3,SIZE,SIZE])});
    const logits=out.logits.data;
    for(let j=0;j<batch.length;j++){
      let bi=0,off=j*300;
      for(let k2=1;k2<300;k2++) if(logits[off+k2]>logits[off+bi]) bi=k2;
      let sum=0; for(let k2=0;k2<300;k2++) sum+=Math.exp(logits[off+k2]-logits[off+bi]);
      const conf=1/sum, label=state.labels[bi];
      const m=meta[i+j]; if(!m) continue;
      if(label!=="__empty__" && conf>m.k.conf){ m.k.conf=conf; m.k.label=label; m.k.x=m.x; m.k.y=m.y; }
    }
    await new Promise(r=>setTimeout(r,0));
  }
  kept.sort((a,b)=>b.conf-a.conf);
  return {cv,scale,kept};
}
function drawDetections(det){
  const {cv,scale,kept}=det;
  const out=$("detectCanvas");
  out.hidden=false; out.width=cv.width; out.height=cv.height;
  const g=out.getContext("2d"); g.drawImage(cv,0,0);
  g.lineWidth=2; g.font="12px 'Microsoft YaHei',sans-serif";
  for(const k of kept){
    const x=k.x/k.size, y=k.y/k.size;
    g.strokeStyle="#38d47a"; g.strokeRect(k.x,k.y,k.size,k.size);
    const label=`${nameOf(k.label)} ${(k.conf*100).toFixed(0)}%`;
    const tw=g.measureText(label).width;
    g.fillStyle="rgba(8,12,10,.8)"; g.fillRect(k.x,k.y-18,tw+8,16);
    g.fillStyle="#a9f0c5"; g.fillText(label,k.x+4,k.y-6);
  }
  $("detectList").innerHTML=kept.map((k,i)=>`<span class="dl" data-id="${k.label}"><img src="${(state.icons&&state.icons[k.label])||""}">${nameOf(k.label)} <span class="cf">${(k.conf*100).toFixed(0)}%</span></span>`).join("")||'<span class="hint">没有检测到帕鲁</span>';
  $("detectList").querySelectorAll(".dl").forEach(el=>el.onclick=()=>{ state.manualAdd.add(el.dataset.id); state.manualRemove.delete(el.dataset.id); mergeOwned(); renderOwned(); });
}
$("detectBtn").onclick=async()=>{
  if(!state.lastImg){ $("status").textContent="先上传一张截图"; return; }
  $("status").textContent="自动检测中（多尺度滑窗）…";
  try{
    const det=await detectAll(state.lastImg);
    drawDetections(det);
    $("status").textContent=`自动检测完成：${det.kept.length} 个（尺度 64–256）`;
  }catch(e){ $("status").textContent="自动检测失败："+e.message; }
};

// ---------------- work suitability search (in target inputs) ----------------
const WORK_MAP={
  "生火":"EmitFlame","点火":"EmitFlame","浇水":"Watering","播种":"Seeding","发电":"GenerateElectricity",
  "手工":"Handcraft","手工制作":"Handcraft","制作":"Handcraft","采集":"Collection","伐木":"Deforest",
  "采矿":"Mining","采油":"OilExtraction","制药":"ProductMedicine","冷却":"Cool","搬运":"Transport","牧场":"MonsterFarm"
};
let workPopFor=null;
function findWork(text){
  const t=(text||"").trim();
  if(!t) return null;
  for(const k in WORK_MAP) if(k===t||t.includes(k)) return WORK_MAP[k];
  const low=t.toLowerCase();
  for(const w of Object.values(WORK_MAP)) if(w.toLowerCase()===low) return w;
  return null;
}
function closeWorkPop(){ const p=$("workPop"); if(p){ p.hidden=true; } workPopFor=null; }
function showWorkPop(input,type){
  const rows=Object.entries(state.works||{}).filter(([id,w])=>(w[type]||0)>0)
    .sort((a,b)=>((b[1][type]||0)-(a[1][type]||0))||(dexNum(a[0])-dexNum(b[0])));
  const p=$("workPop");
  const r=input.getBoundingClientRect();
  p.style.left=(r.left+window.scrollX)+"px";
  p.style.top=(r.bottom+window.scrollY+4)+"px";
  p.style.width=Math.max(260,r.width)+"px";
  p.innerHTML=rows.map(([id,w])=>`<div class="wp-row" data-id="${id}"><img src="${(state.icons&&state.icons[id])||""}"><span class="wp-name">${nameOf(id)}</span><span class="wp-lv">Lv.${w[type]}</span></div>`).join("")||'<div class="hint">没有结果</div>';
  p.querySelectorAll(".wp-row").forEach(el=>el.onclick=()=>{
    const id=el.dataset.id;
    if(input.id==="navTarget"){ addNavTarget(id); return; }
    input.value=nameOf(id);
    closeWorkPop();
    if(input.id==="target"){ setTarget(id); switchMode("rev"); openTarget(); }
  });
  p.hidden=false;
  workPopFor=input;
}
function bindWorkInput(input){
  input.addEventListener("input",()=>{
    const type=findWork(input.value);
    if(type) showWorkPop(input,type); else if(workPopFor===input) closeWorkPop();
  });
  input.addEventListener("blur",()=>{ setTimeout(()=>{ if(workPopFor===input) closeWorkPop(); },180); });
}
bindWorkInput($("target"));
bindWorkInput($("navTarget"));
$("ownAll").onclick=()=>{
  for(const id of Object.keys(state.breed)){ state.manualAdd.add(id); state.manualRemove.delete(id); }
  mergeOwned(); renderShots(); renderOwned();
  $("status").textContent=`已加入全部 ${Object.keys(state.breed).length} 只帕鲁`;
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
$("navGo").onclick = async () => {
  const inputs = navPick.size ? [...navPick] : [...state.owned];
  let passiveId=null, passiveName="";
  const reqGroups=$("navAllGroups").checked ? navGroups.filter(g=>g.ids&&g.ids.length).map(g=>new Set(g.ids)) : null;
  if(navGroupIdx>=0 && navGroups[navGroupIdx]){
    const gname=navGroups[navGroupIdx].name;
    for(const k in NAV_PASSIVES) if(gname.includes(k)){ passiveId=NAV_PASSIVES[k]; passiveName=k; }
    if(!passiveId&&state.passives){
      for(const [pid,v] of Object.entries(state.passives)) if(gname.includes(v.name)){ passiveId=pid; passiveName=v.name; }
    }
  }
  const typed=resolveId($("navTarget").value);
  const targets=[...navTargets];
  if(typed&&!targets.includes(typed)) targets.push(typed);
  if(!inputs.length){$("status").textContent="导航：先在左侧截图识别或手动添加帕鲁";return;}
  if(!targets.length){$("status").textContent="导航：目标没识别出来";return;}
  $("status").textContent="导航：计算中…";
  await new Promise(r=>setTimeout(r,30));
  const t0=performance.now();
  if(targets.length>1){
    $("status").textContent=`导航：${inputs.length} 只已有帕鲁 → ${targets.length} 个目标`;
    const m=navSearchMulti(inputs,targets,passiveId,reqGroups);
    m._inputs=inputs; m.passiveName=passiveName;
    navView.lastResult=m.items[0]?m.items[0].result:null;
    renderNavMulti(m,inputs);
    $("status").textContent+=` · ${Math.round(performance.now()-t0)}ms`;
    return;
  }
  const target=targets[0];
  const searchInputs=inputs.filter(x=>x!==target);
  $("status").textContent=`导航：${searchInputs.length} 只已有帕鲁 → ${nameOf(target)}`;
  const r=navSearch(searchInputs.length?searchInputs:inputs,target,passiveId,undefined,reqGroups);
  if(!r&&reqGroups){ $("status").textContent="导航：找不到能覆盖所有分组的路线"; return; }
  if(passiveId) $("status").textContent=`导航：${inputs.length} 只已有帕鲁 → ${nameOf(target)}（遗传 ${passiveName}）`;
  if(r){r._inputs=inputs;r._target=target;navView.lastResult=r;}
  renderNav(r,inputs,target);
  $("status").textContent+=` · ${Math.round(performance.now()-t0)}ms`;
};
const navTargets=[];
function renderNavTargets(){
  const el=$("navTargets"); if(!el) return;
  el.innerHTML=navTargets.map(id=>`<span class="nt"><img src="${(state.icons&&state.icons[id])||""}">${nameOf(id)}<button data-id="${id}">×</button></span>`).join("");
  el.querySelectorAll("button").forEach(b=>b.onclick=()=>{
    const i=navTargets.indexOf(b.dataset.id);
    if(i>=0) navTargets.splice(i,1);
    renderNavTargets();
  });
}
function addNavTarget(id){
  if(!id) return;
  if(!navTargets.includes(id)) navTargets.push(id);
  $("navTarget").value="";
  renderNavTargets();
  closeWorkPop();
}
$("navAdd").onclick=()=>{ addNavTarget(resolveId($("navTarget").value)); };
$("navTarget").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); addNavTarget(resolveId($("navTarget").value)); } });
function navSearchMulti(inputs,targets,passiveId,groups){
  const inputSet=new Set(inputs);
  const planned=new Set(inputs);
  const items=[];
  for(const t of targets){
    const base=inputs.filter(x=>x!==t);
    const r=navSearch(base.length?base:inputs,t,passiveId,planned,groups);
    if(r&&r.path.length){ items.push({target:t,result:r,done:inputSet.has(t)}); for(const st of r.path) planned.add(st.child); }
    else items.push({target:t,done:true});
  }
  const seen=new Map(), steps=[];
  for(const {target,result} of items){ if(!result) continue; for(const s of result.path){
    const k=`${s.from}|${s.other}|${s.child}`;
    if(!seen.has(k)){ const st={...s,usedBy:new Set([target])}; seen.set(k,st); steps.push(st); }
    else seen.get(k).usedBy.add(target);
  }}
  const cost=steps.reduce((a,s)=>a+(s.stepCost||1),0);
  return {multi:true, items, steps, cost};
}
function buildNavGraphMulti(m,inputs){
  const inputSet=new Set(inputs), nodes=new Map(), edges=[];
  const add=(id,type)=>{ if(!nodes.has(id)) nodes.set(id,{id,type,x:0,y:0}); const n=nodes.get(id); if(type==="target") n.type="target"; else if(n.type!=="target") n.type=type; return n; };
  for(const {target,result} of m.items){
    add(target,"target");
    for(const p of result.path){
      const f=add(p.from,inputSet.has(p.from)?"owned":"external");
      const o=add(p.other,p.external?"external":"owned");
      const c=add(p.child,p.child===target?"target":"child");
      edges.push({a:f.id,b:c.id,kind:"path"});
      edges.push({a:o.id,b:c.id,kind:"path"});
    }
  }
  navView.nodes=[...nodes.values()]; navView.edges=edges; navView.expandedPlans=new Map();
  layoutNav();
}
function renderNavMulti(m,inputs){
 try{
  if(!m.items.length){ $("navSummary").textContent="没有找到可行路线"; $("navTable").innerHTML=""; return; }
  const done=m.items.filter(x=>x.done).length;
  const todo=m.items.filter(x=>x.result).length;
  $("navSummary").textContent=`目标 ${m.items.length} 个 · 已拥有 ${done} 个 · 需配种 ${todo} 个 · 共用后总配种 ${m.cost} 次（蛋糕 ${m.cost} 个）`;
  const rows=m.steps.map((st,i)=>{
    const users=[...st.usedBy].map(nameOf).join("、");
    return `<tr><td>${i+1}</td><td>${nameOf(st.from)} + ${nameOf(st.other)}</td><td>${nameOf(st.child)}</td><td>${users}</td></tr>`;
  }).join("");
  const doneTargets=m.items.filter(x=>!x.result).map(x=>nameOf(x.target));
  $("navTable").innerHTML=`<table><thead><tr><th>步骤</th><th>父母</th><th>子代</th><th>服务于目标</th></tr></thead><tbody>${rows}</tbody></table>${doneTargets.length?`<p class="hint">已拥有无需配种：${doneTargets.join("、")}</p>`:""}`;
  syncCanvasSize();
  buildNavGraphMulti(m,inputs);
  paintNavGraph();
  startNavAnim();
 }catch(e){ $("navSummary").textContent="渲染出错："+e.message; console.error(e); }
}
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
  $("navPanel").hidden = mode !== "nav";
}
document.querySelectorAll(".mode-tabs button").forEach(b => b.onclick = () => switchMode(b.dataset.mode));

init();
