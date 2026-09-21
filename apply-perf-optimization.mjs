#!/usr/bin/env node
/**
 * apply-perf-optimization.mjs
 * ----------------------------------------------------------------------
 * Performance/smoothness optimization pass for the Perimeter dashboards.
 * Purely behavioral/runtime changes -- the visual design (CSS, markup,
 * colors, layout, glass effect) is completely untouched.
 *
 * Changes to static/camera.js and static/buzzer.js:
 *   - The event log (and, on the buzzer page, the sensor-readings SVG
 *     chart) now only re-render their innerHTML when the underlying
 *     data actually changed, via a signature check -- the same pattern
 *     the snapshot/recording galleries already used. Previously both
 *     rebuilt their full DOM/SVG every single 1-second poll tick even
 *     when nothing had changed, which is wasted layout/paint work on
 *     every tick, forever.
 *   - buzzer.js: /api/status and /api/readings were two independent
 *     1-second setInterval timers drifting against each other. They now
 *     share a single tick, halving timer overhead and avoiding
 *     staggered re-renders.
 *   - Both pages pause polling while the browser tab is hidden/
 *     backgrounded (Page Visibility API) and do one immediate catch-up
 *     poll the moment the tab becomes visible again, instead of paying
 *     for fetch/parse/render cycles nobody can see.
 *   - A failing connection now backs off exponentially (1s -> 2s -> 4s
 *     -> 8s cap) instead of hammering the server every second while
 *     offline or during a Pi reboot; a single success snaps it straight
 *     back to the normal 1s cadence.
 *   - Fetches use an AbortController so a slow/hung request from a
 *     previous tick can't pile up behind a new one (e.g. right after a
 *     tab-visibility resume).
 *
 * templates/*.html, static/style.css, and app.py are NOT touched by
 * this patch -- the look of every page is pixel-identical to before.
 *
 * Usage:
 *   node apply-perf-optimization.mjs             # run from the repo root
 *   node apply-perf-optimization.mjs --dry-run   # preview only, writes nothing
 *   node apply-perf-optimization.mjs --root /path/to/ACT3embedd
 *
 * Safe to re-run: if the patch has already been applied, running again
 * is a no-op.
 * ----------------------------------------------------------------------
 */

import path from "node:path";
import fs from "node:fs/promises";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const rootFlagIndex = args.indexOf("--root");
const projectRoot =
  rootFlagIndex !== -1 && args[rootFlagIndex + 1]
    ? path.resolve(args[rootFlagIndex + 1])
    : process.cwd();

const CAMERA_JS_PATH = path.join(projectRoot, "static", "camera.js");
const BUZZER_JS_PATH = path.join(projectRoot, "static", "buzzer.js");

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function exists(p) {
  try {
    await fs.access(p);
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
  await fs.mkdir(backupDir, { recursive: true });
  const dest = path.join(backupDir, path.basename(filePath));
  await fs.copyFile(filePath, dest);
  console.log(`  backed up -> ${path.relative(projectRoot, dest)}`);
}

async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (dryRun) {
    console.log(`  [dry-run] would write ${path.relative(projectRoot, filePath)} (${contents.length} bytes)`);
    return;
  }
  await fs.writeFile(filePath, contents, "utf8");
  console.log(`  wrote ${path.relative(projectRoot, filePath)} (${contents.length} bytes)`);
}

// Normalize to LF-only before comparing/writing, so re-runs on a file that
// was checked out with CRLF line endings (e.g. on Windows) are still
// correctly detected as "already applied" rather than re-patched.
function toLF(s) {
  return s.replace(/\r\n/g, "\n");
}

