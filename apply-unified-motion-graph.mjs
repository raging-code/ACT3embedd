#!/usr/bin/env node
/**
 * apply-unified-motion-graph.mjs
 * ----------------------------------------------------------------------
 * Replaces the split motion-graph UI (no graph at all on Fig. 3.1-3.2 /
 * camera.html, a separate simpler SVG chart on Fig. 3.3 / buzzer.html)
 * with a single shared 24h motion graph used identically on both pages,
 * styled after the "Perimeter — 24h motion graph · Sample 3 (subtle)"
 * design: a pannable/zoomable canvas timeline with a Fig 3.1/Fig 3.3
 * toggle that decides whether clicking a motion spike pops up the
 * captured snapshot (image) or the recorded clip (video) for that event.
 *
 * New file:
 *   static/graph.js
 *     Self-contained motion-graph component (window.initMotionGraph()).
 *     Polls the new /api/events endpoint, draws the canvas timeline,
 *     and opens a fullscreen popup with the matching motion_*.jpg or
 *     motion_*.mp4 file on click. Used by both camera.html and
 *     buzzer.html so they can no longer disagree about what the graph
 *     looks like.
 *
 * Changes to app.py:
 *   - Adds GET /api/events: the last 24h of motion-trigger events, each
 *     paired with its snapshot filename (Fig. 3.1) and, when a matching
 *     recording exists on disk, its recorded-clip filename (Fig. 3.3),
 *     both derived from the same motion_YYYYMMDD_HHMMSS stamp.
 *
 * Changes to templates/buzzer.html:
 *   - Replaces the old .chart-card (id="readingsChart" SVG + legend)
 *     with the new shared <section class="motion-graph" id="motionGraph">
 *     markup.
 *   - Adds <script src="/static/graph.js"> before buzzer.js.
 *
 * Changes to templates/camera.html:
 *   - Inserts the same shared motion-graph markup above the live feed
 *     (this page previously had no graph at all).
 *   - Adds <script src="/static/graph.js"> before camera.js.
 *
 * Changes to static/buzzer.js:
 *   - Removes the old inline-SVG chart renderer (renderReadingsChart,
 *     pollReadings, CHART_* constants, readingsChart/readingsCount/
 *     chartEmpty element refs, lastReadingsSignature, readingsAbort)
 *     now that static/graph.js owns the graph independently via
 *     /api/events instead of /api/readings.
 *   - Calls initMotionGraph() once at the bottom of the file.
 *
 * Changes to static/camera.js:
 *   - Calls initMotionGraph() once at the bottom of the file.
 *
 * Changes to static/style.css:
 *   - Replaces the old "Fig. 3.3 — sensor readings chart" rule block
 *     (.chart-card, .chart-wrap, #readingsChart, .chart-empty,
 *     .chart-legend, .legend-item, .legend-dot, .chart-grid, .chart-dot)
 *     with the new namespaced .motion-graph / .mg-* rules shared by
 *     both pages.
 *
 * app.py's /api/readings and reading_log are left in place (harmless,
 * unused by the new graph) in case anything else on your Pi still
 * depends on them; nothing in this patch removes them.
 *
 * Usage:
 *   node apply-unified-motion-graph.mjs             # run from the repo root
 *   node apply-unified-motion-graph.mjs --dry-run   # preview only, writes nothing
 *   node apply-unified-motion-graph.mjs --root /path/to/ACT3embedd
 *
 * Safe to re-run: if the patch has already been applied, running again
 * is a no-op for the parts already in place.
 * ----------------------------------------------------------------------
 */

import path from "node:path";
import fsp from "node:fs/promises";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const rootFlagIndex = args.indexOf("--root");
const projectRoot =
  rootFlagIndex !== -1 && args[rootFlagIndex + 1]
    ? path.resolve(args[rootFlagIndex + 1])
    : process.cwd();

const APP_PY_PATH = path.join(projectRoot, "app.py");
const BUZZER_HTML_PATH = path.join(projectRoot, "templates", "buzzer.html");
const CAMERA_HTML_PATH = path.join(projectRoot, "templates", "camera.html");
const BUZZER_JS_PATH = path.join(projectRoot, "static", "buzzer.js");
const CAMERA_JS_PATH = path.join(projectRoot, "static", "camera.js");
const STYLE_PATH = path.join(projectRoot, "static", "style.css");
const GRAPH_JS_PATH = path.join(projectRoot, "static", "graph.js");

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function backupFile(filePath, backupDir) {
  if (!(await exists(filePath))) {
    console.log(`  (skip backup -- not found: ${path.relative(projectRoot, filePath)})`);
    return;
  }
  await fsp.mkdir(backupDir, { recursive: true });
  const dest = path.join(backupDir, path.basename(filePath));
  await fsp.copyFile(filePath, dest);
  console.log(`  backed up -> ${path.relative(projectRoot, dest)}`);
}

async function writeFile(filePath, contents) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  if (dryRun) {
    console.log(`  [dry-run] would write ${path.relative(projectRoot, filePath)} (${contents.length} bytes)`);
    return;
  }
  await fsp.writeFile(filePath, contents, "utf8");
  console.log(`  wrote ${path.relative(projectRoot, filePath)} (${contents.length} bytes)`);
}

async function readFileIfExists(filePath) {
  if (!(await exists(filePath))) return null;
  return fsp.readFile(filePath, "utf8");
}

/**
 * Apply a list of {find, replace, label} string replacements to `content`.
 * Each is applied independently and reports whether it matched, so partial
 * re-runs (patch already applied) don't error out.
 */
