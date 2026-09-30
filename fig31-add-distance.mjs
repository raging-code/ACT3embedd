#!/usr/bin/env node
/**
 * fig31-add-distance.mjs
 * ----------------------
 * Adds camera-only DISTANCE MEASUREMENT (in cm) to the moving object, plus a
 * "Distance Calibration" tab on the main menu.
 *
 * Usage (run from anywhere):
 *   node fig31-add-distance.mjs .
 *   node fig31-add-distance.mjs "C:\Users\eugen\OneDrive\Desktop\ACT3embed"
 *
 * Safe to re-run: every edit checks whether it was already applied.
 * Files that get modified are first copied to backup/<timestamp>/.
 *
 * What it does
 *   NEW   distance.py                 YOLOv8n (OpenCV DNN) + motion detection +
 *                                     pinhole distance formula + calibration API
 *   NEW   export_yolo_model.py        run once on a PC to create models/yolov8n.onnx
 *   NEW   templates/calibrate.html    the calibration page
 *   NEW   static/calibrate.js
 *   EDIT  app.py                      hooks the estimator into the Fig. 3.1 AND
 *                                     Fig. 3.3 clip recorders, the live feed,
 *                                     and startup
 *   EDIT  templates/menu.html         third card: Calibration
 *   EDIT  static/style.css            styles for the new card + page
 *   EDIT  README.md                   short setup section
 *
 * Result: every Fig. 3.1 AND Fig. 3.3 motion clip (and the live camera view
 * on both dashboards) shows a box around the MOVING object and
 * "Distance: N cm" in the top-left corner.
 *
 * Already applied the first version? Just run this one over it -- it upgrades
 * distance.py and adds the Fig. 3.3 hooks.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error('Usage: node fig31-add-distance.mjs /path/to/ACT3embedd   (use "." for the current folder)');
  process.exit(1);
}

const REQUIRED = ["app.py", "templates/menu.html", "static/style.css", "templates/camera.html"];
for (const rel of REQUIRED) {
  if (!existsSync(join(root, rel))) {
    console.error(`Could not find ${rel} in ${root} -- is this the project folder?`);
    process.exit(1);
  }
}

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const backedUp = new Set();
let changes = 0;

function backup(rel) {
  if (backedUp.has(rel)) return;
  const src = join(root, rel);
  if (!existsSync(src)) return;
  const dst = join(root, "backup", stamp, rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  backedUp.add(rel);
}

/** Reads a file as LF text, remembering whether it used CRLF (Windows). */
function readText(rel) {
  const raw = readFileSync(join(root, rel), "utf8");
  return { text: raw.replace(/\r\n/g, "\n"), crlf: raw.includes("\r\n") };
}
function writeText(rel, text, crlf) {
  writeFileSync(join(root, rel), crlf ? text.replace(/\n/g, "\r\n") : text, "utf8");
}

/** Creates a new file, or overwrites it if the content differs. */
function ensureFile(rel, content) {
  const full = join(root, rel);
  if (existsSync(full)) {
    const cur = readFileSync(full, "utf8").replace(/\r\n/g, "\n");
    if (cur === content) {
      console.log(`  [skip] ${rel} (already up to date)`);
      return;
    }
    backup(rel);
  }
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  console.log(`  [ok]   ${rel}`);
  changes++;
}

/** Runs edit(text) -> newText | null (null = nothing to do). */
function edit(rel, label, fn) {
  const { text, crlf } = readText(rel);
  const out = fn(text);
  if (out === null || out === text) {
    console.log(`  [skip] ${label} (already applied)`);
    return;
  }
  backup(rel);
  writeText(rel, out, crlf);
  console.log(`  [ok]   ${label}`);
  changes++;
}

/** Replaces `find` (must occur exactly once) with `replace`. */
function replaceOnce(text, find, replace, label) {
  const n = text.split(find).length - 1;
  if (n === 0) throw new Error(`${label}: anchor not found -- app.py differs from what this patch expects.`);
  if (n > 1) throw new Error(`${label}: anchor matched ${n} times -- aborting to avoid a bad edit.`);
  return text.replace(find, () => replace);
}

