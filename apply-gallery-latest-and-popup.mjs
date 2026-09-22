#!/usr/bin/env node
/**
 * apply-gallery-latest-and-popup.mjs
 * ----------------------------------------------------------------------
 * Two changes:
 *
 * 1. MOTION CAPTURES / RECORDINGS STRIP -> latest item + "View all"
 *    Camera Watch's "Motion captures" strip and Buzzer + Graph's "Motion
 *    recordings" strip currently render every file as a horizontally
 *    scrolling row. This patch changes both to show only the single
 *    latest capture (large card) plus a "View all" button that opens a
 *    scrollable list of every capture/recording.
 *
 * 2. CLICKING A CAPTURE -> same fullscreen, centered, blurred-background
 *    popup the graph spikes already use (.mg-pop in static/graph.js),
 *    instead of doing nothing (the old gallery thumbnails had no click
 *    handler at all) or a separate lightbox.
 *    graph.js now exposes window.motionGraphOpenPop(rootId, filename,
 *    hhmmss) so camera.js/buzzer.js can trigger that same popup directly
 *    from a gallery click, and from the new "View all" list too.
 *
 * Also fixes a small pre-existing inconsistency while in the area:
 * buzzer.html/buzzer.js hardcoded "5s" / "5-second clips" labels, left
 * over from before RECORDING_SECONDS became a 10s *minimum* that can
 * extend further -- these now just show the actual clip's timestamp
 * instead of a fixed/misleading duration.
 *
 * Changes:
 *   static/graph.js
 *     - initMotionGraph() now assigns window.motionGraphOpenPop =
 *       (rootId, filename, hhmmss) => ... so other scripts can open the
 *       same popup this page's own graph uses, for the fig this page is
 *       locked to (image on camera.html, video on buzzer.html).
 *
 *   templates/camera.html
 *     - "Motion captures" panel: adds a "View all" button in the header
 *       and a <div id="galleryAllPop"> list-modal shell (reuses .mg-pop
 *       styling patterns already in style.css).
 *
 *   templates/buzzer.html
 *     - Same, for "Motion recordings" / #recordingAllPop.
 *
 *   static/style.css
 *     - .gallery-latest / .gallery-view-all-btn: styles for the new
 *       single-card "latest" layout and the View all button.
 *     - .gallery-all-pop / .gallery-all-list / .gallery-all-row: styles
 *       for the all-items list modal (same blur/center treatment as
 *       .mg-pop).
 *
 *   static/camera.js
 *     - renderGallery(): renders only the latest file as a single large
 *       card, wired to open the fullscreen popup on click.
 *     - New renderGalleryAll() + "View all" / close wiring for the list
 *       modal, each row opening the same fullscreen popup.
 *
 *   static/buzzer.js
 *     - Same for recordings, plus removes the stale "5s" / "5-second
 *       clips" hardcoded text.
 *
 * app.py is NOT touched -- /api/gallery and /api/recordings already
 * return newest-first, which is all this patch needs.
 *
 * Usage:
 *   node apply-gallery-latest-and-popup.mjs             # run from repo root
 *   node apply-gallery-latest-and-popup.mjs --dry-run   # preview only
 *   node apply-gallery-latest-and-popup.mjs --root /path/to/ACT3embedd
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

const GRAPH_JS_PATH = path.join(projectRoot, "static", "graph.js");
const CAMERA_HTML_PATH = path.join(projectRoot, "templates", "camera.html");
const BUZZER_HTML_PATH = path.join(projectRoot, "templates", "buzzer.html");
const STYLE_CSS_PATH = path.join(projectRoot, "static", "style.css");
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
  if (dryRun) {
    console.log(
      `  [dry-run] would back up -> ${path.relative(
        projectRoot,
        path.join(backupDir, path.basename(filePath))
      )}`
    );
    return;
  }
  await fs.mkdir(backupDir, { recursive: true });
  const dest = path.join(backupDir, path.basename(filePath));
  await fs.copyFile(filePath, dest);
  console.log(`  backed up -> ${path.relative(projectRoot, dest)}`);
}

async function writeFile(filePath, contents) {
  if (dryRun) {
    console.log(`  [dry-run] would write ${path.relative(projectRoot, filePath)} (${contents.length} bytes)`);
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
  console.log(`  wrote ${path.relative(projectRoot, filePath)} (${contents.length} bytes)`);
}

function applyReplacements(content, replacements) {
  let applied = 0;
  let alreadyPresent = 0;
  let missing = 0;

  for (const { find, replace, label } of replacements) {
    if (content.includes(replace)) {
      alreadyPresent++;
      console.log(`  = already applied: ${label}`);
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

async function patchFile(filePath, replacements, backupDir) {
  const rel = path.relative(projectRoot, filePath);
  if (!(await exists(filePath))) {
    console.log(`! ${rel} not found, skipping`);
    return { applied: 0, alreadyPresent: 0, missing: replacements.length };
  }

  console.log(`\n${rel}`);
  await backupFile(filePath, backupDir);

  const original = await fs.readFile(filePath, "utf8");
  const { content, applied, alreadyPresent, missing } = applyReplacements(original, replacements);

  if (applied > 0) {
    await writeFile(filePath, content);
  } else {
    console.log(`  (no changes needed)`);
  }

  return { applied, alreadyPresent, missing };
}

// ---------------------------------------------------------------------
// static/graph.js -- expose the fullscreen popup for outside callers
// ---------------------------------------------------------------------
const GRAPH_JS_REPLACEMENTS = [
  {
    label: "expose window.motionGraphOpenPop so gallery clicks can reuse the same fullscreen popup",
    find: `    popX.addEventListener("click", closePop);`,
    replace: `    // Let other scripts on this page (the gallery / recordings strip,
    // and their "View all" list) open the exact same fullscreen, centered,
    // blurred-background popup this graph uses for its own spikes -- fig
    // is whatever this page is locked to (image on camera.html, video on
    // buzzer.html), so a gallery thumbnail click and a graph spike click
    // land on an identical popup.
    window.motionGraphOpenPop = (targetRootId, filename, hhmmss) => {
      if ((targetRootId || "motionGraph") !== (rootId || "motionGraph")) return;
      const [h, m, s] = (hhmmss || "00:00:00").split(":").map(Number);
      openPop({
        t: (h || 0) * 3600 + (m || 0) * 60 + (s || 0),
        file_image: filename,
        file_video: filename,
      });
    };

    popX.addEventListener("click", closePop);`,
  },
];

// ---------------------------------------------------------------------
// templates/camera.html -- latest-only gallery + View all
// ---------------------------------------------------------------------
const CAMERA_HTML_REPLACEMENTS = [
  {
    label: '"Motion captures" panel: add View all button + all-items modal shell',
    find: `      <div class="gallery glass">
        <div class="gallery-head">
          <span>Motion captures</span>
          <span class="log-head-count" id="galleryCount">0</span>
        </div>
        <div class="gallery-strip" id="galleryStrip">
          <p class="gallery-empty" id="galleryEmpty">Snapshots taken on motion will appear here.</p>
        </div>
      </div>`,
    replace: `      <div class="gallery glass">
        <div class="gallery-head">
          <span>Motion captures</span>
          <div class="gallery-head-right">
            <span class="log-head-count" id="galleryCount">0</span>
            <button class="gallery-view-all-btn" id="galleryViewAllBtn" type="button">View all</button>
          </div>
        </div>
        <div class="gallery-strip gallery-strip--latest" id="galleryStrip">
          <p class="gallery-empty" id="galleryEmpty">Snapshots taken on motion will appear here.</p>
        </div>
      </div>

      <div class="gallery-all-pop" id="galleryAllPop" aria-modal="true" role="dialog">
        <div class="gallery-all-frame">
          <div class="gallery-all-bar">
            <span>All motion captures</span>
            <button class="mg-pop-x" id="galleryAllClose" type="button">close ✕</button>
          </div>
          <div class="gallery-all-list" id="galleryAllList"></div>
        </div>
      </div>`,
  },
];

// ---------------------------------------------------------------------
// templates/buzzer.html -- latest-only recordings + View all
// ---------------------------------------------------------------------
const BUZZER_HTML_REPLACEMENTS = [
  {
    label: '"Motion recordings" panel: add View all button + all-items modal shell',
    find: `          <span>Motion recordings</span>
          <span class="log-head-count" id="recordingCount">0</span>
        </div>
        <div class="gallery-strip gallery-strip--video" id="recordingStrip">
          <p class="gallery-empty" id="recordingEmpty">5-second clips recorded on motion will appear here.</p>
        </div>
      </div>`,
    replace: `          <span>Motion recordings</span>
          <div class="gallery-head-right">
            <span class="log-head-count" id="recordingCount">0</span>
            <button class="gallery-view-all-btn" id="recordingViewAllBtn" type="button">View all</button>
          </div>
        </div>
        <div class="gallery-strip gallery-strip--video gallery-strip--latest" id="recordingStrip">
          <p class="gallery-empty" id="recordingEmpty">Clips recorded on motion will appear here.</p>
        </div>
      </div>

      <div class="gallery-all-pop" id="recordingAllPop" aria-modal="true" role="dialog">
        <div class="gallery-all-frame">
          <div class="gallery-all-bar">
            <span>All motion recordings</span>
            <button class="mg-pop-x" id="recordingAllClose" type="button">close ✕</button>
          </div>
          <div class="gallery-all-list" id="recordingAllList"></div>
        </div>
      </div>`,
  },
];

// ---------------------------------------------------------------------
// static/style.css additions
// ---------------------------------------------------------------------
const STYLE_CSS_REPLACEMENTS = [
  {
    label: "add .gallery-head-right / .gallery-view-all-btn / latest-card / all-items-modal styles",
    find: `/* video-clip variant of the gallery strip (Fig. 3.3) */`,
    replace: `.gallery-head-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.gallery-view-all-btn {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: var(--text-dim);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--edge-soft);
  border-radius: 8px;
  padding: 5px 11px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.gallery-view-all-btn:hover { color: #fff; background: rgba(255, 255, 255, 0.12); }

/* "latest capture only" layout: a single large card instead of a strip */
.gallery-strip--latest {
  overflow: visible;
}
.gallery-strip--latest .gallery-shot {
  width: 100%;
  flex: 1 1 auto;
  aspect-ratio: 16 / 9;
}

/* "View all" list modal -- same fullscreen/centered/blurred treatment as
   .mg-pop, so it feels like part of the same popup system */
.gallery-all-pop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: none;
  align-items: center;
  justify-content: center;
  background: rgba(8, 9, 11, 0.55);
  backdrop-filter: blur(22px) saturate(1.2);
  -webkit-backdrop-filter: blur(22px) saturate(1.2);
  padding: 3vh 3vw;
}
.gallery-all-pop.open { display: flex; animation: mg-fade 0.16s ease-out; }