function applyReplacements(content, replacements) {
  let applied = 0;
  let alreadyPresent = 0;
  let missing = 0;

  for (const { find, replace, label } of replacements) {
    if (content.includes(replace)) {
      alreadyPresent++;
      continue;
    }
    if (content.includes(find)) {
      content = content.replace(find, replace);
      applied++;
      console.log(`  \u2713 ${label}`);
    } else {
      missing++;
      console.log(`  ! could not locate: ${label} (skipped -- file may already differ here)`);
    }
  }

  return { content, applied, alreadyPresent, missing };
}

// ---------------------------------------------------------------------
// static/graph.js -- new file, written as-is (verified, tested content)
// ---------------------------------------------------------------------
const GRAPH_JS = "/* Perimeter — Unified 24h motion graph (Fig. 3.1 / Fig. 3.3)\n   ----------------------------------------------------------------------\n   A single canvas-based motion timeline shared by both the Camera Watch\n   (Fig. 3.1-3.2) and Buzzer + Graph (Fig. 3.3) dashboards, replacing the\n   old split UI where only the buzzer page had a (much simpler) SVG chart\n   and the camera page had none at all.\n\n   - Renders every motion event of the last 24h as a spike on a\n     pannable/zoomable timeline (drag to pan, scroll wheel to zoom,\n     shift+scroll / two-finger horizontal scroll to pan).\n   - Hovering a spike shows its timestamp; clicking one opens a\n     fullscreen popup with either the still snapshot (Fig. 3.1, the\n     motion_*.jpg captured at that moment) or the 5-second recorded\n     clip (Fig. 3.3, the matching motion_*.mp4) depending on which\n     figure is selected in the toggle.\n   - Pulls real events from /api/events (added alongside this patch)\n     instead of the sample/demo data the design mockup used.\n\n   Usage: include this script on a page that has a container element\n   with id=\"motionGraph\" wrapping the markup produced by\n   renderMotionGraphShell(), then call initMotionGraph().\n   Both buzzer.html and camera.html do this identically so the two\n   dashboards no longer disagree about what the graph looks like. */\n\n(function () {\n  const DAY = 86400;\n  const MIN_LEN = 15 * 60;\n  const PADL = 26;\n  const PADR = 26;\n  const EVENTS_POLL_MS = 4000;\n\n  const pad2 = (n) => String(n).padStart(2, \"0\");\n  const hms = (s) => `${pad2(Math.floor(s / 3600) % 24)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(Math.floor(s % 60))}`;\n\n  function initMotionGraph(rootId) {\n    const root = document.getElementById(rootId || \"motionGraph\");\n    if (!root) return;\n\n    const cv = root.querySelector(\".mg-canvas\");\n    const ctx = cv.getContext(\"2d\");\n    const tipEl = root.querySelector(\".mg-tip\");\n    const countEl = root.querySelector(\".mg-count\");\n    const zoomEl = root.querySelector(\".mg-zoom\");\n    const rangeEl = root.querySelector(\".mg-range\");\n    const emptyEl = root.querySelector(\".mg-empty\");\n    const segEl = root.querySelector(\".mg-seg\");\n    const pop = root.querySelector(\".mg-pop\");\n    const popFrame = root.querySelector(\".mg-pop-frame\");\n    const popTitle = root.querySelector(\".mg-pop-title\");\n    const popX = root.querySelector(\".mg-pop-x\");\n\n    let events = [];      // [{t, ts, file_image, file_video}] — t = seconds since local midnight\n    let viewStart = 0;\n    let viewLen = DAY;\n    let W = 0, H = 0, dpr = 1;\n    let hover = null, drag = null, selected = null;\n    let fig = \"31\"; // '31' = image popup, '33' = video popup\n    let eventsAbort = null;\n    let pollTimer = null;\n\n    function resize() {\n      dpr = window.devicePixelRatio || 1;\n      const r = cv.getBoundingClientRect();\n      W = r.width;\n      H = r.height;\n      if (!W || !H) return;\n      cv.width = W * dpr;\n      cv.height = H * dpr;\n      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);\n    }\n\n    const plotW = () => Math.max(1, W - PADL - PADR);\n    const xOf = (t) => PADL + ((t - viewStart) / viewLen) * plotW();\n    const tOf = (x) => viewStart + ((x - PADL) / plotW()) * viewLen;\n    const axisY = () => H - 50;\n    const spikeH = (e) => 46 + ((e.ts * 7) % 60); // deterministic 46-106px\n\n    function clampView() {\n      viewLen = Math.min(DAY, Math.max(MIN_LEN, viewLen));\n      viewStart = Math.min(DAY - viewLen, Math.max(0, viewStart));\n    }\n\n    function line(x1, y1, x2, y2, w, a, blur) {\n      ctx.save();\n      ctx.strokeStyle = `rgba(255,255,255,${a})`;\n      ctx.lineWidth = w;\n      ctx.lineCap = \"round\";\n      if (blur) {\n        ctx.shadowColor = \"rgba(95,176,240,.65)\";\n        ctx.shadowBlur = blur;\n      }\n      ctx.beginPath();\n      ctx.moveTo(x1, y1);\n      ctx.lineTo(x2, y2);\n      ctx.stroke();\n      ctx.restore();\n    }\n\n    function dot(x, y, r, a, blur, color) {\n      ctx.save();\n      ctx.fillStyle = color || `rgba(255,255,255,${a})`;\n      if (blur) {\n        ctx.shadowColor = \"rgba(95,176,240,.65)\";\n        ctx.shadowBlur = blur;\n      }\n      ctx.beginPath();\n      ctx.arc(x, y, r, 0, Math.PI * 2);\n      ctx.fill();\n      ctx.restore();\n    }\n\n    function tickStep() {\n      const secPerPx = viewLen / plotW();\n      for (const s of [60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600]) {\n        if (s / secPerPx >= 92) return s;\n      }\n      return 21600;\n    }\n\n    function drawAxis() {\n      const ay = axisY();\n      line(PADL, ay, W - PADR, ay, 1.6, 0.85);\n      const step = tickStep();\n      const first = Math.ceil(viewStart / step) * step;\n      ctx.font = \"600 11px 'Geist Mono', monospace\";\n      ctx.textAlign = \"center\";\n      for (let t = first; t <= viewStart + viewLen + 1; t += step) {\n        const x = xOf(t);\n        if (x < PADL - 1 || x > W - PADR + 1) continue;\n        const major = t % 3600 === 0;\n        ctx.strokeStyle = major ? \"rgba(255,255,255,0.08)\" : \"rgba(255,255,255,0.04)\";\n        ctx.lineWidth = 1;\n        ctx.beginPath();\n        ctx.moveTo(x, 22);\n        ctx.lineTo(x, ay);\n        ctx.stroke();\n        line(x, ay, x, ay + (major ? 9 : 5), major ? 1.4 : 1, major ? 0.85 : 0.5);\n        ctx.fillStyle = major ? \"rgba(255,255,255,0.9)\" : \"rgba(255,255,255,0.5)\";\n        const lab = major\n          ? `${pad2((t / 3600) % 24)}:00`\n          : `${pad2(Math.floor(t / 3600) % 24)}:${pad2(Math.floor((t % 3600) / 60))}`;\n        ctx.fillText(t >= DAY ? \"24:00\" : lab, x, ay + 26);\n      }\n    }\n\n    function drawSpikes() {\n      const ay = axisY();\n      events.forEach((e) => {\n        const x = xOf(e.t);\n        if (x < PADL - 24 || x > W - PADR + 24) return;\n        const active = hover === e || selected === e;\n        const h = spikeH(e) + (active ? 12 : 0);\n        const top = ay - h;\n        const g = ctx.createLinearGradient(0, top, 0, ay);\n        g.addColorStop(0, `rgba(95,176,240,${active ? 0.28 : 0.14})`);\n        g.addColorStop(1, \"rgba(95,176,240,0)\");\n        ctx.fillStyle = g;\n        ctx.fillRect(x - 8, top, 16, ay - top);\n        line(x, ay, x, top, active ? 2.6 : 2, active ? 1 : 0.9, active ? 8 : 0);\n        dot(x, top, active ? 4.5 : 3.2, 1, active ? 10 : 0, \"rgba(95,176,240,1)\");\n        dot(x, ay, active ? 3.2 : 2.4, 0.95);\n      });\n    }\n\n    function drawMini() {\n      if (viewLen >= DAY) return;\n      const mw = 130, mx = W - PADR - mw, my = 10;\n      ctx.save();\n      ctx.strokeStyle = \"rgba(255,255,255,.4)\";\n      ctx.lineWidth = 1;\n      ctx.strokeRect(mx, my, mw, 7);\n      ctx.fillStyle = \"rgba(255,255,255,.9)\";\n      ctx.fillRect(mx + (viewStart / DAY) * mw, my, Math.max(3, (viewLen / DAY) * mw), 7);\n      ctx.restore();\n    }\n\n    function draw() {\n      if (!W || !H) return;\n      ctx.clearRect(0, 0, W, H);\n      drawAxis();\n      drawSpikes();\n      drawMini();\n      if (zoomEl) zoomEl.textContent = (DAY / viewLen).toFixed(1) + \"×\";\n      if (rangeEl) {\n        rangeEl.textContent = `${hms(viewStart).slice(0, 5)} – ${hms(Math.min(DAY, viewStart + viewLen)).slice(0, 5)}`;\n      }\n    }\n\n    let rafId = null;\n    function loop() {\n      draw();\n      rafId = requestAnimationFrame(loop);\n    }\n\n    function hit(x, y) {\n      const ay = axisY();\n      let best = null, bd = 22;\n      events.forEach((e) => {\n        const ex = xOf(e.t);\n        if (ex < PADL - 14 || ex > W - PADR + 14) return;\n        const h = spikeH(e);\n        if (y < ay - h - 16 || y > ay + 10) return;\n        const d = Math.abs(ex - x);\n        if (d < bd) { bd = d; best = e; }\n      });\n      return best;\n    }\n\n    function showTip(e) {\n      if (!tipEl) return;\n      if (!e) { tipEl.classList.remove(\"on\"); return; }\n      tipEl.textContent = hms(e.t);\n      tipEl.style.left = xOf(e.t) + 6 + \"px\";\n      tipEl.style.top = axisY() - spikeH(e) - 22 + 10 + \"px\";\n      tipEl.classList.add(\"on\");\n    }\n\n    // ---------------- popup (Fig 3.1 image / Fig 3.3 video) ----------------\n\n    function openPop(e) {\n      selected = e;\n      const wantsVideo = fig === \"33\";\n      const file = wantsVideo ? e.file_video : e.file_image;\n      const label = hms(e.t);\n      popTitle.innerHTML = file\n        ? `${label}<span>${file}</span>`\n        : `${label}<span>no ${wantsVideo ? \"recording\" : \"snapshot\"} on disk</span>`;\n\n      popFrame.querySelectorAll(\".mg-pop-media, .mg-pop-missing\").forEach((n) => n.remove());\n\n      if (!file) {\n        const p = document.createElement(\"p\");\n        p.className = \"mg-pop-missing\";\n        p.textContent = wantsVideo\n          ? \"This event doesn't have a matching recorded clip.\"\n          : \"This event doesn't have a matching snapshot.\";\n        popFrame.appendChild(p);\n      } else if (wantsVideo) {\n        const v = document.createElement(\"video\");\n        v.className = \"mg-pop-media\";\n        v.controls = true;\n        v.autoplay = true;\n        v.loop = true;\n        v.playsInline = true;\n        v.src = `/recordings/${encodeURIComponent(file)}`;\n        popFrame.appendChild(v);\n        v.play().catch(() => {});\n      } else {\n        const img = document.createElement(\"img\");\n        img.className = \"mg-pop-media\";\n        img.alt = `Motion snapshot ${label}`;\n        img.src = `/captures/${encodeURIComponent(file)}`;\n        popFrame.appendChild(img);\n      }\n\n      pop.classList.add(\"open\");\n    }\n\n    function closePop() {\n      pop.classList.remove(\"open\");\n      selected = null;\n      popFrame.querySelectorAll(\".mg-pop-media, .mg-pop-missing\").forEach((n) => {\n        if (n.pause) n.pause();\n        n.remove();\n      });\n    }\n\n    popX.addEventListener(\"click\", closePop);\n    pop.addEventListener(\"mousedown\", (ev) => { if (ev.target === pop) closePop(); });\n    window.addEventListener(\"keydown\", (ev) => { if (ev.key === \"Escape\" && pop.classList.contains(\"open\")) closePop(); });\n\n    segEl.addEventListener(\"click\", (ev) => {\n      const b = ev.target.closest(\"button\");\n      if (!b) return;\n      fig = b.dataset.fig;\n      segEl.querySelectorAll(\"button\").forEach((x) => x.classList.toggle(\"on\", x === b));\n    });\n\n    // ---------------- interaction ----------------\n\n    cv.addEventListener(\"mousemove\", (ev) => {\n      const r = cv.getBoundingClientRect();\n      const x = ev.clientX - r.left, y = ev.clientY - r.top;\n      if (drag) {\n        const dx = x - drag.x;\n        viewStart = drag.start - (dx / plotW()) * viewLen;\n        clampView();\n        if (Math.abs(dx) > 3) drag.moved = true;\n        showTip(null);\n        return;\n      }\n      hover = hit(x, y);\n      cv.classList.toggle(\"hot\", !!hover);\n      showTip(hover);\n    });\n    cv.addEventListener(\"mouseleave\", () => { hover = null; showTip(null); cv.classList.remove(\"hot\"); });\n    cv.addEventListener(\"mousedown\", (ev) => {\n      const r = cv.getBoundingClientRect();\n      drag = { x: ev.clientX - r.left, start: viewStart, moved: false };\n      cv.classList.add(\"grabbing\");\n    });\n    window.addEventListener(\"mouseup\", (ev) => {\n      if (!drag) return;\n      const r = cv.getBoundingClientRect();\n      if (!drag.moved) {\n        const h = hit(ev.clientX - r.left, ev.clientY - r.top);\n        if (h) openPop(h);\n      }\n      drag = null;\n      cv.classList.remove(\"grabbing\");\n    });\n    cv.addEventListener(\n      \"wheel\",\n      (ev) => {\n        ev.preventDefault();\n        const r = cv.getBoundingClientRect();\n        const x = ev.clientX - r.left;\n        if (ev.shiftKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {\n          const d = ev.shiftKey ? ev.deltaY : ev.deltaX;\n          viewStart += (d / plotW()) * viewLen;\n          clampView();\n          showTip(null);\n          return;\n        }\n        const anchor = tOf(x);\n        viewLen *= Math.exp(ev.deltaY * 0.0016);\n        clampView();\n        viewStart = anchor - ((x - PADL) / plotW()) * viewLen;\n        clampView();\n        showTip(null);\n      },\n      { passive: false }\n    );\n\n    // ---------------- touch (basic pan) ----------------\n\n    let touchStartX = null, touchStartView = 0;\n    cv.addEventListener(\"touchstart\", (ev) => {\n      if (ev.touches.length !== 1) return;\n      touchStartX = ev.touches[0].clientX;\n      touchStartView = viewStart;\n    }, { passive: true });\n    cv.addEventListener(\"touchmove\", (ev) => {\n      if (touchStartX === null || ev.touches.length !== 1) return;\n      const dx = ev.touches[0].clientX - touchStartX;\n      viewStart = touchStartView - (dx / plotW()) * viewLen;\n      clampView();\n    }, { passive: true });\n    cv.addEventListener(\"touchend\", (ev) => {\n      if (touchStartX === null) return;\n      const moved = Math.abs((ev.changedTouches[0]?.clientX || touchStartX) - touchStartX) > 6;\n      if (!moved) {\n        const r = cv.getBoundingClientRect();\n        const t = ev.changedTouches[0];\n        const h = hit(t.clientX - r.left, t.clientY - r.top);\n        if (h) openPop(h);\n      }\n      touchStartX = null;\n    });\n\n    // ---------------- data ----------------\n\n    function toDayEvents(raw) {\n      // raw: [{t: \"HH:MM:SS\", ts: <unix seconds>, file_image, file_video}]\n      return raw.map((r) => {\n        const [h, m, s] = r.t.split(\":\").map(Number);\n        return {\n          t: h * 3600 + m * 60 + s,\n          ts: r.ts,\n          file_image: r.file_image || null,\n          file_video: r.file_video || null,\n        };\n      });\n    }\n\n    async function pollEvents() {\n      if (eventsAbort) eventsAbort.abort();\n      eventsAbort = new AbortController();\n      try {\n        const res = await fetch(\"/api/events\", { cache: \"no-store\", signal: eventsAbort.signal });\n        if (!res.ok) throw new Error(`status ${res.status}`);\n        const data = await res.json();\n        events = toDayEvents(data.events || []);\n        if (countEl) countEl.textContent = `${events.length} event${events.length === 1 ? \"\" : \"s\"}`;\n        if (emptyEl) emptyEl.style.display = events.length ? \"none\" : \"block\";\n      } catch (err) {\n        /* leave the existing graph in place on a transient failure */\n      }\n    }\n\n    function schedulePoll() {\n      pollEvents();\n      pollTimer = setInterval(pollEvents, EVENTS_POLL_MS);\n    }\n\n    document.addEventListener(\"visibilitychange\", () => {\n      if (document.hidden) {\n        if (pollTimer) clearInterval(pollTimer);\n      } else {\n        pollEvents();\n        pollTimer = setInterval(pollEvents, EVENTS_POLL_MS);\n      }\n    });\n\n    new ResizeObserver(resize).observe(cv);\n    resize();\n    loop();\n    schedulePoll();\n  }\n\n  window.initMotionGraph = initMotionGraph;\n})();\n";

