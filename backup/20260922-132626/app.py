"""
Motion-Triggered Capture System
--------------------------------
PIR motion sensor (Raspberry Pi GPIO) + USB webcam (OpenCV) + Flask web dashboard.

The webcam is streamed live to the dashboard (MJPEG) at all times. When the
PIR sensor detects motion, a frame is additionally grabbed and saved to disk
as a snapshot, and logged in the event history/gallery below the live feed.

Run on the Raspberry Pi:
    python3 app.py

Then visit  http://<raspberry-pi-ip>:5000  from any device on the same network.
"""

import os
import io
import json
import time
import shutil
import subprocess
import threading
from datetime import datetime
from collections import deque

import cv2
from flask import Flask, jsonify, send_from_directory, render_template, Response

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

PIR_PIN = 4                 # BCM GPIO pin connected to the PIR sensor's OUT wire
BUZZER_PIN = 17             # BCM GPIO pin connected to the active buzzer's +/signal wire
BUZZER_ON_SECONDS = 1.5     # how long the buzzer sounds per motion trigger
CAMERA_INDEX = 0            # 0 = first USB webcam; try 1 or 2 if it's not found
CAPTURE_DIR = os.path.join(os.path.dirname(__file__), "captures")
RECORDING_DIR = os.path.join(os.path.dirname(__file__), "recordings")
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
STATE_LOG_PATH = os.path.join(DATA_DIR, "state_log.json")  # persists event_log /
                             # recording_event_log / reading_log across restarts
RECORDING_SECONDS = 10      # MINIMUM length of the Fig. 3.3 motion-triggered video
                             # clip; if motion is still active once this is reached,
                             # recording keeps extending until motion actually clears
RECORDING_FPS = 15          # matches the live stream's frame rate
COOLDOWN_SECONDS = 5        # unused by the sensor loop now -- captures are edge-
                             # triggered (once per idle->motion transition) instead of
                             # cooldown-gated; kept in case other code references it
EVENT_HISTORY_LIMIT = 100   # how many past events to keep in memory
READING_HISTORY_LIMIT = 120 # how many sensor-reading points to keep for the graph
SENSOR_WARMUP_SECONDS = 2   # PIR sensors need a moment to settle after power-on
SIMULATE = os.environ.get("MOTION_SIM", "0") == "1"  # run without real GPIO/camera

os.makedirs(CAPTURE_DIR, exist_ok=True)
os.makedirs(RECORDING_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)

# --------------------------------------------------------------------------
# GPIO setup (falls back to simulation if RPi.GPIO isn't available,
# e.g. when developing/testing on a non-Pi machine)
# --------------------------------------------------------------------------

GPIO_AVAILABLE = False
pir_sensor = None
buzzer_device = None
if not SIMULATE:
    try:
        # gpiozero (lgpio backend) instead of RPi.GPIO: RPi.GPIO only
        # talks to the classic BCM283x GPIO peripheral and does not
        # support the Raspberry Pi 5's RP1 I/O controller -- GPIO.setup()
        # raises there even though the import succeeds. gpiozero picks
        # the right backend for whichever Pi this runs on.
        # queue_len/threshold match the known-working standalone PIR
        # test script: 5 consistent readings before the state flips,
        # smoothing out a noisy sensor.
        from gpiozero import MotionSensor, DigitalOutputDevice
        pir_sensor = MotionSensor(PIR_PIN, queue_len=5, threshold=0.6)
        buzzer_device = DigitalOutputDevice(BUZZER_PIN, initial_value=False)
        GPIO_AVAILABLE = True
    except Exception:
        GPIO_AVAILABLE = False

# --------------------------------------------------------------------------
# Shared state (protected by a lock since the sensor thread and Flask's
# request-handling threads both touch it)
# --------------------------------------------------------------------------

state_lock = threading.Lock()
system_state = {
    "armed": True,
    "motion_detected": False,
    "last_motion_at": None,
    "last_capture_file": None,
    "total_events": 0,
    "total_recording_events": 0,
    "camera_ok": False,
    "sensor_ok": GPIO_AVAILABLE or SIMULATE,
    "buzzer_ok": GPIO_AVAILABLE or SIMULATE,
    "buzzer_active": False,
    "recording_active": False,
    "last_recording_file": None,
    "started_at": datetime.now().isoformat(timespec="seconds"),
}
# Fig. 3.1 (snapshot) and Fig. 3.3 (recording) each get their OWN event log now --
# previously both dashboards read the same `event_log` via /api/status, so a 3.1
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