.gallery-all-frame {
  width: min(720px, 94vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  background: rgba(20, 21, 24, 0.92);
  border: 1px solid var(--edge-soft);
  border-radius: 16px;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6);
  overflow: hidden;
}

.gallery-all-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--edge-soft);
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 700;
  color: #fff;
}

.gallery-all-list {
  overflow-y: auto;
  padding: 10px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
}

.gallery-all-row {
  position: relative;
  aspect-ratio: 4 / 3;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.18);
  cursor: pointer;
}
.gallery-all-row img,
.gallery-all-row video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  background: #000;
}
.gallery-all-row .gallery-shot-time {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text);
  background: linear-gradient(to top, rgba(0,0,0,0.75), transparent);
  padding: 10px 6px 4px;
}

/* video-clip variant of the gallery strip (Fig. 3.3) */`,
  },
];

// ---------------------------------------------------------------------
// static/camera.js -- latest-only render + fullscreen popup + View all
// ---------------------------------------------------------------------
const CAMERA_JS_REPLACEMENTS = [
  {
    label: "el map: add galleryViewAllBtn / galleryAllPop / galleryAllList / galleryAllClose",
    find: `  galleryStrip: document.getElementById("galleryStrip"),
  galleryCount: document.getElementById("galleryCount"),`,
    replace: `  galleryStrip: document.getElementById("galleryStrip"),
  galleryCount: document.getElementById("galleryCount"),
  galleryViewAllBtn: document.getElementById("galleryViewAllBtn"),
  galleryAllPop: document.getElementById("galleryAllPop"),
  galleryAllList: document.getElementById("galleryAllList"),
  galleryAllClose: document.getElementById("galleryAllClose"),`,
  },
  {
    label: "renderGallery(): show only the latest file, wired to open the fullscreen popup",
    find: `function renderGallery(files) {
  const signature = files.join(",");
  if (signature === lastGallerySignature) return; // avoid needless re-render/flicker
  lastGallerySignature = signature;

  el.galleryCount.textContent = files.length;

  if (!files.length) {
    el.galleryStrip.innerHTML =
      '<p class="gallery-empty" id="galleryEmpty">Snapshots taken on motion will appear here.</p>';
    return;
  }

  el.galleryStrip.innerHTML = files
    .map((filename) => {
      // filenames look like motion_20260918_025309.jpg — pull a readable time out of it
      const match = filename.match(/(\\d{2})(\\d{2})(\\d{2})\\.\\w+$/);
      const timeLabel = match ? \`\${match[1]}:\${match[2]}:\${match[3]}\` : "";
      return \`
        <div class="gallery-shot" title="\${filename}">
          <img src="/captures/\${filename}" alt="Motion capture \${filename}" loading="lazy">
          <span class="gallery-shot-time">\${timeLabel}</span>
        </div>\`;
    })
    .join("");
}`,
    replace: `function timeLabelFor(filename) {
  // filenames look like motion_20260918_025309.jpg — pull a readable time out of it
  const match = filename.match(/(\\d{2})(\\d{2})(\\d{2})\\.\\w+$/);
  return match ? \`\${match[1]}:\${match[2]}:\${match[3]}\` : "";
}

function openGalleryPop(filename) {
  if (window.motionGraphOpenPop) {
    window.motionGraphOpenPop("motionGraph", filename, timeLabelFor(filename));
  }
}

let latestGalleryFiles = [];

function renderGallery(files) {
  const signature = files.join(",");
  latestGalleryFiles = files;
  if (signature === lastGallerySignature) return; // avoid needless re-render/flicker
  lastGallerySignature = signature;

  el.galleryCount.textContent = files.length;

  if (!files.length) {
    el.galleryStrip.innerHTML =
      '<p class="gallery-empty" id="galleryEmpty">Snapshots taken on motion will appear here.</p>';
    return;
  }

  // Only the latest capture is shown inline; the rest are one click away
  // via "View all".
  const filename = files[0];
  const timeLabel = timeLabelFor(filename);
  el.galleryStrip.innerHTML = \`
    <div class="gallery-shot" title="\${filename}">
      <img src="/captures/\${filename}" alt="Motion capture \${filename}" loading="lazy">
      <span class="gallery-shot-time">\${timeLabel}</span>
    </div>\`;
  const shot = el.galleryStrip.querySelector(".gallery-shot");
  if (shot) shot.addEventListener("click", () => openGalleryPop(filename));
}

function renderGalleryAll() {
  if (!latestGalleryFiles.length) {
    el.galleryAllList.innerHTML = '<p class="gallery-empty">Snapshots taken on motion will appear here.</p>';
    return;
  }
  el.galleryAllList.innerHTML = latestGalleryFiles
    .map((filename) => {
      const timeLabel = timeLabelFor(filename);
      return \`
        <div class="gallery-all-row" data-filename="\${filename}" title="\${filename}">
          <img src="/captures/\${filename}" alt="Motion capture \${filename}" loading="lazy">
          <span class="gallery-shot-time">\${timeLabel}</span>
        </div>\`;
    })
    .join("");
  el.galleryAllList.querySelectorAll(".gallery-all-row").forEach((row) => {
    row.addEventListener("click", () => openGalleryPop(row.dataset.filename));
  });
}

if (el.galleryViewAllBtn) {
  el.galleryViewAllBtn.addEventListener("click", () => {
    renderGalleryAll();
    el.galleryAllPop.classList.add("open");
  });
}
if (el.galleryAllClose) {
  el.galleryAllClose.addEventListener("click", () => el.galleryAllPop.classList.remove("open"));
}
if (el.galleryAllPop) {
  el.galleryAllPop.addEventListener("mousedown", (ev) => {
    if (ev.target === el.galleryAllPop) el.galleryAllPop.classList.remove("open");
  });
}`,
  },
];

// ---------------------------------------------------------------------
// static/buzzer.js -- latest-only render + fullscreen popup + View all
// ---------------------------------------------------------------------
const BUZZER_JS_REPLACEMENTS = [
  {
    label: "el map: add recordingViewAllBtn / recordingAllPop / recordingAllList / recordingAllClose",
    find: `  recordingStrip: document.getElementById("recordingStrip"),
  recordingCount: document.getElementById("recordingCount"),`,
    replace: `  recordingStrip: document.getElementById("recordingStrip"),
  recordingCount: document.getElementById("recordingCount"),
  recordingViewAllBtn: document.getElementById("recordingViewAllBtn"),
  recordingAllPop: document.getElementById("recordingAllPop"),
  recordingAllList: document.getElementById("recordingAllList"),
  recordingAllClose: document.getElementById("recordingAllClose"),`,
  },
  {
    label: "renderRecordings(): show only the latest clip, wired to open the fullscreen popup, drop stale '5s' label",
    find: `function renderRecordings(files) {
  const signature = files.join(",");
  if (signature === lastRecordingSignature) return; // avoid needless re-render/flicker
  lastRecordingSignature = signature;

  el.recordingCount.textContent = files.length;

  if (!files.length) {
    el.recordingStrip.innerHTML =
      '<p class="gallery-empty" id="recordingEmpty">5-second clips recorded on motion will appear here.</p>';
    return;
  }

  el.recordingStrip.innerHTML = files
    .map((filename) => {
      // filenames look like motion_20260918_025309.mp4 — pull a readable time out of it
      const match = filename.match(/(\\d{2})(\\d{2})(\\d{2})\\.\\w+$/);
      const timeLabel = match ? \`\${match[1]}:\${match[2]}:\${match[3]}\` : "";
      return \`
        <div class="gallery-shot" title="\${filename}">
          <video src="/recordings/\${filename}" muted loop playsinline preload="metadata"
                 onmouseenter="this.play()" onmouseleave="this.pause(); this.currentTime = 0;"></video>
          <span class="gallery-shot-duration">5s</span>
          <span class="gallery-shot-time">\${timeLabel}</span>
        </div>\`;
    })
    .join("");
}`,
    replace: `function recordingTimeLabelFor(filename) {
  // filenames look like motion_20260918_025309.mp4 — pull a readable time out of it
  const match = filename.match(/(\\d{2})(\\d{2})(\\d{2})\\.\\w+$/);
  return match ? \`\${match[1]}:\${match[2]}:\${match[3]}\` : "";
}

function openRecordingPop(filename) {
  if (window.motionGraphOpenPop) {
    window.motionGraphOpenPop("motionGraph", filename, recordingTimeLabelFor(filename));
  }
}

let latestRecordingFiles = [];

function renderRecordings(files) {
  const signature = files.join(",");
  latestRecordingFiles = files;
  if (signature === lastRecordingSignature) return; // avoid needless re-render/flicker
  lastRecordingSignature = signature;

  el.recordingCount.textContent = files.length;

  if (!files.length) {
    el.recordingStrip.innerHTML =
      '<p class="gallery-empty" id="recordingEmpty">Clips recorded on motion will appear here.</p>';
    return;
  }

  // Only the latest clip is shown inline; the rest are one click away via
  // "View all".
  const filename = files[0];
  const timeLabel = recordingTimeLabelFor(filename);
  el.recordingStrip.innerHTML = \`
    <div class="gallery-shot" title="\${filename}">
      <video src="/recordings/\${filename}" muted loop playsinline preload="metadata"
             onmouseenter="this.play()" onmouseleave="this.pause(); this.currentTime = 0;"></video>
      <span class="gallery-shot-time">\${timeLabel}</span>
    </div>\`;
  const shot = el.recordingStrip.querySelector(".gallery-shot");
  if (shot) shot.addEventListener("click", () => openRecordingPop(filename));
}

function renderRecordingsAll() {
  if (!latestRecordingFiles.length) {
    el.recordingAllList.innerHTML = '<p class="gallery-empty">Clips recorded on motion will appear here.</p>';
    return;
  }
  el.recordingAllList.innerHTML = latestRecordingFiles
    .map((filename) => {
      const timeLabel = recordingTimeLabelFor(filename);
      return \`
        <div class="gallery-all-row" data-filename="\${filename}" title="\${filename}">
          <video src="/recordings/\${filename}" muted loop playsinline preload="metadata"
                 onmouseenter="this.play()" onmouseleave="this.pause(); this.currentTime = 0;"></video>
          <span class="gallery-shot-time">\${timeLabel}</span>
        </div>\`;
    })
    .join("");
  el.recordingAllList.querySelectorAll(".gallery-all-row").forEach((row) => {
    row.addEventListener("click", () => openRecordingPop(row.dataset.filename));
  });
}

if (el.recordingViewAllBtn) {
  el.recordingViewAllBtn.addEventListener("click", () => {
    renderRecordingsAll();
    el.recordingAllPop.classList.add("open");
  });
}
if (el.recordingAllClose) {
  el.recordingAllClose.addEventListener("click", () => el.recordingAllPop.classList.remove("open"));
}
if (el.recordingAllPop) {
  el.recordingAllPop.addEventListener("mousedown", (ev) => {
    if (ev.target === el.recordingAllPop) el.recordingAllPop.classList.remove("open");
  });
}`,
  },
];

async function main() {
  const backupDir = path.join(projectRoot, "backup", timestamp());

  console.log(`Perimeter -- latest-only gallery/recordings + View all + fullscreen popup reuse`);
  console.log(`root: ${projectRoot}`);
  if (dryRun) console.log(`(dry run -- no files will be written)`);

  const results = [];
  results.push(await patchFile(GRAPH_JS_PATH, GRAPH_JS_REPLACEMENTS, backupDir));
  results.push(await patchFile(CAMERA_HTML_PATH, CAMERA_HTML_REPLACEMENTS, backupDir));
  results.push(await patchFile(BUZZER_HTML_PATH, BUZZER_HTML_REPLACEMENTS, backupDir));
  results.push(await patchFile(STYLE_CSS_PATH, STYLE_CSS_REPLACEMENTS, backupDir));
  results.push(await patchFile(CAMERA_JS_PATH, CAMERA_JS_REPLACEMENTS, backupDir));
  results.push(await patchFile(BUZZER_JS_PATH, BUZZER_JS_REPLACEMENTS, backupDir));

  const totals = results.reduce(
    (acc, r) => ({
      applied: acc.applied + r.applied,
      alreadyPresent: acc.alreadyPresent + r.alreadyPresent,
      missing: acc.missing + r.missing,
    }),
    { applied: 0, alreadyPresent: 0, missing: 0 }
  );

  console.log(
    `\nDone. ${totals.applied} change(s) applied, ${totals.alreadyPresent} already in place, ${totals.missing} not found.`
  );
  if (dryRun) console.log(`Re-run without --dry-run to write changes.`);
}

main().catch((err) => {
  console.error("Patch failed:", err);
  process.exit(1);
});