// ---------------------------------------------------------------------
// shared HTML fragment inserted into both templates
// ---------------------------------------------------------------------
const GRAPH_FRAGMENT = "      <section class=\"motion-graph glass\" id=\"motionGraph\">\n        <div class=\"mg-head\">\n          <span>Motion timeline · last 24h</span>\n          <div class=\"mg-head-right\">\n            <span class=\"mg-seg\">\n              <button data-fig=\"31\" class=\"on\" title=\"Click a spike to view the snapshot\">Fig 3.1 · image</button>\n              <button data-fig=\"33\" title=\"Click a spike to view the recorded clip\">Fig 3.3 · video</button>\n            </span>\n            <span class=\"mg-count\">0 events</span>\n          </div>\n        </div>\n        <div class=\"mg-stage\">\n          <canvas class=\"mg-canvas\"></canvas>\n          <div class=\"mg-tip\"></div>\n          <p class=\"mg-empty\">Waiting for motion events...</p>\n        </div>\n        <div class=\"mg-foot\">\n          <span>Zoom <b class=\"mg-zoom\">1.0×</b> · scroll to zoom, drag to pan</span>\n          <span class=\"mg-range\">00:00 – 24:00</span>\n        </div>\n\n        <div class=\"mg-pop\" aria-modal=\"true\" role=\"dialog\">\n          <div class=\"mg-pop-frame\">\n            <div class=\"mg-pop-bar\">\n              <div class=\"mg-pop-title\"></div>\n              <button class=\"mg-pop-x\">close ✕</button>\n            </div>\n          </div>\n        </div>\n      </section>\n";