load_state_log()

# --------------------------------------------------------------------------
# Camera
# --------------------------------------------------------------------------

camera = None
camera_lock = threading.Lock()
latest_frame = None          # most recent raw frame, shared between stream + capture
latest_frame_lock = threading.Lock()


def init_camera():
    global camera
    if SIMULATE:
        with state_lock:
            system_state["camera_ok"] = True
        return
    cam = cv2.VideoCapture(CAMERA_INDEX)
    ok = cam.isOpened()
    with state_lock:
        system_state["camera_ok"] = ok
    camera = cam if ok else None


def _simulated_frame(label="LIVE"):
    import numpy as np
    frame = (np.random.rand(480, 640, 3) * 40).astype("uint8")
    ts = datetime.now().strftime("%H:%M:%S")
    cv2.putText(frame, f"SIMULATED {label} {ts}", (30, 240),
                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (100, 200, 255), 2)
    return frame


def grab_frame():
    """Read one frame from the webcam (or generate a fake one in SIMULATE mode)
    and cache it as the latest frame. Thread-safe: only one caller reads the
    camera at a time, shared between the live-stream generator and captures."""
    global latest_frame
    if SIMULATE:
        frame = _simulated_frame()
        with latest_frame_lock:
            latest_frame = frame
        return frame

    with camera_lock:
        if camera is None:
            return None
        ret, frame = camera.read()
        if not ret:
            return None
    with latest_frame_lock:
        latest_frame = frame
    return frame


def capture_frame():
    """Grab a frame from the webcam and save it to disk. Returns the filename."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"motion_{timestamp}.jpg"
    filepath = os.path.join(CAPTURE_DIR, filename)

    if SIMULATE:
        frame = _simulated_frame(label="CAPTURE")
        cv2.imwrite(filepath, frame)
        return filename

    frame = grab_frame()
    if frame is None:
        return None
    cv2.imwrite(filepath, frame)
    return filename


def transcode_to_h264(filepath):
    """OpenCV's VideoWriter is given the 'mp4v' FourCC (MPEG-4 Part 2) --
    on a Raspberry Pi, `python3-opencv` from apt is built without an
    H.264 encoder, so mp4v is the one FourCC that reliably opens and
    writes there. The problem: browsers' built-in <video> players
    (Chrome, Firefox, Safari) can't decode MPEG-4 Part 2 inside an .mp4
    container, so the recorded clip plays back as solid black even
    though the file itself is a valid, non-empty video.

    This re-encodes the just-written clip to H.264 (widely supported by
    every browser) via the `ffmpeg` CLI, in place. If ffmpeg isn't
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


