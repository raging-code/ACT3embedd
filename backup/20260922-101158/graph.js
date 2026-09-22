/* Perimeter — Unified 24h motion graph (Fig. 3.1 / Fig. 3.3)
   ----------------------------------------------------------------------
   A single canvas-based motion timeline shared by both the Camera Watch
   (Fig. 3.1-3.2) and Buzzer + Graph (Fig. 3.3) dashboards, replacing the
   old split UI where only the buzzer page had a (much simpler) SVG chart
   and the camera page had none at all.

   - Renders every motion event of the last 24h as a spike on a
     pannable/zoomable timeline (drag to pan, scroll wheel to zoom,
     shift+scroll / two-finger horizontal scroll to pan).
   - Hovering a spike shows its timestamp; clicking one opens a
     fullscreen popup with either the still snapshot (Fig. 3.1, the
     motion_*.jpg captured at that moment) or the 5-second recorded
     clip (Fig. 3.3, the matching motion_*.mp4) depending on which
     figure is selected in the toggle.
   - Pulls real events from /api/events (added alongside this patch)
     instead of the sample/demo data the design mockup used.

   Usage: include this script on a page that has a container element
   with id="motionGraph" wrapping the markup produced by
   renderMotionGraphShell(), then call initMotionGraph().
   Both buzzer.html and camera.html do this identically so the two
   dashboards no longer disagree about what the graph looks like. */