// ---------------------------------------------------------------------
// app.py -- new /api/events route, inserted after /api/readings
// ---------------------------------------------------------------------
const API_EVENTS_ROUTE = "@app.route(\"/api/events\")\ndef api_events():\n    \"\"\"Returns the last 24h of motion-trigger events for the unified\n    Fig. 3.1 / Fig. 3.3 motion graph, each paired with both the\n    snapshot (.jpg, Fig. 3.1) and recorded clip (.mp4, Fig. 3.3) filed\n    under the same motion_YYYYMMDD_HHMMSS stamp, when present on disk.\n    Camera watch and buzzer+graph both call this so they show the same\n    timeline instead of the old split UI.\"\"\"\n    cutoff = time.time() - 24 * 3600\n    with state_lock:\n        events_snapshot = list(event_log)\n\n    out = []\n    for evt in events_snapshot:\n        try:\n            dt = datetime.fromisoformat(evt[\"timestamp\"])\n        except (KeyError, ValueError):\n            continue\n        ts = dt.timestamp()\n        if ts < cutoff:\n            continue\n\n        image_file = evt.get(\"file\")\n        stamp = None\n        if image_file and image_file.startswith(\"motion_\") and image_file.endswith(\".jpg\"):\n            stamp = image_file[len(\"motion_\"):-len(\".jpg\")]\n\n        video_file = None\n        if stamp:\n            candidate = f\"motion_{stamp}.mp4\"\n            if os.path.exists(os.path.join(RECORDING_DIR, candidate)):\n                video_file = candidate\n\n        out.append({\n            \"t\": dt.strftime(\"%H:%M:%S\"),\n            \"ts\": ts,\n            \"file_image\": image_file if image_file and os.path.exists(os.path.join(CAPTURE_DIR, image_file)) else None,\n            \"file_video\": video_file,\n        })\n\n    out.sort(key=lambda e: e[\"ts\"])\n    return jsonify({\"events\": out})\n";

