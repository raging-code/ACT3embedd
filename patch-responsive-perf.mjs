#!/usr/bin/env node
/**
 * patch-responsive-perf.mjs
 * ---------------------------------------------------------------------------
 * Makes the Perimeter dashboard (camera.html / buzzer.html / calibrate.html /
 * menu.html) more responsive on small screens and lighter on low-power
 * devices (phones, and the Raspberry Pi's own GPU when it renders the page
 * locally).
 *
 * What changes and why:
 *
 *   static/style.css
 *     - New <=430px breakpoint: tighter shell padding, smaller header/clock/
 *       toggle, single-column stat row, narrower gallery thumbnails, bigger
 *       (>=40px) tap targets on icon-only buttons (back link, popup close,
 *       "view all") so they meet the ~40-44px touch-target guideline.
 *     - The five decorative ambient ".blob" elements are heavy: large,
 *       blurred, always-composited radial gradients. They're cut from 5 to 2
 *       and shrunk under prefers-reduced-motion and under <=560px, where
 *       they cost real paint/compositing time on phone GPUs for no visible
 *       benefit at that size.
 *     - backdrop-filter blur is reduced further (5px -> 3px) under <=560px.
 *       Backdrop blur is one of the most expensive things a mobile GPU can
 *       be asked to recompute every frame, and .feed-frame sits directly
 *       over the continuously-updating MJPEG stream, so this panel repaints
 *       constantly on phones.
 *     - .gallery-shot and .gallery-all-list thumbnail sizing gets a real
 *       phone-width breakpoint instead of relying on flex/grid minmax alone.
 *
 *   static/camera.js, static/buzzer.js
 *     - renderGalleryAll()/renderRecordingsAll() currently build one <video
 *       preload="metadata"> per recorded clip and inject them ALL into the
 *       DOM at once. With more than a handful of clips this means many
 *       concurrent metadata fetches/decodes the instant "View all" opens --
 *       expensive on mobile data and mobile CPUs, and the elements never
 *       preview anyway on a touchscreen because the existing preview logic
 *       is hover-only (onmouseenter/onmouseleave), which touch devices never
 *       fire. This patch:
 *         - switches those thumbnails to preload="none" and lazy-loads each
 *           video's metadata only when it actually scrolls into view (via
 *           IntersectionObserver, with an eager fallback if unsupported)
 *         - adds a touch-friendly tap-to-preview toggle alongside the
 *           existing hover behaviour, instead of replacing it
 *
 * Usage (run from anywhere; default target is the current folder):
 *
 *     node patch-responsive-perf.mjs                 # patch ./
 *     node patch-responsive-perf.mjs /path/to/repo   # patch another folder
 *     node patch-responsive-perf.mjs --dry-run       # show what would change
 *
 * Safe to re-run: files that are already patched are skipped. Originals are
 * saved next to the files as *.bak before anything is written. If any file
 * does not match what the script expects, NOTHING is written.
 *
 * Files changed: static/style.css, static/camera.js, static/buzzer.js
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const root = path.resolve(args.find((a) => !a.startsWith("--")) || ".");

/* ------------------------------------------------------------- helpers */

function replaceOnce(src, oldStr, newStr, label) {
  const first = src.indexOf(oldStr);
  if (first === -1) throw new Error(`could not find: ${label}`);
  if (src.indexOf(oldStr, first + 1) !== -1) throw new Error(`found more than once: ${label}`);
  return src.slice(0, first) + newStr + src.slice(first + oldStr.length);
}

