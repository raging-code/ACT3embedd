#!/usr/bin/env node
/**
 * apply-fig-tag-fix.mjs
 * ----------------------------------------------------------------------
 * Fixes the "Fig. 3.1-3.2" label on the Camera Watch dashboard.
 *
 * Camera Watch (/camera) is a single view — live feed + motion-triggered
 * snapshot images, shown only when the PIR indicator trips — so it maps
 * to ONE figure, not two. Buzzer + Graph (/buzzer) is likewise a single
 * view (one sensor-readings graph + motion-triggered video clips) and
 * already correctly reads "Fig. 3.3". This patch brings Camera Watch in
 * line: "Fig. 3.1-3.2" -> "Fig. 3.1" everywhere it appears.
 *
 * Changes:
 *   templates/menu.html   - card tag "Fig. 3.1 – 3.2" -> "Fig. 3.1"
 *   templates/camera.html - header sub-label "Fig. 3.1-3.2 · camera watch"
 *                            -> "Fig. 3.1 · camera watch"
 *   app.py                 - docstring comment "Fig. 3.1-3.2 — PIR + camera
 *                            motion watch (the original dashboard)."
 *                            -> "Fig. 3.1 — PIR + camera motion watch
 *                            (the original dashboard)."
 *
 * No HTML structure, JS, or CSS is touched -- text-only label fix.
 *
 * Usage:
 *   node apply-fig-tag-fix.mjs             # run from the repo root
 *   node apply-fig-tag-fix.mjs --dry-run   # preview only, writes nothing
 *   node apply-fig-tag-fix.mjs --root /path/to/ACT3embedd
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

const MENU_PATH = path.join(projectRoot, "templates", "menu.html");
const CAMERA_PATH = path.join(projectRoot, "templates", "camera.html");
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

  console.log(`Perimeter -- Fig. 3.1-3.2 label fix`);
  console.log(`root: ${projectRoot}`);
  if (dryRun) console.log(`(dry run -- no files will be written)`);

  const menuResult = await patchFile(
    MENU_PATH,
    [
      {
        label: 'menu card tag: "Fig. 3.1 – 3.2" -> "Fig. 3.1"',
        find: '<span class="menu-card-tag">Fig. 3.1 – 3.2</span>',
        replace: '<span class="menu-card-tag">Fig. 3.1</span>',
      },
      {
        // fallback in case the dash was authored as a plain hyphen instead
        // of an en-dash in some copy of the file
        label: 'menu card tag (hyphen variant): "Fig. 3.1-3.2" -> "Fig. 3.1"',
        find: '<span class="menu-card-tag">Fig. 3.1-3.2</span>',
        replace: '<span class="menu-card-tag">Fig. 3.1</span>',
      },
    ],
    backupDir
  );

  const cameraResult = await patchFile(
    CAMERA_PATH,
    [
      {
        label: 'header sub-label: "Fig. 3.1-3.2 · camera watch" -> "Fig. 3.1 · camera watch"',
        find: '<span class="bar-sub">Fig. 3.1-3.2 · camera watch</span>',
        replace: '<span class="bar-sub">Fig. 3.1 · camera watch</span>',
      },
    ],
    backupDir
  );

  const appResult = await patchFile(
    APP_PATH,
    [
      {
        label: 'route docstring: "Fig. 3.1-3.2 — PIR + camera motion watch..." -> "Fig. 3.1 — PIR + camera motion watch..."',
        find: '"""Fig. 3.1-3.2 — PIR + camera motion watch (the original dashboard)."""',
        replace: '"""Fig. 3.1 — PIR + camera motion watch (the original dashboard)."""',
      },
    ],
    backupDir
  );

  const totals = [menuResult, cameraResult, appResult].reduce(
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
}

main().catch((err) => {
  console.error("Patch failed:", err);
  process.exit(1);
});