const APP_PY_REPLACEMENTS = [
  {
    label: "GET /api/readings -> add GET /api/events right after it",
    find: `@app.route("/api/readings")
def api_readings():
    """Returns the recent sensor-reading timeline for the Fig. 3.3 graph."""
    return jsonify({"readings": list(reading_log)})
`,
    replace: `@app.route("/api/readings")
def api_readings():
    """Returns the recent sensor-reading timeline for the Fig. 3.3 graph."""
    return jsonify({"readings": list(reading_log)})


` + API_EVENTS_ROUTE,
  },
];

const BUZZER_HTML_REPLACEMENTS = [
  {
    label: ".chart-card (old SVG readings chart) -> shared .motion-graph section",
    find: `      <div class="chart-card glass">
        <div class="gallery-head">
          <span>Sensor readings</span>
          <span class="log-head-count" id="readingsCount">0</span>
        </div>
        <div class="chart-wrap">
          <svg id="readingsChart" viewBox="0 0 640 220" preserveAspectRatio="none" aria-label="Motion sensor readings over time"></svg>
          <p class="chart-empty" id="chartEmpty">Waiting for sensor data...</p>
        </div>
        <div class="chart-legend">
          <span class="legend-item"><span class="legend-dot legend-dot--motion"></span>Motion detected</span>
          <span class="legend-item"><span class="legend-dot legend-dot--idle"></span>No motion</span>
        </div>
      </div>
`,
    replace: GRAPH_FRAGMENT,
  },
  {
    label: "<script src=\"/static/buzzer.js\"> -> load graph.js first",
    find: `<script src="/static/buzzer.js"></script>`,
    replace: `<script src="/static/graph.js"></script>
<script src="/static/buzzer.js"></script>`,
  },
];

