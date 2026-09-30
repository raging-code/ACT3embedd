#!/usr/bin/env node
/**
 * patch-close-range-distance.mjs
 * ---------------------------------------------------------------------------
 * Fixes the wrong distance when you stand too close / the camera is zoomed in
 * and only a PART of the body (head, shoulders, torso, arms ...) is in frame.
 *
 * WHY IT WAS WRONG  (found by reading the repo + your data/calibration.json)
 *   distance = real_size * focal / box_height.
 *   Your calibration says real_size = 63 cm, i.e. the thing you calibrated on
 *   was "what the camera sees of you" (upper body), not a 170 cm standing
 *   person. Two things then went wrong when you got closer:
 *     1. The earlier partial-body patch only switches on when real_size is
 *        120-230 cm. With 63 it stayed OFF, so a cut-off box (471 px of a
 *        480 px frame in your screenshot) was still divided by 63 cm.
 *        471 px -> 63 * 774 / 471 = 103 cm, exactly the number on screen,
 *        although the box was cut by the frame and you were much nearer.
 *     2. Even with it ON, that patch compares the box with an ABSOLUTE
 *        15 cm face / 170 cm body, which is wrong for an upper-body box.
 *
 * THE FIX  (box-relative, learned from YOUR calibration - nothing to type)
 *   - While calibrating (box fully inside the frame) the app now also measures
 *     how big each visible body part is compared with the calibration box:
 *     face, neck (eyes-shoulders), shoulders, torso, hips, thigh, shin, arms.
 *     Those ratios are saved as "cal_seg" in data/calibration.json and are
 *     refined while the app runs whenever the whole box is visible.
 *   - Live: box inside the frame  -> box height (as before, accurate).
 *           box cut by the frame  -> every visible part gives an estimate
 *                                    distance = size_cm * focal * ratio / part_px
 *                                    vertical parts (torso, neck, face, legs)
 *                                    are combined by median, widths (shoulders,
 *                                    hips, eyes, ears) use the largest estimate
 *                                    of "how near" because turning shrinks them,
 *                                    arms are the last resort (shown with "~").
 *           nothing usable        -> "part only" and NO number (never a wrong one).
 *   - Real size no longer has to be a "real" height: the typed size cancels out
 *     of the formula, so 63 is fine. The 120-230 cm gate is gone.
 *   - OPTIONAL but strongly recommended: a small pose model
 *     (models/yolov8n-pose.onnx, made once with export_pose_model.py, which this
 *     patch creates). It finds shoulders / torso / eyes / ears even when the face
 *     is not frontal. Without it only the Haar FACE ruler exists (frontal faces
 *     only) - the app still runs, it just says "part only" more often.
 *
 * WHAT YOU MUST DO AFTER PATCHING
 *   1. (recommended) pip install ultralytics onnx ; python export_pose_model.py
 *   2. Restart the app, open Calibration, and calibrate again in the SAME
 *      framing you will use (whole box inside the frame, relaxed arms, facing
 *      the camera). The parts learned there are what the close-up reading uses.
 *
 * LIMITS (be aware)
 *   - Calibrate with the framing you measure in. If you calibrate on the upper
 *     body and later step far back so the whole body shows, the box is a
 *     different "object" than the calibrated one and the number will be low.
 *   - Widths (shoulders, ears, face) shrink when you turn sideways and the
 *     reading then comes out TOO FAR by 1/cos(turn angle) (about +30 % at 40
 *     degrees). The code prefers vertical parts (torso, neck, legs) for that
 *     reason, and marks width-only / arm-only readings with "~" (approximate).
 *     In a synthetic camera test with a noise-free skeleton, vertical parts were
 *     within about 1 %; expect real-world +-5-10 % (pose keypoint jitter, people
 *     differ). Arms are the roughest ruler.
 *   - Pose adds CPU: the model runs every 3rd pass (and on every pass while the
 *     box is cut off / calibrating). Lower POSE_EVERY cost on a Raspberry Pi by
 *     raising POSE_EVERY or lowering POSE_INPUT (must match the export size).
 *
 * Usage:
 *     node patch-close-range-distance.mjs                 # patch ./
 *     node patch-close-range-distance.mjs /path/to/repo
 *     node patch-close-range-distance.mjs --dry-run
 *
 * Safe to re-run (already patched -> skipped). Original saved as
 * distance.py.before-close-range.bak. If distance.py does not match what the
 * script expects, NOTHING is written.
 *
 * Files changed: distance.py, static/calibrate.js (one message, optional)
 * Files added:   export_pose_model.py
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const root = path.resolve(args.find((a) => !a.startsWith("--")) || ".");

/* ------------------------------------------------------------- helpers */

