#!/usr/bin/env node
/**
 * apply-edge-triggered-capture.mjs
 * ----------------------------------------------------------------------
 * Changes how motion detection drives capture in app.py:
 *
 * 1. POLL RATE
 *    The sensor loop now checks the PIR sensor once per second instead
 *    of every 0.15s.
 *
 * 2. FIG. 3.1 / 3.2 (snapshot) — edge-triggered, single image per streak
 *    Old behavior: while motion stayed on, a new snapshot could still
 *    fire every COOLDOWN_SECONDS (5s).
 *    New behavior: a snapshot fires ONLY on the rising edge (motion
 *    goes idle -> active). While motion stays continuously active, all
 *    further readings are discarded — no new snapshot. Example: motion
 *    detected at 7:13:01 and stays on until 7:13:06 -> exactly one
 *    image, timestamped 7:13:01. A new snapshot only fires after motion
 *    drops back to idle and then trips again.
 *
 * 3. FIG. 3.3 (video) — minimum 10s, extended for as long as motion lasts
 *    Old behavior: record_clip() always recorded a fixed RECORDING_SECONDS
 *    (5s) clip regardless of how long motion actually lasted.
 *    New behavior: RECORDING_SECONDS becomes the MINIMUM clip length
 *    (10s). record_clip() still records at least that long, but if
 *    motion is still active when the minimum is reached, it keeps
 *    recording — checking system_state["motion_detected"] each frame —
 *    and only stops once motion actually clears. Example: motion
 *    7:13:06-7:13:09 (3s) -> one clip padded to the 10s minimum,
 *    7:13:06-7:13:16. Motion continuously 7:13:06-7:13:26 (20s) -> one
 *    continuous ~20s clip covering the whole span, not a fixed 10s cut.
 *
 * Changes to app.py:
 *   - RECORDING_SECONDS comment updated: fixed length -> minimum length
 *   - COOLDOWN_SECONDS is no longer used for gating captures (edge
 *     detection replaces it); the constant and its comment are updated
 *     to reflect that it's now unused / kept only for reference
 *   - record_clip(): loops on a "recorded at least `seconds` AND motion
 *     has cleared" condition instead of a fixed end_at deadline, for
 *     both the SIMULATE and real-camera paths
 *   - sensor_loop(): replaces the cooldown-based trigger with rising-edge
 *     detection using a `motion_active` flag, and changes the poll
 *     interval from 0.15s to 1s
 *
 * static/*.js, templates/*.html are NOT touched by this patch — the
 * event/graph/gallery plumbing already keys everything off event
 * timestamps and just displays whatever app.py produces.
 *
 * Usage:
 *   node apply-edge-triggered-capture.mjs             # run from repo root
 *   node apply-edge-triggered-capture.mjs --dry-run   # preview only
 *   node apply-edge-triggered-capture.mjs --root /path/to/ACT3embedd
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

const APP_PY_PATH = path.join(projectRoot, "app.py");

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
    console.log(
      `  [dry-run] would back up -> ${path.relative(
        projectRoot,
        path.join(backupDir, path.basename(filePath))
      )}`
    );
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
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
  console.log(`  wrote ${path.relative(projectRoot, filePath)} (${contents.length} bytes)`);
}

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
  const { content, applied, alreadyPresent, missing } = applyReplacements(original, replacements);

  if (applied > 0) {
    await writeFile(filePath, content);
  } else {
    console.log(`  (no changes needed)`);
  }

  return { applied, alreadyPresent, missing };
}

// ---------------------------------------------------------------------
// app.py replacements
// ---------------------------------------------------------------------
const APP_PY_REPLACEMENTS = [
  {
    label: "RECORDING_SECONDS: 5 (fixed) -> 10 (minimum, extended while motion continues)",
    find: `RECORDING_SECONDS = 5       # length of the Fig. 3.3 motion-triggered video clip`,
    replace: `RECORDING_SECONDS = 10      # MINIMUM length of the Fig. 3.3 motion-triggered video
                             # clip; if motion is still active once this is reached,
                             # recording keeps extending until motion actually clears`,
  },
  {
    label: "COOLDOWN_SECONDS: comment updated -- no longer gates captures (edge detection replaces it)",
    find: `COOLDOWN_SECONDS = 5        # minimum time between two triggered captures`,
    replace: `COOLDOWN_SECONDS = 5        # unused by the sensor loop now -- captures are edge-
                             # triggered (once per idle->motion transition) instead of
                             # cooldown-gated; kept in case other code references it`,
  },
  {
    label: "record_clip(): motion-aware minimum-length loop, SIMULATE path",
    find: `    if SIMULATE:
        # Write a short simulated clip so the gallery/player has something
        # real to show even without physical hardware.
        writer = cv2.VideoWriter(
            filepath, cv2.VideoWriter_fourcc(*"mp4v"), fps, (640, 480)
        )
        for _ in range(int(seconds * fps)):
            writer.write(_simulated_frame(label="RECORDING"))
            time.sleep(1 / fps)
        writer.release()
        return filename`,
    replace: `    def _motion_still_active():
        with state_lock:
            return bool(system_state.get("motion_detected"))

    if SIMULATE:
        # Write a short simulated clip so the gallery/player has something
        # real to show even without physical hardware. Runs at least
        # \`seconds\` (the minimum), then keeps going for as long as motion
        # is still active, matching the real-camera path below.
        writer = cv2.VideoWriter(
            filepath, cv2.VideoWriter_fourcc(*"mp4v"), fps, (640, 480)
        )
        frame_interval = 1 / fps
        start = time.time()
        frame_count = 0
        while True:
            writer.write(_simulated_frame(label="RECORDING"))
            frame_count += 1
            time.sleep(frame_interval)
            elapsed = time.time() - start
            if elapsed >= seconds and not _motion_still_active():
                break
        writer.release()
        return filename`,
  },
  {
    label: "record_clip(): motion-aware minimum-length loop, real-camera path",
    find: `    frame_interval = 1 / fps
    end_at = time.time() + seconds
    while time.time() < end_at:
        start = time.time()
        frame = grab_frame()
        if frame is not None:
            writer.write(frame)
        elapsed = time.time() - start
        time.sleep(max(0.0, frame_interval - elapsed))

    writer.release()
    return filename`,
    replace: `    frame_interval = 1 / fps
    clip_start = time.time()
    while True:
        loop_start = time.time()
        frame = grab_frame()
        if frame is not None:
            writer.write(frame)
        elapsed_frame = time.time() - loop_start
        time.sleep(max(0.0, frame_interval - elapsed_frame))

        elapsed_total = time.time() - clip_start
        if elapsed_total >= seconds and not _motion_still_active():
            break

    writer.release()
    return filename`,
  },
  {
    label: "sensor_loop(): rising-edge detection replaces cooldown gate, 1s poll interval",
    find: `    last_trigger = 0.0

    while True:
        try:
            motion = read_pir()
            with state_lock:
                armed = system_state["armed"]

            # Record a reading point on every poll so Fig. 3.3's graph has a
            # continuous timeline, not just spikes at trigger moments.
            reading_log.append({
                "t": datetime.now().isoformat(timespec="seconds"),
                "motion": bool(motion and armed),
            })

            if motion and armed:
                now = time.time()
                if now - last_trigger >= COOLDOWN_SECONDS:
                    last_trigger = now
                    filename = capture_frame()
                    sound_buzzer()
                    record_clip_async()
                    event = {
                        "timestamp": datetime.now().isoformat(timespec="seconds"),
                        "file": filename,
                    }
                    with state_lock:
                        system_state["motion_detected"] = True
                        system_state["last_motion_at"] = event["timestamp"]
                        system_state["total_events"] += 1
                        if filename:
                            system_state["last_capture_file"] = filename
                    event_log.appendleft(event)
                    print(f"[{event['timestamp']}] Motion detected -> {filename} (buzzer sounded, recording {RECORDING_SECONDS}s clip)")
            else:
                with state_lock:
                    system_state["motion_detected"] = False

            time.sleep(0.15)
        except Exception as exc:  # keep the loop alive even if a single read fails
            print(f"Sensor loop error: {exc}")
            time.sleep(1)`,
    replace: `    motion_active = False  # tracks whether we're inside an ongoing motion
                            # streak, so capture only fires on the idle->motion
                            # edge and everything else during the streak is
                            # discarded, per Fig. 3.1/3.2's one-shot rule

    while True:
        try:
            motion = read_pir()
            with state_lock:
                armed = system_state["armed"]

            is_motion_now = bool(motion and armed)

            # Record a reading point on every poll so Fig. 3.3's graph has a
            # continuous timeline, not just spikes at trigger moments.
            reading_log.append({
                "t": datetime.now().isoformat(timespec="seconds"),
                "motion": is_motion_now,
            })

            if is_motion_now and not motion_active:
                # Rising edge: idle -> motion. Fire exactly one capture for
                # this streak. Everything else while motion stays on is
                # discarded until it drops back to idle (motion_active=False)
                # and trips again.
                motion_active = True
                filename = capture_frame()
                sound_buzzer()
                record_clip_async()
                event = {
                    "timestamp": datetime.now().isoformat(timespec="seconds"),
                    "file": filename,
                }
                with state_lock:
                    system_state["motion_detected"] = True
                    system_state["last_motion_at"] = event["timestamp"]
                    system_state["total_events"] += 1
                    if filename:
                        system_state["last_capture_file"] = filename
                event_log.appendleft(event)
                print(f"[{event['timestamp']}] Motion detected -> {filename} (buzzer sounded, recording >= {RECORDING_SECONDS}s clip)")
            elif is_motion_now and motion_active:
                # Motion continues from the same streak -- keep
                # motion_detected true (record_clip() reads this to decide
                # whether to keep extending past the minimum length) but
                # discard it as a new event.
                with state_lock:
                    system_state["motion_detected"] = True
            else:
                # Idle: streak (if any) has ended, ready to trigger again.
                motion_active = False
                with state_lock:
                    system_state["motion_detected"] = False

            time.sleep(1)  # poll the PIR sensor once per second
        except Exception as exc:  # keep the loop alive even if a single read fails
            print(f"Sensor loop error: {exc}")
            time.sleep(1)`,
  },
];

async function main() {
  const backupDir = path.join(projectRoot, "backup", timestamp());

  console.log(`Perimeter -- edge-triggered capture (1s poll, single image per streak, min-10s extending video)`);
  console.log(`root: ${projectRoot}`);
  if (dryRun) console.log(`(dry run -- no files will be written)`);

  const result = await patchFile(APP_PY_PATH, APP_PY_REPLACEMENTS, backupDir);

  console.log(
    `\nDone. ${result.applied} change(s) applied, ${result.alreadyPresent} already in place, ${result.missing} not found.`
  );
  if (dryRun) console.log(`Re-run without --dry-run to write changes.`);
}

main().catch((err) => {
  console.error("Patch failed:", err);
  process.exit(1);
});
