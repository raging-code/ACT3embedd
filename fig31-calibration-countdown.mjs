#!/usr/bin/env node
/**
 * fig31-calibration-countdown.mjs
 * -------------------------------
 * Adds a 10-second countdown to the Calibration page: press "Calibrate now",
 * walk the object to the measured distance while the countdown runs on the
 * live view (with beeps for the last 3 seconds), and the measurement is taken
 * and the calibration saved when it reaches zero. "Cancel countdown" aborts.
 *
 * Usage:
 *   node fig31-calibration-countdown.mjs .
 *   node fig31-calibration-countdown.mjs "C:\Users\eugen\OneDrive\Desktop\ACT3embed"
 *
 * Needs fig31-add-distance.mjs to have been applied first.
 * Safe to re-run. Edited files are backed up to backup/<timestamp>/ first.
 * To change the length, edit COUNTDOWN_SECONDS in static/calibrate.js.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error('Usage: node fig31-calibration-countdown.mjs /path/to/project   (use "." for the current folder)');
  process.exit(1);
}
for (const rel of ["static/calibrate.js", "templates/calibrate.html", "static/style.css"]) {
  if (!existsSync(join(root, rel))) {
    console.error(`Could not find ${rel} in ${root}. Apply fig31-add-distance.mjs first.`);
    process.exit(1);
  }
}

const pad = (n) => String(n).padStart(2, "0");
const d = new Date();
const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const backedUp = new Set();
let changes = 0;

function backup(rel) {
  if (backedUp.has(rel)) return;
  const dst = join(root, "backup", stamp, rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(join(root, rel), dst);
  backedUp.add(rel);
}
function edit(rel, label, fn) {
  const raw = readFileSync(join(root, rel), "utf8");
  const crlf = raw.includes("\r\n");
  const text = raw.replace(/\r\n/g, "\n");
  const out = fn(text);
  if (out === null || out === text) {
    console.log(`  [skip] ${label} (already applied)`);
    return;
  }
  backup(rel);
  writeFileSync(join(root, rel), crlf ? out.replace(/\n/g, "\r\n") : out, "utf8");
  console.log(`  [ok]   ${label}`);
  changes++;
}
function replaceOnce(text, find, replace, label) {
  const n = text.split(find).length - 1;
  if (n === 0) throw new Error(`${label}: anchor not found -- the file differs from what this patch expects.`);
  if (n > 1) throw new Error(`${label}: anchor matched ${n} times -- aborting to avoid a bad edit.`);
  return text.replace(find, () => replace);
}

// ---------------------------------------------------------------------
console.log("Patching templates/calibrate.html ...");

edit("templates/calibrate.html", "countdown overlay on the live view", (t) => {
  if (t.includes('id="calCountdown"')) return null;
  return replaceOnce(
    t,
    '<div class="feed-tag live-tag"><span class="live-dot"></span>LIVE</div>\n',
    '<div class="feed-tag live-tag"><span class="live-dot"></span>LIVE</div>\n' +
    '        <div class="cal-countdown" id="calCountdown" aria-live="polite">\n' +
    '          <span class="cal-countdown-num" id="calCountdownNum">10</span>\n' +
    '          <span class="cal-countdown-txt" id="calCountdownTxt">Move the object to the measured distance</span>\n' +
    '        </div>\n',
    "live-tag"
  );
});

edit("templates/calibrate.html", "updated calibration instructions", (t) => {
  if (t.includes("10-second countdown")) return null;
  return replaceOnce(
    t,
    'Put the object at a measured distance from the camera lens, fully in view and facing the camera. Hold still, enter the distance, then press Calibrate.',
    'Enter the distance you will measure to (from the camera lens), then press Calibrate now. A 10-second countdown gives you time to move the object to that distance, fully in view and facing the camera. Hold still when it reaches 0.',
    "cal-help"
  );
});

// ---------------------------------------------------------------------
console.log("Patching static/calibrate.js ...");

const HANDLER = String.raw`  // ---- calibration with a countdown --------------------------------------
  // Press "Calibrate now" -> 10 s countdown (shown on the live view, with
  // beeps for the last 3 s) so you can walk the object to the measured
  // distance -> then the measurement is taken and the calibration saved.
  var COUNTDOWN_SECONDS = 10;
  var calState = "idle";            // idle | counting | measuring
  var countdownTimer = null;
  var audioCtx = null;
  var cdBox = $("calCountdown");
  var cdNum = $("calCountdownNum");
  var cdTxt = $("calCountdownTxt");

  function beep(freq, ms) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.frequency.value = freq;
      gain.gain.value = 0.08;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + ms / 1000);
    } catch (e) { /* sound is optional */ }
  }

  function showCountdown(num, txt) {
    if (!cdBox) return;
    cdBox.className = "cal-countdown show";
    cdNum.textContent = num;
    cdTxt.textContent = txt;
  }

  function hideCountdown() {
    if (cdBox) cdBox.className = "cal-countdown";
  }

  function setCalState(state) {
    calState = state;
    if (state === "idle") {
      el.calBtn.disabled = false;
      el.calBtn.textContent = "Calibrate now";
    } else if (state === "counting") {
      el.calBtn.disabled = false;
      el.calBtn.textContent = "Cancel countdown";
    } else {
      el.calBtn.disabled = true;
      el.calBtn.textContent = "Measuring…";
    }
  }

  function targetPayload() {
    return {
      class_id: parseInt(el.classSelect.value, 10),
      dimension: el.dimSelect.value,
      real_size_cm: parseFloat(el.sizeInput.value)
    };
  }

  function measureAndSave(dist) {
    setCalState("measuring");
    showCountdown("•", "Hold still - measuring…");
    setMsg(el.calMsg, "Measuring… keep the object still.");
    beep(1200, 350);
    // save the target first so the calibration uses what is on screen
    jsonPost("/api/calibration/settings", targetPayload()).then(function (saved) {
      if (!saved.ok) throw new Error(saved.data.error || "Invalid target settings.");
      return jsonPost("/api/calibration/run", { known_distance_cm: dist });
    }).then(function (r) {
      if (!r.ok) throw new Error(r.data.error || "Calibration failed.");
      var res = r.data.result;
      setMsg(el.calMsg, "Saved: object measured " + res.pixel_size.toFixed(0) + " px from " +
        res.samples + " samples (spread " + res.spread_pct.toFixed(1) + "%).", "ok");
      renderCalStatus(r.data.settings);
      beep(1600, 200);
    }).catch(function (err) {
      setMsg(el.calMsg, err.message || "Calibration failed.", "fail");
    }).then(function () {
      hideCountdown();
      setCalState("idle");
    });
  }

  function startCountdown(dist) {
    setCalState("counting");
    var endAt = Date.now() + COUNTDOWN_SECONDS * 1000;
    var lastShown = null;

    function tick() {
      var remaining = Math.ceil((endAt - Date.now()) / 1000);
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        measureAndSave(dist);
        return;
      }
      if (remaining !== lastShown) {
        lastShown = remaining;
        showCountdown(remaining, "Move the object to " + dist + " cm from the camera, then hold still");
        setMsg(el.calMsg, "Move the object to " + dist + " cm from the lens. Measuring starts in " + remaining + " s…");
        if (remaining <= 3) beep(880, 120);
      }
    }
    countdownTimer = setInterval(tick, 200);
    tick();
  }

  function cancelCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    hideCountdown();
    setCalState("idle");
    setMsg(el.calMsg, "Countdown cancelled.");
  }

  el.calBtn.addEventListener("click", function () {
    if (calState === "counting") { cancelCountdown(); return; }
    if (calState !== "idle") return;
    var dist = parseFloat(el.distInput.value);
    if (!dist || dist < 20 || dist > 3000) {
      setMsg(el.calMsg, "Enter the known distance first (20-3000 cm).", "fail");
      return;
    }
    if (!parseFloat(el.sizeInput.value)) {
      setMsg(el.calMsg, "Enter the object's real size first.", "fail");
      return;
    }
    beep(660, 80);      // also unlocks browser audio (needs a click)
    startCountdown(dist);
  });