function replaceOnce(src, oldStr, newStr, label) {
  const first = src.indexOf(oldStr);
  if (first === -1) throw new Error(`could not find: ${label}`);
  if (src.indexOf(oldStr, first + 1) !== -1) throw new Error(`found more than once: ${label}`);
  return src.slice(0, first) + newStr + src.slice(first + oldStr.length);
}

// Replaces everything from startMarker up to (not including) endMarker.
function replaceBlock(src, startMarker, endMarker, newBlock, label) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a + 1);
  if (a === -1 || b === -1 || b <= a) throw new Error(`could not find block: ${label}`);
  if (src.indexOf(startMarker, a + 1) !== -1) throw new Error(`start marker found more than once: ${label}`);
  return src.slice(0, a) + newBlock + src.slice(b);
}

/* --------------------------------------------------------- distance.py */
function patchDistancePy(s) {
  /* 1. tunables ---------------------------------------------------------- */
  s = replaceOnce(
    s,
    String.raw`CALIBRATION_SAMPLES = 15
`,
    String.raw`# --- body-part rulers (box-relative, learned at calibration) ----------------
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
`,
    "tunables"
  );

  /* 2. settings ---------------------------------------------------------- */
  s = replaceOnce(
    s,
    String.raw`    "cal_face_cm": None,         # face width in cm measured during calibration
                                 # (None = FACE_DEFAULT_CM)
`,
    String.raw`    "cal_face_cm": None,         # face width in cm measured during calibration
                                 # (None = FACE_DEFAULT_CM)  [legacy, unused now]
    "cal_seg": None,             # {part: part_px / box_px} learned at calibration;
                                 # the close-up ruler ("cut off" boxes) uses these
`,
    "settings"
  );

  /* 3. module level: body parts + pose parser --------------------------- */
  s = replaceOnce(
    s,
    String.raw`class DistanceEstimator:
`,
    String.raw`# COCO keypoints: 0 nose 1/2 eyes 3/4 ears 5/6 shoulders 7/8 elbows 9/10 wrists
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
`,
    "module level parts"
  );

  /* 4. __init__ ---------------------------------------------------------- */
  s = replaceOnce(
    s,
    String.raw`        self._face_tick = 0
`,
    String.raw`        self._face_tick = 0

        self.pose_net = None                # YOLOv8-pose (None = not available)
        self.pose_ok = False
        self.pose_error = None
        self._pose_tick = 0
        self._pose_cache = None             # (timestamp, persons)
        self._seg_live = {}                 # part ratios refined while running
        self._seg_seed = {}
`,
    "__init__"
  );

  /* 5. reset calibration / history -------------------------------------- */
  s = replaceOnce(
    s,
    String.raw`                                  cal_aspect=None, cal_face_cm=None)
`,
    String.raw`                                  cal_aspect=None, cal_face_cm=None, cal_seg=None)
`,
    "reset_calibration"
  );
  s = replaceOnce(
    s,
    String.raw`    def _reset_history(self):
        self._face_live = None
`,
    String.raw`    def _reset_history(self):
        self._face_live = None
        self._seg_live = {}
        self._seg_seed = {}
        self._pose_cache = None
`,
    "_reset_history"
  );

  /* 6. part-aware no longer depends on the typed size ------------------- */
  s = replaceBlock(
    s,
    String.raw`    def _part_aware(s):`,
    String.raw`    def _check_size(self, s):`,
    String.raw`    def _part_aware(s):
        """True for a person measured by height. The typed size may be anything (63 cm
        for an upper-body box is fine): it cancels out of the close-up formula, which
        works with part-to-box ratios learned at calibration."""
        return s["class_id"] == 0 and s["dimension"] == "height"

`,
    "_part_aware"
  );

  /* 7. model loading ----------------------------------------------------- */
  s = replaceOnce(
    s,
    String.raw`        self._model_tried = True
        self._load_face()
`,
    String.raw`        self._model_tried = True
        self._load_face()
        self._load_pose()
`,
    "_load_model"
  );

  /* 8. face search on every pass while calibrating ---------------------- */
  s = replaceOnce(
    s,
    String.raw`        periodic = self._face_tick % FACE_LEARN_EVERY == 0
`,
    String.raw`        periodic = (self._face_tick % FACE_LEARN_EVERY == 0
                    or time.time() < self._demand_until)
`,
    "face periodic"
  );

  /* 9. new methods (before _motion_mask) --------------------------------- */
  s = replaceOnce(
    s,
    String.raw`    def _motion_mask(self, frame, now):
`,
    String.raw`    # ------------------------------------------------------ body-part rulers
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
`,
    "new methods"
  );

  /* 10. _summary: the actual close-up logic ------------------------------ */
  s = replaceBlock(
    s,
    String.raw`        if self._part_aware(s):
            px, size_cm, side, clipped, face_px = self._pick_ruler(`,
    String.raw`    @staticmethod
    def _smooth(hist, summary):`,
    String.raw`        part_dist, part_approx, parts = None, False, {}
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

`,
    "_summary"
  );

  /* 11. _process: attach pose ------------------------------------------- */
  s = replaceOnce(
    s,
    String.raw`            dets = self._attach_faces(
                frame, self._detect(frame, s["class_id"], self._host_conf(s)), s)
`,
    String.raw`            dets = self._attach_faces(
                frame, self._detect(frame, s["class_id"], self._host_conf(s)), s)
            dets = self._attach_pose(frame, dets, s, w, h)
`,
    "_process"
  );

  /* 12. _publish: learn part ratios while running ------------------------ */
  s = replaceOnce(
    s,
    String.raw`            self._learn_face(raw_sum, s, w)
`,
    String.raw`            self._learn_face(raw_sum, s, w)
            self._learn_parts(raw_sum, s)
`,
    "_publish"
  );

  /* 13. calibrate(): learn the part ratios ------------------------------- */
  s = replaceOnce(
    s,
    String.raw`        samples, aspects, faces, last_ts = [], [], [], 0.0
`,
    String.raw`        samples, aspects, faces, last_ts = [], [], [], 0.0
        part_obs = []                       # (box px, {part: px}) per good sample
`,
    "calibrate: init"
  );
  s = replaceOnce(
    s,
    String.raw`                    if raw.get("face_px"):
                        faces.append(raw["face_px"])
`,
    String.raw`                    if raw.get("face_px"):
                        faces.append(raw["face_px"])
                    part_obs.append((raw["px"], raw.get("segs") or {}))
`,
    "calibrate: sample"
  );
  s = replaceOnce(
    s,
    String.raw`        with self._lock:
            self._settings.update(
                focal_px=focal,`,
    String.raw`        # size of every visible body part relative to the calibration box
        seg_cal = {}
        for name in {n for _, d in part_obs for n in d}:
            rs = [d[name] / p for p, d in part_obs if name in d and p > 1]
            if len(rs) >= max(3, len(part_obs) // 3):
                r = float(np.median(rs))
                if 0.02 <= r <= 1.2:
                    seg_cal[name] = r
        with self._lock:
            self._settings.update(
                focal_px=focal,`,
    "calibrate: ratios"
  );
  s = replaceOnce(
    s,
    String.raw`known_distance_cm=known, cal_aspect=aspect, cal_face_cm=face_cm,
`,
    String.raw`known_distance_cm=known, cal_aspect=aspect, cal_face_cm=face_cm,
                cal_seg=seg_cal or None,
`,
    "calibrate: save"
  );
  s = replaceOnce(
    s,
    String.raw`"face_cm": face_cm}`,
    String.raw`"face_cm": face_cm,
                "parts": sorted(seg_cal), "pose_ok": self.pose_ok}`,
    "calibrate: result"
  );

  /* 14. live() ------------------------------------------------------------ */
  s = replaceOnce(
    s,
    String.raw`            "calibrated": bool(s["focal_px"]),
`,
    String.raw`            "calibrated": bool(s["focal_px"]),
            "pose_ok": self.pose_ok,
`,
    "live"
  );

  return s;
}

