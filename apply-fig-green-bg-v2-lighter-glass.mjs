#!/usr/bin/env node
/**
 * apply-fig-green-bg-v2-lighter-glass.mjs
 * ----------------------------------------------------------------------
 * Revision of apply-fig-glass-lessen-green-bg.mjs based on feedback:
 * the background should read as dark green throughout (not charcoal/gray
 * with a green gradient dropped on top of it), and the glassmorphism
 * should be cut down further for a lighter, more optimized page. Only
 * static/style.css is touched -- markup and JS are untouched.
 *
 * 1. BACKGROUND -- DARK GREEN, TOP TO BOTTOM
 *    a) body's diagonal gradient: every stop is now a shade of green
 *       (deep forest -> muted emerald -> deep forest), same 160deg angle,
 *       same 9 stops, same `background-attachment: fixed`.
 *    b) the ambient .blob radial gradients that sit behind the glass
 *       panels were still gray/graphite from the old palette -- since
 *       they visually blend with the body gradient to form the page
 *       backdrop, they're re-tinted to matching dark-green shades too
 *       (same sizes/positions/opacity, only the hex colors change), so
 *       nothing gray shows through the frosted panels anymore.
 *
 * 2. GLASSMORPHISM -- CUT FURTHER FOR PERFORMANCE
 *    backdrop-filter blur/saturate is the most expensive property on
 *    the page (recomputed every repaint, and .feed-frame pays this cost
 *    on top of a live MJPEG stream). This lowers every remaining
 *    backdrop-filter rule further than the previous pass:
 *
 *      .glass            blur(14px) saturate(1.8) -> blur(5px) saturate(1.12)
 *      .arm-toggle        blur(12px) saturate(1.6) -> blur(5px) saturate(1.12)
 *      .feed-tag          blur(8px)                -> blur(3px)
 *      .gallery-all-pop   blur(22px) saturate(1.2)  -> blur(8px) saturate(1.08)
 *      .mg-pop            blur(22px) saturate(1.2)  -> blur(8px) saturate(1.08)
 *
 *    Fill colors, opacity, borders, and shadows are left exactly as they
 *    are -- panels still read as glass, they're just far cheaper to draw.
 *
 * Usage:
 *   node apply-fig-green-bg-v2-lighter-glass.mjs             # run from the repo root
 *   node apply-fig-green-bg-v2-lighter-glass.mjs --dry-run   # preview only, writes nothing
 *   node apply-fig-green-bg-v2-lighter-glass.mjs --root /path/to/ACT3embedd
 *
 * Safe to re-run: if the patch has already been applied, running again
 * is a no-op. Also safe to run on a repo that already has the earlier
 * apply-fig-glass-lessen-green-bg.mjs applied -- it'll just detect the
 * old values and layer this revision on top.
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

  console.log(`Perimeter -- all-dark-green background + further-optimized glass`);
  console.log(`root: ${projectRoot}`);
  if (dryRun) console.log(`(dry run -- no files will be written)`);

  const styleResult = await patchFile(
    STYLE_CSS_PATH,
    [
      {
        label: "body background -> all dark-green diagonal gradient (same shape/stops/fixed attachment)",
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
      #2F6B4F 0%,
      #245840 14%,
      #1B4732 28%,
      #143A28 42%,
      #0F2E1F 55%,
      #17402D 68%,
      #205339 80%,
      #2A6349 92%,
      #2F6B4F 100%);
  background-attachment: fixed;
}`,
      },
      {
        label: "ambient blobs re-tinted from gray/graphite to matching dark-green shades",
        find:
`.blob-a { width: 560px; height: 560px; top: -180px; left: -140px;
  background: radial-gradient(circle, #4C4F55 0%, transparent 72%); opacity: 0.8; }
.blob-b { width: 620px; height: 620px; bottom: -220px; right: -160px;
  background: radial-gradient(circle, #3A3D42 0%, transparent 70%); opacity: 0.85; }
.blob-c { width: 460px; height: 460px; top: 30%; left: 55%;
  background: radial-gradient(circle, #55585F 0%, transparent 72%); opacity: 0.55; }
.blob-d { width: 380px; height: 380px; top: 5%; right: 8%;
  background: radial-gradient(circle, #2A2C30 0%, transparent 72%); opacity: 0.6; }
.blob-e { width: 420px; height: 420px; bottom: 10%; left: 8%;
  background: radial-gradient(circle, #45474D 0%, transparent 72%); opacity: 0.5; }`,
        replace:
`.blob-a { width: 560px; height: 560px; top: -180px; left: -140px;
  background: radial-gradient(circle, #3F7A5A 0%, transparent 72%); opacity: 0.8; }
.blob-b { width: 620px; height: 620px; bottom: -220px; right: -160px;
  background: radial-gradient(circle, #2E5D44 0%, transparent 70%); opacity: 0.85; }
.blob-c { width: 460px; height: 460px; top: 30%; left: 55%;
  background: radial-gradient(circle, #4E8E68 0%, transparent 72%); opacity: 0.55; }
.blob-d { width: 380px; height: 380px; top: 5%; right: 8%;
  background: radial-gradient(circle, #1C3F2C 0%, transparent 72%); opacity: 0.6; }
.blob-e { width: 420px; height: 420px; bottom: 10%; left: 8%;
  background: radial-gradient(circle, #366B4C 0%, transparent 72%); opacity: 0.5; }`,
      },
      {
        label: ".glass backdrop-filter cut further (blur 14px->5px, saturate 1.8->1.12)",
        find:
`  backdrop-filter: blur(14px) saturate(1.8);
  -webkit-backdrop-filter: blur(14px) saturate(1.8);`,
        replace:
`  backdrop-filter: blur(5px) saturate(1.12);
  -webkit-backdrop-filter: blur(5px) saturate(1.12);`,
      },
      {
        label: ".arm-toggle backdrop-filter cut further (blur 12px->5px, saturate 1.6->1.15)",
        find:
`  background: linear-gradient(155deg, rgba(111,227,190,0.85), rgba(95,176,240,0.55));
  backdrop-filter: blur(12px) saturate(1.6);
  -webkit-backdrop-filter: blur(12px) saturate(1.6);`,
        replace:
`  background: linear-gradient(155deg, rgba(111,227,190,0.85), rgba(95,176,240,0.55));
  backdrop-filter: blur(5px) saturate(1.15);
  -webkit-backdrop-filter: blur(5px) saturate(1.15);`,
      },
      {
        label: ".feed-tag backdrop-filter cut further (blur 8px->3px)",
        find:
`  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);`,
        replace:
`  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);`,
      },
      {
        label: ".gallery-all-pop backdrop-filter cut further (blur 22px->8px, saturate 1.2->1.08)",
        find:
`  background: rgba(8, 9, 11, 0.55);
  backdrop-filter: blur(22px) saturate(1.2);
  -webkit-backdrop-filter: blur(22px) saturate(1.2);
  padding: 3vh 3vw;
}
.gallery-all-pop.open { display: flex; animation: mg-fade 0.16s ease-out; }`,
        replace:
`  background: rgba(8, 9, 11, 0.55);
  backdrop-filter: blur(8px) saturate(1.08);
  -webkit-backdrop-filter: blur(8px) saturate(1.08);
  padding: 3vh 3vw;
}
.gallery-all-pop.open { display: flex; animation: mg-fade 0.16s ease-out; }`,
      },
      {
        label: ".mg-pop backdrop-filter cut further (blur 22px->8px, saturate 1.2->1.08)",
        find:
`  background: rgba(8, 9, 11, 0.55);
  backdrop-filter: blur(22px) saturate(1.2);
  -webkit-backdrop-filter: blur(22px) saturate(1.2);
  padding: 3vh 3vw;
}

.mg-pop.open { display: flex; animation: mg-fade 0.16s ease-out; }`,
        replace:
`  background: rgba(8, 9, 11, 0.55);
  backdrop-filter: blur(8px) saturate(1.08);
  -webkit-backdrop-filter: blur(8px) saturate(1.08);
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
      `${totalMissing} patch location(s) could not be found -- static/style.css may already be in a different state (e.g. the earlier green-bg patch was applied, or the file changed upstream). Check those spots by hand.`
    );
  }
  if (totalApplied === 0 && totalMissing === 0) {
    console.log(`Already up to date -- nothing to do.`);
  }
  if (!dryRun && totalApplied > 0) {
    console.log(`\nHard-refresh (or clear cache) to see the new all-green background and lighter glass blur.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
