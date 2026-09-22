#!/usr/bin/env node
/**
 * apply-fig-events-counter-fix.mjs
 * ----------------------------------------------------------------------
 * Fixes the "EVENTS LOGGED" stat (and the matching badge next to the
 * Event log heading) showing the SAME number on both Fig. 3.1
 * (camera.html) and Fig. 3.3 (buzzer.html), even though the two
 * dashboards' event logs and graphs are otherwise correctly separated.
 *
 * ROOT CAUSE
 *   /api/status already computes a page-scoped counter and puts it on
 *   the response as `total_events_for_page`:
 *     - ?page=camera -> total_events            (Fig. 3.1 snapshot count)
 *     - ?page=buzzer -> total_recording_events   (Fig. 3.3 recording count)
 *   But camera.js and buzzer.js never read that field -- both read
 *   `data.total_events` instead, which is the old GLOBAL counter that
 *   increments on every motion trigger regardless of which page caused
 *   it. So a motion event on Fig. 3.1 bumps the number shown on the
 *   Fig. 3.3 dashboard too (and vice versa), even though Fig. 3.3's own
 *   event log and graph correctly show nothing for it.
 *
 *   This is a different bug from the buzzer/recording/page-heartbeat
 *   one fixed by apply-fig-mutual-exclusion-fix.mjs -- that one gates
 *   whether the buzzer sounds and a clip records; this one is purely a
 *   frontend display bug in the two "events logged" numbers.
 *
 * FIX
 *   camera.js and buzzer.js now read `data.total_events_for_page`
 *   (falling back to `data.total_events` only if the server is an older
 *   version that doesn't send it yet, so this still degrades gracefully
 *   against a stale server).
 *
 * Usage:
 *   node apply-fig-events-counter-fix.mjs             # run from the repo root
 *   node apply-fig-events-counter-fix.mjs --dry-run   # preview only, writes nothing
 *   node apply-fig-events-counter-fix.mjs --root /path/to/ACT3embedd
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

const CAMERA_JS_PATH = path.join(projectRoot, "static", "camera.js");
const BUZZER_JS_PATH = path.join(projectRoot, "static", "buzzer.js");

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

  console.log(`Perimeter -- Fig. 3.1/3.3 events-logged counter fix`);
  console.log(`root: ${projectRoot}`);
  if (dryRun) console.log(`(dry run -- no files will be written)`);

  const cameraResult = await patchFile(
    CAMERA_JS_PATH,
    [
      {
        label: "statTotal reads the page-scoped counter",
        find:
`    // stats
    el.statTotal.textContent = data.total_events ?? 0;
    el.statUptime.textContent = fmtUptime(data.started_at);`,
        replace:
`    // stats -- total_events_for_page is Fig. 3.1's own snapshot count
    // (server-computed in /api/status); data.total_events is the old
    // GLOBAL counter shared with Fig. 3.3 and is only kept as a
    // fallback for an older server that doesn't send the page-scoped
    // field yet.
    el.statTotal.textContent = data.total_events_for_page ?? data.total_events ?? 0;
    el.statUptime.textContent = fmtUptime(data.started_at);`,
      },
      {
        label: "logCount reads the page-scoped counter",
        find:
`    // log
    renderLog(data.events);
    el.logCount.textContent = data.total_events ?? 0;`,
        replace:
`    // log
    renderLog(data.events);
    el.logCount.textContent = data.total_events_for_page ?? data.total_events ?? 0;`,
      },
    ],
    backupDir
  );

  const buzzerResult = await patchFile(
    BUZZER_JS_PATH,
    [
      {
        label: "statTotal reads the page-scoped counter",
        find:
`    // stats
    el.statTotal.textContent = data.total_events ?? 0;
    el.statUptime.textContent = fmtUptime(data.started_at);`,
        replace:
`    // stats -- total_events_for_page is Fig. 3.3's own recording count
    // (server-computed in /api/status); data.total_events is the old
    // GLOBAL counter shared with Fig. 3.1 and is only kept as a
    // fallback for an older server that doesn't send the page-scoped
    // field yet.
    el.statTotal.textContent = data.total_events_for_page ?? data.total_events ?? 0;
    el.statUptime.textContent = fmtUptime(data.started_at);`,
      },
      {
        label: "logCount reads the page-scoped counter",
        find:
`    // log
    renderLog(data.events);
    el.logCount.textContent = data.total_events ?? 0;`,
        replace:
`    // log
    renderLog(data.events);
    el.logCount.textContent = data.total_events_for_page ?? data.total_events ?? 0;`,
      },
    ],
    backupDir
  );

  const totalApplied = cameraResult.applied + buzzerResult.applied;
  const totalMissing = cameraResult.missing + buzzerResult.missing;

  console.log(`\n${"-".repeat(60)}`);
  if (totalApplied > 0) {
    console.log(`Applied ${totalApplied} change(s).${dryRun ? " (dry run -- nothing written)" : ""}`);
  }
  if (totalMissing > 0) {
    console.log(
      `${totalMissing} patch location(s) could not be found -- camera.js/buzzer.js may have changed since this script was written. Check those spots by hand.`
    );
  }
  if (totalApplied === 0 && totalMissing === 0) {
    console.log(`Already up to date -- nothing to do.`);
  }
  if (!dryRun && totalApplied > 0) {
    console.log(`\nHard-refresh (or clear cache) on both dashboards for the updated JS to load.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
