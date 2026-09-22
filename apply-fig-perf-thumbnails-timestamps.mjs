#!/usr/bin/env node
/**
 * apply-fig-perf-thumbnails-timestamps.mjs
 * ----------------------------------------------------------------------
 * Three independent fixes, bundled into one script since they were all
 * requested together. Each is applied and reported separately, and any
 * one of them failing to match doesn't block the others.
 *
 * 1. PERFORMANCE ON RPi CHROMIUM (laggy dashboard)
 *    Two real costs found in the code, not just generic "make it
 *    faster" tweaks:
 *      a) `.glass` (backdrop-filter: blur(32px) saturate(1.8)) is
 *         applied to 7-9 large panels on every page, INCLUDING
 *         `.feed-frame`, which wraps the continuously-updating MJPEG
 *         <img src="/video_feed">. Chromium has to recompute that blur
 *         for everything behind the live feed on every incoming video
 *         frame. This is the single most expensive thing on the page on
 *         a Pi's weaker GPU. Fix: blur is reduced (32px -> 14px, still
 *         reads as "glass" but far cheaper) and layer promotion hints
 *         are added so the browser can composite it more cheaply. The
 *         live feed and popup blurs are untouched visually beyond that
 *         -- same translucent-panel look, just lighter to render.
 *      b) static/graph.js's `loop()` calls `draw()` (full canvas clear +
 *         axis + spikes + minimap redraw) on EVERY requestAnimationFrame
 *         tick, unconditionally, forever -- effectively an uncapped
 *         60fps+ redraw loop running at all times on both dashboards,
 *         whether or not anything on screen actually changed. Fix: the
 *         loop is throttled to a fixed ~20fps ceiling (50ms), which is
 *         still smooth for panning/zooming/hover but cuts the constant
 *         redraw cost by roughly two-thirds to three-quarters depending
 *         on the display's real refresh rate.
 *    No layout, color, or element changes -- panels still look like
 *    frosted glass, the graph still redraws live, nothing about the
 *    design changes, it's just lighter for the Pi's GPU to keep up with.
 *
 * 2. FIG. 3.3 VIDEO THUMBNAILS SOMETIMES BLACK
 *    Root cause: the recording thumbnails use
 *    `preload="metadata"` and reset `this.currentTime = 0` on
 *    mouseleave. Seeking to frame 0 on these clips frequently lands
 *    before the first fully-decoded frame, so the browser shows a black
 *    rectangle until playback actually starts moving forward (which is
 *    why it "plays fine"). Fix: seek to a small positive offset
 *    (0.1s) instead of exactly 0, both on load and on mouseleave, which
 *    reliably lands on a real decoded frame. Purely a JS behavior fix,
 *    no visual/layout change.
 *
 * 3. DATE/TIME STAMP ON CAPTURED IMAGES AND VIDEOS (top-right corner)
 *    app.py already uses cv2.putText for the SIMULATE-mode label, so
 *    the same technique is used for real captures: a new
 *    stamp_timestamp(frame) helper burns "YYYY-MM-DD HH:MM:SS" into the
 *    top-right corner of every frame, applied in capture_frame() (still
 *    JPEGs) and in record_clip_async() (every frame written to the
 *    .mp4, both the simulated and real-camera paths). Font size/margin
 *    scale with the frame's own width, so it looks right at any
 *    resolution.
 *
 * Usage:
 *   node apply-fig-perf-thumbnails-timestamps.mjs             # run from the repo root
 *   node apply-fig-perf-thumbnails-timestamps.mjs --dry-run   # preview only, writes nothing
 *   node apply-fig-perf-thumbnails-timestamps.mjs --root /path/to/ACT3embedd
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

const APP_PATH = path.join(projectRoot, "app.py");
const STYLE_PATH = path.join(projectRoot, "static", "style.css");
const GRAPH_JS_PATH = path.join(projectRoot, "static", "graph.js");
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
    console.log(`  [dry-run] would back up -> ${path.relative(projectRoot, path.join(backupDir, path.basename(filePath)))}`);
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
  const { content, applied, alreadyPresent, missing } = applyReplacements(
    original,
    replacements
  );

  if (applied > 0) {
    await writeFile(filePath, content);
  } else {
    console.log(`  (no changes needed)`);
  }

  return { applied, alreadyPresent, missing };
}

async function main() {
  const backupDir = path.join(projectRoot, "backup", timestamp());

  console.log(`Perimeter -- RPi perf + video-thumbnail + capture-timestamp fixes`);
  console.log(`root: ${projectRoot}`);
  if (dryRun) console.log(`(dry run -- no files will be written)`);

  const results = [];

  // ------------------------------------------------------------------
  // 1a. style.css -- lighten the .glass backdrop-filter blur
  // ------------------------------------------------------------------
  results.push(
    await patchFile(
      STYLE_PATH,
      [
        {
          label: "reduce .glass blur cost (32px -> 14px) + cheaper compositing hint",
          find:
`.glass {
  position: relative;
  background: linear-gradient(155deg, rgba(255,255,255,0.14), rgba(255,255,255,0.03) 40%, rgba(255,255,255,0.07));
  backdrop-filter: blur(32px) saturate(1.8);
  -webkit-backdrop-filter: blur(32px) saturate(1.8);`,
          replace:
`.glass {
  position: relative;
  background: linear-gradient(155deg, rgba(255,255,255,0.14), rgba(255,255,255,0.03) 40%, rgba(255,255,255,0.07));
  /* Lowered from blur(32px) saturate(1.8) -- that cost was being paid on
     every incoming video frame for .feed-frame (which carries the live
     MJPEG feed) and on every other .glass panel on the page at the same
     time. 14px reads visually almost identically as frosted glass but is
     dramatically cheaper for the RPi's GPU to recompute continuously. */
  backdrop-filter: blur(14px) saturate(1.8);
  -webkit-backdrop-filter: blur(14px) saturate(1.8);
  transform: translateZ(0);`,
        },
      ],
      backupDir
    )
  );

  // ------------------------------------------------------------------
  // 1b. graph.js -- cap the render loop instead of uncapped rAF
  // ------------------------------------------------------------------
  results.push(
    await patchFile(
      GRAPH_JS_PATH,
      [
        {
          label: "throttle the canvas render loop to ~20fps",
          find:
`    let rafId = null;
    function loop() {
      draw();
      rafId = requestAnimationFrame(loop);
    }`,
          replace:
`    // Was calling draw() (full clear + axis + spikes + minimap redraw) on
    // every single requestAnimationFrame tick, unconditionally, forever --
    // an uncapped 60fps+ loop running at all times on both dashboards even
    // when nothing on screen had changed. Capped to ~20fps here: still
    // smooth for panning/zooming/hover, but a large, constant cut to the
    // redraw cost on the RPi.
    const FRAME_INTERVAL_MS = 50;
    let rafId = null;
    let lastDrawAt = 0;
    function loop(now) {
      if (now === undefined || now - lastDrawAt >= FRAME_INTERVAL_MS) {
        lastDrawAt = now || 0;
        draw();
      }
      rafId = requestAnimationFrame(loop);
    }`,
        },
      ],
      backupDir
    )
  );

  // ------------------------------------------------------------------
  // 2. buzzer.js -- fix black video thumbnails
  // ------------------------------------------------------------------
  results.push(
    await patchFile(
      BUZZER_JS_PATH,
      [
        {
          label: "fix black thumbnail on latest-clip strip (seek to 0.1s, not 0)",
          find:
`      <video src="/recordings/${"$"}{filename}" muted loop playsinline preload="metadata"
             onmouseenter="this.play()" onmouseleave="this.pause(); this.currentTime = 0;"></video>
      <span class="gallery-shot-time">${"$"}{timeLabel}</span>
    </div>\`;
  const shot = el.recordingStrip.querySelector(".gallery-shot");`,
          replace:
`      <video src="/recordings/${"$"}{filename}" muted loop playsinline preload="metadata"
             onloadedmetadata="this.currentTime = 0.1"
             onmouseenter="this.play()" onmouseleave="this.pause(); this.currentTime = 0.1;"></video>
      <span class="gallery-shot-time">${"$"}{timeLabel}</span>
    </div>\`;
  const shot = el.recordingStrip.querySelector(".gallery-shot");`,
        },
        {
          label: "fix black thumbnail in the full recordings list (seek to 0.1s, not 0)",
          find:
`          <video src="/recordings/${"$"}{filename}" muted loop playsinline preload="metadata"
                 onmouseenter="this.play()" onmouseleave="this.pause(); this.currentTime = 0;"></video>
          <span class="gallery-shot-time">${"$"}{timeLabel}</span>
        </div>\`;
    })
    .join("");`,
          replace:
`          <video src="/recordings/${"$"}{filename}" muted loop playsinline preload="metadata"
                 onloadedmetadata="this.currentTime = 0.1"
                 onmouseenter="this.play()" onmouseleave="this.pause(); this.currentTime = 0.1;"></video>
          <span class="gallery-shot-time">${"$"}{timeLabel}</span>
        </div>\`;
    })
    .join("");`,
        },
      ],
      backupDir
    )
  );

  // ------------------------------------------------------------------
  // 3. app.py -- burn a timestamp into captured images/video frames
  // ------------------------------------------------------------------
  results.push(
    await patchFile(
      APP_PATH,
      [
        {
          label: "add stamp_timestamp() helper",
          find:
`def capture_frame():
    """Grab a frame from the webcam and save it to disk. Returns the filename."""`,
          replace:
`def stamp_timestamp(frame):
    """Burns the current date/time into the top-right corner of \`frame\`
    (an OpenCV BGR ndarray, modified in place and also returned). Used on
    every captured snapshot and every frame written to a recorded clip,
    so both Fig. 3.1 images and Fig. 3.3 videos carry a visible
    timestamp. Font scale and margin are derived from the frame's own
    width so it looks right regardless of camera resolution."""
    h, w = frame.shape[:2]
    text = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = max(0.45, w / 1280)
    thickness = max(1, round(font_scale * 2))
    (text_w, text_h), baseline = cv2.getTextSize(text, font, font_scale, thickness)
    margin = max(8, round(w * 0.012))
    x = w - text_w - margin
    y = margin + text_h
    # Thin dark outline first so the white text stays readable over any
    # background (bright sky, white walls, etc.), same trick used for the
    # SIMULATE-mode label above.
    cv2.putText(frame, text, (x, y), font, font_scale, (0, 0, 0), thickness + 2, cv2.LINE_AA)
    cv2.putText(frame, text, (x, y), font, font_scale, (255, 255, 255), thickness, cv2.LINE_AA)
    return frame


def capture_frame():
    """Grab a frame from the webcam and save it to disk. Returns the filename."""`,
        },
        {
          label: "stamp the SIMULATE-mode snapshot",
          find:
`    if SIMULATE:
        frame = _simulated_frame(label="CAPTURE")
        cv2.imwrite(filepath, frame)
        return filename

    frame = grab_frame()
    if frame is None:
        return None
    cv2.imwrite(filepath, frame)
    return filename`,
          replace:
`    if SIMULATE:
        frame = _simulated_frame(label="CAPTURE")
        cv2.imwrite(filepath, stamp_timestamp(frame))
        return filename

    frame = grab_frame()
    if frame is None:
        return None
    cv2.imwrite(filepath, stamp_timestamp(frame))
    return filename`,
        },
        {
          label: "stamp each frame of the simulated recorded clip",
          find:
`        while True:
            writer.write(_simulated_frame(label="RECORDING"))
            frame_count += 1`,
          replace:
`        while True:
            writer.write(stamp_timestamp(_simulated_frame(label="RECORDING")))
            frame_count += 1`,
        },
        {
          label: "stamp the first frame of the real recorded clip",
          find:
`    writer = cv2.VideoWriter(
        filepath, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height)
    )
    if not writer.isOpened():
        # OpenCV's mp4v encoder couldn't be opened at all (missing codec
        # support in this build of opencv) -- bail out with a clear log
        # line instead of silently producing an empty/corrupt .mp4 that
        # would just show up black in the browser with no explanation.
        print("record_clip: VideoWriter failed to open -- check OpenCV's video codec support")
        return None
    writer.write(probe)`,
          replace:
`    writer = cv2.VideoWriter(
        filepath, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height)
    )
    if not writer.isOpened():
        # OpenCV's mp4v encoder couldn't be opened at all (missing codec
        # support in this build of opencv) -- bail out with a clear log
        # line instead of silently producing an empty/corrupt .mp4 that
        # would just show up black in the browser with no explanation.
        print("record_clip: VideoWriter failed to open -- check OpenCV's video codec support")
        return None
    writer.write(stamp_timestamp(probe))`,
        },
        {
          label: "stamp each subsequent frame of the real recorded clip",
          find:
`        frame = grab_frame()
        if frame is not None:
            writer.write(frame)
        elapsed_frame = time.time() - loop_start`,
          replace:
`        frame = grab_frame()
        if frame is not None:
            writer.write(stamp_timestamp(frame))
        elapsed_frame = time.time() - loop_start`,
        },
      ],
      backupDir
    )
  );

  const totalApplied = results.reduce((n, r) => n + r.applied, 0);
  const totalMissing = results.reduce((n, r) => n + r.missing, 0);

  console.log(`\n${"-".repeat(60)}`);
  if (totalApplied > 0) {
    console.log(`Applied ${totalApplied} change(s).${dryRun ? " (dry run -- nothing written)" : ""}`);
  }
  if (totalMissing > 0) {
    console.log(
      `${totalMissing} patch location(s) could not be found -- one of the files may have changed since this script was written. Check those spots by hand.`
    );
  }
  if (totalApplied === 0 && totalMissing === 0) {
    console.log(`Already up to date -- nothing to do.`);
  }
  if (!dryRun && totalApplied > 0) {
    console.log(`\nRestart the Flask app (for the app.py/timestamp changes) and hard-refresh both dashboards (for the CSS/JS changes) for everything to take effect.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