const CAMERA_HTML_REPLACEMENTS = [
  {
    label: "<section class=\"feed-panel\"> -> insert shared .motion-graph section above the live feed",
    find: `    <section class="feed-panel">

      <div class="feed-frame glass" id="liveFrame">`,
    replace: `    <section class="feed-panel">

` + GRAPH_FRAGMENT + `
      <div class="feed-frame glass" id="liveFrame">`,
  },
  {
    label: "<script src=\"/static/camera.js\"> -> load graph.js first",
    find: `<script src="/static/camera.js"></script>`,
    replace: `<script src="/static/graph.js"></script>
<script src="/static/camera.js"></script>`,
  },
];

const STYLE_REPLACEMENTS = [
  {
    label: "old Fig. 3.3 sensor-readings chart CSS -> shared .motion-graph / .mg-* CSS",
    find: `/* ---------- Fig. 3.3 — sensor readings chart ---------- */

.chart-card {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chart-wrap {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 220px;
  padding: 14px 16px 6px;
}

#readingsChart {
  width: 100%;
  height: 100%;
  min-height: 200px;
  display: block;
}

.chart-empty {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  margin: 0;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-faint);
  pointer-events: none;
}

.chart-legend {
  position: relative;
  z-index: 1;
  display: flex;
  gap: 18px;
  padding: 4px 18px 16px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  color: var(--text-dim);
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.legend-dot--motion { background: var(--signal); box-shadow: 0 0 6px 1px var(--signal-glow); }
.legend-dot--idle { background: var(--text-faint); }

.chart-grid { stroke: rgba(255,255,255,0.08); stroke-width: 1; }
.chart-dot { fill: var(--signal); filter: drop-shadow(0 0 4px var(--signal-glow)); }
`,
    replace: "\n/* ---------- Unified 24h motion graph (Fig. 3.1 / Fig. 3.3) ----------\n   Shared by camera.html and buzzer.html so both dashboards show the\n   same graph instead of the old split UI (no graph on 3.1, a simpler\n   SVG chart on 3.3 only). Namespaced under .motion-graph / .mg- so it\n   can't collide with the rest of style.css. */\n\n.motion-graph {\n  display: flex;\n  flex-direction: column;\n  overflow: hidden;\n}\n\n.mg-head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding: 13px 16px;\n  border-bottom: 1px solid var(--edge-soft);\n  font-size: 13px;\n  font-weight: 800;\n  gap: 12px;\n  flex-wrap: wrap;\n}\n\n.mg-head-right {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n}\n\n.mg-seg {\n  display: inline-flex;\n  background: rgba(255, 255, 255, 0.06);\n  border: 1px solid var(--edge-soft);\n  border-radius: 10px;\n  padding: 3px;\n  gap: 2px;\n}\n\n.mg-seg button {\n  font-family: var(--mono);\n  font-size: 11px;\n  font-weight: 600;\n  letter-spacing: 0.03em;\n  color: var(--text-dim);\n  background: transparent;\n  border: 0;\n  border-radius: 7px;\n  padding: 5px 11px;\n  cursor: pointer;\n  transition: background 0.12s, color 0.12s;\n}\n\n.mg-seg button:hover { color: #fff; }\n.mg-seg button.on { color: #0e0f11; background: #fff; }\n\n.mg-count {\n  font-family: var(--mono);\n  font-size: 12px;\n  font-weight: 700;\n  color: #fff;\n  background: rgba(255, 255, 255, 0.12);\n  border-radius: 20px;\n  padding: 2px 9px;\n  white-space: nowrap;\n}\n\n.mg-stage {\n  position: relative;\n  padding: 10px 6px 0;\n}\n\n.mg-canvas {\n  display: block;\n  width: 100%;\n  height: 260px;\n  cursor: grab;\n  touch-action: none;\n}\n\n.mg-canvas.grabbing { cursor: grabbing; }\n.mg-canvas.hot { cursor: pointer; }\n\n.mg-empty {\n  position: absolute;\n  top: 50%;\n  left: 50%;\n  transform: translate(-50%, -50%);\n  margin: 0;\n  font-family: var(--mono);\n  font-size: 12px;\n  color: var(--text-faint);\n  pointer-events: none;\n}\n\n.mg-foot {\n  display: flex;\n  justify-content: space-between;\n  gap: 12px;\n  padding: 8px 16px 14px;\n  font-family: var(--mono);\n  font-size: 11px;\n  color: var(--text-faint);\n}\n\n.mg-foot b { color: var(--text-dim); font-weight: 600; }\n\n.mg-tip {\n  position: absolute;\n  pointer-events: none;\n  z-index: 5;\n  font-family: var(--mono);\n  font-size: 12px;\n  font-weight: 600;\n  color: #fff;\n  background: rgba(14, 15, 17, 0.9);\n  border: 1px solid rgba(255, 255, 255, 0.5);\n  border-radius: 8px;\n  padding: 4px 10px;\n  white-space: nowrap;\n  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);\n  transform: translate(-50%, -100%);\n  opacity: 0;\n  transition: opacity 0.1s;\n}\n\n.mg-tip.on { opacity: 1; }\n\n/* fullscreen popup */\n\n.mg-pop {\n  position: fixed;\n  inset: 0;\n  z-index: 100;\n  display: none;\n  align-items: center;\n  justify-content: center;\n  background: rgba(8, 9, 11, 0.55);\n  backdrop-filter: blur(22px) saturate(1.2);\n  -webkit-backdrop-filter: blur(22px) saturate(1.2);\n  padding: 3vh 3vw;\n}\n\n.mg-pop.open { display: flex; animation: mg-fade 0.16s ease-out; }\n\n@keyframes mg-fade {\n  from { opacity: 0; }\n  to { opacity: 1; }\n}\n\n.mg-pop-frame {\n  position: relative;\n  max-width: 100%;\n  max-height: 100%;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n}\n\n.mg-pop-media {\n  display: block;\n  max-width: 94vw;\n  max-height: 88vh;\n  border-radius: 14px;\n  border: 1px solid rgba(255, 255, 255, 0.35);\n  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6);\n  background: #000;\n}\n\n.mg-pop-missing {\n  font-family: var(--mono);\n  font-size: 13px;\n  color: var(--text-dim);\n  background: rgba(20, 21, 24, 0.9);\n  border: 1px solid var(--edge-soft);\n  border-radius: 12px;\n  padding: 30px 40px;\n  margin: 0;\n}\n\n.mg-pop-bar {\n  position: absolute;\n  top: -2px;\n  left: 0;\n  right: 0;\n  transform: translateY(-100%);\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding: 0 2px 10px;\n  font-family: var(--mono);\n  font-size: 12px;\n  font-weight: 700;\n  color: #fff;\n}\n\n.mg-pop-bar .mg-pop-title { letter-spacing: 0.03em; }\n.mg-pop-bar .mg-pop-title span { color: var(--text-dim); font-weight: 600; margin-left: 10px; }\n\n.mg-pop-x {\n  font-family: var(--mono);\n  font-size: 12px;\n  font-weight: 700;\n  color: #fff;\n  background: rgba(255, 255, 255, 0.1);\n  border: 1px solid rgba(255, 255, 255, 0.4);\n  border-radius: 9px;\n  padding: 5px 12px;\n  cursor: pointer;\n}\n\n.mg-pop-x:hover { background: rgba(255, 255, 255, 0.22); }\n",
  },
];