// ---------------------------------------------------------------------
// static/camera.js -- full replacement (verified, tested content)
// ---------------------------------------------------------------------
const CAMERA_JS = "/* Perimeter — Camera Watch (Fig. 3.1-3.2): dashboard logic\n   Polls /api/status every second and updates the console in place.\n\n   Perf notes (2026-09-21 optimization pass):\n   - The event log now only re-renders its innerHTML when the underlying\n     events actually changed (signature check), matching the gallery's\n     existing dedupe pattern. Previously it rebuilt the whole <ol> every\n     single poll tick even when nothing changed.\n   - Polling pauses while the tab is hidden/backgrounded (Page\n     Visibility API) and does one immediate catch-up poll the moment the\n     tab becomes visible again, instead of silently drifting or wasting\n     cycles on a tab nobody is looking at.\n   - A failing connection now backs off (1s -> up to 8s) instead of\n     hammering the server every second while offline; success resets it\n     back to the normal 1s cadence immediately.\n   - Fetches use an AbortController so a slow/hung request from a\n     previous tick can't pile up behind a new one after a tab-visibility\n     resume. */\n\nconst POLL_MS = 1000;\nconst POLL_MS_MAX = 8000;\n\nconst el = {\n  clock: document.getElementById(\"clock\"),\n  pulseDot: document.getElementById(\"pulse-dot\"),\n  armToggle: document.getElementById(\"armToggle\"),\n\n  liveFrame: document.getElementById(\"liveFrame\"),\n  liveImg: document.getElementById(\"liveImg\"),\n\n  galleryStrip: document.getElementById(\"galleryStrip\"),\n  galleryCount: document.getElementById(\"galleryCount\"),\n\n  statTotal: document.getElementById(\"statTotal\"),\n  statUptime: document.getElementById(\"statUptime\"),\n\n  modSensorState: document.getElementById(\"modSensorState\"),\n  modCameraState: document.getElementById(\"modCameraState\"),\n\n  logList: document.getElementById(\"logList\"),\n  logCount: document.getElementById(\"logCount\"),\n\n  footStatus: document.getElementById(\"footStatus\"),\n};\n\nlet lastRenderedFile = null;\nlet lastGallerySignature = \"\";\nlet lastLogSignature = \"\";\nlet pollTimer = null;\nlet currentPollMs = POLL_MS;\nlet statusAbort = null;\n\n// Live stream: mark the frame as \"has-image\" once the MJPEG stream actually\n// loads, and fall back to the empty state if it errors out (e.g. no camera).\nel.liveImg.addEventListener(\"load\", () => {\n  el.liveFrame.classList.add(\"has-image\");\n});\nel.liveImg.addEventListener(\"error\", () => {\n  el.liveFrame.classList.remove(\"has-image\");\n});\n\nfunction tickClock() {\n  const now = new Date();\n  el.clock.textContent = now.toLocaleTimeString(\"en-GB\", { hour12: false });\n}\nsetInterval(tickClock, 1000);\ntickClock();\n\nfunction fmtTime(isoString) {\n  if (!isoString) return \"—\";\n  const d = new Date(isoString);\n  return d.toLocaleTimeString(\"en-GB\", { hour12: false });\n}\n\nfunction fmtUptime(startedIso) {\n  if (!startedIso) return \"0m\";\n  const started = new Date(startedIso).getTime();\n  const mins = Math.floor((Date.now() - started) / 60000);\n  if (mins < 60) return `${mins}m`;\n  const hrs = Math.floor(mins / 60);\n  return `${hrs}h ${mins % 60}m`;\n}\n\nfunction setModule(stateEl, ok, okLabel, failLabel) {\n  stateEl.textContent = ok ? okLabel : failLabel;\n  stateEl.classList.toggle(\"ok\", ok);\n  stateEl.classList.toggle(\"fail\", !ok);\n}\n\nfunction renderLog(events) {\n  const signature = events && events.length\n    ? events.map((e) => `${e.timestamp}|${e.file || \"\"}`).join(\",\")\n    : \"\";\n  if (signature === lastLogSignature) return; // nothing changed -- skip the rebuild\n  lastLogSignature = signature;\n\n  if (!events || events.length === 0) {\n    el.logList.innerHTML =\n      '<li class=\"log-empty\">No motion recorded yet. The log fills in here the moment the sensor trips.</li>';\n    return;\n  }\n  el.logList.innerHTML = events\n    .map((e) => {\n      const time = fmtTime(e.timestamp);\n      const desc = e.file ? e.file : \"capture failed\";\n      return `<li class=\"entry\"><span class=\"entry-time\">${time}</span><span class=\"entry-desc\">${desc}</span></li>`;\n    })\n    .join(\"\");\n}\n\nfunction scheduleNextPoll(ms) {\n  if (pollTimer) clearTimeout(pollTimer);\n  pollTimer = setTimeout(poll, ms);\n}\n\nasync function poll() {\n  if (document.hidden) {\n    // Don't fetch while the tab is backgrounded; resume is handled by the\n    // visibilitychange listener below.\n    return;\n  }\n\n  if (statusAbort) statusAbort.abort();\n  statusAbort = new AbortController();\n\n  try {\n    const res = await fetch(\"/api/status\", { cache: \"no-store\", signal: statusAbort.signal });\n    if (!res.ok) throw new Error(`status ${res.status}`);\n    const data = await res.json();\n\n    // header pulse dot\n    if (!data.armed) {\n      el.pulseDot.className = \"dot off\";\n    } else if (data.motion_detected) {\n      el.pulseDot.className = \"dot alert\";\n    } else {\n      el.pulseDot.className = \"dot\";\n    }\n\n    // arm toggle\n    el.armToggle.dataset.armed = data.armed ? \"true\" : \"false\";\n    el.armToggle.querySelector(\".arm-toggle-label\").textContent = data.armed\n      ? \"ARMED\"\n      : \"DISARMED\";\n\n    // stats\n    el.statTotal.textContent = data.total_events ?? 0;\n    el.statUptime.textContent = fmtUptime(data.started_at);\n\n    // modules\n    setModule(el.modSensorState, data.sensor_ok, \"reading\", \"offline\");\n    setModule(el.modCameraState, data.camera_ok, \"ready\", \"offline\");\n\n    // refresh the gallery whenever a new capture has landed\n    if (data.last_capture_file && data.last_capture_file !== lastRenderedFile) {\n      lastRenderedFile = data.last_capture_file;\n      pollGallery();\n    }\n\n    // log\n    renderLog(data.events);\n    el.logCount.textContent = data.total_events ?? 0;\n\n    el.footStatus.textContent = \"connected\";\n    currentPollMs = POLL_MS; // connection is healthy -- back to full speed\n  } catch (err) {\n    if (err.name !== \"AbortError\") {\n      el.footStatus.textContent = \"connection lost — retrying…\";\n      currentPollMs = Math.min(currentPollMs * 2, POLL_MS_MAX); // back off while offline\n    }\n  } finally {\n    scheduleNextPoll(currentPollMs);\n  }\n}\n\nfunction renderGallery(files) {\n  const signature = files.join(\",\");\n  if (signature === lastGallerySignature) return; // avoid needless re-render/flicker\n  lastGallerySignature = signature;\n\n  el.galleryCount.textContent = files.length;\n\n  if (!files.length) {\n    el.galleryStrip.innerHTML =\n      '<p class=\"gallery-empty\" id=\"galleryEmpty\">Snapshots taken on motion will appear here.</p>';\n    return;\n  }\n\n  el.galleryStrip.innerHTML = files\n    .map((filename) => {\n      // filenames look like motion_20260918_025309.jpg — pull a readable time out of it\n      const match = filename.match(/(\\d{2})(\\d{2})(\\d{2})\\.\\w+$/);\n      const timeLabel = match ? `${match[1]}:${match[2]}:${match[3]}` : \"\";\n      return `\n        <div class=\"gallery-shot\" title=\"${filename}\">\n          <img src=\"/captures/${filename}\" alt=\"Motion capture ${filename}\" loading=\"lazy\">\n          <span class=\"gallery-shot-time\">${timeLabel}</span>\n        </div>`;\n    })\n    .join(\"\");\n}\n\nasync function pollGallery() {\n  try {\n    const res = await fetch(\"/api/gallery\", { cache: \"no-store\" });\n    if (!res.ok) throw new Error(`status ${res.status}`);\n    const data = await res.json();\n    renderGallery(data.files || []);\n  } catch (err) {\n    /* leave the existing gallery in place on a transient failure */\n  }\n}\n\nel.armToggle.addEventListener(\"click\", async () => {\n  const currentlyArmed = el.armToggle.dataset.armed === \"true\";\n  const endpoint = currentlyArmed ? \"/api/disarm\" : \"/api/arm\";\n  try {\n    await fetch(endpoint, { method: \"POST\" });\n  } catch (err) {\n    /* status poll will reconcile on next tick regardless */\n  }\n  poll();\n});\n\n// Pause polling while the tab is hidden/backgrounded; catch up immediately\n// on return instead of waiting out whatever interval was mid-flight.\ndocument.addEventListener(\"visibilitychange\", () => {\n  if (!document.hidden) {\n    currentPollMs = POLL_MS;\n    scheduleNextPoll(0);\n  }\n});\n\nlet galleryTimer = setInterval(() => {\n  if (!document.hidden) pollGallery();\n}, POLL_MS * 4); // gallery changes less often than status\n\npoll();\npollGallery();\n";

