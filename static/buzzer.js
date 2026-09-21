/* Perimeter — Buzzer + Graph (Fig. 3.3): dashboard logic
   Polls /api/status every second and updates the console in place. */

const POLL_MS = 1000;

const el = {
  clock: document.getElementById("clock"),
  pulseDot: document.getElementById("pulse-dot"),
  armToggle: document.getElementById("armToggle"),

  statTotal: document.getElementById("statTotal"),
  statUptime: document.getElementById("statUptime"),

  modBuzzerState: document.getElementById("modBuzzerState"),

  logList: document.getElementById("logList"),
  logCount: document.getElementById("logCount"),

  footStatus: document.getElementById("footStatus"),

  buzzerVisual: document.getElementById("buzzerVisual"),
  buzzerTestBtn: document.getElementById("buzzerTestBtn"),
  buzzerHint: document.getElementById("buzzerHint"),

  readingsChart: document.getElementById("readingsChart"),
  readingsCount: document.getElementById("readingsCount"),
  chartEmpty: document.getElementById("chartEmpty"),

  recordingStrip: document.getElementById("recordingStrip"),
  recordingCount: document.getElementById("recordingCount"),
};

let lastRenderedRecording = null;
let lastRecordingSignature = "";

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

    // buzzer module + visual
    setModule(el.modBuzzerState, data.buzzer_ok, "ready", "offline");
    el.buzzerVisual.classList.toggle("sounding", !!data.buzzer_active || !!data.recording_active);
    el.buzzerHint.textContent = data.recording_active
      ? "Recording a 5-second clip right now…"
      : "Sounds automatically whenever motion is detected while armed. A 5-second video also records.";

    // refresh the video-clip gallery whenever a new recording has landed
    if (data.last_recording_file && data.last_recording_file !== lastRenderedRecording) {
      lastRenderedRecording = data.last_recording_file;
      pollRecordings();
    }

    // log
    renderLog(data.events);
    el.logCount.textContent = data.total_events ?? 0;

    el.footStatus.textContent = "connected";
  } catch (err) {
    el.footStatus.textContent = "connection lost — retrying…";
  }
}

// --------------------------------------------------------------------------
// Sensor readings chart (plain inline SVG, no chart library)
// --------------------------------------------------------------------------

const CHART_W = 640;
const CHART_H = 220;
const CHART_PAD = 18;

function renderReadingsChart(readings) {
  if (!readings || readings.length === 0) {
    el.readingsChart.innerHTML = "";
    el.chartEmpty.style.display = "block";
    return;
  }
  el.chartEmpty.style.display = "none";

  const n = readings.length;
  const usableW = CHART_W - CHART_PAD * 2;
  const usableH = CHART_H - CHART_PAD * 2;
  const stepX = n > 1 ? usableW / (n - 1) : 0;

  const points = readings.map((r, i) => {
    const x = CHART_PAD + i * stepX;
    const y = CHART_PAD + (r.motion ? 0 : usableH); // motion = high line, idle = low line
    return { x, y, motion: !!r.motion };
  });

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");

  const areaPath =
    `M ${CHART_PAD} ${CHART_H - CHART_PAD} ` +
    points.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") +
    ` L ${points[points.length - 1].x.toFixed(1)} ${CHART_H - CHART_PAD} Z`;

  const dots = points
    .filter((p) => p.motion)
    .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" class="chart-dot"/>`)
    .join("");

  const gridLines = [0.25, 0.5, 0.75].map((frac) => {
    const y = CHART_PAD + usableH * frac;
    return `<line x1="${CHART_PAD}" y1="${y}" x2="${CHART_W - CHART_PAD}" y2="${y}" class="chart-grid"/>`;
  }).join("");

  el.readingsChart.innerHTML = `
    <defs>
      <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--signal)" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="var(--signal)" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${gridLines}
    <path d="${areaPath}" fill="url(#chartFill)" stroke="none"/>
    <path d="${linePath}" fill="none" stroke="var(--signal)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
  `;
}

async function pollReadings() {
  try {
    const res = await fetch("/api/readings", { cache: "no-store" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    const readings = data.readings || [];
    el.readingsCount.textContent = readings.length;
    renderReadingsChart(readings);
  } catch (err) {
    /* leave the existing chart in place on a transient failure */
  }
}

// --------------------------------------------------------------------------
// Motion-triggered video recordings gallery
// --------------------------------------------------------------------------

function renderRecordings(files) {
  const signature = files.join(",");
  if (signature === lastRecordingSignature) return; // avoid needless re-render/flicker
  lastRecordingSignature = signature;

  el.recordingCount.textContent = files.length;

  if (!files.length) {
    el.recordingStrip.innerHTML =
      '<p class="gallery-empty" id="recordingEmpty">5-second clips recorded on motion will appear here.</p>';
    return;
  }

  el.recordingStrip.innerHTML = files
    .map((filename) => {
      // filenames look like motion_20260918_025309.mp4 — pull a readable time out of it
      const match = filename.match(/(\d{2})(\d{2})(\d{2})\.\w+$/);
      const timeLabel = match ? `${match[1]}:${match[2]}:${match[3]}` : "";
      return `
        <div class="gallery-shot" title="${filename}">
          <video src="/recordings/${filename}" muted loop playsinline preload="metadata"
                 onmouseenter="this.play()" onmouseleave="this.pause(); this.currentTime = 0;"></video>
          <span class="gallery-shot-duration">5s</span>
          <span class="gallery-shot-time">${timeLabel}</span>
        </div>`;
    })
    .join("");
}

async function pollRecordings() {
  try {
    const res = await fetch("/api/recordings", { cache: "no-store" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    renderRecordings(data.files || []);
  } catch (err) {
    /* leave the existing recordings gallery in place on a transient failure */
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

el.buzzerTestBtn.addEventListener("click", async () => {
  el.buzzerTestBtn.disabled = true;
  try {
    await fetch("/api/buzzer/test", { method: "POST" });
  } catch (err) {
    /* status poll will reflect actual buzzer state regardless */
  }
  setTimeout(() => { el.buzzerTestBtn.disabled = false; }, 1600);
});

poll();
pollReadings();
pollRecordings();
setInterval(poll, POLL_MS);
setInterval(pollReadings, POLL_MS);
setInterval(pollRecordings, POLL_MS * 4);
