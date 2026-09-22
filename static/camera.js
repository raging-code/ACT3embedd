/* Perimeter — Camera Watch (Fig. 3.1-3.2): dashboard logic
   Polls /api/status every second and updates the console in place.

   Perf notes (2026-09-21 optimization pass):
   - The event log now only re-renders its innerHTML when the underlying
     events actually changed (signature check), matching the gallery's
     existing dedupe pattern. Previously it rebuilt the whole <ol> every
     single poll tick even when nothing changed.
   - Polling pauses while the tab is hidden/backgrounded (Page
     Visibility API) and does one immediate catch-up poll the moment the
     tab becomes visible again, instead of silently drifting or wasting
     cycles on a tab nobody is looking at.
   - A failing connection now backs off (1s -> up to 8s) instead of
     hammering the server every second while offline; success resets it
     back to the normal 1s cadence immediately.
   - Fetches use an AbortController so a slow/hung request from a
     previous tick can't pile up behind a new one after a tab-visibility
     resume. */

const POLL_MS = 1000;
const POLL_MS_MAX = 8000;

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
let lastLogSignature = "";
let pollTimer = null;
let currentPollMs = POLL_MS;
let statusAbort = null;

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
  const signature = events && events.length
    ? events.map((e) => `${e.timestamp}|${e.file || ""}`).join(",")
    : "";
  if (signature === lastLogSignature) return; // nothing changed -- skip the rebuild
  lastLogSignature = signature;

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

function scheduleNextPoll(ms) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, ms);
}

async function poll() {
  if (document.hidden) {
    // Don't fetch while the tab is backgrounded; resume is handled by the
    // visibilitychange listener below.
    return;
  }

  if (statusAbort) statusAbort.abort();
  statusAbort = new AbortController();

  try {
    const res = await fetch("/api/status", { cache: "no-store", signal: statusAbort.signal });
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
    currentPollMs = POLL_MS; // connection is healthy -- back to full speed
  } catch (err) {
    if (err.name !== "AbortError") {
      el.footStatus.textContent = "connection lost — retrying…";
      currentPollMs = Math.min(currentPollMs * 2, POLL_MS_MAX); // back off while offline
    }
  } finally {
    scheduleNextPoll(currentPollMs);
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

// Pause polling while the tab is hidden/backgrounded; catch up immediately
// on return instead of waiting out whatever interval was mid-flight.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    currentPollMs = POLL_MS;
    scheduleNextPoll(0);
  }
});

let galleryTimer = setInterval(() => {
  if (!document.hidden) pollGallery();
}, POLL_MS * 4); // gallery changes less often than status

poll();
pollGallery();
if (window.initMotionGraph) window.initMotionGraph("motionGraph", "31");
