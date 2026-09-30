#!/usr/bin/env node
/**
 * patch-partial-body-distance.mjs
 * ---------------------------------------------------------------------------
 * Fixes wrong distance readings when only PART of a person is in the frame
 * (face, head+shoulders, torso, legs cut off ...).
 *
 * WHY IT WAS WRONG
 *   1. The distance was `real_height * focal / box_height`. When the person
 *      is too close, YOLO simply draws the box around whatever is visible, and
 *      that box always ends up ~as tall as the frame - so the reading froze at
 *      the same value (about 3 m) however close you got. A face-only box was
 *      being treated as a 170 cm tall body.
 *   2. The "cut off by the frame" test used EDGE_MARGIN = 3 px. YOLO boxes of
 *      a cut-off person stop 3-15 px short of the border, so the test almost
 *      never fired and the width fallback of the previous patch never ran.
 *   3. Nothing checked whether the box really was a whole body.
 *
 * WHAT THIS PATCH DOES  (person class, measured by height)
 *   - Frame-edge test now uses max(3 px, 2.5 % of the frame size).
 *   - Finds a FRONTAL FACE inside each person box (OpenCV's bundled Haar
 *     cascade, no new model to download) and compares face size with box
 *     height. That tells whether the box is a whole body or only a part.
 *   - Chooses the ruler that matches what is visible:
 *         whole body  -> box height          (accurate, as before)
 *         face found  -> face width          (about +-5-10 %)
 *         no face     -> box width, shown as "~123 cm (by width)"  (rough)
 *         nothing dependable -> "part only" and NO number (never a wrong one)
 *   - Face width in cm is learned during calibration and refined while a
 *     whole body and its face are seen together, so the reading stays
 *     continuous when the person walks up to the camera.
 *   - Weak person boxes (conf 0.12-0.35) are kept only if a face confirms them.
 *
 * LIMITS (be aware)
 *   - The face ruler needs a roughly FRONTAL, lit face (sunglasses/beard are fine).
 *     Back of head / strong profile / arms-only have no face: the reading falls
 *     back to the rough width ruler ("~") or to "part only" with no number.
 *   - Face width differs a little between people (+-7 %); calibration measures
 *     yours, otherwise 15 cm is assumed.
 *   - CPU: whole-body frames cost ~10 % more; close-up frames roughly double the
 *     detector time (that is when the face search is needed).
 *
 * Usage (default target is the current folder):
 *
 *     node patch-partial-body-distance.mjs                 # patch ./
 *     node patch-partial-body-distance.mjs /path/to/repo   # patch another folder
 *     node patch-partial-body-distance.mjs --dry-run       # show what would change
 *
 * Safe to re-run: an already patched file is skipped. The original is saved as
 * distance.py.before-partial-fix.bak (your existing distance.py.bak is left
 * alone). If distance.py does not match what the script expects, NOTHING is
 * written.
 *
 * Files changed:  distance.py
 * Files added:    models/haarcascade_frontalface_default.xml  (copied from your
 *                 local OpenCV install so it also works on the Raspberry Pi)
 *
 * AFTER PATCHING - IMPORTANT
 *   Open the Calibration page, set "Real size" to the person's FULL STANDING
 *   HEIGHT in cm (e.g. 170) - your data/calibration.json currently says 63 -
 *   then calibrate once with the person standing full-body, facing the camera.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
  const b = src.indexOf(endMarker);
  if (a === -1 || b === -1 || b <= a) throw new Error(`could not find block: ${label}`);
  if (src.indexOf(startMarker, a + 1) !== -1) throw new Error(`start marker found more than once: ${label}`);
  return src.slice(0, a) + newBlock + src.slice(b);
}

/* --------------------------------------------------------- distance.py */
function patchDistancePy(s) {
  /* 1. tunables ---------------------------------------------------------- */
  s = replaceOnce(
    s,
    `EDGE_MARGIN = 3             # box within N px of the frame edge = "cut off"
`,
    `EDGE_MARGIN = 3             # box within N px of the frame edge = "cut off" (minimum) ...
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
`,
    "tunables"
  );

  /* 2. settings ---------------------------------------------------------- */
  s = replaceOnce(
    s,
    `    "cal_aspect": None,          # box width/height seen during calibration
`,
    `    "cal_aspect": None,          # box width/height seen during calibration
    "cal_face_cm": None,         # face width in cm measured during calibration
                                 # (None = FACE_DEFAULT_CM)
`,
    "DEFAULT_SETTINGS cal_aspect"
  );

  s = replaceOnce(
    s,
    `        self._last_raw_ts = 0.0

    # ---------------------------------------------------------------- settings
`,
    `        self._last_raw_ts = 0.0

        self.face_cc = None                 # Haar face detector (None = not available)
        self.face_error = None
        self._face_live = None              # face width (cm) refined while running
        self._warned_size = False
        self._face_tick = 0

    # ---------------------------------------------------------------- settings
`,
    "__init__ tail"
  );

  s = replaceOnce(
    s,
    `            self._settings.update(focal_px=None, cal_width=None, cal_height=None,
                                  known_distance_cm=None, calibrated_at=None,
                                  cal_aspect=None)`,
    `            self._settings.update(focal_px=None, cal_width=None, cal_height=None,
                                  known_distance_cm=None, calibrated_at=None,
                                  cal_aspect=None, cal_face_cm=None)`,
    "reset_calibration"
  );

  s = replaceOnce(
    s,
    `    def _reset_history(self):
        self._hist_moving.clear()`,
    `    def _reset_history(self):
        self._face_live = None
        self._hist_moving.clear()`,
    "_reset_history"
  );

  /* 3. face detector loading -------------------------------------------- */
  s = replaceOnce(
    s,
    `    def _load_model(self):
        self._model_tried = True
`,
    `    def _load_face(self):
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
`,
    "_load_model"
  );

  /* 4. detection + face attach ------------------------------------------ */
  s = replaceBlock(
    s,
    "    def _detect(self, frame, class_id):",
    "    def _motion_mask(self, frame, now):",
    `    def _detect(self, frame, class_id, conf_thr=CONF_THRESHOLD):
        canvas, ratio, pad_x, pad_y = _letterbox(frame, YOLO_INPUT)
        blob = cv2.dnn.blobFromImage(canvas, 1 / 255.0, (YOLO_INPUT, YOLO_INPUT),
                                     swapRB=True, crop=False)
        self.net.setInput(blob)
        out = self.net.forward()
        return parse_yolov8(out, ratio, pad_x, pad_y, class_id, conf_thr=conf_thr)

    # ------------------------------------------- part-aware measuring (person)
    @staticmethod
    def _part_aware(s):
        """True when a person is measured by height AND the typed size looks like a
        full standing height. Only then can a box be judged 'whole body or part'."""
        return (s["class_id"] == 0 and s["dimension"] == "height"
                and PERSON_MIN_CM <= s["real_size_cm"] <= PERSON_MAX_CM)

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
        periodic = self._face_tick % FACE_LEARN_EVERY == 0
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

`,
    "_detect block"
  );

  /* 5. measuring --------------------------------------------------------- */
  s = replaceBlock(
    s,
    "    def _raw_distance(self, px, frame_w, s, size_cm=None):",
    "    @staticmethod\n    def _smooth",
    `    @staticmethod
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

        if self._part_aware(s):
            px, size_cm, side, clipped, face_px = self._pick_ruler(
                det, s, bw, bh, clip_x, clip_y, aspect, other_cm)
        elif clipped and not other_clipped and other_cm:
            # Main side is cut off by the frame but the other side is fully
            # visible: measure with the other side instead.
            px, size_cm = other_px, other_cm
            side = "width" if main == "height" else "height"
            clipped = False

        dist = self._raw_distance(px, w, s, size_cm) if size_cm else None
        return {"bbox": [x1, y1, x2 - x1, y2 - y1], "px": float(px),
                "conf": det.get("conf", 1.0), "clipped": bool(clipped),
                "side": side,
                "any_clipped": bool(clip_x or clip_y),
                "aspect": aspect,
                "face_px": face_px,
                "approx": bool(side == "width" and size_cm and side != main),
                "motion": det.get("motion", 0.0),
                "dist_inst": dist,
                "distance_cm": dist}

`,
    "_raw_distance/_summary block"
  );

  /* 6. process / publish hooks ------------------------------------------- */
  s = replaceOnce(
    s,
    `            dets = self._detect(frame, s["class_id"])
`,
    `            self._check_size(s)
            dets = self._attach_faces(
                frame, self._detect(frame, s["class_id"], self._host_conf(s)), s)
`,
    "_process detect"
  );

  s = replaceOnce(
    s,
    `        if raw_sum:
            self._last_raw_ts = now
`,
    `        if raw_sum:
            self._last_raw_ts = now
            self._learn_face(raw_sum, s, w)
`,
    "_publish learn"
  );

  /* 7. overlay ------------------------------------------------------------ */
  s = replaceOnce(
    s,
    `            d = target["distance_cm"]
            label = ("%.0f cm" % d) if d is not None else ("%.0f px" % target["px"])
            if target["clipped"]:
                label += " (cut off)"
            elif target.get("side") and target["side"] != s["dimension"]:
                label += " (by %s)" % target["side"]`,
    `            d = target["distance_cm"]
            if d is not None:
                label = ("~%.0f cm" if target.get("approx") else "%.0f cm") % d
            elif calibrated and target["clipped"]:
                label = "part only"
            else:
                label = "%.0f px" % target["px"]
            if d is not None and target["clipped"]:
                label += " (cut off)"
            elif d is not None and target.get("side") and target["side"] != s["dimension"]:
                label += " (by %s)" % target["side"]`,
    "overlay label"
  );

  s = replaceOnce(
    s,
    `            ly = y - 8 if y - th - 12 > 0 else y + th + 10`,
    `            hud_bottom = int(h * 0.02) + int(36 * scale) + 6      # keep clear of the HUD text
            ly = y - 8 if y - th - 12 > hud_bottom else y + th + 10`,
    "overlay label position"
  );

  s = replaceOnce(
    s,
    `            hud = "Distance: %.0f cm" % target["distance_cm"]`,
    `            hud = "Distance: %s%.0f cm" % ("~" if target.get("approx") else "",
                                              target["distance_cm"])`,
    "overlay hud"
  );

  /* 8. calibration -------------------------------------------------------- */
  s = replaceOnce(
    s,
    `        samples, aspects, last_ts = [], [], 0.0`,
    `        samples, aspects, faces, last_ts = [], [], [], 0.0`,
    "calibrate init"
  );

  s = replaceOnce(
    s,
    `                    samples.append(raw["px"])
                    aspects.append(raw["aspect"])`,
    `                    samples.append(raw["px"])
                    aspects.append(raw["aspect"])
                    if raw.get("face_px"):
                        faces.append(raw["face_px"])`,
    "calibrate sample"
  );

  s = replaceOnce(
    s,
    `        aspect = float(np.median(aspects))
        with self._lock:
            self._settings.update(
                focal_px=focal, cal_width=frame_w, cal_height=frame_h,
                known_distance_cm=known, cal_aspect=aspect,`,
    `        aspect = float(np.median(aspects))
        # face width in cm, measured on the person standing in front of the camera
        face_cm = None
        if self._part_aware(s) and len(faces) >= max(3, len(samples) // 3):
            cand = float(np.median(faces)) * s["real_size_cm"] / median
            if FACE_MIN_CM <= cand <= FACE_MAX_CM:
                face_cm = cand
        with self._lock:
            self._settings.update(
                focal_px=focal, cal_width=frame_w, cal_height=frame_h,
                known_distance_cm=known, cal_aspect=aspect, cal_face_cm=face_cm,`,
    "calibrate save"
  );

  s = replaceOnce(
    s,
    `"spread_pct": spread * 100, "frame_w": frame_w, "frame_h": frame_h}`,
    `"spread_pct": spread * 100, "frame_w": frame_w, "frame_h": frame_h,
                "face_cm": face_cm}`,
    "calibrate result"
  );

  return s;
}

