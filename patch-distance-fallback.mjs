#!/usr/bin/env node
/**
 * patch-distance-fallback.mjs
 * ---------------------------------------------------------------------------
 * Adds the "height with automatic width fallback" fix to the Perimeter repo.
 *
 * When the main measured side (height) is cut off by the frame edge but the
 * other side (width) is fully visible, the distance is measured with the
 * other side instead. The other side's real size is learned automatically
 * during calibration (box width/height ratio) or can be typed in.
 *
 * Usage (run from anywhere; default target is the current folder):
 *
 *     node patch-distance-fallback.mjs                 # patch ./
 *     node patch-distance-fallback.mjs /path/to/repo   # patch another folder
 *     node patch-distance-fallback.mjs --dry-run       # show what would change
 *
 * Safe to re-run: files that are already patched are skipped. Originals are
 * saved next to the files as *.bak before anything is written. If any file
 * does not match what the script expects, NOTHING is written.
 *
 * Files changed:  distance.py, templates/calibrate.html, static/calibrate.js
 * After patching, recalibrate once (stand full-body, arms relaxed).
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

function replaceBlock(src, startMarker, endMarker, newBlock, label) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker);
  if (a === -1 || b === -1 || b <= a) throw new Error(`could not find block: ${label}`);
  return src.slice(0, a) + newBlock + src.slice(b);
}

/* --------------------------------------------------------- distance.py */
function patchDistancePy(s) {
  s = replaceOnce(
    s,
    `    "real_size_cm": 170.0,       # real size of that side, in cm
`,
    `    "real_size_cm": 170.0,       # real size of that side, in cm
    "real_other_cm": None,       # real size of the OTHER side (used when the main
                                 # side is cut off by the frame). None = learn it
                                 # from the box shape during calibration
    "cal_aspect": None,          # box width/height seen during calibration
`,
    "DEFAULT_SETTINGS real_size_cm"
  );

  s = replaceOnce(
    s,
    `        size = float(data.get("real_size_cm", self._settings["real_size_cm"]))
`,
    `        size = float(data.get("real_size_cm", self._settings["real_size_cm"]))
        other = data.get("real_other_cm", self._settings["real_other_cm"])
        other = None if other in (None, "") else float(other)
`,
    "update_settings size"
  );

  s = replaceOnce(
    s,
    `            raise ValueError("Real size must be between 1 and 1000 cm.")
        with self._lock:
            self._settings.update(class_id=cid, dimension=dim, real_size_cm=size)`,
    `            raise ValueError("Real size must be between 1 and 1000 cm.")
        if other is not None and not 1.0 <= other <= 1000.0:
            raise ValueError("Other-side size must be between 1 and 1000 cm.")
        with self._lock:
            self._settings.update(class_id=cid, dimension=dim, real_size_cm=size,
                                  real_other_cm=other)`,
    "update_settings validation"
  );

  s = replaceOnce(
    s,
    `            self._settings.update(focal_px=None, cal_width=None, cal_height=None,
                                  known_distance_cm=None, calibrated_at=None)`,
    `            self._settings.update(focal_px=None, cal_width=None, cal_height=None,
                                  known_distance_cm=None, calibrated_at=None,
                                  cal_aspect=None)`,
    "reset_calibration"
  );

  s = replaceBlock(
    s,
    "    def _raw_distance(self, px, frame_w, s):",
    "    @staticmethod\n    def _smooth",
    `    def _raw_distance(self, px, frame_w, s, size_cm=None):
        f = s["focal_px"]
        if not f or px is None or px <= 1:
            return None
        if s["cal_width"]:
            f = f * frame_w / s["cal_width"]     # camera resolution changed
        return (size_cm or s["real_size_cm"]) * f / px

    @staticmethod
    def _other_size_cm(s):
        """Real size of the side that is NOT the main measured one, or None
        when it is unknown (nothing typed in and not calibrated yet)."""
        if s.get("real_other_cm"):
            return float(s["real_other_cm"])
        aspect = s.get("cal_aspect")              # box width / height
        if not aspect:
            return None
        if s["dimension"] == "height":
            return s["real_size_cm"] * aspect     # width  = height * (w/h)
        return s["real_size_cm"] / aspect         # height = width  / (w/h)

    def _summary(self, det, s, w, h):
        x1, y1 = max(0.0, det["x1"]), max(0.0, det["y1"])
        x2, y2 = min(float(w), det["x2"]), min(float(h), det["y2"])
        bw, bh = det["x2"] - det["x1"], det["y2"] - det["y1"]
        clip_x = det["x1"] <= EDGE_MARGIN or det["x2"] >= w - EDGE_MARGIN
        clip_y = det["y1"] <= EDGE_MARGIN or det["y2"] >= h - EDGE_MARGIN

        main = s["dimension"]
        if main == "width":
            px, clipped, other_px, other_clipped = bw, clip_x, bh, clip_y
        else:
            px, clipped, other_px, other_clipped = bh, clip_y, bw, clip_x
        size_cm, side = s["real_size_cm"], main

        # Main side is cut off by the frame but the other side is fully
        # visible: measure with the other side instead.
        other_cm = self._other_size_cm(s)
        if clipped and not other_clipped and other_cm:
            px, size_cm = other_px, other_cm
            side = "width" if main == "height" else "height"
            clipped = False

        return {"bbox": [x1, y1, x2 - x1, y2 - y1], "px": float(px),
                "conf": det.get("conf", 1.0), "clipped": bool(clipped),
                "side": side,
                "any_clipped": bool(clip_x or clip_y),
                "aspect": float(bw / bh) if bh > 1 else None,
                "motion": det.get("motion", 0.0),
                "distance_cm": self._raw_distance(px, w, s, size_cm)}

`,
    "_raw_distance/_summary block"
  );

  s = replaceOnce(
    s,
    `            if target["clipped"]:
                label += " (cut off)"`,
    `            if target["clipped"]:
                label += " (cut off)"
            elif target.get("side") and target["side"] != s["dimension"]:
                label += " (by %s)" % target["side"]`,
    "overlay label"
  );

  s = replaceOnce(
    s,
    `        samples, last_ts = [], 0.0`,
    `        samples, aspects, last_ts = [], [], 0.0`,
    "calibrate samples init"
  );

  s = replaceOnce(
    s,
    `                if raw and not raw["clipped"]:
                    samples.append(raw["px"])`,
    `                # only a fully visible box measured on the MAIN side counts
                if (raw and not raw["any_clipped"] and raw["side"] == s["dimension"]
                        and raw["aspect"]):
                    samples.append(raw["px"])
                    aspects.append(raw["aspect"])`,
    "calibrate sample filter"
  );

  s = replaceOnce(
    s,
    `        focal = median * known / s["real_size_cm"]
        with self._lock:
            self._settings.update(
                focal_px=focal, cal_width=frame_w, cal_height=frame_h,
                known_distance_cm=known,`,
    `        focal = median * known / s["real_size_cm"]
        aspect = float(np.median(aspects))
        with self._lock:
            self._settings.update(
                focal_px=focal, cal_width=frame_w, cal_height=frame_h,
                known_distance_cm=known, cal_aspect=aspect,`,
    "calibrate save"
  );

  return s;
}

