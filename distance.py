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
EDGE_MARGIN = 3             # box within N px of the frame edge = "cut off" (minimum) ...
EDGE_MARGIN_FRAC = 0.025    # ... or this fraction of the frame size, whichever is larger.
                            # YOLO boxes of a cut-off person usually stop 3-15 px short of
                            # the border, so a fixed 3 px never noticed the cut.

# --- partial body ("too close" / "zoomed in") measurement, person class ----
FACE_ENABLED = True         # use the face width as a ruler when the body is cut off
FACE_CASCADE = "haarcascade_frontalface_default.xml"
FACE_DEFAULT_CM = 15.0      # width of an adult face as the Haar detector boxes it; the
                            # calibration replaces it with the value measured on YOU
FACE_MIN_CM, FACE_MAX_CM = 10.0, 21.0   # sanity range for a learned face width
FACE_LEARN_ALPHA = 0.10     # how fast the face width follows whole-body moments
FACE_DETECT_WIDTH = 480     # a person box wider than this is shrunk before face search
FACE_MIN_PX = 20            # smallest face searched for (in the shrunk image)
FACE_MIN_REL = 0.10         # ... and at least this fraction of the search width
FACE_MIN_NEIGHBORS = 5      # Haar strictness (higher = fewer false faces)
FACE_SEARCH_FRAC = 0.70     # look for the face in the top part of the person box
FACE_REL_MIN, FACE_REL_MAX = 0.10, 0.90   # face width / box width that is believable
FACE_MAX_HOSTS = 3          # person boxes searched for a face per pass (CPU cap)
FACE_LEARN_EVERY = 6        # a clearly-whole-body box is only face-searched every Nth pass
FACE_SKIP_ASPECT = 1.3      # ... "clearly whole" = inside the frame and no wider than this
                            # many times a standing person's width/height
FACE_HOST_CONF = 0.12       # weak person boxes are kept only if a face confirms them
FULL_BODY_RATIO_MIN = 0.85  # box height / (height a face this big implies): >= this
                            # means the box is a whole body ...
FULL_BODY_RATIO_EDGE = 1.00 # a box touching the frame edge needs this much to count as whole
FULL_BODY_RATIO_MAX = 1.45  # ... above this the face is a false alarm and is ignored
DEFAULT_PERSON_ASPECT = 0.40    # typical box width/height of a standing person
PARTIAL_ASPECT_FACTOR = 2.0     # no face: a box this many times wider than a standing
                                # person is a torso / head+shoulders, not a whole body
PERSON_MIN_CM, PERSON_MAX_CM = 120.0, 230.0   # "real size" range that looks like a
                                              # full standing height
# --- body-part rulers (box-relative, learned at calibration) ----------------
POSE_ENABLED = True
POSE_MODEL = "yolov8n-pose.onnx"    # made once by export_pose_model.py (optional)
POSE_INPUT = 416                    # must match IMGSZ in export_pose_model.py
POSE_CONF = 0.40                    # min person confidence of the pose detector
POSE_NEW_CONF = 0.50                # ... to add a person the box detector missed
POSE_MATCH_IOU = 0.25               # pose person <-> detector box overlap
POSE_EVERY = 3                      # pose pass every Nth loop (always when cut off)
POSE_IDLE_EVERY = 4                 # nobody in view: look only every Nth loop
POSE_CACHE_SECONDS = 0.6            # reuse the last pose result this long between passes
KP_CONF = 0.50                      # keypoint confidence needed to use it as a ruler end
KP_EDGE_FRAC = 0.01                 # keypoints this close to the frame edge are unreliable
PART_MIN_PX = 12                    # shorter than this = too noisy to measure with
PART_SEED_SAMPLES = 3               # observations before a NEW part ratio is trusted
PART_LEARN_ALPHA = 0.10             # how fast learned ratios follow whole-box moments
CALIBRATION_SAMPLES = 15
CALIBRATION_MIN_SAMPLES = 8
CALIBRATION_TIMEOUT = 8.0
CALIBRATION_MAX_SPREAD = 0.08   # max (max-min)/median of the sampled sizes