def record_clip(seconds=RECORDING_SECONDS, fps=RECORDING_FPS):
    """Records a short video clip (Fig. 3.3) by grabbing frames for `seconds`
    and writing them out with OpenCV's VideoWriter. Runs on the calling
    thread — callers that don't want to block should run this in a thread
    (see the sensor loop, which fires it via record_clip_async)."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"motion_{timestamp}.mp4"
    filepath = os.path.join(RECORDING_DIR, filename)

    def _motion_still_active():
        with state_lock:
            return bool(system_state.get("motion_detected"))

    if SIMULATE:
        # Write a short simulated clip so the gallery/player has something
        # real to show even without physical hardware. Runs at least
        # `seconds` (the minimum), then keeps going for as long as motion
        # is still active, matching the real-camera path below.
        writer = cv2.VideoWriter(
            filepath, cv2.VideoWriter_fourcc(*"mp4v"), fps, (640, 480)
        )
        frame_interval = 1 / fps
        start = time.time()
        frame_count = 0
        while True:
            writer.write(_simulated_frame(label="RECORDING"))
            frame_count += 1
            time.sleep(frame_interval)
            elapsed = time.time() - start
            if elapsed >= seconds and not _motion_still_active():
                break
        writer.release()
        transcode_to_h264(filepath)
        return filename

    if camera is None:
        return None

    # Match the writer's frame size to whatever the camera actually delivers.
    probe = grab_frame()
    if probe is None:
        return None
    height, width = probe.shape[:2]
    writer = cv2.VideoWriter(
        filepath, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height)
    )
    writer.write(probe)

    frame_interval = 1 / fps
    clip_start = time.time()
    while True:
        loop_start = time.time()
        frame = grab_frame()
        if frame is not None:
            writer.write(frame)
        elapsed_frame = time.time() - loop_start
        time.sleep(max(0.0, frame_interval - elapsed_frame))

        elapsed_total = time.time() - clip_start
        if elapsed_total >= seconds and not _motion_still_active():
            break

    writer.release()
    transcode_to_h264(filepath)
    return filename


def record_clip_async(seconds=RECORDING_SECONDS):
    """Fires record_clip() on a background thread and updates system_state
    with recording_active / last_recording_file, so the dashboard can show
    a live "recording..." indicator on the Fig. 3.3 tab."""

    def _run():
        with state_lock:
            system_state["recording_active"] = True
        filename = record_clip(seconds=seconds)
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
            persist_state_log()

    threading.Thread(target=_run, daemon=True).start()


def mjpeg_generator():
    """Yields a continuous multipart JPEG stream for <img src="/video_feed">."""
    boundary = b"--frame"
    while True:
        frame = grab_frame()
        if frame is None:
            time.sleep(0.5)
            continue
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not ok:
            continue
        chunk = (
            boundary + b"\r\n"
            b"Content-Type: image/jpeg\r\n"
            b"Content-Length: " + str(len(buf)).encode() + b"\r\n\r\n" +
            buf.tobytes() + b"\r\n"
        )
        yield chunk
        time.sleep(1 / 15)  # ~15 fps is plenty for a monitoring feed and keeps the Pi's CPU load low


# --------------------------------------------------------------------------
# Buzzer (Fig. 3.3 — active buzzer, direct GPIO drive)
# --------------------------------------------------------------------------

def sound_buzzer(seconds=BUZZER_ON_SECONDS):
    """Turns the active buzzer on for `seconds`, off a background thread so
    it never blocks the sensor loop or the camera capture."""

    def _run():
        with state_lock:
            system_state["buzzer_active"] = True
        if GPIO_AVAILABLE and buzzer_device is not None:
            buzzer_device.on()
        time.sleep(seconds)
        if GPIO_AVAILABLE and buzzer_device is not None:
            buzzer_device.off()
        with state_lock:
            system_state["buzzer_active"] = False

    threading.Thread(target=_run, daemon=True).start()


# --------------------------------------------------------------------------
# Sensor loop (background thread)
# --------------------------------------------------------------------------

def read_pir():
    if SIMULATE:
        # Randomly "detect" motion every so often for demo purposes.
        import random
        time.sleep(1)
        return random.random() < 0.05
    if not GPIO_AVAILABLE or pir_sensor is None:
        return False
    return bool(pir_sensor.motion_detected)


def sensor_loop():
    init_camera()
    print("Sensor warming up...")
    time.sleep(SENSOR_WARMUP_SECONDS)
    print("Motion detection active.")

    motion_active = False  # tracks whether we're inside an ongoing motion
                            # streak, so capture only fires on the idle->motion
                            # edge and everything else during the streak is
                            # discarded, per Fig. 3.1/3.2's one-shot rule

    while True:
        try:
            motion = read_pir()
            with state_lock:
                armed = system_state["armed"]

            is_motion_now = bool(motion and armed)

            # Record a reading point on every poll so Fig. 3.3's graph has a
            # continuous timeline, not just spikes at trigger moments.
            reading_log.append({
                "t": datetime.now().isoformat(timespec="seconds"),
                "motion": is_motion_now,
            })
            persist_state_log()

            if is_motion_now and not motion_active:
                # Rising edge: idle -> motion. Fire exactly one capture for
                # this streak. Everything else while motion stays on is
                # discarded until it drops back to idle (motion_active=False)
                # and trips again.
                motion_active = True
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
                print(f"[{event['timestamp']}] Motion detected -> {filename} (buzzer sounded, recording >= {RECORDING_SECONDS}s clip)")
            elif is_motion_now and motion_active:
                # Motion continues from the same streak -- keep
                # motion_detected true (record_clip() reads this to decide
                # whether to keep extending past the minimum length) but
                # discard it as a new event.
                with state_lock:
                    system_state["motion_detected"] = True
            else:
                # Idle: streak (if any) has ended, ready to trigger again.
                motion_active = False
                with state_lock:
                    system_state["motion_detected"] = False

            time.sleep(1)  # poll the PIR sensor once per second
        except Exception as exc:  # keep the loop alive even if a single read fails
            print(f"Sensor loop error: {exc}")
            time.sleep(1)


# --------------------------------------------------------------------------
# Flask app / API
# --------------------------------------------------------------------------

app = Flask(__name__)


@app.route("/")
def index():
    """Landing menu — choose which activity's dashboard to open."""
    return render_template("menu.html")