/* ------------------------------------------------ templates/calibrate.html */
function patchCalibrateHtml(s) {
  s = replaceOnce(
    s,
    `        <button class="cal-btn" id="saveBtn" type="button">Save target</button>`,
    `        <div class="cal-row">
          <label for="otherInput">Real size of the other side (cm) - optional</label>
          <input class="cal-input" id="otherInput" type="number" min="1" max="1000" step="0.1" placeholder="auto: learned when you calibrate">
        </div>
        <p class="cal-help">When you get so close that the main side is cut off by the frame, the reading switches to the other side automatically. Leave this blank to learn it from your body shape during calibration (stand full-body, arms relaxed).</p>
        <button class="cal-btn" id="saveBtn" type="button">Save target</button>`,
    "save button"
  );
  s = replaceOnce(
    s,
    `<li>A box touching the frame edge is cut off, so the reading is unreliable.</li>`,
    `<li>A box touching the frame edge is cut off. If only one side is cut off, the reading uses the other side (label says "by width"/"by height"); if both are, it is unreliable.</li>`,
    "tips list"
  );
  return s;
}

/* ------------------------------------------------- static/calibrate.js */
function patchCalibrateJs(s) {
  s = replaceOnce(
    s,
    `sizeInput: $("sizeInput"),`,
    `sizeInput: $("sizeInput"), otherInput: $("otherInput"),`,
    "element lookup"
  );
  s = replaceOnce(
    s,
    `        el.sizeInput.value = s.real_size_cm;
`,
    `        el.sizeInput.value = s.real_size_cm;
        el.otherInput.value = s.real_other_cm || "";
`,
    "load settings"
  );
  s = replaceOnce(
    s,
    `      real_size_cm: parseFloat(el.sizeInput.value)
    }).then(function (r) {`,
    `      real_size_cm: parseFloat(el.sizeInput.value),
      real_other_cm: el.otherInput.value === "" ? null : parseFloat(el.otherInput.value)
    }).then(function (r) {`,
    "save button payload"
  );
  s = replaceOnce(
    s,
    `      real_size_cm: parseFloat(el.sizeInput.value)
    };`,
    `      real_size_cm: parseFloat(el.sizeInput.value),
      real_other_cm: el.otherInput.value === "" ? null : parseFloat(el.otherInput.value)
    };`,
    "targetPayload"
  );
  s = replaceOnce(
    s,
    `      el.readSub.textContent = "box " + raw.px.toFixed(0) + " px" +
        (raw.clipped ?`,
    `      el.readSub.textContent = "box " + raw.px.toFixed(0) + " px" +
        (raw.side ? " (" + raw.side + ")" : "") +
        (raw.clipped ?`,
    "live reading text"
  );
  return s;
}