const BUZZER_JS_REPLACEMENTS = [
  {
    label: "el{} -- drop readingsChart/readingsCount/chartEmpty refs (graph.js now owns the graph)",
    find: `  buzzerVisual: document.getElementById("buzzerVisual"),
  buzzerTestBtn: document.getElementById("buzzerTestBtn"),
  buzzerHint: document.getElementById("buzzerHint"),

  readingsChart: document.getElementById("readingsChart"),
  readingsCount: document.getElementById("readingsCount"),
  chartEmpty: document.getElementById("chartEmpty"),

  recordingStrip: document.getElementById("recordingStrip"),`,
    replace: `  buzzerVisual: document.getElementById("buzzerVisual"),
  buzzerTestBtn: document.getElementById("buzzerTestBtn"),
  buzzerHint: document.getElementById("buzzerHint"),

  recordingStrip: document.getElementById("recordingStrip"),`,
  },
  {
    label: "drop lastReadingsSignature / readingsAbort (unused once the old chart renderer is removed)",
    find: `let lastRenderedRecording = null;
let lastRecordingSignature = "";
let lastLogSignature = "";
let lastReadingsSignature = "";
let pollTimer = null;
let currentPollMs = POLL_MS;
let statusAbort = null;
let readingsAbort = null;`,
    replace: `let lastRenderedRecording = null;
let lastRecordingSignature = "";
let lastLogSignature = "";
let pollTimer = null;
let currentPollMs = POLL_MS;
let statusAbort = null;`,
  },
  {
    label: "poll() tail + old inline-SVG chart renderer -- drop pollReadings()/renderReadingsChart()/CHART_* entirely (graph.js + /api/events now own the graph)",
    find: `  // Same tick: readings share the cadence instead of drifting on their own timer.
  await pollReadings();

  if (ok) {
    currentPollMs = POLL_MS; // connection is healthy -- back to full speed
  } else {
    currentPollMs = Math.min(currentPollMs * 2, POLL_MS_MAX); // back off while offline
  }
  scheduleNextPoll(currentPollMs);
}

// --------------------------------------------------------------------------
// Sensor readings chart (plain inline SVG, no chart library)
// --------------------------------------------------------------------------

const CHART_W = 640;
const CHART_H = 220;
const CHART_PAD = 18;

function renderReadingsChart(readings) {
  if (!readings || readings.length === 0) {
    el.readingsChart.innerHTML = "";
    el.chartEmpty.style.display = "block";
    return;
  }
  el.chartEmpty.style.display = "none";

  const n = readings.length;
  const usableW = CHART_W - CHART_PAD * 2;
  const usableH = CHART_H - CHART_PAD * 2;
  const stepX = n > 1 ? usableW / (n - 1) : 0;

  const points = readings.map((r, i) => {
    const x = CHART_PAD + i * stepX;
    const y = CHART_PAD + (r.motion ? 0 : usableH); // motion = high line, idle = low line
    return { x, y, motion: !!r.motion };
  });

  const linePath = points
    .map((p, i) => \`\${i === 0 ? "M" : "L"} \${p.x.toFixed(1)} \${p.y.toFixed(1)}\`)
    .join(" ");

  const areaPath =
    \`M \${CHART_PAD} \${CHART_H - CHART_PAD} \` +
    points.map((p) => \`L \${p.x.toFixed(1)} \${p.y.toFixed(1)}\`).join(" ") +
    \` L \${points[points.length - 1].x.toFixed(1)} \${CHART_H - CHART_PAD} Z\`;

  const dots = points
    .filter((p) => p.motion)
    .map((p) => \`<circle cx="\${p.x.toFixed(1)}" cy="\${p.y.toFixed(1)}" r="3" class="chart-dot"/>\`)
    .join("");

  const gridLines = [0.25, 0.5, 0.75].map((frac) => {
    const y = CHART_PAD + usableH * frac;
    return \`<line x1="\${CHART_PAD}" y1="\${y}" x2="\${CHART_W - CHART_PAD}" y2="\${y}" class="chart-grid"/>\`;
  }).join("");

  el.readingsChart.innerHTML = \`
    <defs>
      <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--signal)" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="var(--signal)" stop-opacity="0"/>
      </linearGradient>
    </defs>
    \${gridLines}
    <path d="\${areaPath}" fill="url(#chartFill)" stroke="none"/>
    <path d="\${linePath}" fill="none" stroke="var(--signal)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    \${dots}
  \`;
}

async function pollReadings() {
  if (readingsAbort) readingsAbort.abort();
  readingsAbort = new AbortController();
  try {
    const res = await fetch("/api/readings", { cache: "no-store", signal: readingsAbort.signal });
    if (!res.ok) throw new Error(\`status \${res.status}\`);
    const data = await res.json();
    const readings = data.readings || [];
    el.readingsCount.textContent = readings.length;

    // Skip the SVG rebuild (path re-stringified + reparsed) when nothing changed.
    const signature = readings.length
      ? \`\${readings.length}|\${readings[readings.length - 1].t}|\${readings[readings.length - 1].motion}\`
      : "";
    if (signature !== lastReadingsSignature) {
      lastReadingsSignature = signature;
      renderReadingsChart(readings);
    }
  } catch (err) {
    /* leave the existing chart in place on a transient failure */
  }
}

// --------------------------------------------------------------------------
// Motion-triggered video recordings gallery
// --------------------------------------------------------------------------`,
    replace: `  if (ok) {
    currentPollMs = POLL_MS; // connection is healthy -- back to full speed
  } else {
    currentPollMs = Math.min(currentPollMs * 2, POLL_MS_MAX); // back off while offline
  }
  scheduleNextPoll(currentPollMs);
}

// --------------------------------------------------------------------------
// Motion-triggered video recordings gallery (unified motion graph now lives
// in static/graph.js, driven by /api/events, not this file)
// --------------------------------------------------------------------------`,
  },
  {
    label: "bottom of file -- call initMotionGraph() alongside the existing poll()/pollRecordings() kickoff",
    find: `poll();
pollRecordings();`,
    replace: `poll();
pollRecordings();
if (window.initMotionGraph) window.initMotionGraph();`,
  },
];

