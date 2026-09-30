#!/usr/bin/env node
/**
 * fig31-to-video.mjs
 * -------------------
 * Converts Fig. 3.1 (camera.html / camera.js / app.py) from motion-triggered
 * IMAGE capture to motion-triggered VIDEO capture, matching Fig. 3.3's
 * clip-recording behavior — but fully independent of the buzzer/page-active
 * gating Fig. 3.3 uses. Fig. 3.1 keeps recording on every motion trigger,
 * same as its current snapshot behavior, just producing a .mp4 instead of
 * a .jpg.
 *
 * Usage:
 *   node fig31-to-video.mjs /path/to/ACT3embedd
 *
 * Safe to re-run: every edit checks whether it has already been applied
 * and skips itself instead of double-patching or throwing.
 *
 * What changes:
 *   app.py
 *     - new record_clip_camera() / record_clip_camera_async(): records an
 *       .mp4 into CAPTURE_DIR, reusing the same VideoWriter + ffmpeg
 *       transcode path record_clip() already uses for Fig. 3.3.
 *     - sensor_loop(): the Fig. 3.1 trigger now calls
 *       record_clip_camera_async() instead of capture_frame(); the event
 *       log entry is appended once the clip finishes instead of immediately
 *       (recording takes several seconds, so it can't be synchronous the
 *       way a single frame grab was).
 *     - /api/gallery, /captures/<file>, /api/events: now look for .mp4
 *       files in CAPTURE_DIR instead of .jpg/.jpeg/.png.
 *   templates/camera.html
 *     - "Fig 3.1 · image" -> "Fig 3.1 · video"; popup title/copy updated.
 *   static/camera.js
 *     - gallery strip / "view all" popup now render <video> clips (muted,
 *       hover-to-play, same markup pattern as buzzer.js) instead of <img>.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("Usage: node fig31-to-video.mjs /path/to/ACT3embedd");
  process.exit(1);
}

const paths = {
  appPy: join(root, "app.py"),
  cameraHtml: join(root, "templates", "camera.html"),
  cameraJs: join(root, "static", "camera.js"),
};

for (const [name, p] of Object.entries(paths)) {
  if (!existsSync(p)) {
    console.error(`Could not find ${name} at ${p}`);
    process.exit(1);
  }
}

let changesMade = 0;

/** Applies a single find/replace. Warns (does not throw) if `find` isn't
 *  found, since that usually means this patch already ran. Throws only if
 *  `find` matches more than once, since that means our anchor isn't unique
 *  and we could edit the wrong spot. */
function patch(filePath, label, find, replace) {
  const original = readFileSync(filePath, "utf8");
  const count = original.split(find).length - 1;

  if (count === 0) {
    console.log(`  [skip] ${label} (already applied or not found)`);
    return original;
  }
  if (count > 1) {
    throw new Error(
      `${label}: anchor matched ${count} times in ${filePath} -- expected exactly 1. Aborting to avoid a bad edit.`
    );
  }
  const updated = original.replace(find, replace);
  writeFileSync(filePath, updated, "utf8");
  console.log(`  [ok]   ${label}`);
  changesMade++;
  return updated;
}

