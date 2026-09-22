#!/usr/bin/env node
/**
 * apply-fig-mutual-exclusion-fix.mjs
 * ----------------------------------------------------------------------
 * Fixes motion detected on Fig. 3.1 (camera.html) still firing the
 * buzzer + starting a recording + logging an event on the Fig. 3.3
 * (buzzer.html) side, even though only the Fig. 3.1 tab was open.
 *
 * ROOT CAUSE
 *   `is_page_active(page)` decides whether a dashboard is "being
 *   watched" by checking if `/api/status?page=...` was polled for THAT
 *   page within the last PAGE_ACTIVE_TIMEOUT (10s). But `page_last_seen`
 *   is a plain heartbeat per page -- it has no idea the *other* page
 *   just became active. So if buzzer.html was open recently (even
 *   seconds ago, in this tab, another tab, or another device) and you
 *   then switch to camera.html, the server still thinks Fig. 3.3 is
 *   "active" for up to another 10 seconds -- long enough for a motion
 *   trigger on Fig. 3.1 to also sound the buzzer, start a recording,
 *   and write into Fig. 3.3's own log.
 *
 * FIX
 *   Make the two pages mutually exclusive instead of independently
 *   timed out. The instant `/api/status?page=camera` is polled, buzzer
 *   is immediately marked not-active (and vice versa) -- there's no
 *   overlap window anymore. The existing PAGE_ACTIVE_TIMEOUT is kept as
 *   a secondary safety net for "nobody has polled either page in a
 *   while" (e.g. both tabs closed), but it no longer has to do the
 *   job of distinguishing which one is currently open.
 *
 * Usage:
 *   node apply-fig-mutual-exclusion-fix.mjs             # run from the repo root
 *   node apply-fig-mutual-exclusion-fix.mjs --dry-run   # preview only, writes nothing
 *   node apply-fig-mutual-exclusion-fix.mjs --root /path/to/ACT3embedd
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

  console.log(`Perimeter -- Fig. 3.1/3.3 mutual-exclusion fix`);
  console.log(`root: ${projectRoot}`);
  if (dryRun) console.log(`(dry run -- no files will be written)`);

  const appResult = await patchFile(
    APP_PATH,
    [
      {
        label: "make note_page_seen mark the other page inactive (mutual exclusion)",
        find:
`def note_page_seen(page):
    if page not in page_last_seen:
        return
    with page_activity_lock:
        page_last_seen[page] = time.time()`,
        replace:
`def note_page_seen(page):
    """Marks \`page\` as the one currently being watched. The two
    dashboards are mutually exclusive: the instant one is polled, the
    other is immediately marked not-active (set to 0.0), instead of
    just letting its own heartbeat quietly expire after
    PAGE_ACTIVE_TIMEOUT. That closes the window where switching from
    Fig. 3.3 to Fig. 3.1 could still leave the server thinking Fig. 3.3
    was "active" for up to another PAGE_ACTIVE_TIMEOUT seconds, which
    let a Fig. 3.1 motion trigger also sound the buzzer / start a
    recording / log an event on the Fig. 3.3 side."""
    if page not in page_last_seen:
        return
    with page_activity_lock:
        page_last_seen[page] = time.time()
        for other in page_last_seen:
            if other != page:
                page_last_seen[other] = 0.0`,
      },
    ],
    backupDir
  );

  const totalApplied = appResult.applied;
  const totalMissing = appResult.missing;

  console.log(`\n${"-".repeat(60)}`);
  if (totalApplied > 0) {
    console.log(`Applied ${totalApplied} change(s).${dryRun ? " (dry run -- nothing written)" : ""}`);
  }
  if (totalMissing > 0) {
    console.log(
      `${totalMissing} patch location(s) could not be found -- app.py may have changed since this script was written. Check those spots by hand.`
    );
  }
  if (totalApplied === 0 && totalMissing === 0) {
    console.log(`Already up to date -- nothing to do.`);
  }
  if (!dryRun && totalApplied > 0) {
    console.log(`\nRestart the Flask app for the change to take effect.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