// ---------------------------------------------------------------------
// static/buzzer.js -- full replacement (verified, tested content)
// ---------------------------------------------------------------------
const BUZZER_JS = "/* Perimeter — Buzzer + Graph (Fig. 3.3): dashboard logic\n   Polls /api/status every second and updates the console in place.\n\n   Perf notes (2026-09-21 optimization pass):\n   - The event log and the sensor-readings chart now only re-render when\n     the underlying data actually changed (signature check), matching\n     the recordings gallery's existing dedupe pattern. Previously both\n     rebuilt their full innerHTML (a whole SVG path re-stringified, in\n     the chart's case) every single poll tick even when nothing changed.\n   - /api/status and /api/readings were two independently-scheduled\n     1-second timers, each with its own fetch/parse/render cycle drifting\n     against each other. They're now a single tick that fires both in\n     the same frame, halving timer overhead and avoiding staggered\n     re-renders.\n   - Polling pauses while the tab is hidden/backgrounded (Page\n     Visibility API) and does one immediate catch-up poll the moment the\n     tab becomes visible again.\n   - A failing connection now backs off (1s -> up to 8s) instead of\n     hammering the server every second while offline; success resets it\n     back to the normal 1s cadence immediately.\n   - Fetches use an AbortController so a slow/hung request from a\n     previous tick can't pile up behind a new one after a tab-visibility\n     resume. */\n\nconst POLL_MS = 1000;\nconst POLL_MS_MAX = 8000;\n\nconst el = {\n  clock: document.getElementById(\"clock\"),\n  pulseDot: document.getElementById(\"pulse-dot\"),\n  armToggle: document.getElementById(\"armToggle\"),\n\n  statTotal: document.getElementById(\"statTotal\"),\n  statUptime: document.getElementById(\"statUptime\"),\n\n  modBuzzerState: document.getElementById(\"modBuzzerState\"),\n\n  logList: document.getElementById(\"logList\"),\n  logCount: document.getElementById(\"logCount\"),\n\n  footStatus: document.getElementById(\"footStatus\"),\n\n  buzzerVisual: document.getElementById(\"buzzerVisual\"),\n  buzzerTestBtn: document.getElementById(\"buzzerTestBtn\"),\n  buzzerHint: document.getElementById(\"buzzerHint\"),\n\n  readingsChart: document.getElementById(\"readingsChart\"),\n  readingsCount: document.getElementById(\"readingsCount\"),\n  chartEmpty: document.getElementById(\"chartEmpty\"),\n\n  recordingStrip: document.getElementById(\"recordingStrip\"),\n  recordingCount: document.getElementById(\"recordingCount\"),\n};\n\nlet lastRenderedRecording = null;\nlet lastRecordingSignature = \"\";\nlet lastLogSignature = \"\";\nlet lastReadingsSignature = \"\";\nlet pollTimer = null;\nlet currentPollMs = POLL_MS;\nlet statusAbort = null;\nlet readingsAbort = null;\n\nfunction tickClock() {\n  const now = new Date();\n  el.clock.textContent = now.toLocaleTimeString(\"en-GB\", { hour12: false });\n}\nsetInterval(tickClock, 1000);\ntickClock();\n\nfunction fmtTime(isoString) {\n  if (!isoString) return \"—\";\n  const d = new Date(isoString);\n  return d.toLocaleTimeString(\"en-GB\", { hour12: false });\n}\n\nfunction fmtUptime(startedIso) {\n  if (!startedIso) return \"0m\";\n  const started = new Date(startedIso).getTime();\n  const mins = Math.floor((Date.now() - started) / 60000);\n  if (mins < 60) return `${mins}m`;\n  const hrs = Math.floor(mins / 60);\n  return `${hrs}h ${mins % 60}m`;\n}\n\nfunction setModule(stateEl, ok, okLabel, failLabel) {\n  stateEl.textContent = ok ? okLabel : failLabel;\n  stateEl.classList.toggle(\"ok\", ok);\n  stateEl.classList.toggle(\"fail\", !ok);\n}\n\nfunction renderLog(events) {\n  const signature = events && events.length\n    ? events.map((e) => `${e.timestamp}|${e.file || \"\"}`).join(\",\")\n    : \"\";\n  if (signature === lastLogSignature) return; // nothing changed -- skip the rebuild\n  lastLogSignature = signature;\n\n  if (!events || events.length === 0) {\n    el.logList.innerHTML =\n      '<li class=\"log-empty\">No motion recorded yet. The log fills in here the moment the sensor trips.</li>';\n    return;\n  }\n  el.logList.innerHTML = events\n    .map((e) => {\n      const time = fmtTime(e.timestamp);\n      const desc = e.file ? e.file : \"capture failed\";\n      return `<li class=\"entry\"><span class=\"entry-time\">${time}</span><span class=\"entry-desc\">${desc}</span></li>`;\n    })\n    .join(\"\");\n}\n\nfunction scheduleNextPoll(ms) {\n  if (pollTimer) clearTimeout(pollTimer);\n  pollTimer = setTimeout(poll, ms);\n}\n\nasync function poll() {\n  if (document.hidden) {\n    // Don't fetch while the tab is backgrounded; resume is handled by the\n    // visibilitychange listener below.\n    return;\n  }\n\n  if (statusAbort) statusAbort.abort();\n  statusAbort = new AbortController();\n\n  let ok = true;\n  try {\n    const res = await fetch(\"/api/status\", { cache: \"no-store\", signal: statusAbort.signal });\n    if (!res.ok) throw new Error(`status ${res.status}`);\n    const data = await res.json();\n\n    // header pulse dot\n    if (!data.armed) {\n      el.pulseDot.className = \"dot off\";\n    } else if (data.motion_detected) {\n      el.pulseDot.className = \"dot alert\";\n    } else {\n      el.pulseDot.className = \"dot\";\n    }\n\n    // arm toggle\n    el.armToggle.dataset.armed = data.armed ? \"true\" : \"false\";\n    el.armToggle.querySelector(\".arm-toggle-label\").textContent = data.armed\n      ? \"ARMED\"\n      : \"DISARMED\";\n\n    // stats\n    el.statTotal.textContent = data.total_events ?? 0;\n    el.statUptime.textContent = fmtUptime(data.started_at);\n\n    // buzzer module + visual\n    setModule(el.modBuzzerState, data.buzzer_ok, \"ready\", \"offline\");\n    el.buzzerVisual.classList.toggle(\"sounding\", !!data.buzzer_active || !!data.recording_active);\n    el.buzzerHint.textContent = data.recording_active\n      ? \"Recording a 5-second clip right now…\"\n      : \"Sounds automatically whenever motion is detected while armed. A 5-second video also records.\";\n\n    // refresh the video-clip gallery whenever a new recording has landed\n    if (data.last_recording_file && data.last_recording_file !== lastRenderedRecording) {\n      lastRenderedRecording = data.last_recording_file;\n      pollRecordings();\n    }\n\n    // log\n    renderLog(data.events);\n    el.logCount.textContent = data.total_events ?? 0;\n\n    el.footStatus.textContent = \"connected\";\n  } catch (err) {\n    ok = ok && err.name === \"AbortError\";\n    if (err.name !== \"AbortError\") {\n      el.footStatus.textContent = \"connection lost — retrying…\";\n    }\n  }\n\n  // Same tick: readings share the cadence instead of drifting on their own timer.\n  await pollReadings();\n\n  if (ok) {\n    currentPollMs = POLL_MS; // connection is healthy -- back to full speed\n  } else {\n    currentPollMs = Math.min(currentPollMs * 2, POLL_MS_MAX); // back off while offline\n  }\n  scheduleNextPoll(currentPollMs);\n}\n\n// --------------------------------------------------------------------------\n// Sensor readings chart (plain inline SVG, no chart library)\n// --------------------------------------------------------------------------\n\nconst CHART_W = 640;\nconst CHART_H = 220;\nconst CHART_PAD = 18;\n\nfunction renderReadingsChart(readings) {\n  if (!readings || readings.length === 0) {\n    el.readingsChart.innerHTML = \"\";\n    el.chartEmpty.style.display = \"block\";\n    return;\n  }\n  el.chartEmpty.style.display = \"none\";\n\n  const n = readings.length;\n  const usableW = CHART_W - CHART_PAD * 2;\n  const usableH = CHART_H - CHART_PAD * 2;\n  const stepX = n > 1 ? usableW / (n - 1) : 0;\n\n  const points = readings.map((r, i) => {\n    const x = CHART_PAD + i * stepX;\n    const y = CHART_PAD + (r.motion ? 0 : usableH); // motion = high line, idle = low line\n    return { x, y, motion: !!r.motion };\n  });\n\n  const linePath = points\n    .map((p, i) => `${i === 0 ? \"M\" : \"L\"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)\n    .join(\" \");\n\n  const areaPath =\n    `M ${CHART_PAD} ${CHART_H - CHART_PAD} ` +\n    points.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(\" \") +\n    ` L ${points[points.length - 1].x.toFixed(1)} ${CHART_H - CHART_PAD} Z`;\n\n  const dots = points\n    .filter((p) => p.motion)\n    .map((p) => `<circle cx=\"${p.x.toFixed(1)}\" cy=\"${p.y.toFixed(1)}\" r=\"3\" class=\"chart-dot\"/>`)\n    .join(\"\");\n\n  const gridLines = [0.25, 0.5, 0.75].map((frac) => {\n    const y = CHART_PAD + usableH * frac;\n    return `<line x1=\"${CHART_PAD}\" y1=\"${y}\" x2=\"${CHART_W - CHART_PAD}\" y2=\"${y}\" class=\"chart-grid\"/>`;\n  }).join(\"\");\n\n  el.readingsChart.innerHTML = `\n    <defs>\n      <linearGradient id=\"chartFill\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n        <stop offset=\"0%\" stop-color=\"var(--signal)\" stop-opacity=\"0.35\"/>\n        <stop offset=\"100%\" stop-color=\"var(--signal)\" stop-opacity=\"0\"/>\n      </linearGradient>\n    </defs>\n    ${gridLines}\n    <path d=\"${areaPath}\" fill=\"url(#chartFill)\" stroke=\"none\"/>\n    <path d=\"${linePath}\" fill=\"none\" stroke=\"var(--signal)\" stroke-width=\"2\" stroke-linejoin=\"round\" stroke-linecap=\"round\"/>\n    ${dots}\n  `;\n}\n\nasync function pollReadings() {\n  if (readingsAbort) readingsAbort.abort();\n  readingsAbort = new AbortController();\n  try {\n    const res = await fetch(\"/api/readings\", { cache: \"no-store\", signal: readingsAbort.signal });\n    if (!res.ok) throw new Error(`status ${res.status}`);\n    const data = await res.json();\n    const readings = data.readings || [];\n    el.readingsCount.textContent = readings.length;\n\n    // Skip the SVG rebuild (path re-stringified + reparsed) when nothing changed.\n    const signature = readings.length\n      ? `${readings.length}|${readings[readings.length - 1].t}|${readings[readings.length - 1].motion}`\n      : \"\";\n    if (signature !== lastReadingsSignature) {\n      lastReadingsSignature = signature;\n      renderReadingsChart(readings);\n    }\n  } catch (err) {\n    /* leave the existing chart in place on a transient failure */\n  }\n}\n\n// --------------------------------------------------------------------------\n// Motion-triggered video recordings gallery\n// --------------------------------------------------------------------------\n\nfunction renderRecordings(files) {\n  const signature = files.join(\",\");\n  if (signature === lastRecordingSignature) return; // avoid needless re-render/flicker\n  lastRecordingSignature = signature;\n\n  el.recordingCount.textContent = files.length;\n\n  if (!files.length) {\n    el.recordingStrip.innerHTML =\n      '<p class=\"gallery-empty\" id=\"recordingEmpty\">5-second clips recorded on motion will appear here.</p>';\n    return;\n  }\n\n  el.recordingStrip.innerHTML = files\n    .map((filename) => {\n      // filenames look like motion_20260918_025309.mp4 — pull a readable time out of it\n      const match = filename.match(/(\\d{2})(\\d{2})(\\d{2})\\.\\w+$/);\n      const timeLabel = match ? `${match[1]}:${match[2]}:${match[3]}` : \"\";\n      return `\n        <div class=\"gallery-shot\" title=\"${filename}\">\n          <video src=\"/recordings/${filename}\" muted loop playsinline preload=\"metadata\"\n                 onmouseenter=\"this.play()\" onmouseleave=\"this.pause(); this.currentTime = 0;\"></video>\n          <span class=\"gallery-shot-duration\">5s</span>\n          <span class=\"gallery-shot-time\">${timeLabel}</span>\n        </div>`;\n    })\n    .join(\"\");\n}\n\nasync function pollRecordings() {\n  try {\n    const res = await fetch(\"/api/recordings\", { cache: \"no-store\" });\n    if (!res.ok) throw new Error(`status ${res.status}`);\n    const data = await res.json();\n    renderRecordings(data.files || []);\n  } catch (err) {\n    /* leave the existing recordings gallery in place on a transient failure */\n  }\n}\n\nel.armToggle.addEventListener(\"click\", async () => {\n  const currentlyArmed = el.armToggle.dataset.armed === \"true\";\n  const endpoint = currentlyArmed ? \"/api/disarm\" : \"/api/arm\";\n  try {\n    await fetch(endpoint, { method: \"POST\" });\n  } catch (err) {\n    /* status poll will reconcile on next tick regardless */\n  }\n  poll();\n});\n\nel.buzzerTestBtn.addEventListener(\"click\", async () => {\n  el.buzzerTestBtn.disabled = true;\n  try {\n    await fetch(\"/api/buzzer/test\", { method: \"POST\" });\n  } catch (err) {\n    /* status poll will reflect actual buzzer state regardless */\n  }\n  setTimeout(() => { el.buzzerTestBtn.disabled = false; }, 1600);\n});\n\n// Pause polling while the tab is hidden/backgrounded; catch up immediately\n// on return instead of waiting out whatever interval was mid-flight.\ndocument.addEventListener(\"visibilitychange\", () => {\n  if (!document.hidden) {\n    currentPollMs = POLL_MS;\n    scheduleNextPoll(0);\n  }\n});\n\nlet recordingsTimer = setInterval(() => {\n  if (!document.hidden) pollRecordings();\n}, POLL_MS * 4);\n\npoll();\npollRecordings();\n";