// ---------------------------------------------------------------------
// New files
// ---------------------------------------------------------------------
console.log("Creating files ...");

ensureFile("distance.py", String.raw`"""
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
`);

ensureFile("export_yolo_model.py", String.raw`"""
Creates models/yolov8n.onnx for the camera-only distance measurement.

Run this ONCE on any normal PC (Windows / Mac / Linux), then copy the
models/ folder to the Raspberry Pi next to app.py:

    pip install ultralytics onnx
    python export_yolo_model.py

IMGSZ here must match YOLO_INPUT in distance.py (default 416).
Lower it to 320 for more speed, raise it to 640 for a bit more accuracy
(then change YOLO_INPUT in distance.py to the same number).
"""
import os
from ultralytics import YOLO

IMGSZ = 416

model = YOLO("yolov8n.pt")          # downloads the small pretrained model
exported = model.export(format="onnx", imgsz=IMGSZ, opset=12, simplify=False, dynamic=False)

os.makedirs("models", exist_ok=True)
dest = os.path.join("models", "yolov8n.onnx")
os.replace(exported, dest)
print("Saved", dest)
`);

ensureFile("templates/calibrate.html", String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Perimeter — Distance Calibration</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Geist+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/style.css">
</head>
<body>

<div class="blob blob-a"></div>
<div class="blob blob-b"></div>
<div class="blob blob-c"></div>
<div class="blob blob-d"></div>
<div class="blob blob-e"></div>

<div class="console">

  <header class="bar glass">
    <div class="bar-id">
      <a href="/" class="back-link" title="Back to menu">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3 5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </a>
      <span class="dot" id="pulse-dot"></span>
      <span class="bar-name">Distance Calibration</span>
    </div>
    <div class="bar-right">
      <div class="bar-modules">
        <div class="bar-module glass" id="modModel">
          <span class="bar-module-name">AI model</span>
          <span class="bar-module-state" id="modModelState">checking</span>
        </div>
      </div>
      <span class="bar-clock" id="clock">--:--:--</span>
    </div>
  </header>

  <main class="grid">

    <section class="feed-panel">
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
        <div class="feed-tag live-tag"><span class="live-dot"></span>LIVE</div>
      </div>
      <div class="feed-caption">
        <span>Live view with detection box</span>
        <span class="feed-caption-sep">·</span>
        <span id="liveRes">webcam</span>
      </div>

      <div class="cal-panel glass">
        <div class="cal-title">Live reading</div>
        <div class="cal-readout"><span id="readValue">--</span><span class="cal-unit"> cm</span></div>
        <div class="cal-sub" id="readSub">waiting for the camera…</div>
        <div class="cal-sub" id="readMoving">moving object: --</div>
      </div>
    </section>

    <aside class="side">

      <div class="cal-panel glass">
        <div class="cal-title">1 · What are you measuring?</div>
        <div class="cal-row">
          <label for="classSelect">Object</label>
          <select class="cal-input" id="classSelect"></select>
        </div>
        <div class="cal-row">
          <label for="dimSelect">Measure by</label>
          <select class="cal-input" id="dimSelect">
            <option value="height">Height (best for a person fully in view)</option>
            <option value="width">Width</option>
          </select>
        </div>
        <div class="cal-row">
          <label for="sizeInput">Real size of that side (cm)</label>
          <input class="cal-input" id="sizeInput" type="number" min="1" max="1000" step="0.1">
        </div>
        <button class="cal-btn" id="saveBtn" type="button">Save target</button>
        <div class="cal-msg" id="saveMsg"></div>
      </div>

      <div class="cal-panel glass">
        <div class="cal-title">2 · Calibrate</div>
        <p class="cal-help">Put the object at a measured distance from the camera lens, fully in view and facing the camera. Hold still, enter the distance, then press Calibrate.</p>
        <div class="cal-row">
          <label for="distInput">Known distance to the lens (cm)</label>
          <input class="cal-input" id="distInput" type="number" min="20" max="3000" step="1" value="100">
        </div>
        <button class="cal-btn cal-btn-primary" id="calBtn" type="button">Calibrate now</button>
        <div class="cal-msg" id="calMsg"></div>
        <div class="cal-status" id="calStatus">Not calibrated yet.</div>
        <button class="cal-btn cal-btn-ghost" id="resetBtn" type="button">Reset calibration</button>
      </div>

      <div class="cal-panel glass">
        <div class="cal-title">Tips for accuracy</div>
        <ul class="cal-tips">
          <li>Calibrate near the distance you will actually measure.</li>
          <li>Check it: move the object to a second known distance and compare the live reading.</li>
          <li>Only one object of the chosen type in view while calibrating.</li>
          <li>Recalibrate if you change the camera, its zoom or its resolution.</li>
          <li>A box touching the frame edge is cut off, so the reading is unreliable.</li>
        </ul>
      </div>

    </aside>
  </main>

  <footer class="foot">
    <span>Camera-only distance · YOLOv8n + pinhole model</span>
    <span class="foot-sep">·</span>
    <span id="footStatus">connecting…</span>
  </footer>

</div>

<script src="/static/calibrate.js"></script>
</body>
</html>
`);

ensureFile("static/calibrate.js", String.raw`/* Perimeter — Distance Calibration page logic.
   Loads/saves the target settings, runs the calibration, and shows the live
   distance reading (polls /api/distance/live?page=calibrate). */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    clock: $("clock"), liveFrame: $("liveFrame"), liveImg: $("liveImg"), liveRes: $("liveRes"),
    modModel: $("modModel"), modModelState: $("modModelState"), dot: $("pulse-dot"),
    classSelect: $("classSelect"), dimSelect: $("dimSelect"), sizeInput: $("sizeInput"),
    saveBtn: $("saveBtn"), saveMsg: $("saveMsg"),
    distInput: $("distInput"), calBtn: $("calBtn"), calMsg: $("calMsg"),
    calStatus: $("calStatus"), resetBtn: $("resetBtn"),
    readValue: $("readValue"), readSub: $("readSub"), readMoving: $("readMoving"),
    footStatus: $("footStatus")
  };

  var pollTimer = null;
  var pollMs = 400;
  var POLL_MAX = 6000;

  el.liveImg.addEventListener("load", function () { el.liveFrame.classList.add("has-image"); });
  el.liveImg.addEventListener("error", function () { el.liveFrame.classList.remove("has-image"); });

  function tickClock() {
    el.clock.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
  }
  setInterval(tickClock, 1000);
  tickClock();

  function setMsg(node, text, kind) {
    node.textContent = text || "";
    node.className = node.className.replace(/\s*(ok|fail)\b/g, "");
    if (kind) node.className += " " + kind;
  }

  function jsonPost(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    });
  }

  function renderCalStatus(s) {
    if (s && s.focal_px) {
      var when = s.calibrated_at ? new Date(s.calibrated_at).toLocaleString() : "";
      el.calStatus.textContent = "Calibrated: focal length " + s.focal_px.toFixed(1) +
        " px, at " + s.known_distance_cm + " cm, " + s.cal_width + "×" + s.cal_height +
        (when ? " (" + when + ")" : "");
      el.calStatus.className = "cal-status ok";
    } else {
      el.calStatus.textContent = "Not calibrated yet.";
      el.calStatus.className = "cal-status";
    }
  }

  function renderModel(cfg) {
    var ok = cfg.model_ok;
    var label = cfg.simulate ? "simulated" : (ok ? "YOLOv8n ready" : (cfg.model_tried ? "missing" : "loading"));
    el.modModelState.textContent = label;
    el.modModelState.classList.toggle("ok", ok);
    el.modModelState.classList.toggle("fail", !ok && cfg.model_tried);
    if (!ok && cfg.model_tried && cfg.model_error) {
      setMsg(el.calMsg, "AI model: " + cfg.model_error, "fail");
    }
  }

  function loadConfig() {
    return fetch("/api/calibration", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (!el.classSelect.options.length) {
          cfg.classes.forEach(function (c) {
            var opt = document.createElement("option");
            opt.value = c.id;
            opt.textContent = c.name;
            el.classSelect.appendChild(opt);
          });
        }
        var s = cfg.settings;
        el.classSelect.value = s.class_id;
        el.dimSelect.value = s.dimension;
        el.sizeInput.value = s.real_size_cm;
        if (s.known_distance_cm) el.distInput.value = s.known_distance_cm;
        renderCalStatus(s);
        renderModel(cfg);
      });
  }

  el.saveBtn.addEventListener("click", function () {
    setMsg(el.saveMsg, "Saving…");
    jsonPost("/api/calibration/settings", {
      class_id: parseInt(el.classSelect.value, 10),
      dimension: el.dimSelect.value,
      real_size_cm: parseFloat(el.sizeInput.value)
    }).then(function (r) {
      if (r.ok) setMsg(el.saveMsg, "Saved.", "ok");
      else setMsg(el.saveMsg, r.data.error || "Could not save.", "fail");
    }).catch(function () { setMsg(el.saveMsg, "Server not reachable.", "fail"); });
  });

  el.calBtn.addEventListener("click", function () {
    var dist = parseFloat(el.distInput.value);
    if (!dist) { setMsg(el.calMsg, "Enter the known distance first.", "fail"); return; }
    el.calBtn.disabled = true;
    setMsg(el.calMsg, "Measuring… keep the object still.");
    // save the target first so the calibration uses what is on screen
    jsonPost("/api/calibration/settings", {
      class_id: parseInt(el.classSelect.value, 10),
      dimension: el.dimSelect.value,
      real_size_cm: parseFloat(el.sizeInput.value)
    }).then(function (saved) {
      if (!saved.ok) throw new Error(saved.data.error || "Invalid target settings.");
      return jsonPost("/api/calibration/run", { known_distance_cm: dist });
    }).then(function (r) {
      if (!r.ok) throw new Error(r.data.error || "Calibration failed.");
      var res = r.data.result;
      setMsg(el.calMsg, "Done: object measured " + res.pixel_size.toFixed(0) + " px from " +
        res.samples + " samples (spread " + res.spread_pct.toFixed(1) + "%).", "ok");
      renderCalStatus(r.data.settings);
    }).catch(function (err) {
      setMsg(el.calMsg, err.message || "Calibration failed.", "fail");
    }).then(function () { el.calBtn.disabled = false; });
  });

  el.resetBtn.addEventListener("click", function () {
    if (!window.confirm("Clear the saved calibration?")) return;
    jsonPost("/api/calibration/reset", {}).then(function (r) {
      renderCalStatus(r.data.settings);
      setMsg(el.calMsg, "Calibration cleared.");
    });
  });

  function fmtCm(v) { return (v === null || v === undefined) ? "--" : v.toFixed(0); }

  function renderLive(d) {
    el.dot.className = d.fresh ? "dot alert" : "dot";
    if (d.frame_w) el.liveRes.textContent = d.frame_w + "×" + d.frame_h;
    el.footStatus.textContent = d.fps ? ("detector " + d.fps + " passes/s") : "idle";

    var raw = d.raw;
    if (!d.fresh || !raw) {
      el.readValue.textContent = "--";
      el.readSub.textContent = d.model_ok || d.simulate
        ? "no object of the chosen type detected"
        : "AI model missing - using motion fallback (less accurate)";
    } else if (!d.calibrated) {
      el.readValue.textContent = "--";
      el.readSub.textContent = "box is " + raw.px.toFixed(0) + " px - calibrate to get cm";
    } else {
      el.readValue.textContent = fmtCm(raw.distance_cm);
      el.readSub.textContent = "box " + raw.px.toFixed(0) + " px" +
        (raw.clipped ? " · cut off by the frame edge, unreliable" : "") +
        " · confidence " + Math.round(raw.conf * 100) + "%";
    }

    var mv = d.moving;
    if (d.fresh && mv && mv.distance_cm !== null && mv.distance_cm !== undefined) {
      el.readMoving.textContent = "moving object: " + fmtCm(mv.distance_cm) + " cm";
    } else {
      el.readMoving.textContent = "moving object: none right now";
    }
  }

  function schedule(ms) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, ms);
  }

  function poll() {
    if (document.hidden) return;
    fetch("/api/distance/live?page=calibrate", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("status " + r.status);
        return r.json();
      })
      .then(function (d) {
        renderLive(d);
        renderModelLive(d);
        pollMs = 400;
        schedule(pollMs);
      })
      .catch(function () {
        el.footStatus.textContent = "connection lost - retrying…";
        pollMs = Math.min(POLL_MAX, pollMs * 2);
        schedule(pollMs);
      });
  }

  function renderModelLive(d) {
    var label = d.simulate ? "simulated" : (d.model_ok ? "YOLOv8n ready" : (d.model_error ? "missing" : "loading"));
    el.modModelState.textContent = label;
    el.modModelState.classList.toggle("ok", !!d.model_ok);
    el.modModelState.classList.toggle("fail", !d.model_ok && !!d.model_error);
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) poll();
  });

  loadConfig().catch(function () {
    el.footStatus.textContent = "could not load settings";
  });
  poll();
})();
`);

// ---------------------------------------------------------------------
// app.py
// ---------------------------------------------------------------------
console.log("Patching app.py ...");

edit("app.py", "track the calibration page in page_last_seen", (t) => {
  if (t.includes('"calibrate": 0.0')) return null;
  return replaceOnce(
    t,
    'page_last_seen = {"camera": 0.0, "buzzer": 0.0}',
    'page_last_seen = {"camera": 0.0, "buzzer": 0.0, "calibrate": 0.0}',
    "page_last_seen"
  );
});

const NEW_RECORD_FN = String.raw`def record_clip_camera(seconds=RECORDING_SECONDS, fps=RECORDING_FPS):
    """Records a short video clip for Fig. 3.1 by grabbing frames for
    seconds and writing them out with OpenCV's VideoWriter, the same way
    record_clip() does for Fig. 3.3 -- except this one saves into
    CAPTURE_DIR (Fig. 3.1's own directory) rather than RECORDING_DIR, so the
    two dashboards' clips never mix. Every frame carries the tracked
    moving object's box and 'Distance: N cm' (see distance.py) plus the
    timestamp. Runs on the calling thread -- callers that don't want to
    block should use record_clip_camera_async()."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"motion_{timestamp}.mp4"
    filepath = os.path.join(CAPTURE_DIR, filename)

    def _motion_still_active():
        with state_lock:
            return bool(system_state.get("motion_detected"))

    distance_est.hold()          # keep the distance tracker running for this clip
    try:
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
                sim = _simulated_frame(label="CAPTURE")
                writer.write(stamp_timestamp(distance_est.annotate(sim)))
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
        writer.write(stamp_timestamp(distance_est.annotate(probe)))

        frame_interval = 1 / fps
        clip_start = time.time()
        while True:
            loop_start = time.time()
            frame = grab_frame()
            if frame is not None:
                writer.write(stamp_timestamp(distance_est.annotate(frame)))
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
    finally:
        distance_est.release()


`;

edit("app.py", "record_clip_camera(): draw box + distance on every clip frame", (t) => {
  if (t.includes("distance_est.hold()")) return null;
  const start = t.indexOf("def record_clip_camera(seconds");
  const end = t.indexOf("def record_clip_camera_async(");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("record_clip_camera(): could not find the function in app.py -- was fig31-to-video.mjs applied?");
  }
  return t.slice(0, start) + NEW_RECORD_FN + t.slice(end);
});

edit("app.py", "record_clip() (Fig. 3.3): draw box + distance on every clip frame", (t) => {
  if (t.includes("def _record_clip_impl(")) return null;
  const start = t.indexOf("def record_clip(seconds");
  const end = t.indexOf("def record_clip_async(");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("record_clip(): could not find the function in app.py.");
  }
  let body = t.slice(start, end);
  body = replaceOnce(body, "def record_clip(seconds=RECORDING_SECONDS, fps=RECORDING_FPS):",
    "def _record_clip_impl(seconds=RECORDING_SECONDS, fps=RECORDING_FPS):", "record_clip def");
  body = replaceOnce(body, 'writer.write(stamp_timestamp(_simulated_frame(label="RECORDING")))',
    'writer.write(stamp_timestamp(distance_est.annotate(_simulated_frame(label="RECORDING"))))', "record_clip sim frame");
  body = replaceOnce(body, "writer.write(stamp_timestamp(probe))",
    "writer.write(stamp_timestamp(distance_est.annotate(probe)))", "record_clip probe frame");
  body = replaceOnce(body, "writer.write(stamp_timestamp(frame))",
    "writer.write(stamp_timestamp(distance_est.annotate(frame)))", "record_clip frame");
  const wrapper = `def record_clip(seconds=RECORDING_SECONDS, fps=RECORDING_FPS):
    """Fig. 3.3 clip: same recorder as before, but every frame carries the
    moving object's box and 'Distance: N cm' (see distance.py)."""
    distance_est.hold()          # keep the distance tracker running for this clip
    try:
        return _record_clip_impl(seconds, fps)
    finally:
        distance_est.release()


