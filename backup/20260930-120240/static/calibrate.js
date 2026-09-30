/* Perimeter — Distance Calibration page logic.
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