// ---------------------------------------------------------------------
// app.py
// ---------------------------------------------------------------------
console.log("Patching app.py ...");
{
  let src = readFileSync(paths.appPy, "utf8");

  // 1. Add record_clip_camera() + record_clip_camera_async() right after
  //    capture_frame(), reusing record_clip()'s recording logic but writing
  //    into CAPTURE_DIR as Fig. 3.1's own clip.
  const capture_frame_anchor = `def capture_frame():
    """Grab a frame from the webcam and save it to disk. Returns the filename."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"motion_{timestamp}.jpg"
    filepath = os.path.join(CAPTURE_DIR, filename)

    if SIMULATE:
        frame = _simulated_frame(label="CAPTURE")
        cv2.imwrite(filepath, stamp_timestamp(frame))
        return filename

    frame = grab_frame()
    if frame is None:
        return None
    cv2.imwrite(filepath, stamp_timestamp(frame))
    return filename
`;
  const capture_frame_replacement = `def capture_frame():
    """Grab a frame from the webcam and save it to disk. Returns the filename.
    Superseded by record_clip_camera() for the live motion trigger (Fig. 3.1
    now records video, not a single snapshot) -- kept here in case anything
    else still calls it directly."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"motion_{timestamp}.jpg"
    filepath = os.path.join(CAPTURE_DIR, filename)

    if SIMULATE:
        frame = _simulated_frame(label="CAPTURE")
        cv2.imwrite(filepath, stamp_timestamp(frame))
        return filename

    frame = grab_frame()
    if frame is None:
        return None
    cv2.imwrite(filepath, stamp_timestamp(frame))
    return filename


def record_clip_camera(seconds=RECORDING_SECONDS, fps=RECORDING_FPS):
    """Records a short video clip for Fig. 3.1 by grabbing frames for
    \`seconds\` and writing them out with OpenCV's VideoWriter, the same way
    record_clip() does for Fig. 3.3 -- except this one saves into
    CAPTURE_DIR (Fig. 3.1's own directory) rather than RECORDING_DIR, so the
    two dashboards' clips never mix. Runs on the calling thread -- callers
    that don't want to block should use record_clip_camera_async()."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"motion_{timestamp}.mp4"
    filepath = os.path.join(CAPTURE_DIR, filename)

    def _motion_still_active():
        with state_lock:
            return bool(system_state.get("motion_detected"))

    if SIMULATE:
        writer = cv2.VideoWriter(
            filepath, cv2.VideoWriter_fourcc(*"mp4v"), fps, (640, 480)
        )
        if not writer.isOpened():
            print("record_clip_camera: VideoWriter failed to open (simulated clip)")
            return None
        frame_interval = 1 / fps
        clip_start = time.time()
        while True:
            loop_start = time.time()
            writer.write(stamp_timestamp(_simulated_frame(label="CAPTURE")))
            elapsed_frame = time.time() - loop_start
            time.sleep(max(0.0, frame_interval - elapsed_frame))
            elapsed_total = time.time() - clip_start
            if elapsed_total >= seconds and not _motion_still_active():
                break
        writer.release()
        transcode_to_h264(filepath)
        return filename

    probe = grab_frame()
    if probe is None:
        return None
    h, w = probe.shape[:2]
    writer = cv2.VideoWriter(
        filepath, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h)
    )
    if not writer.isOpened():
        print("record_clip_camera: VideoWriter failed to open -- check OpenCV's video codec support")
        return None
    writer.write(stamp_timestamp(probe))

    frame_interval = 1 / fps
    clip_start = time.time()
    while True:
        loop_start = time.time()
        frame = grab_frame()
        if frame is not None:
            writer.write(stamp_timestamp(frame))
        elapsed_frame = time.time() - loop_start
        time.sleep(max(0.0, frame_interval - elapsed_frame))

        elapsed_total = time.time() - clip_start
        if elapsed_total >= seconds and not _motion_still_active():
            break

    writer.release()
    transcode_to_h264(filepath)
    if not os.path.exists(filepath) or os.path.getsize(filepath) == 0:
        print(f"record_clip_camera: {filename} ended up empty -- something went wrong writing it")
        return None
    return filename


def record_clip_camera_async(on_done, seconds=RECORDING_SECONDS):
    """Fires record_clip_camera() on a background thread so the sensor loop
    isn't blocked for the clip's whole duration, then calls \`on_done(filename)\`
    (filename may be None on failure) once it finishes."""

    def _run():
        filename = record_clip_camera(seconds=seconds)
        on_done(filename)

    threading.Thread(target=_run, daemon=True).start()
`;
  src = (() => {
    const count = src.split(capture_frame_anchor).length - 1;
    if (count === 0) {
      console.log("  [skip] add record_clip_camera()/record_clip_camera_async() (already applied or not found)");
      return src;
    }
    if (count > 1) {
      throw new Error("capture_frame() anchor matched more than once in app.py -- aborting.");
    }
    console.log("  [ok]   add record_clip_camera()/record_clip_camera_async()");
    changesMade++;
    return src.replace(capture_frame_anchor, capture_frame_replacement);
  })();
  writeFileSync(paths.appPy, src, "utf8");

  // 2. sensor_loop(): swap the synchronous capture_frame() call for the
  //    async video recorder, and move the event-log/state update into the
  //    on_done callback since it now completes several seconds later.
  src = patch(
    paths.appPy,
    "sensor_loop(): record video instead of a snapshot on the Fig. 3.1 trigger",
    `                motion_active = True
                filename = capture_frame()

                # Buzzer + video recording are a Fig. 3.3-only behavior --
                # only fire them while someone actually has the buzzer.html
                # dashboard open. Fig. 3.1 (camera.html) still gets its
                # snapshot and event-log entry either way, exactly as before.
                fig33_watching = is_page_active("buzzer")
                if fig33_watching:
                    sound_buzzer()
                    record_clip_async()

                event = {
                    "timestamp": datetime.now().isoformat(timespec="seconds"),
                    "file": filename,
                }
                with state_lock:
                    system_state["motion_detected"] = True
                    system_state["last_motion_at"] = event["timestamp"]
                    system_state["total_events"] += 1
                    if filename:
                        system_state["last_capture_file"] = filename
                event_log.appendleft(event)
                persist_state_log()
                if fig33_watching:
                    print(f"[{event['timestamp']}] Motion detected -> {filename} (buzzer sounded, recording >= {RECORDING_SECONDS}s clip)")
                else:
                    print(f"[{event['timestamp']}] Motion detected -> {filename} (Fig. 3.1 only -- buzzer/recording skipped)")`,
    `                motion_active = True
                trigger_ts = datetime.now().isoformat(timespec="seconds")

                with state_lock:
                    system_state["motion_detected"] = True
                    system_state["last_motion_at"] = trigger_ts

                # Fig. 3.1 now records a motion-triggered video clip (same
                # clip-recording path as Fig. 3.3), independent of the
                # buzzer/page-active gating -- it fires on every trigger
                # the same way the old snapshot capture did. The event log
                # entry is appended once the clip finishes (several
                # seconds later) rather than immediately, since recording
                # is no longer a single synchronous frame grab.
                def _on_camera_clip_done(filename, ts=trigger_ts):
                    event = {"timestamp": ts, "file": filename}
                    with state_lock:
                        system_state["total_events"] += 1
                        if filename:
                            system_state["last_capture_file"] = filename
                    event_log.appendleft(event)
                    persist_state_log()
                    print(f"[{ts}] Motion detected -> {filename} (Fig. 3.1 video clip, >= {RECORDING_SECONDS}s)")

                record_clip_camera_async(_on_camera_clip_done)

                # Buzzer + Fig. 3.3's own recording are unchanged -- only
                # fire while someone actually has the buzzer.html dashboard
                # open.
                if is_page_active("buzzer"):
                    sound_buzzer()
                    record_clip_async()`
  );

  // 3. /api/gallery: list Fig. 3.1's .mp4 clips instead of .jpg/.jpeg/.png.
  patch(
    paths.appPy,
    "/api/gallery: serve .mp4 clips",
    `    files = sorted(
        (f for f in os.listdir(CAPTURE_DIR) if f.lower().endswith((".jpg", ".jpeg", ".png"))),
        reverse=True,
    )[:30]`,
    `    files = sorted(
        (f for f in os.listdir(CAPTURE_DIR) if f.lower().endswith(".mp4")),
        reverse=True,
    )[:30]`
  );

  // 4. /api/events: stamp_of(...) and the on-disk existence check for
  //    Fig. 3.1's image_events now look for .mp4 instead of .jpg.
  patch(
    paths.appPy,
    "/api/events: match Fig. 3.1's clips by .mp4 extension",
    `            image_file = evt.get("file")
            stamp = stamp_of(image_file, ".jpg") or evt["timestamp"]`,
    `            image_file = evt.get("file")
            stamp = stamp_of(image_file, ".mp4") or evt["timestamp"]`
  );
  patch(
    paths.appPy,
    "/api/events: legacy cross-pairing looks for Fig. 3.1's .mp4 clip",
    `            if entry["file_image"] is None:
                candidate = f"motion_{stamp}.jpg"
                if os.path.exists(os.path.join(CAPTURE_DIR, candidate)):
                    entry["file_image"] = candidate`,
    `            if entry["file_image"] is None:
                candidate = f"motion_{stamp}.mp4"
                if os.path.exists(os.path.join(CAPTURE_DIR, candidate)):
                    entry["file_image"] = candidate`
  );
}

