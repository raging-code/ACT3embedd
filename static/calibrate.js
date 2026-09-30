/* Perimeter — Distance Calibration page logic.
   Loads/saves the target settings, runs the calibration, and shows the live
   distance reading (polls /api/distance/live?page=calibrate). */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    clock: $("clock"), liveFrame: $("liveFrame"), liveImg: $("liveImg"), liveRes: $("liveRes"),
    modModel: $("modModel"), modModelState: $("modModelState"), dot: $("pulse-dot"),
    classSelect: $("classSelect"), dimSelect: $("dimSelect"), sizeInput: $("sizeInput"), otherInput: $("otherInput"),
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
        el.otherInput.value = s.real_other_cm || "";
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
      real_size_cm: parseFloat(el.sizeInput.value),
      real_other_cm: el.otherInput.value === "" ? null : parseFloat(el.otherInput.value)
    }).then(function (r) {
      if (r.ok) setMsg(el.saveMsg, "Saved.", "ok");
      else setMsg(el.saveMsg, r.data.error || "Could not save.", "fail");
    }).catch(function () { setMsg(el.saveMsg, "Server not reachable.", "fail"); });
  });

  // ---- calibration with a countdown --------------------------------------
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
      real_size_cm: parseFloat(el.sizeInput.value),
      real_other_cm: el.otherInput.value === "" ? null : parseFloat(el.otherInput.value)
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
        (raw.side ? " (" + raw.side + ")" : "") +
        (raw.clipped ? " · too close: no body part I can measure with - step back" : "") +
        (raw.approx && !raw.clipped ? " · approximate" : "") +
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
