#!/usr/bin/env node
/**
 * apply-fig-events-graph-isolation.mjs
 * ----------------------------------------------------------------------
 * Fixes the remaining cross-page leak in the motion-timeline GRAPH after
 * apply-fig-scope-livefeed-fix.mjs (which only scoped the buzzer/
 * recording trigger + the side-panel Event Log).
 *
 * THE BUG
 *   Both camera.html (Fig. 3.1) and buzzer.html (Fig. 3.3) render the
 *   same "Motion timeline · last 24h" graph via graph.js, and both call
 *   the exact same GET /api/events with no distinguishing parameter.
 *   Server-side, api_events() always merges event_log (Fig. 3.1
 *   snapshots) and recording_event_log (Fig. 3.3 recordings) into one
 *   combined timeline by shared timestamp stamp -- by design, at the
 *   time, so "both dashboards show the same unified timeline". So a
 *   motion trigger fired while only Fig. 3.1 was open still produced a
 *   spike on Fig. 3.3's graph (with "no recording on disk" if clicked),
 *   and vice versa -- exactly the cross-logging being reported, just in
 *   the graph rather than the side-panel log (which was already fixed).
 *
 * THE FIX
 *   - graph.js now calls `/api/events?page=camera` from camera.html and
 *     `/api/events?page=buzzer` from buzzer.html (derived from the same
 *     fixedFig="31"/"33" value each page already passes into
 *     initMotionGraph()).
 *   - api_events() in app.py now honors that `page` param:
 *       ?page=camera -> built ONLY from event_log (Fig. 3.1 snapshots).
 *         No video is ever attached, even if one happens to exist for
 *         the same timestamp -- Fig. 3.1's graph can now never show a
 *         Fig. 3.3 recording spike.
 *       ?page=buzzer -> built ONLY from recording_event_log (Fig. 3.3
 *         recordings). The matching snapshot is still attached when
 *         that SAME trigger produced both an image and a video (which
 *         happens exactly when Fig. 3.3 was being watched at the moment
 *         motion fired -- see is_page_active()/sensor_loop() from the
 *         previous patch) -- that's not a cross-page leak, it's the
 *         same physical event's own paired files.
 *       no `page` param -> unchanged legacy merged behavior, kept only
 *         for backward compatibility with anything else still calling
 *         this route without one.
 *
 * Changes:
 *   app.py           - api_events() accepts ?page= and filters per-page
 *   static/graph.js  - pollEvents() passes ?page=camera / ?page=buzzer
 *
 * Requires apply-fig-scope-livefeed-fix.mjs to already be applied
 * (this patch edits the same api_events()/graph.js region it left
 * alone). Running this without that one first will still work, but the
 * buzzer/recording itself won't yet be page-gated -- only the graph will.
 *
 * Usage:
 *   node apply-fig-events-graph-isolation.mjs             # run from the repo root
 *   node apply-fig-events-graph-isolation.mjs --dry-run   # preview only, writes nothing
 *   node apply-fig-events-graph-isolation.mjs --root /path/to/ACT3embedd
 *
 * Safe to re-run: if the patch has already been applied, running again
 * is a no-op.
 * ----------------------------------------------------------------------
 */

import path from "node:path";
import fs from "node:fs/promises";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const rootFlagIndex = args.indexOf("--root");
const projectRoot =
  rootFlagIndex !== -1 && args[rootFlagIndex + 1]
    ? path.resolve(args[rootFlagIndex + 1])
    : process.cwd();

const APP_PATH = path.join(projectRoot, "app.py");
const GRAPH_JS_PATH = path.join(projectRoot, "static", "graph.js");

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function backupFile(filePath, backupDir) {
  if (!(await exists(filePath))) {
    console.log(`  (skip backup -- not found: ${path.relative(projectRoot, filePath)})`);
    return;
  }
  if (dryRun) {
    console.log(`  [dry-run] would back up -> ${path.relative(projectRoot, path.join(backupDir, path.basename(filePath)))}`);
    return;
  }
  await fs.mkdir(backupDir, { recursive: true });
  const dest = path.join(backupDir, path.basename(filePath));
  await fs.copyFile(filePath, dest);
  console.log(`  backed up -> ${path.relative(projectRoot, dest)}`);
}

async function writeFile(filePath, contents) {
  if (dryRun) {
    console.log(`  [dry-run] would write ${path.relative(projectRoot, filePath)} (${contents.length} bytes)`);
    return;
  }
  await fs.writeFile(filePath, contents, "utf8");
  console.log(`  wrote ${path.relative(projectRoot, filePath)} (${contents.length} bytes)`);
}

/**
 * Apply a list of {find, replace, label} string replacements to `content`.
 * Each is applied independently and reports whether it matched, so partial
 * re-runs (patch already applied) don't error out.
 */