(function () {
  const DAY = 86400;
  const MIN_LEN = 15 * 60;
  const PADL = 26;
  const PADR = 26;
  const EVENTS_POLL_MS = 4000;

  const pad2 = (n) => String(n).padStart(2, "0");
  const hms = (s) => `${pad2(Math.floor(s / 3600) % 24)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(Math.floor(s % 60))}`;

  function initMotionGraph(rootId) {
    const root = document.getElementById(rootId || "motionGraph");
    if (!root) return;

    const cv = root.querySelector(".mg-canvas");
    const ctx = cv.getContext("2d");
    const tipEl = root.querySelector(".mg-tip");
    const countEl = root.querySelector(".mg-count");
    const zoomEl = root.querySelector(".mg-zoom");
    const rangeEl = root.querySelector(".mg-range");
    const emptyEl = root.querySelector(".mg-empty");
    const segEl = root.querySelector(".mg-seg");
    const pop = root.querySelector(".mg-pop");
    const popFrame = root.querySelector(".mg-pop-frame");
    const popTitle = root.querySelector(".mg-pop-title");
    const popX = root.querySelector(".mg-pop-x");

    let events = [];      // [{t, ts, file_image, file_video}] — t = seconds since local midnight
    let viewStart = 0;
    let viewLen = DAY;
    let W = 0, H = 0, dpr = 1;
    let hover = null, drag = null, selected = null;
    let fig = "31"; // '31' = image popup, '33' = video popup
    let eventsAbort = null;
    let pollTimer = null;

    function resize() {
      dpr = window.devicePixelRatio || 1;
      const r = cv.getBoundingClientRect();
      W = r.width;
      H = r.height;
      if (!W || !H) return;
      cv.width = W * dpr;
      cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    const plotW = () => Math.max(1, W - PADL - PADR);
    const xOf = (t) => PADL + ((t - viewStart) / viewLen) * plotW();
    const tOf = (x) => viewStart + ((x - PADL) / plotW()) * viewLen;
    const axisY = () => H - 50;
    const spikeH = (e) => 46 + ((e.ts * 7) % 60); // deterministic 46-106px

    function clampView() {
      viewLen = Math.min(DAY, Math.max(MIN_LEN, viewLen));
      viewStart = Math.min(DAY - viewLen, Math.max(0, viewStart));
    }

    function line(x1, y1, x2, y2, w, a, blur) {
      ctx.save();
      ctx.strokeStyle = `rgba(255,255,255,${a})`;
      ctx.lineWidth = w;
      ctx.lineCap = "round";
      if (blur) {
        ctx.shadowColor = "rgba(95,176,240,.65)";
        ctx.shadowBlur = blur;
      }
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.restore();
    }

    function dot(x, y, r, a, blur, color) {
      ctx.save();
      ctx.fillStyle = color || `rgba(255,255,255,${a})`;
      if (blur) {
        ctx.shadowColor = "rgba(95,176,240,.65)";
        ctx.shadowBlur = blur;
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function tickStep() {
      const secPerPx = viewLen / plotW();
      for (const s of [60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600]) {
        if (s / secPerPx >= 92) return s;
      }
      return 21600;
    }

    function drawAxis() {
      const ay = axisY();
      line(PADL, ay, W - PADR, ay, 1.6, 0.85);
      const step = tickStep();
      const first = Math.ceil(viewStart / step) * step;
      ctx.font = "600 11px 'Geist Mono', monospace";
      ctx.textAlign = "center";
      for (let t = first; t <= viewStart + viewLen + 1; t += step) {
        const x = xOf(t);
        if (x < PADL - 1 || x > W - PADR + 1) continue;
        const major = t % 3600 === 0;
        ctx.strokeStyle = major ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 22);
        ctx.lineTo(x, ay);
        ctx.stroke();
        line(x, ay, x, ay + (major ? 9 : 5), major ? 1.4 : 1, major ? 0.85 : 0.5);
        ctx.fillStyle = major ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.5)";
        const lab = major
          ? `${pad2((t / 3600) % 24)}:00`
          : `${pad2(Math.floor(t / 3600) % 24)}:${pad2(Math.floor((t % 3600) / 60))}`;
        ctx.fillText(t >= DAY ? "24:00" : lab, x, ay + 26);
      }
    }

    function drawSpikes() {
      const ay = axisY();
      events.forEach((e) => {
        const x = xOf(e.t);
        if (x < PADL - 24 || x > W - PADR + 24) return;
        const active = hover === e || selected === e;
        const h = spikeH(e) + (active ? 12 : 0);
        const top = ay - h;
        const g = ctx.createLinearGradient(0, top, 0, ay);
        g.addColorStop(0, `rgba(95,176,240,${active ? 0.28 : 0.14})`);
        g.addColorStop(1, "rgba(95,176,240,0)");
        ctx.fillStyle = g;
        ctx.fillRect(x - 8, top, 16, ay - top);
        line(x, ay, x, top, active ? 2.6 : 2, active ? 1 : 0.9, active ? 8 : 0);
        dot(x, top, active ? 4.5 : 3.2, 1, active ? 10 : 0, "rgba(95,176,240,1)");
        dot(x, ay, active ? 3.2 : 2.4, 0.95);
      });
    }

    function drawMini() {
      if (viewLen >= DAY) return;
      const mw = 130, mx = W - PADR - mw, my = 10;
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,.4)";
      ctx.lineWidth = 1;
      ctx.strokeRect(mx, my, mw, 7);
      ctx.fillStyle = "rgba(255,255,255,.9)";
      ctx.fillRect(mx + (viewStart / DAY) * mw, my, Math.max(3, (viewLen / DAY) * mw), 7);
      ctx.restore();
    }

    function draw() {
      if (!W || !H) return;
      ctx.clearRect(0, 0, W, H);
      drawAxis();
      drawSpikes();
      drawMini();
      if (zoomEl) zoomEl.textContent = (DAY / viewLen).toFixed(1) + "×";
      if (rangeEl) {
        rangeEl.textContent = `${hms(viewStart).slice(0, 5)} – ${hms(Math.min(DAY, viewStart + viewLen)).slice(0, 5)}`;
      }
    }

    let rafId = null;
    function loop() {
      draw();
      rafId = requestAnimationFrame(loop);
    }

    function hit(x, y) {
      const ay = axisY();
      let best = null, bd = 22;
      events.forEach((e) => {
        const ex = xOf(e.t);
        if (ex < PADL - 14 || ex > W - PADR + 14) return;
        const h = spikeH(e);
        if (y < ay - h - 16 || y > ay + 10) return;
        const d = Math.abs(ex - x);
        if (d < bd) { bd = d; best = e; }
      });
      return best;
    }

    function showTip(e) {
      if (!tipEl) return;
      if (!e) { tipEl.classList.remove("on"); return; }
      tipEl.textContent = hms(e.t);
      tipEl.style.left = xOf(e.t) + 6 + "px";
      tipEl.style.top = axisY() - spikeH(e) - 22 + 10 + "px";
      tipEl.classList.add("on");
    }

    // ---------------- popup (Fig 3.1 image / Fig 3.3 video) ----------------

    function openPop(e) {
      selected = e;
      const wantsVideo = fig === "33";
      const file = wantsVideo ? e.file_video : e.file_image;
      const label = hms(e.t);
      popTitle.innerHTML = file
        ? `${label}<span>${file}</span>`
        : `${label}<span>no ${wantsVideo ? "recording" : "snapshot"} on disk</span>`;

      popFrame.querySelectorAll(".mg-pop-media, .mg-pop-missing").forEach((n) => n.remove());

      if (!file) {
        const p = document.createElement("p");
        p.className = "mg-pop-missing";
        p.textContent = wantsVideo
          ? "This event doesn't have a matching recorded clip."
          : "This event doesn't have a matching snapshot.";
        popFrame.appendChild(p);
      } else if (wantsVideo) {
        const v = document.createElement("video");
        v.className = "mg-pop-media";
        v.controls = true;
        v.autoplay = true;
        v.loop = true;
        v.playsInline = true;
        v.src = `/recordings/${encodeURIComponent(file)}`;
        popFrame.appendChild(v);
        v.play().catch(() => {});
      } else {
        const img = document.createElement("img");
        img.className = "mg-pop-media";
        img.alt = `Motion snapshot ${label}`;
        img.src = `/captures/${encodeURIComponent(file)}`;
        popFrame.appendChild(img);
      }

      pop.classList.add("open");
    }

    function closePop() {
      pop.classList.remove("open");
      selected = null;
      popFrame.querySelectorAll(".mg-pop-media, .mg-pop-missing").forEach((n) => {
        if (n.pause) n.pause();
        n.remove();
      });
    }

    popX.addEventListener("click", closePop);
    pop.addEventListener("mousedown", (ev) => { if (ev.target === pop) closePop(); });
    window.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && pop.classList.contains("open")) closePop(); });

    segEl.addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (!b) return;
      fig = b.dataset.fig;
      segEl.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    });

    // ---------------- interaction ----------------

    cv.addEventListener("mousemove", (ev) => {
      const r = cv.getBoundingClientRect();
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      if (drag) {
        const dx = x - drag.x;
        viewStart = drag.start - (dx / plotW()) * viewLen;
        clampView();
        if (Math.abs(dx) > 3) drag.moved = true;
        showTip(null);
        return;
      }
      hover = hit(x, y);
      cv.classList.toggle("hot", !!hover);
      showTip(hover);
    });
    cv.addEventListener("mouseleave", () => { hover = null; showTip(null); cv.classList.remove("hot"); });
    cv.addEventListener("mousedown", (ev) => {
      const r = cv.getBoundingClientRect();
      drag = { x: ev.clientX - r.left, start: viewStart, moved: false };
      cv.classList.add("grabbing");
    });
    window.addEventListener("mouseup", (ev) => {
      if (!drag) return;
      const r = cv.getBoundingClientRect();
      if (!drag.moved) {
        const h = hit(ev.clientX - r.left, ev.clientY - r.top);
        if (h) openPop(h);
      }
      drag = null;
      cv.classList.remove("grabbing");
    });
    cv.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const r = cv.getBoundingClientRect();
        const x = ev.clientX - r.left;
        if (ev.shiftKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
          const d = ev.shiftKey ? ev.deltaY : ev.deltaX;
          viewStart += (d / plotW()) * viewLen;
          clampView();
          showTip(null);
          return;
        }
        const anchor = tOf(x);
        viewLen *= Math.exp(ev.deltaY * 0.0016);
        clampView();
        viewStart = anchor - ((x - PADL) / plotW()) * viewLen;
        clampView();
        showTip(null);
      },
      { passive: false }
    );

    // ---------------- touch (basic pan) ----------------

    let touchStartX = null, touchStartView = 0;
    cv.addEventListener("touchstart", (ev) => {
      if (ev.touches.length !== 1) return;
      touchStartX = ev.touches[0].clientX;
      touchStartView = viewStart;
    }, { passive: true });
    cv.addEventListener("touchmove", (ev) => {
      if (touchStartX === null || ev.touches.length !== 1) return;
      const dx = ev.touches[0].clientX - touchStartX;
      viewStart = touchStartView - (dx / plotW()) * viewLen;
      clampView();
    }, { passive: true });
    cv.addEventListener("touchend", (ev) => {
      if (touchStartX === null) return;
      const moved = Math.abs((ev.changedTouches[0]?.clientX || touchStartX) - touchStartX) > 6;
      if (!moved) {
        const r = cv.getBoundingClientRect();
        const t = ev.changedTouches[0];
        const h = hit(t.clientX - r.left, t.clientY - r.top);
        if (h) openPop(h);
      }
      touchStartX = null;
    });

    // ---------------- data ----------------

    function toDayEvents(raw) {
      // raw: [{t: "HH:MM:SS", ts: <unix seconds>, file_image, file_video}]
      return raw.map((r) => {
        const [h, m, s] = r.t.split(":").map(Number);
        return {
          t: h * 3600 + m * 60 + s,
          ts: r.ts,
          file_image: r.file_image || null,
          file_video: r.file_video || null,
        };
      });
    }

    async function pollEvents() {
      if (eventsAbort) eventsAbort.abort();
      eventsAbort = new AbortController();
      try {
        const res = await fetch("/api/events", { cache: "no-store", signal: eventsAbort.signal });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = await res.json();
        events = toDayEvents(data.events || []);
        if (countEl) countEl.textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
        if (emptyEl) emptyEl.style.display = events.length ? "none" : "block";
      } catch (err) {
        /* leave the existing graph in place on a transient failure */
      }
    }

    function schedulePoll() {
      pollEvents();
      pollTimer = setInterval(pollEvents, EVENTS_POLL_MS);
    }

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        if (pollTimer) clearInterval(pollTimer);
      } else {
        pollEvents();
        pollTimer = setInterval(pollEvents, EVENTS_POLL_MS);
      }
    });

    new ResizeObserver(resize).observe(cv);
    resize();
    loop();
    schedulePoll();
  }

  window.initMotionGraph = initMotionGraph;
})();
