#!/usr/bin/env node
/**
 * apply-fig-glass-lessen-green-bg.mjs
 * ----------------------------------------------------------------------
 * Two purely cosmetic/perf changes to static/style.css. Nothing else in
 * the repo (markup, JS, server) is touched.
 *
 * 1. LESSEN THE GLASSMORPHISM (perf + smoothness)
 *    backdrop-filter: blur()/saturate() is the single most expensive
 *    property on the page -- every ".glass" panel, the arm toggle, the
 *    feed tag, and both fullscreen popups recompute their blur on every
 *    repaint, and .feed-frame does this while also streaming a live
 *    MJPEG frame underneath it. style.css already dropped the main
 *    panel recipe once (see the comment at .glass, 32px -> 14px). This
 *    patch dials every backdrop-filter in the file down further and
 *    trims saturate() alongside it, which is what was actually keeping
 *    the frosted look expensive:
 *
 *      .glass            blur(14px) saturate(1.8) -> blur(7px) saturate(1.25)
 *      .arm-toggle        blur(12px) saturate(1.6) -> blur(6px) saturate(1.2)
 *      .feed-tag          blur(8px)                -> blur(4px)
 *      .gallery-all-pop   blur(22px) saturate(1.2)  -> blur(10px) saturate(1.1)
 *      .mg-pop            blur(22px) saturate(1.2)  -> blur(10px) saturate(1.1)
 *
 *    The fill/border/shadow colors, opacities, and every other rule are
 *    left exactly as they are -- only the blur/saturate cost is cut, so
 *    the panels still read as glass, they just cost far less to draw.
 *
 * 2. DARK GREEN GRADIENT BACKGROUND
 *    body's background is swapped from the charcoal/graphite diagonal
 *    gradient to a dark green one of the same shape (same angle, same
 *    stop count/positions, same background-attachment: fixed) -- only
 *    the hues change. The ambient .blob radial gradients behind the
 *    glass are left untouched, as requested.
 *
 * Usage:
 *   node apply-fig-glass-lessen-green-bg.mjs             # run from the repo root
 *   node apply-fig-glass-lessen-green-bg.mjs --dry-run   # preview only, writes nothing
 *   node apply-fig-glass-lessen-green-bg.mjs --root /path/to/ACT3embedd
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

const STYLE_CSS_PATH = path.join(projectRoot, "static", "style.css");

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

  console.log(`Perimeter -- lessen glassmorphism + dark green gradient background`);
  console.log(`root: ${projectRoot}`);
  if (dryRun) console.log(`(dry run -- no files will be written)`);

  const styleResult = await patchFile(
    STYLE_CSS_PATH,
    [
      {
        label: "body background -> dark green diagonal gradient (same shape/stops, fixed attachment kept)",
        find:
`body {
  min-height: 100vh;
  position: relative;
  overflow-x: hidden;
  background:
    linear-gradient(160deg,
      #3A3D42 0%,
      #2C2E33 14%,
      #202226 28%,
      #17181B 42%,
      #0E0F11 55%,
      #191A1D 68%,
      #26282C 80%,
      #313336 92%,
      #3A3D42 100%);
  background-attachment: fixed;
}`,
        replace:
`body {
  min-height: 100vh;
  position: relative;
  overflow-x: hidden;
  background:
    linear-gradient(160deg,
      #234F3C 0%,
      #1B3F30 14%,
      #143226 28%,
      #0E2620 42%,
      #081A16 55%,
      #0D2119 68%,
      #163527 80%,
      #1D4636 92%,
      #234F3C 100%);
  background-attachment: fixed;
}`,
      },
      {
        label: ".glass backdrop-filter lessened (blur 14px->7px, saturate 1.8->1.25) for smoother repaint",
        find:
`  backdrop-filter: blur(14px) saturate(1.8);
  -webkit-backdrop-filter: blur(14px) saturate(1.8);`,
        replace:
`  backdrop-filter: blur(7px) saturate(1.25);
  -webkit-backdrop-filter: blur(7px) saturate(1.25);`,
      },
      {
        label: ".arm-toggle backdrop-filter lessened (blur 12px->6px, saturate 1.6->1.2)",
        find:
`  backdrop-filter: blur(12px) saturate(1.6);
  -webkit-backdrop-filter: blur(12px) saturate(1.6);`,
        replace:
`  backdrop-filter: blur(6px) saturate(1.2);
  -webkit-backdrop-filter: blur(6px) saturate(1.2);`,
      },
      {
        label: ".feed-tag backdrop-filter lessened (blur 8px->4px)",
        find:
`  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);`,
        replace:
`  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);`,
      },
      {
        label: ".gallery-all-pop backdrop-filter lessened (blur 22px->10px, saturate 1.2->1.1)",
        find:
`  background: rgba(8, 9, 11, 0.55);
  backdrop-filter: blur(22px) saturate(1.2);
  -webkit-backdrop-filter: blur(22px) saturate(1.2);
  padding: 3vh 3vw;
}
.gallery-all-pop.open { display: flex; animation: mg-fade 0.16s ease-out; }`,
        replace:
`  background: rgba(8, 9, 11, 0.55);
  backdrop-filter: blur(10px) saturate(1.1);
  -webkit-backdrop-filter: blur(10px) saturate(1.1);
  padding: 3vh 3vw;
}
.gallery-all-pop.open { display: flex; animation: mg-fade 0.16s ease-out; }`,
      },
      {
        label: ".mg-pop backdrop-filter lessened (blur 22px->10px, saturate 1.2->1.1)",
        find:
`  background: rgba(8, 9, 11, 0.55);
  backdrop-filter: blur(22px) saturate(1.2);
  -webkit-backdrop-filter: blur(22px) saturate(1.2);
  padding: 3vh 3vw;
}

.mg-pop.open { display: flex; animation: mg-fade 0.16s ease-out; }`,
        replace:
`  background: rgba(8, 9, 11, 0.55);
  backdrop-filter: blur(10px) saturate(1.1);
  -webkit-backdrop-filter: blur(10px) saturate(1.1);
  padding: 3vh 3vw;
}

.mg-pop.open { display: flex; animation: mg-fade 0.16s ease-out; }`,
      },
    ],
    backupDir
  );

  const totalApplied = styleResult.applied;
  const totalMissing = styleResult.missing;

  console.log(`\n${"-".repeat(60)}`);
  if (totalApplied > 0) {
    console.log(`Applied ${totalApplied} change(s).${dryRun ? " (dry run -- nothing written)" : ""}`);
  }
  if (totalMissing > 0) {
    console.log(
      `${totalMissing} patch location(s) could not be found -- static/style.css may have changed since this script was written. Check those spots by hand.`
    );
  }
  if (totalApplied === 0 && totalMissing === 0) {
    console.log(`Already up to date -- nothing to do.`);
  }
  if (!dryRun && totalApplied > 0) {
    console.log(`\nHard-refresh (or clear cache) to see the new background and lighter glass blur.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