function applyReplacements(content, replacements) {
  let applied = 0;
  let alreadyPresent = 0;
  let missing = 0;

  for (const { find, replace, label } of replacements) {
    if (content.includes(replace)) {
      alreadyPresent++;
      console.log(`  = already applied: ${label}`);
      continue;
    }
    if (content.includes(find)) {
      content = content.replace(find, replace);
      applied++;
      console.log(`  \u2713 ${label}`);
    } else {
      missing++;
      console.log(`  ! could not locate: ${label} (skipped -- file may already differ here)`);
    }
  }

  return { content, applied, alreadyPresent, missing };
}

async function patchFile(filePath, replacements, backupDir) {
  const rel = path.relative(projectRoot, filePath);
  if (!(await exists(filePath))) {
    console.log(`! ${rel} not found, skipping`);
    return { applied: 0, alreadyPresent: 0, missing: replacements.length };
  }

  console.log(`\n${rel}`);
  await backupFile(filePath, backupDir);

  const original = await fs.readFile(filePath, "utf8");
  const { content, applied, alreadyPresent, missing } = applyReplacements(
    original,
    replacements
  );

  if (applied > 0) {
    await writeFile(filePath, content);
  } else {
    console.log(`  (no changes needed)`);
  }

  return { applied, alreadyPresent, missing };
}