`;
  return t.slice(0, start) + body + wrapper + t.slice(end);
});

const ESTIMATOR_BLOCK = `app = Flask(__name__)

# --- camera-only distance measurement (see distance.py) -------------------
import distance as distance_mod


def _latest_frame_copy():
    with latest_frame_lock:
        return None if latest_frame is None else latest_frame.copy()


distance_est = distance_mod.DistanceEstimator(
    get_frame=_latest_frame_copy,
    is_page_active=is_page_active,
    simulate=SIMULATE,
    base_dir=os.path.dirname(os.path.abspath(__file__)),
)
app.register_blueprint(distance_mod.create_blueprint(distance_est, note_page_seen))
`;

edit("app.py", "create the DistanceEstimator + register /calibrate routes", (t) => {
  if (t.includes("distance_mod.DistanceEstimator")) return null;
  return replaceOnce(t, "app = Flask(__name__)\n", ESTIMATOR_BLOCK, "Flask app creation");
});

edit("app.py", "live feed: overlay the tracked box + distance", (t) => {
  if (t.includes("frame = distance_est.annotate(frame)")) return null;
  return replaceOnce(
    t,
    '        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])',
    '        frame = distance_est.annotate(frame)\n        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])',
    "mjpeg_generator"
  );
});

edit("app.py", "start the distance worker at launch", (t) => {
  if (t.includes("distance_est.start()")) return null;
  return replaceOnce(
    t,
    "    t = threading.Thread(target=sensor_loop, daemon=True)\n    t.start()\n",
    "    t = threading.Thread(target=sensor_loop, daemon=True)\n    t.start()\n    distance_est.start()\n",
    "__main__ block"
  );
});

// ---------------------------------------------------------------------
// templates/menu.html -- third card
// ---------------------------------------------------------------------
console.log("Patching templates/menu.html ...");

const MENU_CARD = String.raw`
    <a class="menu-card glass" href="/calibrate">
      <div class="icon-c">
        <svg width="40" height="40" viewBox="0 0 27 27" fill="none">
          <rect x="2.5" y="9" width="22" height="9" rx="2" stroke="white" stroke-width="2.6"/>
          <path d="M8 9v4M13.5 9v6M19 9v4" stroke="white" stroke-width="2.6" stroke-linecap="round"/>
        </svg>
      </div>
      <span class="menu-card-tag">Distance</span>
      <span class="menu-card-title">Calibration</span>
      <p class="menu-card-desc">Teach the camera to measure how far the moving object is, in cm, shown on the recorded video.</p>
      <span class="menu-card-cta">Open calibration →</span>
    </a>
