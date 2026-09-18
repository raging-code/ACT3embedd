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
CAMERA_INDEX = 0            # 0 = first USB webcam; try 1 or 2 if it's not found
CAPTURE_DIR = os.path.join(os.path.dirname(__file__), "captures")
COOLDOWN_SECONDS = 5        # minimum time between two triggered captures
EVENT_HISTORY_LIMIT = 100   # how many past events to keep in memory
SENSOR_WARMUP_SECONDS = 2   # PIR sensors need a moment to settle after power-on
SIMULATE = os.environ.get("MOTION_SIM", "0") == "1"  # run without real GPIO/camera

os.makedirs(CAPTURE_DIR, exist_ok=True)

# --------------------------------------------------------------------------
# GPIO setup (falls back to simulation if RPi.GPIO isn't available,
# e.g. when developing/testing on a non-Pi machine)
# --------------------------------------------------------------------------

GPIO_AVAILABLE = False
if not SIMULATE:
    try:
        import RPi.GPIO as GPIO
        GPIO.setmode(GPIO.BCM)
        GPIO.setup(PIR_PIN, GPIO.IN)
        GPIO_AVAILABLE = True
    except (ImportError, RuntimeError):
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
    "started_at": datetime.now().isoformat(timespec="seconds"),
}
event_log = deque(maxlen=EVENT_HISTORY_LIMIT)

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
# Sensor loop (background thread)
# --------------------------------------------------------------------------

def read_pir():
    if SIMULATE:
        # Randomly "detect" motion every so often for demo purposes.
        import random
        time.sleep(1)
        return random.random() < 0.05
    if not GPIO_AVAILABLE:
        return False
    return bool(GPIO.input(PIR_PIN))


def sensor_loop():
    init_camera()
    print("Sensor warming up...")
    time.sleep(SENSOR_WARMUP_SECONDS)
    print("Motion detection active.")

    last_trigger = 0.0

    while True:
        try:
            motion = read_pir()
            with state_lock:
                armed = system_state["armed"]

            if motion and armed:
                now = time.time()
                if now - last_trigger >= COOLDOWN_SECONDS:
                    last_trigger = now
                    filename = capture_frame()
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
                    print(f"[{event['timestamp']}] Motion detected -> {filename}")
            else:
                with state_lock:
                    system_state["motion_detected"] = False

            time.sleep(0.15)
        except Exception as exc:  # keep the loop alive even if a single read fails
            print(f"Sensor loop error: {exc}")
            time.sleep(1)


# --------------------------------------------------------------------------
# Flask app / API
# --------------------------------------------------------------------------

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html")


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


if __name__ == "__main__":
    t = threading.Thread(target=sensor_loop, daemon=True)
    t.start()
    app.run(host="0.0.0.0", port=5000, threaded=True)