/**
 * Marker string unique to the optimized version of each file, used to
 * detect "already applied" without doing a byte-for-byte compare (in
 * case whitespace/CRLF differs slightly from a prior manual edit).
 */
const OPTIMIZATION_MARKER = "Perf notes (2026-09-21 optimization pass)";

async function patchJsFile(label, filePath, newContent) {
  console.log(`\nPatching ${label} ...`);

  if (!(await exists(filePath))) {
    console.log(`  ! ${path.relative(projectRoot, filePath)} not found -- skipping`);
    return "missing";
  }

  const current = await fs.readFile(filePath, "utf8");

  if (toLF(current).includes(OPTIMIZATION_MARKER)) {
    console.log(`  already applied -- no changes needed`);
    return "already-applied";
  }

  await writeFile(filePath, newContent);
  console.log(`  \u2713 optimized`);
  return "applied";
}

async function main() {
  console.log(`Perimeter -- dashboard performance/smoothness optimization`);
  console.log(`Project root: ${projectRoot}${dryRun ? "  (dry run -- no files will be written)" : ""}`);
  console.log(`Visual design (CSS, markup, colors, layout) is not touched by this patch.\n`);

  const foundCamera = await exists(CAMERA_JS_PATH);
  const foundBuzzer = await exists(BUZZER_JS_PATH);

  if (!foundCamera && !foundBuzzer) {
    console.error(
      "Could not find static/camera.js or static/buzzer.js under the given root.\n" +
        "Run this from the repo root (ACT3embedd/), or pass --root /path/to/ACT3embedd"
    );
    process.exitCode = 1;
    return;
  }

  if (!dryRun) {
    const backupDir = path.join(projectRoot, "backup", timestamp());
    console.log(`Backing up existing files to backup/${timestamp()}/ ...`);
    if (foundCamera) await backupFile(CAMERA_JS_PATH, backupDir);
    if (foundBuzzer) await backupFile(BUZZER_JS_PATH, backupDir);
  } else {
    console.log(`[dry-run] would back up to backup/${timestamp()}/ (skipped)`);
  }

  const results = {};
  results.camera = await patchJsFile("static/camera.js", CAMERA_JS_PATH, CAMERA_JS);
  results.buzzer = await patchJsFile("static/buzzer.js", BUZZER_JS_PATH, BUZZER_JS);

  const applied = Object.values(results).filter((r) => r === "applied").length;
  const already = Object.values(results).filter((r) => r === "already-applied").length;
  const missing = Object.values(results).filter((r) => r === "missing").length;

  console.log(
    `\nSummary: ${applied} file(s) optimized, ${already} already up to date, ${missing} not found.`
  );

  console.log(
    dryRun
      ? "\nDry run complete -- no files were changed."
      : "\nDone. templates/*.html, static/style.css, and app.py were not touched --\n" +
        "every page looks exactly the same, it just polls and re-renders more\n" +
        "efficiently now. Reload the camera/buzzer dashboard pages to pick up\n" +
        "the new static/camera.js and static/buzzer.js."
  );
}

main().catch((err) => {
  console.error("Patch failed:", err);
  process.exitCode = 1;
});