`;

edit("templates/menu.html", "add the Calibration card", (t) => {
  if (t.includes('href="/calibrate"')) return null;
  return replaceOnce(t, "    </a>\n\n  </main>", "    </a>\n" + MENU_CARD + "\n  </main>", "menu </main>");
});

// ---------------------------------------------------------------------
// static/style.css
// ---------------------------------------------------------------------
console.log("Patching static/style.css ...");

const CSS_BLOCK = String.raw`
/* === distance-calibration (added by fig31-add-distance.mjs) ============== */

.menu-console { max-width: 960px; }
.menu-grid { grid-template-columns: repeat(3, 1fr); }
@media (max-width: 760px) {
  .menu-grid { grid-template-columns: 1fr; }
}

.cal-panel {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.cal-panel > * { position: relative; z-index: 1; }

.cal-title {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--signal);
}

.cal-help {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-dim);
}

.cal-row { display: flex; flex-direction: column; gap: 5px; }
.cal-row label { font-size: 12px; color: var(--text-dim); }

.cal-input {
  width: 100%;
  background: rgba(0,0,0,0.25);
  border: 1px solid var(--edge-soft);
  border-radius: var(--radius-s);
  color: var(--text);
  font-family: var(--mono);
  font-size: 13px;
  padding: 9px 11px;
}
.cal-input:focus-visible { outline: 2px solid var(--signal); outline-offset: 1px; }
select.cal-input option { color: #111; background: #fff; }

.cal-btn {
  font-family: var(--grot);
  font-weight: 700;
  font-size: 13px;
  color: var(--text);
  background: rgba(255,255,255,0.08);
  border: 1px solid var(--edge-soft);
  border-radius: var(--radius-s);
  padding: 10px 14px;
  cursor: pointer;
  transition: filter 0.15s ease, transform 0.1s ease;
}
.cal-btn:hover { filter: brightness(1.15); }
.cal-btn:active { transform: scale(0.98); }
.cal-btn:disabled { opacity: 0.5; cursor: wait; }
.cal-btn-primary {
  background: var(--signal-dim);
  border-color: var(--signal);
  color: var(--signal);
}
.cal-btn-ghost { color: var(--text-dim); }

.cal-msg { font-size: 12px; line-height: 1.45; color: var(--text-dim); min-height: 1em; }
.cal-msg.ok { color: var(--ok); }
.cal-msg.fail { color: var(--off); }

.cal-status {
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-faint);
}
.cal-status.ok { color: var(--ok); }

