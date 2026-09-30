"""
distance.py -- camera-only distance estimation for Perimeter
------------------------------------------------------------
Measures how far (in cm) the MOVING object is from the camera, using only
the webcam:

  1. A YOLOv8n detector (ONNX, run through OpenCV's DNN module) finds the
     target object class (default: person) in the latest camera frame.
  2. Frame differencing tells us which detection is actually MOVING.
  3. The pinhole camera formula turns the box size into a distance:

         distance_cm = real_size_cm * focal_px / box_size_px

     focal_px is learned once by the Calibration page (put the object at a
     measured distance, press Calibrate).
  4. The last few readings are median-smoothed so the number doesn't jitter.

If models/yolov8n.onnx is missing, it falls back to the biggest moving blob
(much less accurate) so the dashboard still works. Run export_yolo_model.py
once to create the model file.

Everything runs on a background thread that only wakes up while the camera,
buzzer or calibration dashboard is open or a clip is being recorded, so it costs
nothing the rest of the time.
"""

import os
import json
import time
import math
import random
import threading
from collections import deque
from datetime import datetime

import cv2
import numpy as np
from flask import Blueprint, jsonify, render_template, request

COCO_CLASSES = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
    "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
    "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
    "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
    "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup",
    "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
    "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear",
    "hair drier", "toothbrush",
]

# --- tunables -------------------------------------------------------------
YOLO_INPUT = 416            # must match IMGSZ in export_yolo_model.py
CONF_THRESHOLD = 0.35       # minimum detector confidence
NMS_THRESHOLD = 0.45
MIN_MOTION_RATIO = 0.03     # fraction of a box's pixels that must be changing
                            # for it to count as "the moving object"
WORKER_MIN_INTERVAL = 0.08  # seconds between detection passes (caps CPU use)
RESULT_HOLD_SECONDS = 1.5   # keep showing the last moving reading this long
SMOOTHING_WINDOW = 5        # median over the last N readings
MOTION_GAP_RESET = 1.0      # frames further apart than this can't be diffed
EDGE_MARGIN = 3             # box within N px of the frame edge = "cut off"
CALIBRATION_SAMPLES = 15
CALIBRATION_MIN_SAMPLES = 8
CALIBRATION_TIMEOUT = 8.0
CALIBRATION_MAX_SPREAD = 0.08   # max (max-min)/median of the sampled sizes

DEFAULT_SETTINGS = {
    "class_id": 0,               # 0 = person
    "dimension": "height",       # which side of the box is measured
    "real_size_cm": 170.0,       # real size of that side, in cm
    "focal_px": None,            # learned by calibration
    "cal_width": None,           # frame size the calibration was done at
    "cal_height": None,
    "known_distance_cm": None,
    "calibrated_at": None,
}


def _letterbox(img, size):
    h, w = img.shape[:2]
    ratio = min(size / w, size / h)
    nw, nh = int(round(w * ratio)), int(round(h * ratio))
    resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    pad_x, pad_y = (size - nw) // 2, (size - nh) // 2
    canvas[pad_y:pad_y + nh, pad_x:pad_x + nw] = resized
    return canvas, ratio, pad_x, pad_y


def parse_yolov8(output, ratio, pad_x, pad_y, class_id,
                 conf_thr=CONF_THRESHOLD, nms_thr=NMS_THRESHOLD):
    """Turns a raw YOLOv8 ONNX output (1 x 84 x N) into a list of
    {x1, y1, x2, y2, conf} boxes in ORIGINAL frame coordinates, for one
    class only, after non-max suppression."""
    preds = np.squeeze(np.asarray(output))
    if preds.ndim != 2:
        return []
    if preds.shape[0] < preds.shape[1]:
        preds = preds.T                      # -> (N, 84)
    if preds.shape[1] <= 4 + class_id:
        return []
    scores = preds[:, 4 + class_id]
    keep = scores >= conf_thr
    if not np.any(keep):
        return []
    preds, scores = preds[keep], scores[keep]
    cx, cy, w, h = preds[:, 0], preds[:, 1], preds[:, 2], preds[:, 3]
    x1 = (cx - w / 2 - pad_x) / ratio
    y1 = (cy - h / 2 - pad_y) / ratio
    x2 = (cx + w / 2 - pad_x) / ratio
    y2 = (cy + h / 2 - pad_y) / ratio
    nms_boxes = [[int(a), int(b), int(c - a), int(d - b)]
                 for a, b, c, d in zip(x1, y1, x2, y2)]
    idxs = cv2.dnn.NMSBoxes(nms_boxes, scores.astype(float).tolist(), conf_thr, nms_thr)
    idxs = np.array(idxs).flatten() if len(idxs) else []
    return [{"x1": float(x1[i]), "y1": float(y1[i]), "x2": float(x2[i]),
             "y2": float(y2[i]), "conf": float(scores[i])} for i in idxs]


