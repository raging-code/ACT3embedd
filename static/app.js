/* Perimeter — Motion Watch: dashboard logic
   Polls /api/status every second and updates the console in place. */

const POLL_MS = 1000;

const el = {
  clock: document.getElementById("clock"),
  pulseDot: document.getElementById("pulse-dot"),
  armToggle: document.getElementById("armToggle"),

  liveFrame: document.getElementById("liveFrame"),
  liveImg: document.getElementById("liveImg"),

  galleryStrip: document.getElementById("galleryStrip"),
  galleryCount: document.getElementById("galleryCount"),

  statTotal: document.getElementById("statTotal"),
  statUptime: document.getElementById("statUptime"),

  modSensorState: document.getElementById("modSensorState"),
  modCameraState: document.getElementById("modCameraState"),

  logList: document.getElementById("logList"),
  logCount: document.getElementById("logCount"),

  footStatus: document.getElementById("footStatus"),
};

let lastRenderedFile = null;
let lastGallerySignature = "";
let startedAt = null;

// Live stream: mark the frame as "has-image" once the MJPEG stream actually
// loads, and fall back to the empty state if it errors out (e.g. no camera).
el.liveImg.addEventListener("load", () => {
  el.liveFrame.classList.add("has-image");
});
el.liveImg.addEventListener("error", () => {
  el.liveFrame.classList.remove("has-image");
});

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

    // refresh the gallery whenever a new capture has landed
    if (data.last_capture_file && data.last_capture_file !== lastRenderedFile) {
      lastRenderedFile = data.last_capture_file;
      pollGallery();
    }

    // log
    renderLog(data.events);
    el.logCount.textContent = data.total_events ?? 0;

    el.footStatus.textContent = "connected";
  } catch (err) {
    el.footStatus.textContent = "connection lost — retrying…";
  }
}

function renderGallery(files) {
  const signature = files.join(",");
  if (signature === lastGallerySignature) return; // avoid needless re-render/flicker
  lastGallerySignature = signature;

  el.galleryCount.textContent = files.length;

  if (!files.length) {
    el.galleryStrip.innerHTML =
      '<p class="gallery-empty" id="galleryEmpty">Snapshots taken on motion will appear here.</p>';
    return;
  }

  el.galleryStrip.innerHTML = files
    .map((filename) => {
      // filenames look like motion_20260918_025309.jpg — pull a readable time out of it
      const match = filename.match(/(\d{2})(\d{2})(\d{2})\.\w+$/);
      const timeLabel = match ? `${match[1]}:${match[2]}:${match[3]}` : "";
      return `
        <div class="gallery-shot" title="${filename}">
          <img src="/captures/${filename}" alt="Motion capture ${filename}" loading="lazy">
          <span class="gallery-shot-time">${timeLabel}</span>
        </div>`;
    })
    .join("");
}

async function pollGallery() {
  try {
    const res = await fetch("/api/gallery", { cache: "no-store" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    renderGallery(data.files || []);
  } catch (err) {
    /* leave the existing gallery in place on a transient failure */
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
pollGallery();
setInterval(poll, POLL_MS);
setInterval(pollGallery, POLL_MS * 4); // gallery changes less often than status