/* --------------------------------------------------------- style.css */
function patchStyleCss(s) {
  // 1) Trim the blob count / cost under reduced motion (existing rule).
  s = replaceOnce(
    s,
    `@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}`,
    `@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}

/* Cheaper ambient background on small / low-power screens: fewer blobs,
   smaller blur radius, and one notch less backdrop blur on the glass
   panels that sit over continuously-updating content (the live feed). */
@media (max-width: 560px) {
  .blob-c, .blob-d, .blob-e { display: none; }
  .blob { filter: blur(6px); }
  .glass {
    backdrop-filter: blur(3px) saturate(1.08);
    -webkit-backdrop-filter: blur(3px) saturate(1.08);
  }
}`,
    "prefers-reduced-motion block"
  );

  // 2) Shell padding scales down on phones instead of staying fixed at 24px.
  s = replaceOnce(
    s,
    `.console {
  position: relative;
  z-index: 1;
  max-width: 1180px;
  margin: 0 auto;
  padding: 24px 24px 40px;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}`,
    `.console {
  position: relative;
  z-index: 1;
  max-width: 1180px;
  margin: 0 auto;
  padding: 24px 24px 40px;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

@media (max-width: 430px) {
  .console { padding: 12px 12px 28px; }
}`,
    ".console shell padding"
  );

  // 3) Touch targets: back-link and gallery "view all" button grow to a
  //    real tappable size on phones (26px / text-only were below the
  //    ~40-44px guideline for touch input).
  s = replaceOnce(
    s,
    `.back-link {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  color: var(--text-dim);
  background: rgba(255,255,255,0.05);
  border: 1px solid var(--edge-soft);
  margin-right: 2px;
  transition: background 0.15s ease, color 0.15s ease;
}
.back-link:hover { background: rgba(255,255,255,0.1); color: var(--text); }`,
    `.back-link {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  color: var(--text-dim);
  background: rgba(255,255,255,0.05);
  border: 1px solid var(--edge-soft);
  margin-right: 2px;
  transition: background 0.15s ease, color 0.15s ease;
}
.back-link:hover { background: rgba(255,255,255,0.1); color: var(--text); }

@media (max-width: 430px) {
  .back-link { width: 40px; height: 40px; }
  .mg-pop-x, .gallery-view-all-btn { padding: 10px 14px; }
}`,
    ".back-link touch target"
  );

  // 4) Header bar / clock / arm-toggle shrink further on very small phones
  //    (the existing 860px/560px breakpoints only hide the clock and module
  //    labels -- this adds a real size reduction pass below that).
  s = replaceOnce(
    s,
    `@media (max-width: 560px) {
  .bar-modules { gap: 6px; }
  .bar-clock { display: none; }
}`,
    `@media (max-width: 560px) {
  .bar-modules { gap: 6px; }
  .bar-clock { display: none; }
}

@media (max-width: 430px) {
  .bar { padding: 12px 14px; margin-bottom: 12px; }
  .arm-toggle { padding: 8px 12px; font-size: 12px; }
  .bar-module { padding: 5px 7px; }
  .bar-module-state { font-size: 10.5px; }
}`,
    "560px bar-modules block"
  );

  // 5) Stat row stacks to one column on very narrow phones instead of
  //    squeezing two stat cards into ~180px each.
  s = replaceOnce(
    s,
    `.stat-row {`,
    `@media (max-width: 430px) {
  .stat-row { grid-template-columns: 1fr; }
}

.stat-row {`,
    ".stat-row declaration"
  );

  // 6) Gallery thumbnails (inline strip) get a real phone-width size step
  //    instead of relying on the flex strip alone -- 152px fixed-width
  //    cards on a ~360px phone leave awkward overflow.
  s = replaceOnce(
    s,
    `.gallery-strip::-webkit-scrollbar { height: 6px; }`,
    `@media (max-width: 430px) {
  .gallery-shot { width: 124px; }
  .gallery-strip { padding: 10px; gap: 8px; }
}

.gallery-strip::-webkit-scrollbar { height: 6px; }`,
    ".gallery-strip scrollbar rule"
  );

  // 7) "View all" grid: smaller minimum tile on phones so at least two
  //    columns fit instead of one oversized column.
  s = replaceOnce(
    s,
    `.gallery-all-list {
  overflow-y: auto;
  padding: 10px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
}`,
    `.gallery-all-list {
  overflow-y: auto;
  padding: 10px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
}

@media (max-width: 430px) {
  .gallery-all-list { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 8px; }
  .gallery-all-pop { padding: 0; }
  .gallery-all-frame { width: 100vw; max-height: 100vh; height: 100vh; border-radius: 0; }
}`,
    ".gallery-all-list grid"
  );

  return s;
}