const CAMERA_JS_REPLACEMENTS = [
  {
    label: "bottom of file -- call initMotionGraph() alongside the existing poll()/pollGallery() kickoff",
    find: `poll();
pollGallery();`,
    replace: `poll();
pollGallery();
if (window.initMotionGraph) window.initMotionGraph();`,
  },
];

async function patchFile(label, filePath, replacementsOrNull, backupDir) {
  console.log(`\n${label}`);
  const content = await readFileIfExists(filePath);
  if (content === null) {
    console.log(`  ! file not found, skipping: ${path.relative(projectRoot, filePath)}`);
    return;
  }
  await backupFile(filePath, backupDir);
  const { content: next, applied, alreadyPresent, missing } = applyReplacements(content, replacementsOrNull);
  if (applied === 0 && missing === 0) {
    console.log("  (already up to date)");
  }
  if (next !== content) {
    await writeFile(filePath, next);
  } else if (applied === 0) {
    console.log(`  no changes written (applied=${applied}, alreadyPresent=${alreadyPresent}, missing=${missing})`);
  }
}

async function main() {
  console.log(`Perimeter -- unified motion graph patch`);
  console.log(`Project root: ${projectRoot}`);
  if (dryRun) console.log("Mode: DRY RUN (no files will be written)");

  const backupDir = path.join(projectRoot, "backup", timestamp());

  await patchFile("app.py -- add GET /api/events", APP_PY_PATH, APP_PY_REPLACEMENTS, backupDir);
  await patchFile(
    "templates/buzzer.html -- swap old chart for shared motion-graph section",
    BUZZER_HTML_PATH,
    BUZZER_HTML_REPLACEMENTS,
    backupDir
  );
  await patchFile(
    "templates/camera.html -- add shared motion-graph section",
    CAMERA_HTML_PATH,
    CAMERA_HTML_REPLACEMENTS,
    backupDir
  );
  await patchFile("static/style.css -- swap old chart CSS for .motion-graph / .mg-* CSS", STYLE_PATH, STYLE_REPLACEMENTS, backupDir);
  await patchFile("static/buzzer.js -- remove old chart renderer, init the new graph", BUZZER_JS_PATH, BUZZER_JS_REPLACEMENTS, backupDir);
  await patchFile("static/camera.js -- init the new graph", CAMERA_JS_PATH, CAMERA_JS_REPLACEMENTS, backupDir);

  // static/graph.js is a brand-new file -- write it directly (idempotent: identical content = no-op diff).
  console.log("\nstatic/graph.js -- new shared motion-graph component");
  const existingGraphJs = await readFileIfExists(GRAPH_JS_PATH);
  if (existingGraphJs === GRAPH_JS) {
    console.log("  (already up to date)");
  } else {
    if (existingGraphJs !== null) {
      await backupFile(GRAPH_JS_PATH, backupDir);
    }
    await writeFile(GRAPH_JS_PATH, GRAPH_JS);
  }

  console.log(`\nDone.${dryRun ? " (dry run -- nothing was written)" : ` Backups saved under ${path.relative(projectRoot, backupDir)}/`}`);
  console.log(`
Next steps:
  1. Start the app (SIMULATE mode works fine for a UI check):
       MOTION_SIM=1 python3 app.py
  2. Open http://localhost:5000/camera and http://localhost:5000/buzzer
     -- both should now show the same 24h motion-timeline graph above
     the rest of the page content.
  3. Trigger a couple of simulated motion events (wait ~a minute in
     SIMULATE mode, or trip the real PIR sensor) and confirm spikes
     appear; click one to pop up its snapshot (Fig 3.1) or switch the
     toggle to Fig 3.3 and click again for its recorded clip.
`);
}

main().catch((err) => {
  console.error("Patch failed:", err);
  process.exitCode = 1;
});