async function main() {
  const backupDir = path.join(projectRoot, "backup", timestamp());

  console.log(`Perimeter -- Fig. 3.1/3.3 motion-graph isolation fix`);
  console.log(`root: ${projectRoot}`);
  if (dryRun) console.log(`(dry run -- no files will be written)`);

  // ------------------------------------------------------------------
  // app.py
  // ------------------------------------------------------------------
  const appResult = await patchFile(
    APP_PATH,
    [
      {
        label: "page-scope api_events(): camera-only / buzzer-only / legacy merged",
        find:
`@app.route("/api/events")
def api_events():
    """Returns the last 24h of motion-trigger events for the unified
    Fig. 3.1 / Fig. 3.3 motion graph, each paired with both the
    snapshot (.jpg, Fig. 3.1) and recorded clip (.mp4, Fig. 3.3) filed
    under the same motion_YYYYMMDD_HHMMSS stamp, when present on disk.
    Camera watch and buzzer+graph both call this so they show the same
    timeline instead of the old split UI."""
    cutoff = time.time() - 24 * 3600
    with state_lock:
        image_events = list(event_log)
        video_events = list(recording_event_log)

    # Fig. 3.1 (snapshot) and Fig. 3.3 (recording) now log independently
    # (see /api/status), so the graph merges both by their shared
    # motion_YYYYMMDD_HHMMSS stamp to keep showing one unified timeline
    # with both an image and a video attached to the same trigger moment.
    by_stamp = {}

    def stamp_of(filename, ext):
        if filename and filename.startswith("motion_") and filename.endswith(ext):
            return filename[len("motion_"):-len(ext)]
        return None

    for evt in image_events:
        try:
            dt = datetime.fromisoformat(evt["timestamp"])
        except (KeyError, ValueError):
            continue
        ts = dt.timestamp()
        if ts < cutoff:
            continue
        image_file = evt.get("file")
        stamp = stamp_of(image_file, ".jpg") or evt["timestamp"]
        entry = by_stamp.setdefault(stamp, {"t": dt.strftime("%H:%M:%S"), "ts": ts, "file_image": None, "file_video": None})
        if image_file and os.path.exists(os.path.join(CAPTURE_DIR, image_file)):
            entry["file_image"] = image_file

    for evt in video_events:
        try:
            dt = datetime.fromisoformat(evt["timestamp"])
        except (KeyError, ValueError):
            continue
        ts = dt.timestamp()
        if ts < cutoff:
            continue
        video_file = evt.get("file")
        stamp = stamp_of(video_file, ".mp4") or evt["timestamp"]
        entry = by_stamp.setdefault(stamp, {"t": dt.strftime("%H:%M:%S"), "ts": ts, "file_image": None, "file_video": None})
        if video_file and os.path.exists(os.path.join(RECORDING_DIR, video_file)):
            entry["file_video"] = video_file
        # a stamp that only has a video event so far still needs its
        # matching snapshot filled in if one exists on disk
        if entry["file_image"] is None:
            candidate = f"motion_{stamp}.jpg"
            if os.path.exists(os.path.join(CAPTURE_DIR, candidate)):
                entry["file_image"] = candidate

    # and an image-only entry still needs its matching clip filled in
    for stamp, entry in by_stamp.items():
        if entry["file_video"] is None:
            candidate = f"motion_{stamp}.mp4"
            if os.path.exists(os.path.join(RECORDING_DIR, candidate)):
                entry["file_video"] = candidate

    out = sorted(by_stamp.values(), key=lambda e: e["ts"])
    return jsonify({"events": out})`,
        replace:
`@app.route("/api/events")
def api_events():
    """Returns the last 24h of motion-trigger events for the motion graph.
    \`?page=camera\` (Fig. 3.1) returns ONLY snapshot events -- no video is
    ever attached, even if one happens to exist for the same timestamp,
    so Fig. 3.1's timeline can never show a Fig. 3.3 recording spike.
    \`?page=buzzer\` (Fig. 3.3) returns ONLY recording events, paired with
    their snapshot only when that same trigger produced both (which
    happens exactly when Fig. 3.3 was being watched at the moment motion
    fired -- see is_page_active() / sensor_loop()). No \`page\` param keeps
    the old merged-timeline behavior, for backward compatibility with
    anything else still calling this route without one."""
    from flask import request
    page = request.args.get("page")
    cutoff = time.time() - 24 * 3600
    with state_lock:
        image_events = list(event_log)
        video_events = list(recording_event_log)

    by_stamp = {}

    def stamp_of(filename, ext):
        if filename and filename.startswith("motion_") and filename.endswith(ext):
            return filename[len("motion_"):-len(ext)]
        return None

    if page != "buzzer":
        for evt in image_events:
            try:
                dt = datetime.fromisoformat(evt["timestamp"])
            except (KeyError, ValueError):
                continue
            ts = dt.timestamp()
            if ts < cutoff:
                continue
            image_file = evt.get("file")
            stamp = stamp_of(image_file, ".jpg") or evt["timestamp"]
            entry = by_stamp.setdefault(stamp, {"t": dt.strftime("%H:%M:%S"), "ts": ts, "file_image": None, "file_video": None})
            if image_file and os.path.exists(os.path.join(CAPTURE_DIR, image_file)):
                entry["file_image"] = image_file

    if page != "camera":
        for evt in video_events:
            try:
                dt = datetime.fromisoformat(evt["timestamp"])
            except (KeyError, ValueError):
                continue
            ts = dt.timestamp()
            if ts < cutoff:
                continue
            video_file = evt.get("file")
            stamp = stamp_of(video_file, ".mp4") or evt["timestamp"]
            entry = by_stamp.setdefault(stamp, {"t": dt.strftime("%H:%M:%S"), "ts": ts, "file_image": None, "file_video": None})
            if video_file and os.path.exists(os.path.join(RECORDING_DIR, video_file)):
                entry["file_video"] = video_file
            # a stamp that only has a video event so far still needs its
            # matching snapshot filled in if one exists on disk -- safe,
            # because it's the SAME physical trigger that produced both
            # files, not a snapshot borrowed from an unrelated Fig. 3.1
            # session
            if entry["file_image"] is None:
                candidate = f"motion_{stamp}.jpg"
                if os.path.exists(os.path.join(CAPTURE_DIR, candidate)):
                    entry["file_image"] = candidate

    if page not in ("camera", "buzzer"):
        # legacy/no-page-param behavior: keep the old cross-pairing so
        # anything still calling this route without ?page= sees the
        # original unified timeline
        for stamp, entry in by_stamp.items():
            if entry["file_video"] is None:
                candidate = f"motion_{stamp}.mp4"
                if os.path.exists(os.path.join(RECORDING_DIR, candidate)):
                    entry["file_video"] = candidate

    out = sorted(by_stamp.values(), key=lambda e: e["ts"])
    return jsonify({"events": out})`,
      },
    ],
    backupDir
  );

  // ------------------------------------------------------------------
  // static/graph.js
  // ------------------------------------------------------------------
  const graphJsResult = await patchFile(
    GRAPH_JS_PATH,
    [
      {
        label: "pollEvents() requests /api/events?page=camera or ?page=buzzer instead of the unscoped endpoint",
        find:
`    async function pollEvents() {
      if (eventsAbort) eventsAbort.abort();
      eventsAbort = new AbortController();
      try {
        const res = await fetch("/api/events", { cache: "no-store", signal: eventsAbort.signal });`,
        replace:
`    async function pollEvents() {
      if (eventsAbort) eventsAbort.abort();
      eventsAbort = new AbortController();
      try {
        // Scope the timeline to this dashboard's own events -- Fig. 3.1
        // (fig "31") should never show a Fig. 3.3 recording spike and
        // vice versa. See /api/events in app.py for the page-filtered logic.
        const pageParam = fixedFig === "33" ? "buzzer" : fixedFig === "31" ? "camera" : "";
        const url = pageParam ? \`/api/events?page=\${pageParam}\` : "/api/events";
        const res = await fetch(url, { cache: "no-store", signal: eventsAbort.signal });`,
      },
    ],
    backupDir
  );

  const totals = [appResult, graphJsResult].reduce(
    (acc, r) => ({
      applied: acc.applied + r.applied,
      alreadyPresent: acc.alreadyPresent + r.alreadyPresent,
      missing: acc.missing + r.missing,
    }),
    { applied: 0, alreadyPresent: 0, missing: 0 }
  );

  console.log(
    `\nDone. ${totals.applied} change(s) applied, ${totals.alreadyPresent} already in place, ${totals.missing} not found.`
  );
  if (dryRun) console.log(`Re-run without --dry-run to write changes.`);
  if (totals.missing > 0) {
    console.log(
      `\nSome anchors weren't found -- this usually means app.py/graph.js have drifted ` +
      `from the version this patch was written against (e.g. apply-fig-scope-livefeed-fix.mjs ` +
      `not applied yet, or api_events()/pollEvents() edited since). Check the "!" lines above.`
    );
  }
}

main().catch((err) => {
  console.error("Patch failed:", err);
  process.exit(1);
});
