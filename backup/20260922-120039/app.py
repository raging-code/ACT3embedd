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
import time
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
    "camera_ok": False,
    "sensor_ok": GPIO_AVAILABLE or SIMULATE,
    "buzzer_ok": GPIO_AVAILABLE or SIMULATE,
    "buzzer_active": False,
    "recording_active": False,
    "last_recording_file": None,
    "started_at": datetime.now().isoformat(timespec="seconds"),
}
event_log = deque(maxlen=EVENT_HISTORY_LIMIT)
reading_log = deque(maxlen=READING_HISTORY_LIMIT)     # [{time, motion}] for the Fig. 3.3 graph
recording_log = deque(maxlen=EVENT_HISTORY_LIMIT)      # Fig. 3.3's own event history (video clips)

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
        if filename:
            recording_log.appendleft({
                "timestamp": datetime.now().isoformat(timespec="seconds"),
                "file": filename,
            })

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
    with state_lock:
        payload = dict(system_state)
    payload["events"] = list(event_log)[:20]
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