/* ------------------------------------------- lazy-video helper (shared) */
// Injected once into camera.js and once into buzzer.js (same text both
// times) so each file stays self-contained and neither depends on the
// other loading first.
const LAZY_VIDEO_HELPER = `
// Lazily starts loading a thumbnail <video>'s metadata only once it
// scrolls into view, instead of every clip in "View all" fetching
// metadata the instant the list is built. Falls back to loading
// immediately if IntersectionObserver isn't available. Also wires up a
// tap-to-preview toggle so touch devices (which never fire
// mouseenter/mouseleave) get the same preview behaviour as hover on
// desktop.
function lazyPreviewVideo(video) {
  video.preload = "none";
  const load = () => {
    if (video.preload === "metadata") return;
    video.preload = "metadata";
  };
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          load();
          io.unobserve(video);
        }
      }
    }, { rootMargin: "200px" });
    io.observe(video);
  } else {
    load();
  }
  video.addEventListener("click", (e) => {
    e.stopPropagation();
    load();
    if (video.paused) video.play().catch(() => {});
    else { video.pause(); video.currentTime = 0.1; }
  });
}
`;

function patchCameraJs(s) {
  s = replaceOnce(s, `function timeLabelFor(`, `${LAZY_VIDEO_HELPER}\nfunction timeLabelFor(`, "camera.js function anchor");
  s = replaceOnce(
    s,
    `  el.galleryAllList.innerHTML = latestGalleryFiles
    .map((filename) => {
      const timeLabel = timeLabelFor(filename);
      return \`
        <div class="gallery-all-row" data-filename="\${filename}" title="\${filename}">
          <video src="/captures/\${filename}" muted loop playsinline preload="metadata"
                 onloadedmetadata="this.currentTime = 0.1"
                 onmouseenter="this.play()" onmouseleave="this.pause(); this.currentTime = 0.1;"></video>
          <span class="gallery-shot-time">\${timeLabel}</span>
        </div>\`;
    })
    .join("");
  el.galleryAllList.querySelectorAll(".gallery-all-row").forEach((row) => {
    row.addEventListener("click", () => openGalleryPop(row.dataset.filename));
  });`,
    `  el.galleryAllList.innerHTML = latestGalleryFiles
    .map((filename) => {
      const timeLabel = timeLabelFor(filename);
      return \`
        <div class="gallery-all-row" data-filename="\${filename}" title="\${filename}">
          <video src="/captures/\${filename}" muted loop playsinline preload="none"
                 onloadedmetadata="this.currentTime = 0.1"
                 onmouseenter="this.play()" onmouseleave="this.pause(); this.currentTime = 0.1;"></video>
          <span class="gallery-shot-time">\${timeLabel}</span>
        </div>\`;
    })
    .join("");
  el.galleryAllList.querySelectorAll(".gallery-all-row").forEach((row) => {
    const video = row.querySelector("video");
    if (video) lazyPreviewVideo(video);
    row.addEventListener("click", (e) => {
      if (e.target === video) return; // tap-to-preview handled its own click
      openGalleryPop(row.dataset.filename);
    });
  });`,
    "renderGalleryAll row wiring"
  );
  return s;
}

