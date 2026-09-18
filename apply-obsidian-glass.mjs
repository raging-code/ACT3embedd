#!/usr/bin/env node
/**
 * apply-obsidian-glass.mjs
 * ----------------------------------------------------------------------
 * Applies the "Obsidian Pastel Glass" redesign to the Perimeter motion-
 * watch dashboard: a dark charcoal gradient background with true
 * glassmorphism panels (heavy blur, layered iOS-style shadows, a single
 * sky-blue signal color).
 *
 * What it does:
 *   1. Backs up your current templates/index.html and static/style.css
 *      into a timestamped backup/ folder (never overwrites a backup).
 *   2. Writes the new static/style.css.
 *   3. Writes the new templates/index.html.
 *   4. Leaves static/app.js completely untouched — all element IDs are
 *      unchanged, so the existing polling/render logic keeps working.
 *
 * Usage:
 *   node apply-obsidian-glass.mjs            # run from the repo root
 *   node apply-obsidian-glass.mjs --dry-run  # preview only, writes nothing
 *   node apply-obsidian-glass.mjs --root /path/to/ACT3embedd
 *
 * Safe to re-run: each run makes a fresh timestamped backup before writing.
 * ----------------------------------------------------------------------
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const rootFlagIndex = args.indexOf("--root");
const projectRoot =
  rootFlagIndex !== -1 && args[rootFlagIndex + 1]
    ? path.resolve(args[rootFlagIndex + 1])
    : process.cwd();

const TEMPLATE_PATH = path.join(projectRoot, "templates", "index.html");
const STYLE_PATH = path.join(projectRoot, "static", "style.css");

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
    console.log(`  (skip backup — not found: ${path.relative(projectRoot, filePath)})`);
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

// ---------------------------------------------------------------------
// New static/style.css
// ---------------------------------------------------------------------
const STYLE_CSS = String.raw`/* ==========================================================================
   Perimeter — Motion Watch
   Design language: "Obsidian Pastel Glass" — a dark charcoal gradient
   backdrop with true glassmorphism panels (heavy blur, low-opacity fill,
   layered iOS-style shadows, a single sky-blue signal color).
   ========================================================================== */

:root {
  --panel:      rgba(255,255,255,0.10);
  --panel-2:    rgba(255,255,255,0.06);
  --edge:       rgba(255,255,255,0.22);
  --edge-soft:  rgba(255,255,255,0.14);

  --text:       #F1F2F4;
  --text-dim:   #A7ACB5;
  --text-faint: #6B7078;

  --signal:     #5FB0F0;   /* sky blue — motion / live / accent */
  --signal-dim: rgba(95, 176, 240, 0.18);
  --signal-glow:rgba(95, 176, 240, 0.45);
  --ok:         #6FE3BE;   /* muted mint — system nominal */
  --ok-dim:     rgba(111, 227, 190, 0.18);
  --off:        #E08585;   /* muted red — offline/disarmed */
  --off-dim:    rgba(224, 133, 133, 0.18);

  --radius-s: 10px;
  --radius-m: 18px;

  --mono: 'IBM Plex Mono', ui-monospace, monospace;
  --grot: 'Space Grotesk', system-ui, sans-serif;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  color: var(--text);
  font-family: var(--grot);
  -webkit-font-smoothing: antialiased;
}

body {
  min-height: 100vh;
  position: relative;
  overflow-x: hidden;
  background:
    linear-gradient(160deg,
      #3A3D42 0%,
      #2C2E33 14%,
      #202226 28%,
      #17181B 42%,
      #0E0F11 55%,
      #191A1D 68%,
      #26282C 80%,
      #313336 92%,
      #3A3D42 100%);
  background-attachment: fixed;
}

@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}

/* ---------- ambient background blobs ----------
   Dark graphite/charcoal blobs behind the glass so the frosted panels have
   real tonal variation to refract, instead of a flat backdrop. Purely
   decorative — do not intercept clicks. */