/* ----------------------------------------------------- calibrate.js msg */
function patchCalibrateJs(s) {
  return replaceOnce(
    s,
    String.raw`(raw.clipped ? " · cut off by the frame edge, unreliable" : "") +`,
    String.raw`(raw.clipped ? " · too close: no body part I can measure with - step back" : "") +
        (raw.approx && !raw.clipped ? " · approximate" : "") +`,
    "calibrate.js message"
  );
}

const EXPORT_POSE = `"""
Creates models/yolov8n-pose.onnx (OPTIONAL) - lets the distance measurement use
shoulders / torso / eyes / ears when you are too close for the whole body to fit.

Run ONCE on any normal PC, then copy the models/ folder next to app.py:

    pip install ultralytics onnx
    python export_pose_model.py

IMGSZ must match POSE_INPUT in distance.py (default 416).
"""
import os
from ultralytics import YOLO

IMGSZ = 416

model = YOLO("yolov8n-pose.pt")          # downloads the small pretrained model
exported = model.export(format="onnx", imgsz=IMGSZ, opset=12, simplify=False, dynamic=False)

os.makedirs("models", exist_ok=True)
dest = os.path.join("models", "yolov8n-pose.onnx")
os.replace(exported, dest)
print("Saved", dest)
`;

/* ------------------------------------------------------------- runner */
console.log(`Target folder: ${root}${dryRun ? "  (dry run)" : ""}`);