class DistanceEstimator:
    def __init__(self, get_frame, is_page_active, simulate, base_dir):
        self.get_frame = get_frame
        self.is_page_active = is_page_active
        self.simulate = simulate
        self.base_dir = base_dir
        self.model_path = os.path.join(base_dir, "models", "yolov8n.onnx")
        self.settings_path = os.path.join(base_dir, "data", "calibration.json")

        self._lock = threading.Lock()
        self._settings = dict(DEFAULT_SETTINGS)
        self._load_settings()

        self.net = None
        self.model_ok = False
        self.model_error = None
        self._model_tried = False

        self._result = None
        self._holds = 0
        self._demand_until = 0.0
        self._started = False
        self._fps = 0.0

        self._prev_gray = None
        self._prev_t = 0.0
        self._last_mask = None
        self._hist_moving = deque(maxlen=SMOOTHING_WINDOW)
        self._hist_raw = deque(maxlen=SMOOTHING_WINDOW)
        self._last_moving = None
        self._last_moving_ts = 0.0
        self._last_raw_ts = 0.0

    # ---------------------------------------------------------------- settings
    def _load_settings(self):
        try:
            with open(self.settings_path, "r", encoding="utf-8") as fh:
                saved = json.load(fh)
            for key in DEFAULT_SETTINGS:
                if key in saved:
                    self._settings[key] = saved[key]
        except (OSError, ValueError):
            pass

    def _save_settings(self):
        try:
            os.makedirs(os.path.dirname(self.settings_path), exist_ok=True)
            tmp = self.settings_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self._settings, fh, indent=2)
            os.replace(tmp, self.settings_path)
        except OSError as exc:
            print("distance: could not save calibration.json:", exc)

    def get_settings(self):
        with self._lock:
            return dict(self._settings)

    def update_settings(self, data):
        cid = int(data.get("class_id", self._settings["class_id"]))
        dim = str(data.get("dimension", self._settings["dimension"]))
        size = float(data.get("real_size_cm", self._settings["real_size_cm"]))
        if not 0 <= cid < len(COCO_CLASSES):
            raise ValueError("Unknown object class.")
        if dim not in ("width", "height"):
            raise ValueError("Dimension must be width or height.")
        if not 1.0 <= size <= 1000.0:
            raise ValueError("Real size must be between 1 and 1000 cm.")
        with self._lock:
            self._settings.update(class_id=cid, dimension=dim, real_size_cm=size)
            self._save_settings()
        self._reset_history()

    def reset_calibration(self):
        with self._lock:
            self._settings.update(focal_px=None, cal_width=None, cal_height=None,
                                  known_distance_cm=None, calibrated_at=None)
            self._save_settings()
        self._reset_history()

    def _reset_history(self):
        self._hist_moving.clear()
        self._hist_raw.clear()
        self._last_moving = None

    # ------------------------------------------------------------- lifecycle
    def start(self):
        if self._started:
            return
        self._started = True
        threading.Thread(target=self._loop, daemon=True).start()

    def hold(self):
        """Keep the estimator running (e.g. while a clip is recording)."""
        with self._lock:
            self._holds += 1

    def release(self):
        with self._lock:
            self._holds = max(0, self._holds - 1)

    def _wanted(self):
        return (self._holds > 0
                or time.time() < self._demand_until
                or self.is_page_active("camera")
                or self.is_page_active("buzzer")
                or self.is_page_active("calibrate"))

    def _load_model(self):
        self._model_tried = True
        if self.simulate:
            self.model_ok = True
            return
        if not os.path.exists(self.model_path):
            self.model_error = "models/yolov8n.onnx not found - run export_yolo_model.py"
            print("distance:", self.model_error, "(using motion-blob fallback)")
            return
        try:
            self.net = cv2.dnn.readNetFromONNX(self.model_path)
            self.model_ok = True
            self.model_error = None
            print("distance: YOLO model loaded")
        except Exception as exc:
            self.model_error = "could not load model: %s" % exc
            print("distance:", self.model_error)

    def _loop(self):
        while True:
            if not self._wanted():
                self._prev_gray = None
                time.sleep(0.25)
                continue
            if not self._model_tried:
                self._load_model()
            t0 = time.time()
            try:
                if self.simulate:
                    self._process_sim()
                else:
                    frame = self.get_frame()
                    if frame is None:
                        time.sleep(0.2)
                        continue
                    self._process(frame)
            except Exception as exc:
                print("distance: processing error:", exc)
                time.sleep(0.5)
            dt = time.time() - t0
            time.sleep(max(0.02, WORKER_MIN_INTERVAL - dt))
            period = time.time() - t0
            self._fps = 0.8 * self._fps + 0.2 * (1.0 / period) if self._fps else 1.0 / period

    # ------------------------------------------------------------ detection
    def _detect(self, frame, class_id):
        canvas, ratio, pad_x, pad_y = _letterbox(frame, YOLO_INPUT)
        blob = cv2.dnn.blobFromImage(canvas, 1 / 255.0, (YOLO_INPUT, YOLO_INPUT),
                                     swapRB=True, crop=False)
        self.net.setInput(blob)
        out = self.net.forward()
        return parse_yolov8(out, ratio, pad_x, pad_y, class_id)

    def _motion_mask(self, frame, now):
        small = cv2.resize(frame, (160, 120), interpolation=cv2.INTER_AREA)
        gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (5, 5), 0)
        prev, prev_t = self._prev_gray, self._prev_t
        if prev is not None and np.array_equal(gray, prev):
            return self._last_mask            # same frame as last pass
        self._prev_gray, self._prev_t = gray, now
        if prev is None or now - prev_t > MOTION_GAP_RESET:
            self._last_mask = None
            return None
        diff = cv2.absdiff(gray, prev)
        _, mask = cv2.threshold(diff, 20, 255, cv2.THRESH_BINARY)
        mask = cv2.dilate(mask, None, iterations=2)
        self._last_mask = mask
        return mask

    @staticmethod
    def _motion_ratio(mask, det, w, h):
        mh, mw = mask.shape
        x1 = max(0, int(det["x1"] * mw / w)); x2 = min(mw, int(det["x2"] * mw / w) + 1)
        y1 = max(0, int(det["y1"] * mh / h)); y2 = min(mh, int(det["y2"] * mh / h) + 1)
        if x2 <= x1 or y2 <= y1:
            return 0.0
        region = mask[y1:y2, x1:x2]
        return float(np.count_nonzero(region)) / region.size

    @staticmethod
    def _motion_blob(mask, w, h):
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return None
        biggest = max(contours, key=cv2.contourArea)
        if cv2.contourArea(biggest) < 0.015 * mask.size:
            return None
        x, y, bw, bh = cv2.boundingRect(biggest)
        sx, sy = w / mask.shape[1], h / mask.shape[0]
        return {"x1": x * sx, "y1": y * sy, "x2": (x + bw) * sx, "y2": (y + bh) * sy,
                "conf": 1.0, "motion": 1.0}

    # ------------------------------------------------------------- measuring
    def _raw_distance(self, px, frame_w, s):
        f = s["focal_px"]
        if not f or px is None or px <= 1:
            return None
        if s["cal_width"]:
            f = f * frame_w / s["cal_width"]     # camera resolution changed
        return s["real_size_cm"] * f / px

    def _summary(self, det, s, w, h):
        x1, y1 = max(0.0, det["x1"]), max(0.0, det["y1"])
        x2, y2 = min(float(w), det["x2"]), min(float(h), det["y2"])
        if s["dimension"] == "width":
            px = det["x2"] - det["x1"]
            clipped = det["x1"] <= EDGE_MARGIN or det["x2"] >= w - EDGE_MARGIN
        else:
            px = det["y2"] - det["y1"]
            clipped = det["y1"] <= EDGE_MARGIN or det["y2"] >= h - EDGE_MARGIN
        return {"bbox": [x1, y1, x2 - x1, y2 - y1], "px": float(px),
                "conf": det.get("conf", 1.0), "clipped": bool(clipped),
                "motion": det.get("motion", 0.0),
                "distance_cm": self._raw_distance(px, w, s)}

    @staticmethod
    def _smooth(hist, summary):
        if summary["distance_cm"] is not None:
            hist.append(summary["distance_cm"])
            summary["distance_cm"] = float(np.median(hist))
        return summary

    def _process(self, frame):
        h, w = frame.shape[:2]
        now = time.time()
        s = self.get_settings()
        mask = self._motion_mask(frame, now)

        if self.model_ok:
            dets = self._detect(frame, s["class_id"])
            raw = max(dets, key=lambda d: d["conf"]) if dets else None
            moving = None
            if mask is not None:
                best = 0.0
                for d in dets:
                    d["motion"] = self._motion_ratio(mask, d, w, h)
                    if d["motion"] >= MIN_MOTION_RATIO and d["motion"] > best:
                        best, moving = d["motion"], d
        else:                                  # fallback: biggest moving blob
            blob = self._motion_blob(mask, w, h) if mask is not None else None
            raw = moving = blob

        self._publish(raw, moving, s, w, h, now)

    def _process_sim(self):
        now = time.time()
        w, h = 640, 480
        s = self.get_settings()

        def fake(px, cx):
            if s["dimension"] == "width":
                bw, bh = px, min(px * 2.2, h * 0.9)
            else:
                bw, bh = px * 0.45, px
            return {"x1": cx - bw / 2, "y1": h / 2 - bh / 2, "x2": cx + bw / 2,
                    "y2": h / 2 + bh / 2, "conf": 0.9, "motion": 0.2}

        raw = fake(200 + random.uniform(-1.5, 1.5), w / 2)
        moving = fake(200 + 70 * math.sin(now / 2.0), w / 2 + 120 * math.sin(now / 2.0))
        self._publish(raw, moving, s, w, h, now)

    def _publish(self, raw, moving, s, w, h, now):
        raw_sum = self._smooth(self._hist_raw, self._summary(raw, s, w, h)) if raw else None
        if raw_sum:
            self._last_raw_ts = now
        elif now - self._last_raw_ts > RESULT_HOLD_SECONDS:
            self._hist_raw.clear()

        held = False
        if moving:
            mov_sum = self._smooth(self._hist_moving, self._summary(moving, s, w, h))
            self._last_moving, self._last_moving_ts = mov_sum, now
        elif self._last_moving and now - self._last_moving_ts <= RESULT_HOLD_SECONDS:
            mov_sum, held = self._last_moving, True
        else:
            mov_sum = None
            self._hist_moving.clear()
            self._last_moving = None

        with self._lock:
            self._result = {"ts": now, "frame_w": w, "frame_h": h,
                            "raw": raw_sum, "moving": mov_sum, "held": held}

    # --------------------------------------------------------------- overlay
    @staticmethod
    def _put_text(img, text, org, scale, color, thick):
        font = cv2.FONT_HERSHEY_SIMPLEX
        cv2.putText(img, text, org, font, scale, (0, 0, 0), thick + 2, cv2.LINE_AA)
        cv2.putText(img, text, org, font, scale, color, thick, cv2.LINE_AA)

    def annotate(self, frame):
        """Returns a COPY of frame with the tracked box and 'Distance: N cm'
        drawn on it. Returns the frame untouched when nothing is running."""
        if not self._wanted():
            return frame
        with self._lock:
            res = self._result
            s = dict(self._settings)
        fresh = res is not None and time.time() - res["ts"] <= 1.0
        calib_view = self.is_page_active("calibrate")
        target = None
        if fresh:
            target = res["raw"] if calib_view else res["moving"]

        out = frame.copy()
        h, w = out.shape[:2]
        scale = max(0.5, w / 1000.0)
        thick = max(1, int(round(scale * 2)))
        color = (240, 176, 95)                      # sky blue (BGR)
        calibrated = bool(s["focal_px"])

        if target:
            x, y, bw, bh = [int(v) for v in target["bbox"]]
            cv2.rectangle(out, (x, y), (x + bw, y + bh), color, thick + 1)
            d = target["distance_cm"]
            label = ("%.0f cm" % d) if d is not None else ("%.0f px" % target["px"])
            if target["clipped"]:
                label += " (cut off)"
            (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, scale, thick)
            ly = y - 8 if y - th - 12 > 0 else y + th + 10
            self._put_text(out, label, (max(2, x), ly), scale, color, thick)

        if not calibrated:
            hud = "Distance: not calibrated"
        elif target and target["distance_cm"] is not None:
            hud = "Distance: %.0f cm" % target["distance_cm"]
        else:
            hud = "Distance: --"
        self._put_text(out, hud, (int(w * 0.012) + 4, int(h * 0.02) + int(28 * scale)),
                       scale * 1.05, (255, 255, 255), thick)
        return out

    # ---------------------------------------------------------- calibration
    def calibrate(self, known_distance_cm):
        known = float(known_distance_cm)
        if not 20.0 <= known <= 3000.0:
            raise ValueError("Known distance must be between 20 and 3000 cm.")
        s = self.get_settings()
        if not self.model_ok and not self.simulate:
            raise ValueError("AI model not loaded (%s). Calibrating with the motion "
                             "fallback is unreliable." % (self.model_error or "unknown error"))

        self._demand_until = time.time() + CALIBRATION_TIMEOUT + 3
        samples, last_ts = [], 0.0
        frame_w = frame_h = None
        deadline = time.time() + CALIBRATION_TIMEOUT
        while time.time() < deadline and len(samples) < CALIBRATION_SAMPLES:
            with self._lock:
                res = self._result
            if res and res["ts"] > last_ts and time.time() - res["ts"] < 1.0:
                last_ts = res["ts"]
                raw = res["raw"]
                if raw and not raw["clipped"]:
                    samples.append(raw["px"])
                    frame_w, frame_h = res["frame_w"], res["frame_h"]
            time.sleep(0.05)

        if len(samples) < CALIBRATION_MIN_SAMPLES:
            raise ValueError("Could not see the target clearly (%d good samples, need %d). "
                             "Make sure the whole object is in frame, well lit, and it is the "
                             "only one of its kind in view." % (len(samples), CALIBRATION_MIN_SAMPLES))
        samples.sort()
        trim = max(0, int(len(samples) * 0.1))
        core = samples[trim:len(samples) - trim] or samples
        median = float(np.median(core))
        spread = (core[-1] - core[0]) / median if median else 1.0
        if spread > CALIBRATION_MAX_SPREAD:
            raise ValueError("The box size kept changing (%.0f%% spread). Hold the object "
                             "still and facing the camera, then try again." % (spread * 100))

        focal = median * known / s["real_size_cm"]
        with self._lock:
            self._settings.update(
                focal_px=focal, cal_width=frame_w, cal_height=frame_h,
                known_distance_cm=known,
                calibrated_at=datetime.now().isoformat(timespec="seconds"))
            self._save_settings()
        self._reset_history()
        return {"focal_px": focal, "pixel_size": median, "samples": len(core),
                "spread_pct": spread * 100, "frame_w": frame_w, "frame_h": frame_h}

    # --------------------------------------------------------------- status
    def live(self):
        with self._lock:
            res = self._result
            s = dict(self._settings)
        fresh = res is not None and time.time() - res["ts"] <= 1.0
        return {
            "running": self._wanted(),
            "fresh": fresh,
            "fps": round(self._fps, 1),
            "calibrated": bool(s["focal_px"]),
            "model_ok": self.model_ok,
            "model_error": self.model_error,
            "simulate": self.simulate,
            "raw": res["raw"] if fresh else None,
            "moving": res["moving"] if fresh else None,
            "frame_w": res["frame_w"] if res else None,
            "frame_h": res["frame_h"] if res else None,
        }

    def config(self):
        return {
            "settings": self.get_settings(),
            "classes": [{"id": i, "name": n} for i, n in enumerate(COCO_CLASSES)],
            "model_ok": self.model_ok,
            "model_error": self.model_error,
            "model_tried": self._model_tried,
            "model_path": "models/yolov8n.onnx",
            "simulate": self.simulate,
        }


def create_blueprint(est, note_page_seen):
    bp = Blueprint("distance", __name__)

    @bp.route("/calibrate")
    def calibrate_view():
        return render_template("calibrate.html")

    @bp.route("/api/calibration")
    def api_calibration():
        note_page_seen("calibrate")
        est._demand_until = time.time() + 3      # wake the worker so the model loads
        return jsonify(est.config())

    @bp.route("/api/calibration/settings", methods=["POST"])
    def api_settings():
        try:
            est.update_settings(request.get_json(force=True, silent=True) or {})
        except (ValueError, TypeError) as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, "settings": est.get_settings()})

    @bp.route("/api/calibration/run", methods=["POST"])
    def api_run():
        data = request.get_json(force=True, silent=True) or {}
        try:
            result = est.calibrate(data.get("known_distance_cm"))
        except (ValueError, TypeError) as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, "result": result, "settings": est.get_settings()})

    @bp.route("/api/calibration/reset", methods=["POST"])
    def api_reset():
        est.reset_calibration()
        return jsonify({"ok": True, "settings": est.get_settings()})

    @bp.route("/api/distance/live")
    def api_live():
        if request.args.get("page") == "calibrate":
            note_page_seen("calibrate")
        return jsonify(est.live())

    return bp
