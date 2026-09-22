#!/usr/bin/env node
/**
 * apply-popup-video-logfix.mjs
 * ----------------------------------------------------------------------
 * Fixes five issues in the Perimeter motion-watch dashboard:
 *
 * 1. GRAPH POPUP NOT FULLSCREEN / NOT CENTERED
 *    `.mg-pop` (the fullscreen image/video popup opened by clicking a
 *    spike on the motion graph) lives inside `.motion-graph.glass`.
 *    `.glass` sets `backdrop-filter`, and `backdrop-filter` (like
 *    `transform`/`filter`) creates a new containing block for any
 *    descendant with `position: fixed`. So `.mg-pop`'s `inset: 0` was
 *    resolving against `.motion-graph`'s box instead of the viewport --
 *    it looked squashed into the graph card instead of truly
 *    fullscreen/centered on the page.
 *    Fix: on init, both popup overlays are moved to be direct children
 *    of <body> (in JS), so `position: fixed` is relative to the
 *    viewport again, the way the CSS already intended.
 *
 * 2. MOTION-CAPTURES POPUP: SAME FIX, PLUS CONFIRMS BLUR/CENTER
 *    `.gallery-all-pop` (the "View all" grid) has the identical bug --
 *    it lives inside `.gallery.glass`. Clicking a single gallery
 *    thumbnail already routes through `window.motionGraphOpenPop()`
 *    into the very same `.mg-pop` overlay, so fix #1 covers both the
 *    single-item popup and (once moved to <body>) the "View all" grid.
 *
 * 3. FIG. 3.3 RECORDED CLIP IS JUST BLACK
 *    `record_clip()` writes with the `mp4v` FourCC (MPEG-4 Part 2).
 *    That's the only encoder that reliably works with the stock
 *    `python3-opencv` build on a Raspberry Pi (no libx264), but
 *    browsers' built-in <video> players (Chrome/Firefox/Safari) cannot
 *    decode MPEG-4 Part 2 inside an .mp4 container -- so the <video>
 *    element shows nothing but a black rectangle.
 *    Fix: after writing the raw clip with `mp4v`, transcode it to
 *    H.264 (`ffmpeg -c:v libx264 -pix_fmt yuv420p -movflags +faststart`)
 *    and replace the file. If `ffmpeg` isn't installed or the
 *    transcode fails, the original mp4v file is kept as a fallback
 *    (still saved to disk, just not guaranteed playable in-browser)
 *    and a warning is printed -- so this never turns a working capture
 *    into a missing one.
 *    On the Pi:  sudo apt install ffmpeg
 *
 * 4. FIG. 3.1 EVENTS ALSO APPEARING IN FIG. 3.3'S LOG (AND VICE VERSA)
 *    Both dashboards' side-panel Event Log rendered `data.events` from
 *    the *same* shared `/api/status` payload / `event_log` deque, so a
 *    3.1 snapshot event and a 3.3 recording event were indistinguishable
 *    entries in one shared list -- both pages showed both.
 *    Fix: the snapshot (3.1) and recording (3.3) events are now kept in
 *    two separate logs (`event_log` for 3.1, `recording_event_log` for
 *    3.3). `/api/status` accepts `?page=camera` or `?page=buzzer` and
 *    returns only that page's own log; camera.js/buzzer.js pass their
 *    page name. The unified motion-timeline graph (`/api/events`, used
 *    by both pages' canvas chart) is unaffected -- it already merges
 *    image+video by shared timestamp stamp and keeps doing so.
 *
 * 5. LOGS RESET AFTER RESTARTING THE SYSTEM
 *    `event_log`, `recording_event_log` and `reading_log` were plain
 *    in-memory deques -- gone the moment the process restarted, so the
 *    graph and event logs came back empty.
 *    Fix: all three are now mirrored to a JSON file
 *    (`data/state_log.json`) after every update, and reloaded from that
 *    file at startup. A short debounce (0.5s) coalesces bursts of
 *    writes (e.g. the once-per-second reading_log ticks) into a single
 *    disk write instead of one per poll.
 *
 * Touches: app.py, static/graph.js, static/camera.js, static/buzzer.js
 *
 * Usage:
 *   node apply-popup-video-logfix.mjs             # run from repo root
 *   node apply-popup-video-logfix.mjs --dry-run   # preview only
 *   node apply-popup-video-logfix.mjs --root /path/to/ACT3embedd
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

const APP_PY_PATH = path.join(projectRoot, "app.py");
const GRAPH_JS_PATH = path.join(projectRoot, "static", "graph.js");
const CAMERA_JS_PATH = path.join(projectRoot, "static", "camera.js");
const BUZZER_JS_PATH = path.join(projectRoot, "static", "buzzer.js");

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
const BACKUP_DIR = path.join(projectRoot, "backup", timestamp());

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
// app.py replacements
// ---------------------------------------------------------------------

const APP_PY_REPLACEMENTS = [
  // -- imports: subprocess (ffmpeg transcode) + json (log persistence) --
  {
    label: "imports: add subprocess + json",
    find: `import os
import time
import threading
from datetime import datetime
from collections import deque`,
    replace: `import os
import io
import json
import time
import shutil
import subprocess
import threading
from datetime import datetime
from collections import deque`,
  },

  // -- config: persistence file path --
  {
    label: "config: STATE_LOG_PATH for persisted event/reading history",
    find: `CAPTURE_DIR = os.path.join(os.path.dirname(__file__), "captures")
RECORDING_DIR = os.path.join(os.path.dirname(__file__), "recordings")`,
    replace: `CAPTURE_DIR = os.path.join(os.path.dirname(__file__), "captures")
RECORDING_DIR = os.path.join(os.path.dirname(__file__), "recordings")
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
STATE_LOG_PATH = os.path.join(DATA_DIR, "state_log.json")  # persists event_log /
                             # recording_event_log / reading_log across restarts`,
  },
  {
    label: "makedirs: add DATA_DIR",
    find: `os.makedirs(CAPTURE_DIR, exist_ok=True)
os.makedirs(RECORDING_DIR, exist_ok=True)`,
    replace: `os.makedirs(CAPTURE_DIR, exist_ok=True)
os.makedirs(RECORDING_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)`,
  },

  // -- state: split event_log into per-page logs, wire up recording_log
  //    as the real Fig. 3.3 log, and load persisted history at startup --
  {
    label: "state: event_log (3.1) / recording_event_log (3.3) split + persisted load",
    find: `event_log = deque(maxlen=EVENT_HISTORY_LIMIT)
reading_log = deque(maxlen=READING_HISTORY_LIMIT)     # [{time, motion}] for the Fig. 3.3 graph
recording_log = deque(maxlen=EVENT_HISTORY_LIMIT)      # Fig. 3.3's own event history (video clips)`,
    replace: `# Fig. 3.1 (snapshot) and Fig. 3.3 (recording) each get their OWN event log now --
# previously both dashboards read the same \`event_log\` via /api/status, so a 3.1
# capture event showed up in 3.3's side panel and vice versa. /api/events (the
# unified motion-timeline graph both pages share) still merges the two by their
# shared motion_YYYYMMDD_HHMMSS stamp, so the graph itself is unaffected.
event_log = deque(maxlen=EVENT_HISTORY_LIMIT)              # Fig. 3.1 -- snapshot events
recording_event_log = deque(maxlen=EVENT_HISTORY_LIMIT)    # Fig. 3.3 -- recording events
reading_log = deque(maxlen=READING_HISTORY_LIMIT)          # [{time, motion}] for the graph
log_lock = threading.Lock()      # guards STATE_LOG_PATH read/write
_save_timer = None                # debounce handle for persist_state_log()


def load_state_log():
    """Restores event_log / recording_event_log / reading_log (and the
    total/recording event counters) from disk, if a previous run saved
    one. Called once at import time, before the sensor loop starts, so
    the dashboard's graph and event logs don't come back empty after a
    restart."""
    if not os.path.exists(STATE_LOG_PATH):
        return
    try:
        with open(STATE_LOG_PATH, "r", encoding="utf-8") as f:
            saved = json.load(f)
    except (OSError, ValueError) as exc:
        print(f"Could not load persisted state log ({exc}); starting fresh.")
        return

    for item in saved.get("event_log", []):
        event_log.append(item)
    event_log.reverse()  # appendleft order -> stored newest-first -> restore order
    for item in saved.get("recording_event_log", []):
        recording_event_log.append(item)
    recording_event_log.reverse()
    for item in saved.get("reading_log", []):
        reading_log.append(item)

    system_state["total_events"] = saved.get("total_events", 0)
    system_state["total_recording_events"] = saved.get("total_recording_events", 0)


def persist_state_log():
    """Writes event_log / recording_event_log / reading_log to disk so a
    system restart doesn't wipe the graph and event-log history. Debounced
    by 0.5s so a burst of calls (e.g. the once-per-second reading_log tick)
    collapses into a single disk write instead of one per update."""
    global _save_timer

    def _write():
        with log_lock:
            with state_lock:
                total_events = system_state.get("total_events", 0)
                total_recording_events = system_state.get("total_recording_events", 0)
            payload = {
                "event_log": list(event_log),
                "recording_event_log": list(recording_event_log),
                "reading_log": list(reading_log),
                "total_events": total_events,
                "total_recording_events": total_recording_events,
            }
            tmp_path = STATE_LOG_PATH + ".tmp"
            try:
                with open(tmp_path, "w", encoding="utf-8") as f:
                    json.dump(payload, f)
                os.replace(tmp_path, STATE_LOG_PATH)
            except OSError as exc:
                print(f"Could not persist state log: {exc}")

    if _save_timer is not None:
        _save_timer.cancel()
    _save_timer = threading.Timer(0.5, _write)
    _save_timer.daemon = True
    _save_timer.start()


load_state_log()`,
  },
  {
    label: "state: add total_recording_events counter",
    find: `    "total_events": 0,
    "camera_ok": False,`,
    replace: `    "total_events": 0,
    "total_recording_events": 0,
    "camera_ok": False,`,
  },

  // -- record_clip(): transcode mp4v -> H.264 after writing so the clip
  //    actually plays in-browser instead of showing up black --
  {
    label: "record_clip(): transcode SIMULATE-path clip to H.264 after writing",
    find: `            if elapsed >= seconds and not _motion_still_active():
                break
        writer.release()
        return filename

    if camera is None:
        return None`,
    replace: `            if elapsed >= seconds and not _motion_still_active():
                break
        writer.release()
        transcode_to_h264(filepath)
        return filename

    if camera is None:
        return None`,
  },
  {
    label: "record_clip(): transcode real-camera-path clip to H.264 after writing",
    find: `        if elapsed_total >= seconds and not _motion_still_active():
            break

    writer.release()
    return filename`,
    replace: `        if elapsed_total >= seconds and not _motion_still_active():
            break

    writer.release()
    transcode_to_h264(filepath)
    return filename`,
  },
  {
    label: "add transcode_to_h264() helper (fixes black/undecodable Fig. 3.3 clips)",
    find: `def record_clip(seconds=RECORDING_SECONDS, fps=RECORDING_FPS):`,
    replace: `def transcode_to_h264(filepath):
    """OpenCV's VideoWriter is given the 'mp4v' FourCC (MPEG-4 Part 2) --
    on a Raspberry Pi, \`python3-opencv\` from apt is built without an
    H.264 encoder, so mp4v is the one FourCC that reliably opens and
    writes there. The problem: browsers' built-in <video> players
    (Chrome, Firefox, Safari) can't decode MPEG-4 Part 2 inside an .mp4
    container, so the recorded clip plays back as solid black even
    though the file itself is a valid, non-empty video.

    This re-encodes the just-written clip to H.264 (widely supported by
    every browser) via the \`ffmpeg\` CLI, in place. If ffmpeg isn't
    installed or the transcode fails for any reason, the original mp4v
    file is left untouched (still saved, just not guaranteed to preview
    correctly in-browser) rather than losing the capture.
    """
    if shutil.which("ffmpeg") is None:
        print("ffmpeg not found -- leaving clip as mp4v (install with: sudo apt install ffmpeg)")
        return
    tmp_path = filepath + ".h264.mp4"
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-i", filepath,
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-preset", "veryfast", "-crf", "23",
                "-movflags", "+faststart",
                "-an",
                tmp_path,
            ],
            capture_output=True,
            timeout=60,
        )
        if result.returncode == 0 and os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 0:
            os.replace(tmp_path, filepath)
        else:
            print(f"ffmpeg transcode failed (code {result.returncode}): {result.stderr.decode(errors='replace')[:300]}")
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
    except (subprocess.SubprocessError, OSError) as exc:
        print(f"ffmpeg transcode error: {exc}")
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def record_clip(seconds=RECORDING_SECONDS, fps=RECORDING_FPS):`,
  },

  // -- record_clip_async(): log into recording_event_log (3.3's own log),
  //    bump its own counter, and persist --
  {
    label: "record_clip_async(): log into recording_event_log instead of the unused recording_log",
    find: `        filename = record_clip(seconds=seconds)
        with state_lock:
            system_state["recording_active"] = False
            if filename:
                system_state["last_recording_file"] = filename
        if filename:
            recording_log.appendleft({
                "timestamp": datetime.now().isoformat(timespec="seconds"),
                "file": filename,
            })`,
    replace: `        filename = record_clip(seconds=seconds)
        with state_lock:
            system_state["recording_active"] = False
            if filename:
                system_state["last_recording_file"] = filename
                system_state["total_recording_events"] += 1
        if filename:
            recording_event_log.appendleft({
                "timestamp": datetime.now().isoformat(timespec="seconds"),
                "file": filename,
            })
            persist_state_log()`,
  },

  // -- sensor_loop(): persist after every reading_log/event_log update --
  {
    label: "sensor_loop(): persist reading_log tick",
    find: `            reading_log.append({
                "t": datetime.now().isoformat(timespec="seconds"),
                "motion": is_motion_now,
            })`,
    replace: `            reading_log.append({
                "t": datetime.now().isoformat(timespec="seconds"),
                "motion": is_motion_now,
            })
            persist_state_log()`,
  },
  {
    label: "sensor_loop(): persist after a new Fig. 3.1 event is logged",
    find: `                event_log.appendleft(event)
                print(f"[{event['timestamp']}] Motion detected -> {filename} (buzzer sounded, recording >= {RECORDING_SECONDS}s clip)")`,
    replace: `                event_log.appendleft(event)
                persist_state_log()
                print(f"[{event['timestamp']}] Motion detected -> {filename} (buzzer sounded, recording >= {RECORDING_SECONDS}s clip)")`,
  },

  // -- /api/status: accept ?page= and return that page's own log only --
  {
    label: "/api/status: split events by ?page=camera|buzzer instead of one shared log",
    find: `@app.route("/api/status")
def api_status():
    with state_lock:
        payload = dict(system_state)
    payload["events"] = list(event_log)[:20]
    return jsonify(payload)`,
    replace: `@app.route("/api/status")
def api_status():
    """\`?page=camera\` (Fig. 3.1) returns only snapshot events; \`?page=buzzer\`
    (Fig. 3.3) returns only recording events -- previously both dashboards
    read the same shared log here, so a 3.1 event showed up in 3.3's panel
    and vice versa. No \`page\` param falls back to the Fig. 3.1 log, for
    backward compatibility with anything else still calling this route."""
    from flask import request
    page = request.args.get("page", "camera")
    with state_lock:
        payload = dict(system_state)
    if page == "buzzer":
        payload["events"] = list(recording_event_log)[:20]
        payload["total_events_for_page"] = payload.get("total_recording_events", 0)
    else:
        payload["events"] = list(event_log)[:20]
        payload["total_events_for_page"] = payload.get("total_events", 0)
    return jsonify(payload)`,
  },

  // -- /api/events: merge BOTH logs for the unified graph (previously
  //    only read event_log, so a video-only edge case would be missed) --
  {
    label: "/api/events: merge event_log + recording_event_log by shared timestamp",
    find: `    cutoff = time.time() - 24 * 3600
    with state_lock:
        events_snapshot = list(event_log)

    out = []
    for evt in events_snapshot:
        try:
            dt = datetime.fromisoformat(evt["timestamp"])
        except (KeyError, ValueError):
            continue
        ts = dt.timestamp()
        if ts < cutoff:
            continue

        image_file = evt.get("file")
        stamp = None
        if image_file and image_file.startswith("motion_") and image_file.endswith(".jpg"):
            stamp = image_file[len("motion_"):-len(".jpg")]

        video_file = None
        if stamp:
            candidate = f"motion_{stamp}.mp4"
            if os.path.exists(os.path.join(RECORDING_DIR, candidate)):
                video_file = candidate

        out.append({
            "t": dt.strftime("%H:%M:%S"),
            "ts": ts,
            "file_image": image_file if image_file and os.path.exists(os.path.join(CAPTURE_DIR, image_file)) else None,
            "file_video": video_file,
        })

    out.sort(key=lambda e: e["ts"])
    return jsonify({"events": out})`,
    replace: `    cutoff = time.time() - 24 * 3600
    with state_lock:
        image_events = list(event_log)
        video_events = list(recording_event_log)

    # Fig. 3.1 (snapshot) and Fig. 3.3 (recording) now log independently
    # (see /api/status), so the graph merges both by their shared
    # motion_YYYYMMDD_HHMMSS stamp to keep showing one unified timeline
    # with both an image and a video attached to the same trigger moment.
    by_stamp = {}

    def stamp_of(filename, ext):
        if filename and filename.startswith("motion_") and filename.endswith(ext):
            return filename[len("motion_"):-len(ext)]
        return None

    for evt in image_events:
        try:
            dt = datetime.fromisoformat(evt["timestamp"])
        except (KeyError, ValueError):
            continue
        ts = dt.timestamp()
        if ts < cutoff:
            continue
        image_file = evt.get("file")
        stamp = stamp_of(image_file, ".jpg") or evt["timestamp"]
        entry = by_stamp.setdefault(stamp, {"t": dt.strftime("%H:%M:%S"), "ts": ts, "file_image": None, "file_video": None})
        if image_file and os.path.exists(os.path.join(CAPTURE_DIR, image_file)):
            entry["file_image"] = image_file

    for evt in video_events:
        try:
            dt = datetime.fromisoformat(evt["timestamp"])
        except (KeyError, ValueError):
            continue
        ts = dt.timestamp()
        if ts < cutoff:
            continue
        video_file = evt.get("file")
        stamp = stamp_of(video_file, ".mp4") or evt["timestamp"]
        entry = by_stamp.setdefault(stamp, {"t": dt.strftime("%H:%M:%S"), "ts": ts, "file_image": None, "file_video": None})
        if video_file and os.path.exists(os.path.join(RECORDING_DIR, video_file)):
            entry["file_video"] = video_file
        # a stamp that only has a video event so far still needs its
        # matching snapshot filled in if one exists on disk
        if entry["file_image"] is None:
            candidate = f"motion_{stamp}.jpg"
            if os.path.exists(os.path.join(CAPTURE_DIR, candidate)):
                entry["file_image"] = candidate

    # and an image-only entry still needs its matching clip filled in
    for stamp, entry in by_stamp.items():
        if entry["file_video"] is None:
            candidate = f"motion_{stamp}.mp4"
            if os.path.exists(os.path.join(RECORDING_DIR, candidate)):
                entry["file_video"] = candidate

    out = sorted(by_stamp.values(), key=lambda e: e["ts"])
    return jsonify({"events": out})`,
  },
];

// ---------------------------------------------------------------------
// static/graph.js replacements -- move both popups to <body> so
// position: fixed is relative to the viewport, not a backdrop-filter
// ancestor (fixes #1 and #2)
// ---------------------------------------------------------------------

const GRAPH_JS_REPLACEMENTS = [
  {
    label: "graph.js: move .mg-pop to <body> so it's truly fullscreen/centered, not squashed into the .glass graph card",
    find: `    const pop = root.querySelector(".mg-pop");
    const popFrame = root.querySelector(".mg-pop-frame");
    const popTitle = root.querySelector(".mg-pop-title");
    const popX = root.querySelector(".mg-pop-x");`,
    replace: `    const pop = root.querySelector(".mg-pop");
    const popFrame = root.querySelector(".mg-pop-frame");
    const popTitle = root.querySelector(".mg-pop-title");
    const popX = root.querySelector(".mg-pop-x");

    // .mg-pop is authored as position:fixed + inset:0 so it's fullscreen
    // and centered over the whole page with a blurred backdrop. But its
    // ancestor .motion-graph carries the .glass recipe, which sets
    // backdrop-filter -- and backdrop-filter (like transform/filter)
    // creates a new containing block for fixed-position descendants, so
    // inset:0 was resolving against the graph card's box instead of the
    // viewport. Re-parenting the popup onto <body> restores true
    // viewport-relative fullscreen/centered/blurred behavior.
    if (pop && pop.parentElement !== document.body) {
      document.body.appendChild(pop);
    }`,
  },
];

// ---------------------------------------------------------------------
// static/camera.js replacements -- same body re-parent for the
// gallery's "View all" popup, plus ?page=camera on /api/status
// ---------------------------------------------------------------------

const CAMERA_JS_REPLACEMENTS = [
  {
    label: "camera.js: re-parent .gallery-all-pop onto <body> (same fullscreen/centered/blurred fix as the graph popup)",
    find: `if (el.galleryViewAllBtn) {
  el.galleryViewAllBtn.addEventListener("click", () => {`,
    replace: `// .gallery-all-pop has the same fixed+inset:0 vs. backdrop-filter
// containing-block issue as .mg-pop in graph.js -- it lives inside
// .gallery.glass, so it rendered squashed into that card instead of
// truly fullscreen/centered over the page. Re-parent it onto <body>.
if (el.galleryAllPop && el.galleryAllPop.parentElement !== document.body) {
  document.body.appendChild(el.galleryAllPop);
}

if (el.galleryViewAllBtn) {
  el.galleryViewAllBtn.addEventListener("click", () => {`,
  },
  {
    label: "camera.js: /api/status -> /api/status?page=camera (Fig. 3.1's own event log, not the shared one)",
    find: `    const res = await fetch("/api/status", { cache: "no-store", signal: statusAbort.signal });`,
    replace: `    const res = await fetch("/api/status?page=camera", { cache: "no-store", signal: statusAbort.signal });`,
  },
];

// ---------------------------------------------------------------------
// static/buzzer.js replacements -- same body re-parent for the
// recordings' "View all" popup, plus ?page=buzzer on /api/status
// ---------------------------------------------------------------------

const BUZZER_JS_REPLACEMENTS = [
  {
    label: "buzzer.js: re-parent .gallery-all-pop (#recordingAllPop) onto <body> (same fullscreen/centered/blurred fix as the graph popup)",
    find: `if (el.recordingViewAllBtn) {
  el.recordingViewAllBtn.addEventListener("click", () => {`,
    replace: `// .gallery-all-pop (#recordingAllPop) has the same fixed+inset:0 vs.
// backdrop-filter containing-block issue as .mg-pop in graph.js -- it
// lives inside .gallery.glass, so it rendered squashed into that card
// instead of truly fullscreen/centered over the page. Re-parent it onto
// <body>.
if (el.recordingAllPop && el.recordingAllPop.parentElement !== document.body) {
  document.body.appendChild(el.recordingAllPop);
}

if (el.recordingViewAllBtn) {
  el.recordingViewAllBtn.addEventListener("click", () => {`,
  },
  {
    label: "buzzer.js: /api/status -> /api/status?page=buzzer (Fig. 3.3's own event log, not the shared one)",
    find: `    const res = await fetch("/api/status", { cache: "no-store", signal: statusAbort.signal });`,
    replace: `    const res = await fetch("/api/status?page=buzzer", { cache: "no-store", signal: statusAbort.signal });`,
  },
];

// ---------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------

async function main() {
  console.log(`Perimeter patch: popup fullscreen/centering, Fig. 3.3 black video, per-page logs, log persistence`);
  console.log(`Project root: ${projectRoot}${dryRun ? "  (dry run -- no files will be changed)" : ""}`);

  const results = [];
  results.push(["app.py", await patchFile(APP_PY_PATH, APP_PY_REPLACEMENTS, BACKUP_DIR)]);
  results.push(["static/graph.js", await patchFile(GRAPH_JS_PATH, GRAPH_JS_REPLACEMENTS, BACKUP_DIR)]);
  results.push(["static/camera.js", await patchFile(CAMERA_JS_PATH, CAMERA_JS_REPLACEMENTS, BACKUP_DIR)]);
  results.push(["static/buzzer.js", await patchFile(BUZZER_JS_PATH, BUZZER_JS_REPLACEMENTS, BACKUP_DIR)]);

  console.log("\n----------------------------------------------------------------------");
  let totalApplied = 0, totalAlready = 0, totalMissing = 0;
  for (const [name, r] of results) {
    console.log(`${name}: ${r.applied} applied, ${r.alreadyPresent} already present, ${r.missing} missing`);
    totalApplied += r.applied;
    totalAlready += r.alreadyPresent;
    totalMissing += r.missing;
  }

  if (totalMissing > 0) {
    console.log(
      `\n${totalMissing} replacement(s) could not be located -- the source file may already\n` +
      `differ from what this patch expects. Check the messages above; anything already\n` +
      `applied or unaffected is safe, but a "could not locate" on a change you still\n` +
      `need means it should be applied by hand.`
    );
  }

  if (!dryRun && totalApplied > 0) {
    console.log(
      `\nDone. Restart the app for the app.py changes to take effect:\n` +
      `  python3 app.py\n` +
      `(or MOTION_SIM=1 python3 app.py to test without hardware)\n\n` +
      `If Fig. 3.3 clips are still black after this, install ffmpeg on the Pi:\n` +
      `  sudo apt install ffmpeg\n` +
      `(existing clips already on disk from before this patch stay as mp4v and\n` +
      `won't be retroactively fixed -- only new recordings are transcoded.)`
    );
  } else if (!dryRun) {
    console.log(`\nNo changes were applied (see notes above).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