function readNormalised(file) {
  const raw = fs.readFileSync(file, "utf8");
  const crlf = raw.includes("\r\n");
  return { crlf, text: crlf ? raw.replace(/\r\n/g, "\n") : raw };
}

const pyRel = "distance.py";
const pyFile = path.join(root, pyRel);
if (!fs.existsSync(pyFile)) {
  console.error(`  ✗ ${pyRel}: file not found (is this the repo folder?)`);
  process.exit(1);
}
const py = readNormalised(pyFile);

let plannedPy = null;
if (py.text.includes("POSE_ENABLED")) {
  console.log(`  • ${pyRel}: already patched, skipping`);
} else {
  if (!py.text.includes("FACE_DEFAULT_CM")) {
    console.error(
      `  ✗ ${pyRel}: 'patch-partial-body-distance.mjs' has not been applied to this file.\n` +
        `    Run that one first, then this script.`
    );
    process.exit(1);
  }
  try {
    let out = patchDistancePy(py.text);
    if (py.crlf) out = out.replace(/\n/g, "\r\n");
    plannedPy = out;
    console.log(`  ✓ ${pyRel}: ok`);
  } catch (err) {
    console.error(`  ✗ ${pyRel}: ${err.message}`);
    console.error("\nNothing was written. distance.py differs from what this patch expects.");
    process.exit(1);
  }
}

// optional UI message - a mismatch here only skips this file
const jsRel = path.join("static", "calibrate.js");
const jsFile = path.join(root, jsRel);
let plannedJs = null;
let jsCrlf = false;
if (fs.existsSync(jsFile)) {
  const js = readNormalised(jsFile);
  jsCrlf = js.crlf;
  if (js.text.includes("step back")) {
    console.log(`  • ${jsRel}: already patched, skipping`);
  } else {
    try {
      plannedJs = patchCalibrateJs(js.text);
      if (js.crlf) plannedJs = plannedJs.replace(/\n/g, "\r\n");
      console.log(`  ✓ ${jsRel}: ok`);
    } catch (err) {
      console.log(`  ! ${jsRel}: ${err.message} - skipped (only a status message, not needed)`);
    }
  }
}

const exportDest = path.join(root, "export_pose_model.py");
const needExport = !fs.existsSync(exportDest);
console.log(needExport ? "  ✓ export_pose_model.py: will be created" : "  • export_pose_model.py: already there");

if (dryRun || (!plannedPy && !plannedJs && !needExport)) {
  console.log(dryRun ? "\nDry run finished, no files written." : "\nNothing to do.");
  process.exit(0);
}

if (plannedPy) {
  const bak = pyFile + ".before-close-range.bak";
  fs.copyFileSync(pyFile, bak);
  fs.writeFileSync(pyFile, plannedPy, "utf8");
  console.log(`  wrote ${pyRel}  (backup: ${path.basename(bak)})`);
}
if (plannedJs) {
  fs.copyFileSync(jsFile, jsFile + ".before-close-range.bak");
  fs.writeFileSync(jsFile, plannedJs, "utf8");
  console.log(`  wrote ${jsRel}`);
}
if (needExport) {
  fs.writeFileSync(exportDest, EXPORT_POSE, "utf8");
  console.log("  wrote export_pose_model.py");
}

console.log(`
Done. Next steps:
  1. (recommended) on any PC:   pip install ultralytics onnx
                                python export_pose_model.py
     then keep models/yolov8n-pose.onnx next to models/yolov8n.onnx.
     The app log should show "pose model loaded" after a restart.
  2. Restart the app and open the Calibration page. CALIBRATE AGAIN, standing
     the way you will be measured (whole box inside the frame, arms relaxed, facing
     the camera). The result now lists the body parts it learned.
  3. Test by walking toward the camera. Readout: "NNN cm" while the box fits, then
     "NNN cm (by torso / head+neck / face / shoulders)" once the frame cuts you,
     "~NNN cm" for rough parts, and "part only" with no number if nothing is usable.
`);