.blob {
  position: fixed;
  border-radius: 50%;
  z-index: 0;
  pointer-events: none;
  filter: blur(10px);
}
.blob-a { width: 560px; height: 560px; top: -180px; left: -140px;
  background: radial-gradient(circle, #4C4F55 0%, transparent 72%); opacity: 0.8; }
.blob-b { width: 620px; height: 620px; bottom: -220px; right: -160px;
  background: radial-gradient(circle, #3A3D42 0%, transparent 70%); opacity: 0.85; }
.blob-c { width: 460px; height: 460px; top: 30%; left: 55%;
  background: radial-gradient(circle, #55585F 0%, transparent 72%); opacity: 0.55; }
.blob-d { width: 380px; height: 380px; top: 5%; right: 8%;
  background: radial-gradient(circle, #2A2C30 0%, transparent 72%); opacity: 0.6; }
.blob-e { width: 420px; height: 420px; bottom: 10%; left: 8%;
  background: radial-gradient(circle, #45474D 0%, transparent 72%); opacity: 0.5; }

/* ---------- shell ---------- */

.console {
  position: relative;
  z-index: 1;
  max-width: 1180px;
  margin: 0 auto;
  padding: 24px 24px 40px;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

/* ---------- shared glass recipe ----------
   Heavy blur + saturation + very low-opacity fill so the blobs behind
   actually show through and distort, a bright 1px top bevel highlight,
   and a layered iOS-style shadow stack (contact + mid + ambient) so each
   panel reads as floating glass rather than a flat card. */

.glass {
  position: relative;
  background: linear-gradient(155deg, rgba(255,255,255,0.14), rgba(255,255,255,0.03) 40%, rgba(255,255,255,0.07));
  backdrop-filter: blur(32px) saturate(1.8);
  -webkit-backdrop-filter: blur(32px) saturate(1.8);
  border: 1px solid var(--edge-soft);
  border-radius: var(--radius-m);
  box-shadow:
    0 1px 2px rgba(0,0,0,0.35),
    0 4px 12px rgba(0,0,0,0.35),
    0 16px 32px -8px rgba(0,0,0,0.5),
    0 36px 64px -18px rgba(0,0,0,0.55),
    inset 0 1px 1px rgba(255,255,255,0.14),
    inset 0 -1px 1px rgba(255,255,255,0.03);
}
.glass::before {
  content: "";
  position: absolute;
  top: 0; left: 12%; right: 12%; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent);
  pointer-events: none;
}
.glass::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background: radial-gradient(120% 60% at 15% -10%, rgba(255,255,255,0.06), transparent 60%);
}

/* ---------- header bar ---------- */

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  margin-bottom: 18px;
}

.bar-id {
  display: flex;
  align-items: baseline;
  gap: 10px;
  position: relative;
  z-index: 1;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 0 4px var(--ok-dim), 0 0 8px 1px rgba(111,227,190,0.5);
  align-self: center;
  flex-shrink: 0;
}
.dot.alert {
  background: var(--signal);
  box-shadow: 0 0 0 4px var(--signal-dim), 0 0 10px 1px var(--signal-glow);
}
.dot.off {
  background: var(--off);
  box-shadow: 0 0 0 4px var(--off-dim);
}

.bar-name {
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 0.01em;
}

.bar-sub {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-faint);
}

.bar-right {
  display: flex;
  align-items: center;
  gap: 16px;
  position: relative;
  z-index: 1;
}

.bar-clock {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--text-dim);
  letter-spacing: 0.03em;
}

.arm-toggle {
  font-family: var(--grot);
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.04em;
  color: #fff;
  background: linear-gradient(155deg, rgba(111,227,190,0.85), rgba(95,176,240,0.55));
  backdrop-filter: blur(12px) saturate(1.6);
  -webkit-backdrop-filter: blur(12px) saturate(1.6);
  border: 1px solid rgba(255,255,255,0.3);
  border-radius: var(--radius-s);
  padding: 9px 16px;
  cursor: pointer;
  box-shadow:
    0 1px 2px rgba(0,0,0,0.3),
    0 6px 16px -4px rgba(111,227,190,0.35),
    inset 0 1px 1px rgba(255,255,255,0.35);
  transition: filter 0.15s ease, box-shadow 0.15s ease;
}
.arm-toggle:hover { filter: brightness(1.08); }
.arm-toggle[data-armed="false"] {
  background: linear-gradient(155deg, rgba(224,133,133,0.85), rgba(224,133,133,0.45));
  box-shadow:
    0 1px 2px rgba(0,0,0,0.3),
    0 6px 16px -4px rgba(224,133,133,0.4),
    inset 0 1px 1px rgba(255,255,255,0.3);
}

/* ---------- main grid ---------- */

.grid {
  display: grid;
  grid-template-columns: 1.6fr 1fr;
  gap: 16px;
  flex: 1;
}

@media (max-width: 860px) {
  .grid { grid-template-columns: 1fr; }
}

/* ---------- feed panel ---------- */

.feed-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.feed-frame {
  position: relative;
  border-radius: var(--radius-m);
  aspect-ratio: 16 / 10;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
.feed-frame::before {
  /* dark base under the video so the empty state and edges look intentional */
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(155deg, #1B222C, #0D1116);
  z-index: 0;
}

.feed-frame img {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: none;
}
.feed-frame.has-image img { display: block; }
.feed-frame.has-image .feed-empty { display: none; }

.feed-empty {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  color: var(--text-faint);
}
.feed-empty p {
  margin: 0;
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0.02em;
}

.feed-tag {
  position: absolute;
  z-index: 2;
  top: 13px;
  left: 13px;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  background: rgba(20,22,26,0.5);
  border: 1px solid var(--edge-soft);
  border-radius: 20px;
  padding: 5px 11px 5px 9px;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.live-tag {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--ok);
  border-color: rgba(111,227,190,0.3);
  font-weight: 600;
}

.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 8px 1px rgba(111,227,190,0.6);
  animation: live-pulse 2s ease-in-out infinite;
}

@keyframes live-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.feed-caption {
  display: flex;
  gap: 8px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-faint);
  padding: 0 2px;
}
.feed-caption-sep { color: var(--text-faint); opacity: 0.4; }

/* ---------- captured-snapshot gallery ---------- */

.gallery {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 160px;
  overflow: hidden;
}

.gallery-head {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid var(--edge-soft);
  font-size: 13px;
  font-weight: 600;
}

.gallery-strip {
  position: relative;
  z-index: 1;
  flex: 1;
  display: flex;
  gap: 11px;
  padding: 14px;
  overflow-x: auto;
  overflow-y: hidden;
  align-items: flex-start;
}

.gallery-empty {
  margin: 0;
  padding: 10px 4px;
  font-size: 13px;
  color: var(--text-faint);
  line-height: 1.5;
}

.gallery-shot {
  position: relative;
  flex: 0 0 auto;
  width: 152px;
  aspect-ratio: 4 / 3;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.18);
  cursor: pointer;
  box-shadow:
    0 1px 2px rgba(0,0,0,0.4),
    0 8px 18px -8px rgba(0,0,0,0.5),
    0 18px 32px -14px rgba(0,0,0,0.45),
    inset 0 1px 1px rgba(255,255,255,0.16);
}

.gallery-shot img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.15s ease;
}
.gallery-shot:hover img { transform: scale(1.04); }

.gallery-shot:first-child {
  border-color: var(--signal);
  box-shadow: 0 0 0 3px var(--signal-dim), 0 8px 18px -8px rgba(0,0,0,0.5);
}

.gallery-shot-time {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text);
  background: linear-gradient(to top, rgba(0,0,0,0.75), transparent);
  padding: 12px 8px 5px;
}

.gallery-strip::-webkit-scrollbar { height: 6px; }
.gallery-strip::-webkit-scrollbar-track { background: transparent; }
.gallery-strip::-webkit-scrollbar-thumb { background: var(--edge); border-radius: 3px; }

/* ---------- side column ---------- */

.side {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.stat-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.stat {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: hidden;
}
.stat > * { position: relative; z-index: 1; }

.stat-value {
  font-family: var(--grot);
  font-size: 28px;
  font-weight: 800;
  letter-spacing: -0.01em;
  color: var(--text);
  line-height: 1;
}

.stat-label {
  font-size: 12px;
  color: var(--text-dim);
}

.module-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.module {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: hidden;
}
.module > * { position: relative; z-index: 1; }

.module-name {
  font-size: 12px;
  color: var(--text-dim);
}

.module-state {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 500;
  color: var(--text-faint);
}
.module-state.ok { color: var(--ok); }
.module-state.fail { color: var(--off); }

/* ---------- event log ---------- */

.log {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 260px;
  overflow: hidden;
}

.log-head {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid var(--edge-soft);
  font-size: 13px;
  font-weight: 600;
}

.log-head-count {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--signal);
  background: var(--signal-dim);
  border-radius: 20px;
  padding: 2px 9px;
}

.log-list {
  position: relative;
  z-index: 1;
  list-style: none;
  margin: 0;
  padding: 6px 8px;
  overflow-y: auto;
  flex: 1;
}

.log-list li.entry {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 9px 10px;
  border-radius: var(--radius-s);
  font-size: 13px;
}
.log-list li.entry:hover { background: rgba(255,255,255,0.06); }

.entry-time {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--signal);
  flex-shrink: 0;
  width: 68px;
}

.entry-desc {
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-empty {
  padding: 20px 14px;
  font-size: 13px;
  color: var(--text-faint);
  line-height: 1.5;
}

/* ---------- footer ---------- */

.foot {
  position: relative;
  z-index: 1;
  margin-top: 16px;
  display: flex;
  gap: 8px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-faint);
  padding: 0 4px;
}
.foot-sep { color: var(--text-faint); opacity: 0.4; }

/* ---------- scrollbar (webkit) ---------- */

.log-list::-webkit-scrollbar { width: 6px; }
.log-list::-webkit-scrollbar-track { background: transparent; }
.log-list::-webkit-scrollbar-thumb { background: var(--edge); border-radius: 3px; }

/* ---------- focus visibility ---------- */

button:focus-visible {
  outline: 2px solid var(--signal);
  outline-offset: 2px;
}
`;

// ---------------------------------------------------------------------
// New templates/index.html
// ---------------------------------------------------------------------
const INDEX_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Perimeter — Motion Watch</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/style.css">
</head>
<body>

<!-- ambient background blobs — purely decorative, sit behind everything -->
<div class="blob blob-a"></div>
<div class="blob blob-b"></div>
<div class="blob blob-c"></div>
<div class="blob blob-d"></div>
<div class="blob blob-e"></div>

<div class="console">

  <!-- Header strip -->
  <header class="bar glass">
    <div class="bar-id">
      <span class="dot" id="pulse-dot"></span>
      <span class="bar-name">PERIMETER</span>
      <span class="bar-sub">motion watch</span>
    </div>
    <div class="bar-right">
      <span class="bar-clock" id="clock">--:--:--</span>
      <button class="arm-toggle" id="armToggle" data-armed="true">
        <span class="arm-toggle-label">ARMED</span>
      </button>
    </div>
  </header>

  <!-- Main grid: feed | log -->
  <main class="grid">

    <!-- Left: live feed on top, captured-snapshot gallery below -->
    <section class="feed-panel">

      <!-- Live camera stream -->
      <div class="feed-frame glass" id="liveFrame">
        <img id="liveImg" alt="Live camera feed" src="/video_feed">
        <div class="feed-empty" id="liveEmpty">
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
            <circle cx="20" cy="20" r="18" stroke="currentColor" stroke-width="1.4"/>
            <circle cx="20" cy="20" r="6" stroke="currentColor" stroke-width="1.4"/>
            <path d="M2 20h6M32 20h6M20 2v6M20 32v6" stroke="currentColor" stroke-width="1.4"/>
          </svg>
          <p>Camera not connected</p>
        </div>
        <div class="feed-tag live-tag" id="liveTag">
          <span class="live-dot"></span>LIVE
        </div>
      </div>
      <div class="feed-caption">
        <span>Live camera feed</span>
        <span class="feed-caption-sep">·</span>
        <span id="liveResolution">webcam</span>
      </div>

      <!-- Captured snapshots, triggered by motion -->
      <div class="gallery glass">
        <div class="gallery-head">
          <span>Motion captures</span>
          <span class="log-head-count" id="galleryCount">0</span>
        </div>
        <div class="gallery-strip" id="galleryStrip">
          <p class="gallery-empty" id="galleryEmpty">Snapshots taken on motion will appear here.</p>
        </div>
      </div>

    </section>

    <!-- Right: telemetry + log -->
    <aside class="side">

      <div class="stat-row">
        <div class="stat glass">
          <span class="stat-value" id="statTotal">0</span>
          <span class="stat-label">events logged</span>
        </div>
        <div class="stat glass">
          <span class="stat-value" id="statUptime">0m</span>
          <span class="stat-label">watch time</span>
        </div>
      </div>

      <div class="module-row">
        <div class="module glass" id="modSensor">
          <span class="module-name">PIR sensor</span>
          <span class="module-state" id="modSensorState">checking</span>
        </div>
        <div class="module glass" id="modCamera">
          <span class="module-name">Webcam</span>
          <span class="module-state" id="modCameraState">checking</span>
        </div>
      </div>

      <div class="log glass">
        <div class="log-head">
          <span>Event log</span>
          <span class="log-head-count" id="logCount">0</span>
        </div>
        <ol class="log-list" id="logList">
          <li class="log-empty">No motion recorded yet. The log fills in here the moment the sensor trips.</li>
        </ol>
      </div>

    </aside>
  </main>

  <footer class="foot">
    <span>Raspberry Pi · PIR + USB webcam</span>
    <span class="foot-sep">·</span>
    <span id="footStatus">connecting…</span>
  </footer>

</div>

<script src="/static/app.js"></script>
</body>
</html>
`;

// ---------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------
async function main() {
  console.log(`Perimeter — Obsidian Pastel Glass patch`);
  console.log(`Project root: ${projectRoot}${dryRun ? "  (dry run — no files will be written)" : ""}\n`);

  if (!(await exists(path.join(projectRoot, "templates"))) || !(await exists(path.join(projectRoot, "static")))) {
    console.error(
      "Could not find templates/ and static/ under the given root.\n" +
        "Run this from the repo root (ACT3embedd/), or pass --root /path/to/ACT3embedd"
    );
    process.exitCode = 1;
    return;
  }

  const backupDir = path.join(projectRoot, "backup", timestamp());
  if (dryRun) {
    console.log(`[dry-run] would back up to backup/${timestamp()}/ (skipped)`);
  } else {
    console.log(`Backing up existing files to backup/${timestamp()}/ ...`);
    await backupFile(TEMPLATE_PATH, backupDir);
    await backupFile(STYLE_PATH, backupDir);
  }

  console.log("\nWriting new design...");
  await writeFile(STYLE_PATH, STYLE_CSS);
  await writeFile(TEMPLATE_PATH, INDEX_HTML);

  console.log(
    dryRun
      ? "\nDry run complete — no files were changed."
      : "\nDone. static/app.js was not touched — every element ID is unchanged, so your existing polling logic keeps working as-is.\nRun the app and open the dashboard to see the new design."
  );
}

main().catch((err) => {
  console.error("Patch failed:", err);
  process.exitCode = 1;
});