DEFAULT_SETTINGS = {
    "class_id": 0,               # 0 = person
    "dimension": "height",       # which side of the box is measured
    "real_size_cm": 170.0,       # real size of that side, in cm
    "real_other_cm": None,       # real size of the OTHER side (used when the main
                                 # side is cut off by the frame). None = learn it
                                 # from the box shape during calibration
    "cal_aspect": None,          # box width/height seen during calibration
    "cal_face_cm": None,         # face width in cm measured during calibration
                                 # (None = FACE_DEFAULT_CM)  [legacy, unused now]
    "cal_seg": None,             # {part: part_px / box_px} learned at calibration;
                                 # the close-up ruler ("cut off" boxes) uses these
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


# COCO keypoints: 0 nose 1/2 eyes 3/4 ears 5/6 shoulders 7/8 elbows 9/10 wrists
#                 11/12 hips 13/14 knees 15/16 ankles   (odd = left, even = right)
# name: (points A, points B, kind). A / B are averaged over the visible members.
#   v = vertical (turning the body hardly changes it)   w = width (shrinks when turned)
#   a = arm (moves a lot, last resort)                  face = Haar face box width
BODY_PARTS = {
    "torso":       ((5, 6), (11, 12), "v"),     # shoulders -> hips
    "neck":        ((1, 2), (5, 6), "v"),       # eyes -> shoulders
    "thigh":       ((11, 12), (13, 14), "v"),
    "shin":        ((13, 14), (15, 16), "v"),
    "shoulders":   ((5,), (6,), "w"),
    "hips":        ((11,), (12,), "w"),
    "ears":        ((3,), (4,), "w"),
    "eyes":        ((1,), (2,), "w"),
    "upper_arm_l": ((5,), (7,), "a"),
    "upper_arm_r": ((6,), (8,), "a"),
    "forearm_l":   ((7,), (9,), "a"),
    "forearm_r":   ((8,), (10,), "a"),
}
PART_LABEL = {"torso": "torso", "neck": "head+neck", "face": "face", "thigh": "legs",
              "shin": "legs", "shoulders": "shoulders", "hips": "hips", "ears": "head",
              "eyes": "head", "upper_arm_l": "arm", "upper_arm_r": "arm",
              "forearm_l": "arm", "forearm_r": "arm"}
PART_PRIORITY = ["torso", "neck", "face", "thigh", "shin", "shoulders", "hips", "ears",
                 "eyes", "upper_arm_l", "upper_arm_r", "forearm_l", "forearm_r"]


def parse_pose(output, ratio, pad_x, pad_y, conf_thr=POSE_CONF, nms_thr=NMS_THRESHOLD):
    """Turns a raw YOLOv8-pose ONNX output (1 x 56 x N: box, score, 17 x (x, y, conf))
    into [{x1, y1, x2, y2, conf, kps}] in ORIGINAL frame coordinates. kps is 17 x 3."""
    preds = np.squeeze(np.asarray(output))
    if preds.ndim != 2:
        return []
    if preds.shape[0] < preds.shape[1]:
        preds = preds.T                      # -> (N, 56)
    if preds.shape[1] < 56:
        return []
    scores = preds[:, 4]
    keep = scores >= conf_thr
    if not np.any(keep):
        return []
    preds, scores = preds[keep], scores[keep]
    cx, cy, bw, bh = preds[:, 0], preds[:, 1], preds[:, 2], preds[:, 3]
    x1 = (cx - bw / 2 - pad_x) / ratio
    y1 = (cy - bh / 2 - pad_y) / ratio
    x2 = (cx + bw / 2 - pad_x) / ratio
    y2 = (cy + bh / 2 - pad_y) / ratio
    kps = preds[:, 5:56].reshape(-1, 17, 3).astype(np.float64)
    kps[:, :, 0] = (kps[:, :, 0] - pad_x) / ratio
    kps[:, :, 1] = (kps[:, :, 1] - pad_y) / ratio
    nms_boxes = [[int(a), int(b), int(c - a), int(d - b)]
                 for a, b, c, d in zip(x1, y1, x2, y2)]
    idxs = cv2.dnn.NMSBoxes(nms_boxes, scores.astype(float).tolist(), conf_thr, nms_thr)
    idxs = np.array(idxs).flatten() if len(idxs) else []
    return [{"x1": float(x1[i]), "y1": float(y1[i]), "x2": float(x2[i]),
             "y2": float(y2[i]), "conf": float(scores[i]), "kps": kps[i]} for i in idxs]


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

        self.face_cc = None                 # Haar face detector (None = not available)
        self.face_error = None
        self._face_live = None              # face width (cm) refined while running
        self._warned_size = False
        self._face_tick = 0

        self.pose_net = None                # YOLOv8-pose (None = not available)
        self.pose_ok = False
        self.pose_error = None
        self._pose_tick = 0
        self._pose_cache = None             # (timestamp, persons)
        self._seg_live = {}                 # part ratios refined while running
        self._seg_seed = {}

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
        other = data.get("real_other_cm", self._settings["real_other_cm"])
        other = None if other in (None, "") else float(other)
        if not 0 <= cid < len(COCO_CLASSES):
            raise ValueError("Unknown object class.")
        if dim not in ("width", "height"):
            raise ValueError("Dimension must be width or height.")
        if not 1.0 <= size <= 1000.0:
            raise ValueError("Real size must be between 1 and 1000 cm.")
        if other is not None and not 1.0 <= other <= 1000.0:
            raise ValueError("Other-side size must be between 1 and 1000 cm.")
        with self._lock:
            self._settings.update(class_id=cid, dimension=dim, real_size_cm=size,
                                  real_other_cm=other)
            self._save_settings()
        self._reset_history()

    def reset_calibration(self):
        with self._lock:
            self._settings.update(focal_px=None, cal_width=None, cal_height=None,
                                  known_distance_cm=None, calibrated_at=None,
                                  cal_aspect=None, cal_face_cm=None, cal_seg=None)
            self._save_settings()
        self._reset_history()

    def _reset_history(self):
        self._face_live = None
        self._seg_live = {}
        self._seg_seed = {}
        self._pose_cache = None
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

    def _load_face(self):
        """Loads OpenCV's bundled frontal-face Haar cascade. Looks in models/ first
        (the patch copies it there), then wherever OpenCV keeps its data. If it
        cannot be found the estimator still works, just without the face ruler."""
        self.face_cc = None
        if self.simulate or not FACE_ENABLED:
            return
        dirs = [os.path.join(self.base_dir, "models")]
        data = getattr(cv2, "data", None)
        if data is not None and getattr(data, "haarcascades", None):
            dirs.append(data.haarcascades)
        dirs += ["/usr/share/opencv4/haarcascades", "/usr/share/opencv/haarcascades",
                 "/usr/local/share/opencv4/haarcascades", "/usr/local/share/opencv/haarcascades"]
        for d in dirs:
            path = os.path.join(d, FACE_CASCADE)
            if os.path.isfile(path):
                cc = cv2.CascadeClassifier(path)
                if not cc.empty():
                    self.face_cc, self.face_error = cc, None
                    print("distance: face cascade loaded from", d)
                    return
        self.face_error = "%s not found - copy it into models/" % FACE_CASCADE
        print("distance:", self.face_error, "(face ruler disabled)")

    def _load_model(self):
        self._model_tried = True
        self._load_face()
        self._load_pose()
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
    def _detect(self, frame, class_id, conf_thr=CONF_THRESHOLD):
        canvas, ratio, pad_x, pad_y = _letterbox(frame, YOLO_INPUT)
        blob = cv2.dnn.blobFromImage(canvas, 1 / 255.0, (YOLO_INPUT, YOLO_INPUT),
                                     swapRB=True, crop=False)
        self.net.setInput(blob)
        out = self.net.forward()
        return parse_yolov8(out, ratio, pad_x, pad_y, class_id, conf_thr=conf_thr)

    # ------------------------------------------- part-aware measuring (person)
    @staticmethod
    def _part_aware(s):
        """True for a person measured by height. The typed size may be anything (63 cm
        for an upper-body box is fine): it cancels out of the close-up formula, which
        works with part-to-box ratios learned at calibration."""
        return s["class_id"] == 0 and s["dimension"] == "height"

    def _check_size(self, s):
        if (s["class_id"] == 0 and s["dimension"] == "height" and not self._part_aware(s)
                and not self._warned_size):
            self._warned_size = True
            print("distance: part-aware mode is OFF - 'real size' is %.0f cm, which is not a "
                  "full standing height (%.0f-%.0f cm). Set it on the Calibration page and "
                  "recalibrate with the person standing full-body."
                  % (s["real_size_cm"], PERSON_MIN_CM, PERSON_MAX_CM))

    def _host_conf(self, s):
        # weak person boxes are only useful when a face can confirm them
        if self._part_aware(s) and self.face_cc is not None:
            return FACE_HOST_CONF
        return CONF_THRESHOLD

    def _find_face(self, gray, det):
        """Largest frontal face in the upper part of ONE person box, as a box in frame
        coordinates, or None. Searching only inside person boxes keeps Haar's false
        alarms out: a face counts only when the person detector agrees."""
        h, w = gray.shape[:2]
        bw, bh = det["x2"] - det["x1"], det["y2"] - det["y1"]
        x1, x2 = max(0, int(det["x1"])), min(w, int(det["x2"]))
        y1, y2 = max(0, int(det["y1"])), min(h, int(det["y1"] + FACE_SEARCH_FRAC * bh))
        if x2 - x1 < 30 or y2 - y1 < 30:
            return None
        roi = gray[y1:y2, x1:x2]
        sc = min(1.0, FACE_DETECT_WIDTH / roi.shape[1])      # only ever shrink
        if sc < 1.0:
            roi = cv2.resize(roi, None, fx=sc, fy=sc, interpolation=cv2.INTER_AREA)
        roi = cv2.equalizeHist(roi)
        min_px = max(FACE_MIN_PX, int(FACE_MIN_REL * roi.shape[1]))
        rects, _, weights = self.face_cc.detectMultiScale3(
            roi, 1.1, FACE_MIN_NEIGHBORS, minSize=(min_px, min_px), outputRejectLevels=True)
        cands = [(fx, fy, fw, fh, float(wt)) for (fx, fy, fw, fh), wt in zip(rects, weights)
                 if FACE_REL_MIN * bw <= fw / sc <= FACE_REL_MAX * bw]
        if not cands:
            return None

        def centre_in(a, b):
            cx, cy = a[0] + a[2] / 2.0, a[1] + a[3] / 2.0
            return b[0] <= cx <= b[0] + b[2] and b[1] <= cy <= b[1] + b[3]

        # Haar often returns the real face plus a few bigger "over-scale" boxes around the
        # same face (hair, neck). Seed on the strongest hit and take the SMALLEST box that
        # overlaps it. Measured on three different people this cut the frame-to-frame face
        # width error from 8-35 % (largest box) to 3-8 %.
        seed = max(cands, key=lambda c: c[4])
        cluster = [c for c in cands if centre_in(seed, c) or centre_in(c, seed)]
        fx, fy, fw, fh, _ = min(cluster, key=lambda c: c[2])
        return {"x1": x1 + fx / sc, "y1": y1 + fy / sc,
                "x2": x1 + (fx + fw) / sc, "y2": y1 + (fy + fh) / sc}

    def _attach_faces(self, frame, dets, s):
        """Returns the detections worth measuring. Person boxes get det["face"] (the face
        found inside, or None). A box below CONF_THRESHOLD survives only when a face
        confirms it - the usual look of a person who is too close to fit the frame."""
        if not (self._part_aware(s) and self.face_cc is not None):
            return [d for d in dets if d["conf"] >= CONF_THRESHOLD]
        h, w = frame.shape[:2]
        self._face_tick += 1
        periodic = (self._face_tick % FACE_LEARN_EVERY == 0
                    or time.time() < self._demand_until)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if dets else None
        kept = []
        for i, d in enumerate(sorted(dets, key=lambda d: d["conf"], reverse=True)):
            d["face"] = None
            if i < FACE_MAX_HOSTS and (periodic or d["conf"] < CONF_THRESHOLD
                                       or not self._clearly_whole(d, s, w, h)):
                d["face"] = self._find_face(gray, d)
            if d["conf"] >= CONF_THRESHOLD or d["face"] is not None:
                kept.append(d)
        return kept

    @staticmethod
    def _clearly_whole(d, s, w, h):
        """A box well inside the frame with the proportions of a standing person: no need
        to spend CPU looking for a face on every single pass."""
        mx, my = max(EDGE_MARGIN, EDGE_MARGIN_FRAC * w), max(EDGE_MARGIN, EDGE_MARGIN_FRAC * h)
        if d["x1"] <= mx or d["y1"] <= my or d["x2"] >= w - mx or d["y2"] >= h - my:
            return False
        bw, bh = d["x2"] - d["x1"], d["y2"] - d["y1"]
        exp_aspect = s.get("cal_aspect") or DEFAULT_PERSON_ASPECT
        return bh > 1 and bw / bh <= exp_aspect * FACE_SKIP_ASPECT

    def _learn_face(self, summ, s, w):
        """Whole body + face seen together = a trustworthy distance, so the face width
        in cm can be refined from it (per person, nothing to type). This keeps the
        reading continuous when the person then walks closer and the body no longer fits."""
        if (not summ or summ.get("side") != "height" or summ.get("any_clipped")
                or not summ.get("face_px") or summ.get("dist_inst") is None
                or not self._part_aware(s)):
            return
        f = self._focal_at(s, w)
        if not f:
            return
        implied = summ["face_px"] * summ["dist_inst"] / f
        cur = self._face_cm(s)
        if not 0.75 * cur <= implied <= 1.35 * cur:
            return                                            # outlier, ignore
        new = (1.0 - FACE_LEARN_ALPHA) * cur + FACE_LEARN_ALPHA * implied
        self._face_live = min(FACE_MAX_CM, max(FACE_MIN_CM, new))

    # ------------------------------------------------------ body-part rulers
    def _load_pose(self):
        """Optional pose model. Without it only the Haar face ruler exists."""
        self.pose_net, self.pose_ok = None, False
        if self.simulate or not POSE_ENABLED:
            return
        path = os.path.join(self.base_dir, "models", POSE_MODEL)
        if not os.path.exists(path):
            self.pose_error = ("models/%s not found - run export_pose_model.py for "
                               "reliable close-up measuring (optional)" % POSE_MODEL)
            print("distance:", self.pose_error)
            return
        try:
            self.pose_net = cv2.dnn.readNetFromONNX(path)
            self.pose_ok, self.pose_error = True, None
            print("distance: pose model loaded")
        except Exception as exc:
            self.pose_error = "could not load pose model: %s" % exc
            print("distance:", self.pose_error)

    def _run_pose(self, frame):
        canvas, ratio, pad_x, pad_y = _letterbox(frame, POSE_INPUT)
        blob = cv2.dnn.blobFromImage(canvas, 1 / 255.0, (POSE_INPUT, POSE_INPUT),
                                     swapRB=True, crop=False)
        self.pose_net.setInput(blob)
        return parse_pose(self.pose_net.forward(), ratio, pad_x, pad_y)

    @staticmethod
    def _iou(a, b):
        ix = max(0.0, min(a["x2"], b["x2"]) - max(a["x1"], b["x1"]))
        iy = max(0.0, min(a["y2"], b["y2"]) - max(a["y1"], b["y1"]))
        inter = ix * iy
        union = ((a["x2"] - a["x1"]) * (a["y2"] - a["y1"])
                 + (b["x2"] - b["x1"]) * (b["y2"] - b["y1"]) - inter)
        return inter / union if union > 0 else 0.0

    def _attach_pose(self, frame, dets, s, w, h):
        """Adds det["kps"] (17 keypoints) to the person boxes. A person the pose model
        sees but the box detector missed (typical when you are too close) is added as
        a box of its own. The pose model is not run on every pass to save CPU."""
        if self.pose_net is None or not self._part_aware(s):
            return dets
        self._pose_tick += 1
        now = time.time()
        calibrating = now < self._demand_until
        cache = self._pose_cache
        fresh = cache is not None and now - cache[0] <= POSE_CACHE_SECONDS
        if not dets and not calibrating:
            need = self._pose_tick % POSE_IDLE_EVERY == 0
        else:
            need = (calibrating or not fresh or self._pose_tick % POSE_EVERY == 0
                    or any(not self._clearly_whole(d, s, w, h) for d in dets))
        if need:
            try:
                persons = self._run_pose(frame)
            except Exception as exc:
                print("distance: pose error:", exc)
                persons = []
            self._pose_cache = (now, persons)
        else:
            persons = cache[1] if fresh else []

        used = set()
        for d in dets:
            best, bi = 0.0, -1
            for i, p in enumerate(persons):
                v = self._iou(d, p)
                if v > best:
                    best, bi = v, i
            if bi >= 0 and best >= POSE_MATCH_IOU:
                d["kps"] = persons[bi]["kps"]
                used.add(bi)
        if need:                                       # only add from a fresh pass
            gray = None
            for i, p in enumerate(persons):
                if i in used or p["conf"] < POSE_NEW_CONF:
                    continue
                if any(self._iou(d, p) >= 0.10 for d in dets):
                    continue
                nd = {"x1": p["x1"], "y1": p["y1"], "x2": p["x2"], "y2": p["y2"],
                      "conf": p["conf"], "kps": p["kps"], "face": None}
                if self.face_cc is not None:
                    if gray is None:
                        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                    nd["face"] = self._find_face(gray, nd)
                dets.append(nd)
        return dets

    @staticmethod
    def _pose_parts(kps, w, h):
        """Pixel length of every body part whose two ends are both visible."""
        mx, my = KP_EDGE_FRAC * w, KP_EDGE_FRAC * h

        def visible(i):
            x, y, c = kps[i]
            return c >= KP_CONF and mx <= x <= w - mx and my <= y <= h - my

        def point(group):
            pts = [(kps[i][0], kps[i][1]) for i in group if visible(i)]
            if not pts:
                return None
            return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))

        out = {}
        for name, (ga, gb, kind) in BODY_PARTS.items():
            a, b = point(ga), point(gb)
            if a is None or b is None:
                continue
            if kind in ("w", "a") and (len(ga) != 1 or len(gb) != 1):
                continue
            length = math.hypot(a[0] - b[0], a[1] - b[1])
            if length >= PART_MIN_PX:
                out[name] = float(length)
        return out

    def _part_pixels(self, det, w, h):
        """{part: pixel length} for everything measurable on this person box."""
        parts = {}
        face = det.get("face")
        if face:
            fw = face["x2"] - face["x1"]
            if fw >= PART_MIN_PX:
                parts["face"] = float(fw)
        kps = det.get("kps")
        if kps is not None:
            parts.update(self._pose_parts(kps, w, h))
        return parts

    def _part_ratio(self, s, name):
        """part_px / box_px learned at calibration (refined live), or None."""
        return self._seg_live.get(name) or (s.get("cal_seg") or {}).get(name)

    @staticmethod
    def _combine_parts(cands):
        """cands: [(name, kind, distance_cm, part_px)] -> (label, cm, px, approx) or None.
        Vertical parts + face: median of their estimates. Only widths (or only arms):
        the SMALLEST distance wins, because turning the body makes a width look
        shorter, i.e. the person look farther than they are. Widths/arms are approx."""
        if not cands:
            return None
        good = [c for c in cands if c[1] in ("v", "f")]
        if good:
            pool, dist, approx = good, float(np.median([c[2] for c in good])), False
        else:
            wide = [c for c in cands if c[1] == "w"]
            arms = [c for c in cands if c[1] == "a"]
            pool = wide or arms
            if not pool:
                return None
            dist, approx = float(min(c[2] for c in pool)), True
        order = {n: i for i, n in enumerate(PART_PRIORITY)}
        best = min(pool, key=lambda c: order.get(c[0], 99))
        return PART_LABEL.get(best[0], best[0]), dist, float(best[3]), approx

    def _pick_part(self, parts, s, w):
        f = self._focal_at(s, w)
        if not f or not parts:
            return None
        cands = []
        for name, px in parts.items():
            r = self._part_ratio(s, name)
            if not r or px < PART_MIN_PX:
                continue
            kind = "f" if name == "face" else BODY_PARTS[name][2]
            cands.append((name, kind, s["real_size_cm"] * f * r / px, px))
        return self._combine_parts(cands)

    def _learn_parts(self, summ, s):
        """Whole box inside the frame + parts seen together = trustworthy ratios.
        This keeps the reading continuous when you then walk up to the camera."""
        if (not summ or summ.get("side") != "height" or summ.get("any_clipped")
                or not summ.get("segs") or not self._part_aware(s) or summ["px"] <= 1):
            return
        body = summ["px"]
        saved = s.get("cal_seg") or {}
        for name, px in summ["segs"].items():
            obs = px / body
            cur = self._seg_live.get(name) or saved.get(name)
            if cur:
                if 0.75 * cur <= obs <= 1.30 * cur:
                    self._seg_live[name] = (1.0 - PART_LEARN_ALPHA) * cur + PART_LEARN_ALPHA * obs
            elif 0.02 <= obs <= 1.2:
                seed = self._seg_seed.setdefault(name, deque(maxlen=5))
                seed.append(obs)
                if len(seed) >= PART_SEED_SAMPLES:
                    self._seg_live[name] = float(np.median(seed))

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
    @staticmethod
    def _focal_at(s, frame_w):
        f = s["focal_px"]
        if f and s["cal_width"]:
            f = f * frame_w / s["cal_width"]     # camera resolution changed
        return f

    def _raw_distance(self, px, frame_w, s, size_cm=None):
        f = self._focal_at(s, frame_w)
        if not f or px is None or px <= 1:
            return None
        return (size_cm or s["real_size_cm"]) * f / px

    def _face_cm(self, s):
        """Face width in cm: refined live > measured at calibration > default."""
        return self._face_live or s.get("cal_face_cm") or FACE_DEFAULT_CM

    @staticmethod
    def _other_size_cm(s):
        """Real size of the side that is NOT the main measured one, or None
        when it is unknown (nothing typed in and not calibrated yet)."""
        if s.get("real_other_cm"):
            return float(s["real_other_cm"])
        aspect = s.get("cal_aspect")              # box width / height
        if not aspect and DistanceEstimator._part_aware(s):
            aspect = DEFAULT_PERSON_ASPECT        # nothing learned yet: typical person
        if not aspect:
            return None
        if s["dimension"] == "height":
            return s["real_size_cm"] * aspect     # width  = height * (w/h)
        return s["real_size_cm"] / aspect         # height = width  / (w/h)

    def _pick_ruler(self, det, s, bw, bh, clip_x, clip_y, aspect, other_cm):
        """Person measured by height. Decides WHICH part of the body the box really
        covers and returns (px, size_cm, side, clipped, face_px):
          height : the whole body is in the box            (most accurate)
          face   : a face was found -> use the face width   (body cut off / zoomed in)
          width  : no face -> box width vs the learned body width (rough)
          none   : nothing dependable, size_cm is None -> no number instead of a wrong one"""
        face_px = None
        full = None                                # is this box a whole standing body?
        face = det.get("face")
        if face:
            fw = face["x2"] - face["x1"]
            if fw > 1:
                # height a whole body would have if its face is this wide
                ratio = bh / (fw * s["real_size_cm"] / self._face_cm(s))
                if ratio <= FULL_BODY_RATIO_MAX:   # bigger = false face / merged people
                    face_px = float(fw)
                    full = ratio >= FULL_BODY_RATIO_MIN
                    if clip_y and ratio < FULL_BODY_RATIO_EDGE:
                        full = False               # touches the edge: legs probably cut
        if full is None:                           # no usable face: judge by edge and shape
            exp_aspect = s.get("cal_aspect") or DEFAULT_PERSON_ASPECT
            wide = bool(aspect and aspect >= exp_aspect * PARTIAL_ASPECT_FACTOR)
            full = (not clip_y) and not wide
        if full:
            return bh, s["real_size_cm"], "height", False, face_px
        if face_px:
            return face_px, self._face_cm(s), "face", False, face_px
        if other_cm and not clip_x:
            return bw, other_cm, "width", False, None
        return bh, None, "height", True, None

    def _summary(self, det, s, w, h):
        x1, y1 = max(0.0, det["x1"]), max(0.0, det["y1"])
        x2, y2 = min(float(w), det["x2"]), min(float(h), det["y2"])
        bw, bh = det["x2"] - det["x1"], det["y2"] - det["y1"]
        mx, my = max(EDGE_MARGIN, EDGE_MARGIN_FRAC * w), max(EDGE_MARGIN, EDGE_MARGIN_FRAC * h)
        clip_x = det["x1"] <= mx or det["x2"] >= w - mx
        clip_y = det["y1"] <= my or det["y2"] >= h - my
        aspect = float(bw / bh) if bh > 1 else None

        main = s["dimension"]
        if main == "width":
            px, clipped, other_px, other_clipped = bw, clip_x, bh, clip_y
        else:
            px, clipped, other_px, other_clipped = bh, clip_y, bw, clip_x
        size_cm, side, face_px = s["real_size_cm"], main, None
        other_cm = self._other_size_cm(s)

        part_dist, part_approx, parts = None, False, {}
        if self._part_aware(s):
            # A person measured by height. The box is trusted while it is the same kind
            # of box that was calibrated (inside the frame, not far wider than it was).
            # When the frame cuts it, use the body parts that are still visible.
            parts = self._part_pixels(det, w, h)
            exp_aspect = s.get("cal_aspect") or DEFAULT_PERSON_ASPECT
            wide = bool(aspect and aspect >= exp_aspect * PARTIAL_ASPECT_FACTOR)
            if (not clip_y) and not wide:
                px, size_cm, side, clipped = bh, s["real_size_cm"], "height", False
            else:
                px, size_cm, side, clipped = bh, None, "height", True
                pick = self._pick_part(parts, s, w)
                if pick:
                    side, part_dist, px, part_approx = pick
                    clipped = False
        elif clipped and not other_clipped and other_cm:
            # Main side is cut off by the frame but the other side is fully
            # visible: measure with the other side instead.
            px, size_cm = other_px, other_cm
            side = "width" if main == "height" else "height"
            clipped = False

        if part_dist is not None:
            dist = part_dist
        else:
            dist = self._raw_distance(px, w, s, size_cm) if size_cm else None
        return {"bbox": [x1, y1, x2 - x1, y2 - y1], "px": float(px),
                "conf": det.get("conf", 1.0), "clipped": bool(clipped),
                "side": side,
                "any_clipped": bool(clip_x or clip_y),
                "aspect": aspect,
                "face_px": None,
                "segs": {k: round(float(v), 1) for k, v in parts.items()},
                "approx": bool(part_approx
                               or (side == "width" and size_cm and side != main)),
                "motion": det.get("motion", 0.0),
                "dist_inst": dist,
                "distance_cm": dist}

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
            self._check_size(s)
            dets = self._attach_faces(
                frame, self._detect(frame, s["class_id"], self._host_conf(s)), s)
            dets = self._attach_pose(frame, dets, s, w, h)
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
            self._learn_face(raw_sum, s, w)
            self._learn_parts(raw_sum, s)
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
            if d is not None:
                label = ("~%.0f cm" if target.get("approx") else "%.0f cm") % d
            elif calibrated and target["clipped"]:
                label = "part only"
            else:
                label = "%.0f px" % target["px"]
            if d is not None and target["clipped"]:
                label += " (cut off)"
            elif d is not None and target.get("side") and target["side"] != s["dimension"]:
                label += " (by %s)" % target["side"]
            (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, scale, thick)
            hud_bottom = int(h * 0.02) + int(36 * scale) + 6      # keep clear of the HUD text
            ly = y - 8 if y - th - 12 > hud_bottom else y + th + 10
            self._put_text(out, label, (max(2, x), ly), scale, color, thick)

        if not calibrated:
            hud = "Distance: not calibrated"
        elif target and target["distance_cm"] is not None:
            hud = "Distance: %s%.0f cm" % ("~" if target.get("approx") else "",
                                              target["distance_cm"])
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
        samples, aspects, faces, last_ts = [], [], [], 0.0
        part_obs = []                       # (box px, {part: px}) per good sample
        frame_w = frame_h = None
        deadline = time.time() + CALIBRATION_TIMEOUT
        while time.time() < deadline and len(samples) < CALIBRATION_SAMPLES:
            with self._lock:
                res = self._result
            if res and res["ts"] > last_ts and time.time() - res["ts"] < 1.0:
                last_ts = res["ts"]
                raw = res["raw"]
                # only a fully visible box measured on the MAIN side counts
                if (raw and not raw["any_clipped"] and raw["side"] == s["dimension"]
                        and raw["aspect"]):
                    samples.append(raw["px"])
                    aspects.append(raw["aspect"])
                    if raw.get("face_px"):
                        faces.append(raw["face_px"])
                    part_obs.append((raw["px"], raw.get("segs") or {}))
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
        aspect = float(np.median(aspects))
        # face width in cm, measured on the person standing in front of the camera
        face_cm = None
        if self._part_aware(s) and len(faces) >= max(3, len(samples) // 3):
            cand = float(np.median(faces)) * s["real_size_cm"] / median
            if FACE_MIN_CM <= cand <= FACE_MAX_CM:
                face_cm = cand
        # size of every visible body part relative to the calibration box
        seg_cal = {}
        for name in {n for _, d in part_obs for n in d}:
            rs = [d[name] / p for p, d in part_obs if name in d and p > 1]
            if len(rs) >= max(3, len(part_obs) // 3):
                r = float(np.median(rs))
                if 0.02 <= r <= 1.2:
                    seg_cal[name] = r
        with self._lock:
            self._settings.update(
                focal_px=focal, cal_width=frame_w, cal_height=frame_h,
                known_distance_cm=known, cal_aspect=aspect, cal_face_cm=face_cm,
                cal_seg=seg_cal or None,
                calibrated_at=datetime.now().isoformat(timespec="seconds"))
            self._save_settings()
        self._reset_history()
        return {"focal_px": focal, "pixel_size": median, "samples": len(core),
                "spread_pct": spread * 100, "frame_w": frame_w, "frame_h": frame_h,
                "face_cm": face_cm,
                "parts": sorted(seg_cal), "pose_ok": self.pose_ok}

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
            "pose_ok": self.pose_ok,
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
