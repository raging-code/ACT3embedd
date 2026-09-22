#!/usr/bin/env node
/**
 * apply-fig-scope-livefeed-fix.mjs
 * ----------------------------------------------------------------------
 * Fixes three related Fig. 3.1 / Fig. 3.3 issues:
 *
 * 1. FIG. 3.1 WAS ALSO SOUNDING THE BUZZER AND RECORDING VIDEO
 *    `sensor_loop()` in app.py fired `sound_buzzer()` and
 *    `record_clip_async()` on every motion trigger, unconditionally --
 *    it had no idea whether anyone was even looking at the Fig. 3.3
 *    dashboard. So being on Fig. 3.1 (camera.html, which should only
 *    ever take a snapshot) still sounded the buzzer and wrote entries
 *    into Fig. 3.3's own recording log.
 *    Fix: each dashboard's poll loop already hits `/api/status?page=...`
 *    about once a second. That's now used as a heartbeat -- the server
 *    remembers when each page was last polled, and the sensor loop only
 *    fires the buzzer + video recording when the Fig. 3.3 (buzzer.html)
 *    tab has been polled within the last `PAGE_ACTIVE_TIMEOUT` seconds.
 *    Fig. 3.1 still gets its snapshot + event-log entry exactly as
 *    before, every time, regardless of which page is open.
 *
 * 2. FIG. 3.3 HAD NO LIVE CAMERA FEED
 *    buzzer.html only showed the sensor-reading graph and the recorded
 *    clip strip -- no `<img src="/video_feed">` at all, unlike
 *    camera.html. Fix: the same live-feed frame markup, CSS and JS
 *    wiring camera.html/camera.js already use is added to
 *    buzzer.html/buzzer.js, plus a red "REC" badge that lights up
 *    specifically while a motion-triggered clip is being written, so
 *    it's obvious the feed itself is alive and what state it's in.
 *
 * 3. FIG. 3.3 RECORDED CLIP PLAYS BACK BLACK
 *    app.py already re-encodes the raw `mp4v` clip to H.264 via the
 *    `ffmpeg` CLI (see transcode_to_h264()) because browsers can't
 *    decode MPEG-4 Part 2 in an .mp4 container. That fix silently does
 *    nothing if `ffmpeg` isn't installed on the Pi -- it only prints a
 *    line to the server's console, which is easy to miss. This patch:
 *      - checks for `ffmpeg` at startup and logs a loud one-time warning
 *        if it's missing (`sudo apt install ffmpeg`)
 *      - exposes that as `ffmpeg_available` in `/api/status`, and
 *        buzzer.js surfaces it directly in the dashboard's buzzer-hint
 *        text so it's visible without checking server logs
 *      - hardens record_clip() to check `VideoWriter.isOpened()` and to
 *        verify the written file is non-empty, logging a clear reason
 *        and returning None instead of quietly producing a broken clip
 *    This does NOT reproduce your OpenCV/ffmpeg environment, so it
 *    can't guarantee playback -- if `ffmpeg` genuinely isn't installed
 *    on your Pi, install it and re-test:  sudo apt install ffmpeg
 *
 * Changes:
 *   app.py            - PAGE_ACTIVE_TIMEOUT config, page-heartbeat
 *                        tracking, sensor_loop() gating, ffmpeg-presence
 *                        check + system_state field, record_clip()
 *                        hardening
 *   templates/buzzer.html - live-feed frame + REC badge markup
 *   static/buzzer.js  - live-feed wiring, REC badge toggle, ffmpeg-
 *                        missing hint text
 *   static/style.css  - .rec-tag / .rec-dot styles
 *
 * Usage:
 *   node apply-fig-scope-livefeed-fix.mjs             # run from the repo root
 *   node apply-fig-scope-livefeed-fix.mjs --dry-run   # preview only, writes nothing
 *   node apply-fig-scope-livefeed-fix.mjs --root /path/to/ACT3embedd
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
const BUZZER_HTML_PATH = path.join(projectRoot, "templates", "buzzer.html");
const BUZZER_JS_PATH = path.join(projectRoot, "static", "buzzer.js");
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

  console.log(`Perimeter -- Fig. 3.1/3.3 scope + live-feed + video-diagnostics fix`);
  console.log(`root: ${projectRoot}`);
  if (dryRun) console.log(`(dry run -- no files will be written)`);

  // ------------------------------------------------------------------
  // app.py
  // ------------------------------------------------------------------
  const appResult = await patchFile(
    APP_PATH,
    [
      {
        label: "add PAGE_ACTIVE_TIMEOUT config",
        find:
`COOLDOWN_SECONDS = 5        # unused by the sensor loop now -- captures are edge-
                             # triggered (once per idle->motion transition) instead of
                             # cooldown-gated; kept in case other code references it
EVENT_HISTORY_LIMIT = 100   # how many past events to keep in memory`,
        replace:
`COOLDOWN_SECONDS = 5        # unused by the sensor loop now -- captures are edge-
                             # triggered (once per idle->motion transition) instead of
                             # cooldown-gated; kept in case other code references it
PAGE_ACTIVE_TIMEOUT = 10    # seconds since a dashboard's last /api/status poll
                             # before it's considered "not being watched" -- gates
                             # the buzzer/video recording (Fig. 3.3-only) so they
                             # don't fire while someone's on the Fig. 3.1 tab
EVENT_HISTORY_LIMIT = 100   # how many past events to keep in memory`,
      },
      {
        label: "log a startup warning if ffmpeg is missing",
        find:
`os.makedirs(CAPTURE_DIR, exist_ok=True)
os.makedirs(RECORDING_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)`,
        replace:
`os.makedirs(CAPTURE_DIR, exist_ok=True)
os.makedirs(RECORDING_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)

if shutil.which("ffmpeg") is None:
    print(
        "WARNING: ffmpeg not found on PATH -- Fig. 3.3 recorded clips will be "
        "saved but will likely play back as a black rectangle in the browser "
        "(see transcode_to_h264()). Install it with: sudo apt install ffmpeg"
    )`,
      },
      {
        label: "expose ffmpeg_available in system_state",
        find:
`    "recording_active": False,
    "last_recording_file": None,
    "started_at": datetime.now().isoformat(timespec="seconds"),
}`,
        replace:
`    "recording_active": False,
    "last_recording_file": None,
    "ffmpeg_available": shutil.which("ffmpeg") is not None,
    "started_at": datetime.now().isoformat(timespec="seconds"),
}`,
      },
      {
        label: "add per-page heartbeat tracking (page_last_seen / is_page_active)",
        find:
`log_lock = threading.Lock()      # guards STATE_LOG_PATH read/write
_save_timer = None                # debounce handle for persist_state_log()`,
        replace:
`log_lock = threading.Lock()      # guards STATE_LOG_PATH read/write
_save_timer = None                # debounce handle for persist_state_log()

# Which dashboard(s) are actively being polled right now, so the sensor
# loop knows whether it's safe to fire the buzzer / start a recording.
# Fig. 3.1 (camera.html) should only ever produce a snapshot + log entry;
# the buzzer and 5s video clip are a Fig. 3.3 (buzzer.html)-only behavior.
# Each dashboard's poll loop hits /api/status?page=... roughly once a
# second, so "last seen within PAGE_ACTIVE_TIMEOUT" is a reliable proxy
# for "that tab is currently open".
page_activity_lock = threading.Lock()
page_last_seen = {"camera": 0.0, "buzzer": 0.0}


def note_page_seen(page):
    if page not in page_last_seen:
        return
    with page_activity_lock:
        page_last_seen[page] = time.time()


def is_page_active(page, timeout=PAGE_ACTIVE_TIMEOUT):
    with page_activity_lock:
        last_seen = page_last_seen.get(page, 0.0)
    return (time.time() - last_seen) <= timeout`,
      },
      {
        label: "record the heartbeat on every /api/status poll",
        find:
`    from flask import request
    page = request.args.get("page", "camera")
    with state_lock:
        payload = dict(system_state)`,
        replace:
`    from flask import request
    page = request.args.get("page", "camera")
    note_page_seen(page)  # heartbeat: this dashboard is (still) open
    with state_lock:
        payload = dict(system_state)`,
      },
      {
        label: "harden the simulated-clip VideoWriter (isOpened check)",
        find:
`        writer = cv2.VideoWriter(
            filepath, cv2.VideoWriter_fourcc(*"mp4v"), fps, (640, 480)
        )
        frame_interval = 1 / fps`,
        replace:
`        writer = cv2.VideoWriter(
            filepath, cv2.VideoWriter_fourcc(*"mp4v"), fps, (640, 480)
        )
        if not writer.isOpened():
            print("record_clip: VideoWriter failed to open (simulated clip)")
            return None
        frame_interval = 1 / fps`,
      },
      {
        label: "harden the real-camera VideoWriter (isOpened check)",
        find:
`    height, width = probe.shape[:2]
    writer = cv2.VideoWriter(
        filepath, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height)
    )
    writer.write(probe)`,
        replace:
`    height, width = probe.shape[:2]
    writer = cv2.VideoWriter(
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
      },
      {
        label: "verify the simulated clip isn't empty before returning it",
        find:
`        writer.release()
        transcode_to_h264(filepath)
        return filename`,
        replace:
`        writer.release()
        transcode_to_h264(filepath)
        if not os.path.exists(filepath) or os.path.getsize(filepath) == 0:
            print(f"record_clip: {filename} ended up empty -- something went wrong writing it")
            return None
        return filename`,
      },
      {
        label: "verify the real-camera clip isn't empty before returning it",
        find:
`    writer.release()
    transcode_to_h264(filepath)
    return filename`,
        replace:
`    writer.release()
    transcode_to_h264(filepath)
    if not os.path.exists(filepath) or os.path.getsize(filepath) == 0:
        print(f"record_clip: {filename} ended up empty -- something went wrong writing it")
        return None
    return filename`,
      },
      {
        label: "gate the buzzer + recording behind is_page_active('buzzer')",
        find:
`                motion_active = True
                filename = capture_frame()
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
                print(f"[{event['timestamp']}] Motion detected -> {filename} (buzzer sounded, recording >= {RECORDING_SECONDS}s clip)")`,
        replace:
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
      },
    ],
    backupDir
  );

  // ------------------------------------------------------------------
  // templates/buzzer.html
  // ------------------------------------------------------------------
  const buzzerHtmlResult = await patchFile(
    BUZZER_HTML_PATH,
    [
      {
        label: "add the live-feed frame (+ REC badge) between the motion graph and the recordings gallery",
        find:
`      </section>

      <div class="gallery glass" id="recordingGallery">`,
        replace:
`      </section>

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
        <div class="feed-tag rec-tag" id="recTag">
          <span class="rec-dot"></span>REC
        </div>
      </div>
      <div class="feed-caption">
        <span>Live camera feed</span>
        <span class="feed-caption-sep">·</span>
        <span id="liveResolution">webcam</span>
      </div>

      <div class="gallery glass" id="recordingGallery">`,
      },
    ],
    backupDir
  );

  // ------------------------------------------------------------------
  // static/buzzer.js
  // ------------------------------------------------------------------
  const buzzerJsResult = await patchFile(
    BUZZER_JS_PATH,
    [
      {
        label: "add liveFrame/liveImg/recTag element refs",
        find:
`const el = {
  clock: document.getElementById("clock"),
  pulseDot: document.getElementById("pulse-dot"),
  armToggle: document.getElementById("armToggle"),

  statTotal: document.getElementById("statTotal"),`,
        replace:
`const el = {
  clock: document.getElementById("clock"),
  pulseDot: document.getElementById("pulse-dot"),
  armToggle: document.getElementById("armToggle"),

  liveFrame: document.getElementById("liveFrame"),
  liveImg: document.getElementById("liveImg"),
  recTag: document.getElementById("recTag"),

  statTotal: document.getElementById("statTotal"),`,
      },
      {
        label: "wire up the live-feed load/error listeners (same pattern as camera.js)",
        find:
`  recordingAllClose: document.getElementById("recordingAllClose"),
};

let lastRenderedRecording = null;`,
        replace:
`  recordingAllClose: document.getElementById("recordingAllClose"),
};

// Live stream: mark the frame as "has-image" once the MJPEG stream actually
// loads, and fall back to the empty state if it errors out (e.g. no camera).
// Fig. 3.3 previously had no live view at all -- this is the same wiring
// camera.js (Fig. 3.1) already uses.
el.liveImg.addEventListener("load", () => {
  el.liveFrame.classList.add("has-image");
});
el.liveImg.addEventListener("error", () => {
  el.liveFrame.classList.remove("has-image");
});

let lastRenderedRecording = null;`,
      },
      {
        label: "toggle the REC badge + surface an ffmpeg-missing hint",
        find:
`    // buzzer module + visual
    setModule(el.modBuzzerState, data.buzzer_ok, "ready", "offline");
    el.buzzerVisual.classList.toggle("sounding", !!data.buzzer_active || !!data.recording_active);
    el.buzzerHint.textContent = data.recording_active
      ? "Recording a 5-second clip right now…"
      : "Sounds automatically whenever motion is detected while armed. A 5-second video also records.";`,
        replace:
`    // buzzer module + visual
    setModule(el.modBuzzerState, data.buzzer_ok, "ready", "offline");
    el.buzzerVisual.classList.toggle("sounding", !!data.buzzer_active || !!data.recording_active);
    if (el.recTag) el.recTag.classList.toggle("on", !!data.recording_active);
    const ffmpegMissing = data.ffmpeg_available === false;
    el.buzzerHint.textContent = data.recording_active
      ? "Recording a 5-second clip right now…"
      : ffmpegMissing
        ? "Sounds automatically whenever motion is detected while armed. A 5-second video also records — install ffmpeg on the Pi (sudo apt install ffmpeg) so clips play back correctly in the browser."
        : "Sounds automatically whenever motion is detected while armed. A 5-second video also records.";`,
      },
    ],
    backupDir
  );

  // ------------------------------------------------------------------
  // static/style.css
  // ------------------------------------------------------------------
  const styleResult = await patchFile(
    STYLE_PATH,
    [
      {
        label: "add .rec-tag / .rec-dot styles for the Fig. 3.3 recording badge",
        find:
`@keyframes live-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}`,
        replace:
`@keyframes live-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* Fig. 3.3's live feed additionally shows a REC badge (top-right) while
   a motion-triggered clip is actively being recorded, so the feed reads
   as "camera's live, and yes, it's currently recording" instead of
   looking like nothing is happening. */
.rec-tag {
  left: auto;
  right: 13px;
  display: none;
  align-items: center;
  gap: 7px;
  color: var(--off);
  border-color: rgba(224,133,133,0.35);
  font-weight: 600;
}
.rec-tag.on { display: flex; }

.rec-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--off);
  box-shadow: 0 0 8px 1px rgba(224,133,133,0.6);
  animation: live-pulse 1s ease-in-out infinite;
}`,
      },
    ],
    backupDir
  );

  const totals = [appResult, buzzerHtmlResult, buzzerJsResult, styleResult].reduce(
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
  if (totals.missing > 0) {
    console.log(
      `\nSome anchors weren't found -- this usually means app.py/buzzer.html/buzzer.js/style.css ` +
      `have drifted from the version this patch was written against. Check the "!" lines above.`
    );
  }
}

main().catch((err) => {
  console.error("Patch failed:", err);
  process.exit(1);
});