@app.route("/camera")
def camera_view():
    """Fig. 3.1 — PIR + camera motion watch (the original dashboard)."""
    return render_template("camera.html")


@app.route("/buzzer")
def buzzer_view():
    """Fig. 3.3 — PIR + camera + buzzer, with sensor-reading graph and
    5-second motion-triggered video recordings."""
    return render_template("buzzer.html")


@app.route("/api/status")
def api_status():
    """`?page=camera` (Fig. 3.1) returns only snapshot events; `?page=buzzer`
    (Fig. 3.3) returns only recording events -- previously both dashboards
    read the same shared log here, so a 3.1 event showed up in 3.3's panel
    and vice versa. No `page` param falls back to the Fig. 3.1 log, for
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
    return jsonify(payload)


@app.route("/api/arm", methods=["POST"])
def api_arm():
    with state_lock:
        system_state["armed"] = True
    return jsonify({"armed": True})


@app.route("/api/disarm", methods=["POST"])
def api_disarm():
    with state_lock:
        system_state["armed"] = False
    return jsonify({"armed": False})


@app.route("/captures/<path:filename>")
def serve_capture(filename):
    return send_from_directory(CAPTURE_DIR, filename)


@app.route("/recordings/<path:filename>")
def serve_recording(filename):
    return send_from_directory(RECORDING_DIR, filename)


@app.route("/video_feed")
def video_feed():
    return Response(
        mjpeg_generator(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


@app.route("/api/gallery")
def api_gallery():
    """Returns the most recent captured snapshots, newest first."""
    with state_lock:
        camera_ok = system_state["camera_ok"]
    files = sorted(
        (f for f in os.listdir(CAPTURE_DIR) if f.lower().endswith((".jpg", ".jpeg", ".png"))),
        reverse=True,
    )[:30]
    return jsonify({"files": files, "camera_ok": camera_ok})


@app.route("/api/readings")
def api_readings():
    """Returns the recent sensor-reading timeline for the Fig. 3.3 graph."""
    return jsonify({"readings": list(reading_log)})


@app.route("/api/events")
def api_events():
    """Returns the last 24h of motion-trigger events for the unified
    Fig. 3.1 / Fig. 3.3 motion graph, each paired with both the
    snapshot (.jpg, Fig. 3.1) and recorded clip (.mp4, Fig. 3.3) filed
    under the same motion_YYYYMMDD_HHMMSS stamp, when present on disk.
    Camera watch and buzzer+graph both call this so they show the same
    timeline instead of the old split UI."""
    cutoff = time.time() - 24 * 3600
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
    return jsonify({"events": out})


@app.route("/api/recordings")
def api_recordings():
    """Returns the most recent motion-triggered video clips (Fig. 3.3),
    newest first."""
    with state_lock:
        camera_ok = system_state["camera_ok"]
    files = sorted(
        (f for f in os.listdir(RECORDING_DIR) if f.lower().endswith(".mp4")),
        reverse=True,
    )[:30]
    return jsonify({"files": files, "camera_ok": camera_ok})


@app.route("/api/buzzer/test", methods=["POST"])
def api_buzzer_test():
    """Manually sounds the buzzer for a moment — lets you verify wiring
    straight from the dashboard without waiting for real motion."""
    sound_buzzer()
    return jsonify({"ok": True})


if __name__ == "__main__":
    t = threading.Thread(target=sensor_loop, daemon=True)
    t.start()
    app.run(host="0.0.0.0", port=5000, threaded=True)