/* ------------------------------------------------------------- runner */
// [file, patch function, text that only exists once the file is patched]
const targets = [
  ["distance.py", patchDistancePy, "real_other_cm"],
  [path.join("templates", "calibrate.html"), patchCalibrateHtml, 'id="otherInput"'],
  [path.join("static", "calibrate.js"), patchCalibrateJs, "real_other_cm"],
];

console.log(`Target folder: ${root}${dryRun ? "  (dry run)" : ""}`);

const planned = [];
let failed = false;

for (const [rel, fn, marker] of targets) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.error(`  ✗ ${rel}: file not found (is this the repo folder?)`);
    failed = true;
    continue;
  }
  const raw = fs.readFileSync(file, "utf8");
  const crlf = raw.includes("\r\n");
  const text = crlf ? raw.replace(/\r\n/g, "\n") : raw;

  if (text.includes(marker)) {
    console.log(`  • ${rel}: already patched, skipping`);
    continue;
  }
  try {
    let out = fn(text);
    if (crlf) out = out.replace(/\n/g, "\r\n");
    planned.push({ rel, file, out });
    console.log(`  ✓ ${rel}: ok`);
  } catch (err) {
    console.error(`  ✗ ${rel}: ${err.message}`);
    failed = true;
  }
}

if (failed) {
  console.error("\nNothing was written. The files differ from what this patch expects.");
  process.exit(1);
}

if (dryRun || planned.length === 0) {
  console.log(planned.length === 0 ? "\nNothing to do." : "\nDry run finished, no files written.");
  process.exit(0);
}

for (const { rel, file, out } of planned) {
  fs.copyFileSync(file, file + ".bak");
  fs.writeFileSync(file, out, "utf8");
  console.log(`  wrote ${rel}  (backup: ${rel}.bak)`);
}

console.log(`
Done. Next steps:
  1. Restart the app (python3 app.py).
  2. Open the Calibration page and calibrate once, standing full-body with
     your arms relaxed. This also learns the width used as the fallback.
`);