function patchBuzzerJs(s) {
  s = replaceOnce(s, `function recordingTimeLabelFor(`, `${LAZY_VIDEO_HELPER}\nfunction recordingTimeLabelFor(`, "buzzer.js function anchor");
  s = replaceOnce(
    s,
    `  el.recordingAllList.innerHTML = latestRecordingFiles
    .map((filename) => {
      const timeLabel = recordingTimeLabelFor(filename);
      return \`
        <div class="gallery-all-row" data-filename="\${filename}" title="\${filename}">
          <video src="/recordings/\${filename}" muted loop playsinline preload="metadata"
                 onloadedmetadata="this.currentTime = 0.1"
                 onmouseenter="this.play()" onmouseleave="this.pause(); this.currentTime = 0.1;"></video>
          <span class="gallery-shot-time">\${timeLabel}</span>
        </div>\`;
    })
    .join("");
  el.recordingAllList.querySelectorAll(".gallery-all-row").forEach((row) => {
    row.addEventListener("click", () => openRecordingPop(row.dataset.filename));
  });`,
    `  el.recordingAllList.innerHTML = latestRecordingFiles
    .map((filename) => {
      const timeLabel = recordingTimeLabelFor(filename);
      return \`
        <div class="gallery-all-row" data-filename="\${filename}" title="\${filename}">
          <video src="/recordings/\${filename}" muted loop playsinline preload="none"
                 onloadedmetadata="this.currentTime = 0.1"
                 onmouseenter="this.play()" onmouseleave="this.pause(); this.currentTime = 0.1;"></video>
          <span class="gallery-shot-time">\${timeLabel}</span>
        </div>\`;
    })
    .join("");
  el.recordingAllList.querySelectorAll(".gallery-all-row").forEach((row) => {
    const video = row.querySelector("video");
    if (video) lazyPreviewVideo(video);
    row.addEventListener("click", (e) => {
      if (e.target === video) return; // tap-to-preview handled its own click
      openRecordingPop(row.dataset.filename);
    });
  });`,
    "renderRecordingsAll row wiring"
  );
  return s;
}

/* --------------------------------------------------------------- main */

// [file, patch function, text that only exists once the file is patched]
const targets = [
  [path.join("static", "style.css"), patchStyleCss, "Cheaper ambient background on small / low-power screens"],
  [path.join("static", "camera.js"), patchCameraJs, "lazyPreviewVideo"],
  [path.join("static", "buzzer.js"), patchBuzzerJs, "lazyPreviewVideo"],
];

console.log(`Target folder: ${root}${dryRun ? "  (dry run)" : ""}`);

const planned = [];
let failed = false;

for (const [rel, fn, marker] of targets) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.error(`  ✗ ${rel}: file not found (is this the repo folder?)`);
    failed = true;
    continue;
  }
  const raw = fs.readFileSync(file, "utf8");
  const crlf = raw.includes("\r\n");
  const text = crlf ? raw.replace(/\r\n/g, "\n") : raw;

  if (text.includes(marker)) {
    console.log(`  • ${rel}: already patched, skipping`);
    continue;
  }
  try {
    let out = fn(text);
    if (crlf) out = out.replace(/\n/g, "\r\n");
    planned.push({ rel, file, out });
    console.log(`  ✓ ${rel}: ok`);
  } catch (err) {
    console.error(`  ✗ ${rel}: ${err.message}`);
    failed = true;
  }
}

if (failed) {
  console.error("\nNothing was written. The files differ from what this patch expects.");
  process.exit(1);
}

if (dryRun || planned.length === 0) {
  console.log(planned.length === 0 ? "\nNothing to do." : "\nDry run finished, no files written.");
  process.exit(0);
}

for (const { rel, file, out } of planned) {
  fs.copyFileSync(file, file + ".bak");
  fs.writeFileSync(file, out, "utf8");
  console.log(`  wrote ${rel}  (backup: ${rel}.bak)`);
}

console.log(`
Done. Next steps:
  1. Restart the app (python3 app.py).
  2. Hard-refresh the dashboard (Ctrl/Cmd+Shift+R) so the new CSS/JS load.
  3. Try it at a phone width (~375-430px) and open "View all" on a page
     with several recorded clips to see the lazy-loaded thumbnails.
`);