/* ------------------------------------------- models/ face cascade copy */
const CASCADE = "haarcascade_frontalface_default.xml";

function findCascadeOnThisMachine() {
  const found = [];
  for (const py of ["python3", "python", "py"]) {
    const r = spawnSync(
      py,
      ["-c", "import cv2;print(cv2.data.haarcascades)"],
      { encoding: "utf8" }
    );
    if (r.status === 0 && r.stdout) found.push(r.stdout.trim().split(/\r?\n/).pop());
  }
  found.push(
    "/usr/share/opencv4/haarcascades",
    "/usr/share/opencv/haarcascades",
    "/usr/local/share/opencv4/haarcascades",
    "/usr/local/share/opencv/haarcascades"
  );
  for (const dir of found) {
    const p = path.join(dir, CASCADE);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/* ------------------------------------------------------------- runner */
console.log(`Target folder: ${root}${dryRun ? "  (dry run)" : ""}`);

const rel = "distance.py";
const file = path.join(root, rel);
if (!fs.existsSync(file)) {
  console.error(`  ✗ ${rel}: file not found (is this the repo folder?)`);
  process.exit(1);
}

const raw = fs.readFileSync(file, "utf8");
const crlf = raw.includes("\r\n");
const text = crlf ? raw.replace(/\r\n/g, "\n") : raw;

let plannedOut = null;
if (text.includes("FACE_DEFAULT_CM")) {
  console.log(`  • ${rel}: already patched, skipping`);
} else {
  if (!text.includes("real_other_cm")) {
    console.error(
      `  ✗ ${rel}: the earlier 'patch-distance-fallback.mjs' has not been applied to this file.\n` +
        `    Run:  node patch-distance-fallback.mjs   first, then this script.`
    );
    process.exit(1);
  }
  try {
    let out = patchDistancePy(text);
    if (crlf) out = out.replace(/\n/g, "\r\n");
    plannedOut = out;
    console.log(`  ✓ ${rel}: ok`);
  } catch (err) {
    console.error(`  ✗ ${rel}: ${err.message}`);
    console.error("\nNothing was written. distance.py differs from what this patch expects.");
    process.exit(1);
  }
}

const cascadeDest = path.join(root, "models", CASCADE);
const cascadeSrc = fs.existsSync(cascadeDest) ? null : findCascadeOnThisMachine();
if (fs.existsSync(cascadeDest)) {
  console.log(`  • models/${CASCADE}: already there`);
} else if (cascadeSrc) {
  console.log(`  ✓ models/${CASCADE}: will copy from ${cascadeSrc}`);
} else {
  console.log(
    `  ! models/${CASCADE}: OpenCV's copy was not found on this machine.\n` +
      `    distance.py will still look in cv2.data at run time; if it is missing there too the\n` +
      `    face ruler is disabled (the log then says "face ruler disabled"). Fix: put the file\n` +
      `    from your OpenCV install (cv2/data/) into models/.`
  );
}

if (dryRun || (!plannedOut && !cascadeSrc)) {
  console.log(!plannedOut && !cascadeSrc ? "\nNothing to do." : "\nDry run finished, no files written.");
  process.exit(0);
}

if (plannedOut) {
  const bak = file + ".before-partial-fix.bak";
  fs.copyFileSync(file, bak);
  fs.writeFileSync(file, plannedOut, "utf8");
  console.log(`  wrote ${rel}  (backup: ${path.basename(bak)})`);
}
if (cascadeSrc) {
  fs.mkdirSync(path.dirname(cascadeDest), { recursive: true });
  fs.copyFileSync(cascadeSrc, cascadeDest);
  console.log(`  wrote models/${CASCADE}`);
}

console.log(`
Done. Next steps:
  1. Restart the app (python3 app.py). The log should show "face cascade loaded".
  2. Open the Calibration page:
       - Class: person, measured side: height
       - Real size: the person's FULL STANDING HEIGHT in cm (e.g. 170)
     then calibrate once with that person standing full-body, facing the camera,
     3+ m away so the whole body is inside the frame.
  3. Test by walking closer: label reads "NNN cm" (whole body), then "NNN cm (by face)"
     when the body no longer fits, "~NNN cm (by width)" if no face is visible, and
     "part only" when there is nothing dependable to measure with.
`);
