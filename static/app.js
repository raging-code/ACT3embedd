/* Perimeter — Motion Watch: dashboard logic
   Polls /api/status every second and updates the console in place. */

const POLL_MS = 1000;

const el = {
  clock: document.getElementById("clock"),
  pulseDot: document.getElementById("pulse-dot"),
  armToggle: document.getElementById("armToggle"),

  feedFrame: document.getElementById("feedFrame"),
  feedImg: document.getElementById("feedImg"),
  feedTag: document.getElementById("feedTag"),
  feedTimestamp: document.getElementById("feedTimestamp"),
  feedFile: document.getElementById("feedFile"),

  statTotal: document.getElementById("statTotal"),
  statUptime: document.getElementById("statUptime"),

  modSensorState: document.getElementById("modSensorState"),
  modCameraState: document.getElementById("modCameraState"),

  logList: document.getElementById("logList"),
  logCount: document.getElementById("logCount"),

  footStatus: document.getElementById("footStatus"),
};

let lastRenderedFile = null;
let startedAt = null;

function tickClock() {
  const now = new Date();
  el.clock.textContent = now.toLocaleTimeString("en-GB", { hour12: false });
}
setInterval(tickClock, 1000);
tickClock();

function fmtTime(isoString) {
  if (!isoString) return "—";
  const d = new Date(isoString);
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

function fmtUptime(startedIso) {
  if (!startedIso) return "0m";
  const started = new Date(startedIso).getTime();
  const mins = Math.floor((Date.now() - started) / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function setModule(stateEl, ok, okLabel, failLabel) {
  stateEl.textContent = ok ? okLabel : failLabel;
  stateEl.classList.toggle("ok", ok);
  stateEl.classList.toggle("fail", !ok);
}

function renderLog(events) {
  if (!events || events.length === 0) {
    el.logList.innerHTML =
      '<li class="log-empty">No motion recorded yet. The log fills in here the moment the sensor trips.</li>';
    return;
  }
  el.logList.innerHTML = events
    .map((e) => {
      const time = fmtTime(e.timestamp);
      const desc = e.file ? e.file : "capture failed";
      return `<li class="entry"><span class="entry-time">${time}</span><span class="entry-desc">${desc}</span></li>`;
    })
    .join("");
}

async function poll() {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();

    // header pulse dot
    if (!data.armed) {
      el.pulseDot.className = "dot off";
    } else if (data.motion_detected) {
      el.pulseDot.className = "dot alert";
    } else {
      el.pulseDot.className = "dot";
    }

    // arm toggle
    el.armToggle.dataset.armed = data.armed ? "true" : "false";
    el.armToggle.querySelector(".arm-toggle-label").textContent = data.armed
      ? "ARMED"
      : "DISARMED";

    // stats
    el.statTotal.textContent = data.total_events ?? 0;
    el.statUptime.textContent = fmtUptime(data.started_at);

    // modules
    setModule(el.modSensorState, data.sensor_ok, "reading", "offline");
    setModule(el.modCameraState, data.camera_ok, "ready", "offline");

    // feed tag
    el.feedTag.textContent = data.motion_detected ? "motion — capturing" : "idle";
    el.feedTag.classList.toggle("live", !!data.motion_detected);

    // feed image
    if (data.last_capture_file && data.last_capture_file !== lastRenderedFile) {
      lastRenderedFile = data.last_capture_file;
      el.feedImg.src = `/captures/${data.last_capture_file}?t=${Date.now()}`;
      el.feedFrame.classList.add("has-image");
    }
    el.feedTimestamp.textContent = fmtTime(data.last_motion_at);
    el.feedFile.textContent = data.last_capture_file || "—";

    // log
    renderLog(data.events);
    el.logCount.textContent = data.total_events ?? 0;

    el.footStatus.textContent = "connected";
  } catch (err) {
    el.footStatus.textContent = "connection lost — retrying…";
  }
}

el.armToggle.addEventListener("click", async () => {
  const currentlyArmed = el.armToggle.dataset.armed === "true";
  const endpoint = currentlyArmed ? "/api/disarm" : "/api/arm";
  try {
    await fetch(endpoint, { method: "POST" });
  } catch (err) {
    /* status poll will reconcile on next tick regardless */
  }
  poll();
});

poll();
setInterval(poll, POLL_MS);