`;

edit("static/calibrate.js", "calibration button: 10 s countdown before measuring", (t) => {
  if (t.includes("COUNTDOWN_SECONDS")) return null;
  const start = t.indexOf('  el.calBtn.addEventListener("click", function () {');
  const end = t.indexOf('  el.resetBtn.addEventListener("click"');
  if (start === -1 || end === -1 || end < start) {
    throw new Error("calibrate.js: could not find the calibrate button handler -- was the file edited?");
  }
  return t.slice(0, start) + HANDLER + t.slice(end);
});

// ---------------------------------------------------------------------
console.log("Patching static/style.css ...");

const CSS = String.raw`
/* === cal-countdown (added by fig31-calibration-countdown.mjs) ============ */

.cal-countdown {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  padding: 0 12px 5%;
  text-align: center;
  pointer-events: none;
}
.cal-countdown.show { display: flex; }
.cal-countdown-num {
  font-family: var(--grot);
  font-weight: 800;
  font-size: clamp(48px, 11vw, 110px);
  line-height: 1;
  color: var(--signal);
  text-shadow: 0 2px 6px rgba(0,0,0,0.8), 0 6px 28px rgba(0,0,0,0.6);
}
.cal-countdown-txt {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  text-shadow: 0 1px 6px rgba(0,0,0,0.9);
}
`;

edit("static/style.css", "countdown overlay styles", (t) => {
  if (t.includes("cal-countdown (added by")) return null;
  return t.replace(/\n*$/, "\n") + CSS;
});

console.log(`\nDone. ${changes} change(s) applied.`);
if (changes === 0) console.log("Nothing changed -- this patch was already applied.");
else console.log("Refresh the Calibration page (Ctrl+F5) to see the countdown.");