// ---------------------------------------------------------------------
// templates/camera.html
// ---------------------------------------------------------------------
console.log("Patching templates/camera.html ...");
patch(
  paths.cameraHtml,
  "header label: 'Fig 3.1 · image' -> 'Fig 3.1 · video'",
  `<span class="mg-seg"><button class="on" disabled title="This dashboard always opens the snapshot">Fig 3.1 · image</button></span>`,
  `<span class="mg-seg"><button class="on" disabled title="This dashboard always opens the recorded clip">Fig 3.1 · video</button></span>`
);
patch(
  paths.cameraHtml,
  "gallery heading: 'Motion captures' -> 'Motion recordings'",
  `<span>Motion captures</span>`,
  `<span>Motion recordings</span>`
);
patch(
  paths.cameraHtml,
  "gallery empty-state copy",
  `<p class="gallery-empty" id="galleryEmpty">Snapshots taken on motion will appear here.</p>`,
  `<p class="gallery-empty" id="galleryEmpty">Clips recorded on motion will appear here.</p>`
);
patch(
  paths.cameraHtml,
  "'all captures' popup heading",
  `<span>All motion captures</span>`,
  `<span>All motion recordings</span>`
);

// ---------------------------------------------------------------------
// static/camera.js
// ---------------------------------------------------------------------
console.log("Patching static/camera.js ...");
patch(
  paths.cameraJs,
  "header comment: clarify Fig. 3.1 now records video",
  `/* Perimeter — Camera Watch (Fig. 3.1-3.2): dashboard logic
   Polls /api/status every second and updates the console in place.`,
  `/* Perimeter — Camera Watch (Fig. 3.1-3.2): dashboard logic
   Fig. 3.1 now records a short motion-triggered VIDEO clip instead of a
   single snapshot (matching Fig. 3.3's clip gallery), independent of the
   buzzer/page-active gating Fig. 3.3 uses for its own recording.
   Polls /api/status every second and updates the console in place.`
);
patch(
  paths.cameraJs,
  "filename regex comment: .jpg -> .mp4 example",
  `  // filenames look like motion_20260918_025309.jpg — pull a readable time out of it`,
  `  // filenames look like motion_20260918_025309.mp4 — pull a readable time out of it`
);
patch(
  paths.cameraJs,
  "renderGallery(): empty-state copy",
  `  if (!files.length) {
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
    </div>\`;`,
  `  if (!files.length) {
    el.galleryStrip.innerHTML =
      '<p class="gallery-empty" id="galleryEmpty">Clips recorded on motion will appear here.</p>';
    return;
  }

  // Only the latest clip is shown inline; the rest are one click away via
  // "View all".
  const filename = files[0];
  const timeLabel = timeLabelFor(filename);
  el.galleryStrip.innerHTML = \`
    <div class="gallery-shot" title="\${filename}">
      <video src="/captures/\${filename}" muted loop playsinline preload="metadata"
             onloadedmetadata="this.currentTime = 0.1"
             onmouseenter="this.play()" onmouseleave="this.pause(); this.currentTime = 0.1;"></video>
      <span class="gallery-shot-time">\${timeLabel}</span>
    </div>\`;`
);
patch(
  paths.cameraJs,
  "renderGalleryAll(): empty-state + row markup",
  `function renderGalleryAll() {
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
    .join("");`,
  `function renderGalleryAll() {
  if (!latestGalleryFiles.length) {
    el.galleryAllList.innerHTML = '<p class="gallery-empty">Clips recorded on motion will appear here.</p>';
    return;
  }
  el.galleryAllList.innerHTML = latestGalleryFiles
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
    .join("");`
);

console.log(`\nDone. ${changesMade} edit(s) applied.`);
if (changesMade === 0) {
  console.log("Nothing changed -- looks like this patch was already applied.");
}