.cal-readout {
  font-family: var(--grot);
  font-size: 52px;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1;
  color: var(--text);
}
.cal-unit { font-size: 20px; font-weight: 600; color: var(--text-dim); }
.cal-sub { font-family: var(--mono); font-size: 11px; color: var(--text-dim); }

.cal-tips {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-dim);
}
`;

edit("static/style.css", "append calibration styles + 3-column menu", (t) => {
  if (t.includes("distance-calibration (added by")) return null;
  return t.replace(/\n*$/, "\n") + CSS_BLOCK;
});

// ---------------------------------------------------------------------
// README.md
// ---------------------------------------------------------------------
console.log("Patching README.md ...");

const README_BLOCK = `

## Camera-only distance (cm)

Motion clips (Fig. 3.1 and Fig. 3.3) and the live camera views show a box around the **moving** object
and \`Distance: N cm\` (top-left), measured with the webcam only.

1. On any PC: \`pip install ultralytics onnx\` then \`python export_yolo_model.py\`
   -> creates \`models/yolov8n.onnx\`. Copy the \`models/\` folder next to \`app.py\` on the Pi.
2. Open **Calibration** on the main menu, choose the object + its real size in cm,
   place it at a measured distance, press **Calibrate now**.
3. Re-calibrate if you change the camera, zoom or resolution.

Without the model file the app falls back to the biggest moving blob (much less accurate).
`;

if (existsSync(join(root, "README.md"))) {
  edit("README.md", "add distance setup section", (t) => {
    if (t.includes("## Camera-only distance (cm)")) return null;
    return t.replace(/\n*$/, "\n") + README_BLOCK;
  });
}

console.log(`\nDone. ${changes} change(s) applied.`);
if (changes === 0) console.log("Nothing changed -- this patch was already applied.");
else {
  console.log("\nNext steps:");
  console.log("  1. Create the AI model file (once, on any PC):");
  console.log("       pip install ultralytics onnx");
  console.log("       python export_yolo_model.py");
  console.log("     then make sure models/yolov8n.onnx sits next to app.py on the Pi.");
  console.log("  2. Restart the app:  python3 app.py");
  console.log("  3. Open the menu -> Calibration, and calibrate.");
}
