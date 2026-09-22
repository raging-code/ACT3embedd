#!/usr/bin/env node
/**
 * apply-fig-green-bg-v3-lighter-glass.mjs
 * ----------------------------------------------------------------------
 * Same end result as apply-fig-green-bg-v2-lighter-glass.mjs (all-green
 * background incl. the ambient blobs, and a further-lightened glass
 * effect), but each target now tries MULTIPLE candidate "find" strings:
 * the untouched original static/style.css text, and the text left by
 * the earlier apply-fig-glass-lessen-green-bg.mjs script, in case that
 * one was already run against this checkout. Whichever candidate is
 * actually present gets rewritten to the same final v3 value. Only
 * static/style.css is touched -- markup and JS are untouched.
 *
 * Final values this script converges on, regardless of starting point:
 *
 *   body background      all-green 160deg diagonal (9 stops, same shape)
 *   .blob-a..e           re-tinted from gray/graphite to dark-green
 *   .glass               backdrop-filter: blur(5px) saturate(1.12)
 *   .arm-toggle          backdrop-filter: blur(5px) saturate(1.15)
 *   .feed-tag            backdrop-filter: blur(3px)
 *   .gallery-all-pop     backdrop-filter: blur(8px) saturate(1.08)
 *   .mg-pop              backdrop-filter: blur(8px) saturate(1.08)
 *
 * Fill colors, opacity, borders, and shadows are left exactly as they
 * are -- panels still read as glass, they're just far cheaper to draw.
 *
 * Usage:
 *   node apply-fig-green-bg-v3-lighter-glass.mjs             # run from the repo root
 *   node apply-fig-green-bg-v3-lighter-glass.mjs --dry-run   # preview only, writes nothing
 *   node apply-fig-green-bg-v3-lighter-glass.mjs --root /path/to/ACT3embed
 *
 * Safe to re-run: if a target is already at its final v3 value, that
 * target is reported as already applied and left alone.
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
 * Apply a list of {finds: [candidate, ...], replace, label} replacements
 * to `content`. Each target is checked against `replace` first (already
 * done -> skip), then each candidate in `finds` in order (first match
 * wins) so the same target can be reached from more than one starting
 * state (e.g. the untouched original, or an earlier patch's output).
 */
function applyReplacements(content, replacements) {
  let applied = 0;
  let alreadyPresent = 0;
  let missing = 0;

  for (const { finds, replace, label } of replacements) {
    if (content.includes(replace)) {
      alreadyPresent++;
      console.log(`  = already applied: ${label}`);
      continue;
    }
    const matchIndex = finds.findIndex((f) => content.includes(f));
    if (matchIndex !== -1) {
      content = content.replace(finds[matchIndex], replace);
      applied++;
      const via = matchIndex === 0 ? "" : ` (from earlier-patch state)`;
      console.log(`  \u2713 ${label}${via}`);
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

  console.log(`Perimeter -- all-dark-green background + further-optimized glass (v3)`);
  console.log(`root: ${projectRoot}`);
  if (dryRun) console.log(`(dry run -- no files will be written)`);

  const styleResult = await patchFile(
    STYLE_CSS_PATH,
    [
      {
        label: "body background -> all dark-green diagonal gradient",
        finds: [
          // original charcoal gradient
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
          // state left by apply-fig-glass-lessen-green-bg.mjs
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
        ],
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
        finds: [
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
        ],
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
        label: ".glass backdrop-filter -> blur(5px) saturate(1.12)",
        finds: [
`  backdrop-filter: blur(14px) saturate(1.8);
  -webkit-backdrop-filter: blur(14px) saturate(1.8);`,
`  backdrop-filter: blur(7px) saturate(1.25);
  -webkit-backdrop-filter: blur(7px) saturate(1.25);`,
        ],
        replace:
`  backdrop-filter: blur(5px) saturate(1.12);
  -webkit-backdrop-filter: blur(5px) saturate(1.12);`,
      },
      {
        label: ".arm-toggle backdrop-filter -> blur(5px) saturate(1.15)",
        finds: [
`  backdrop-filter: blur(12px) saturate(1.6);
  -webkit-backdrop-filter: blur(12px) saturate(1.6);`,
`  backdrop-filter: blur(6px) saturate(1.2);
  -webkit-backdrop-filter: blur(6px) saturate(1.2);`,
        ],
        replace:
`  backdrop-filter: blur(5px) saturate(1.15);
  -webkit-backdrop-filter: blur(5px) saturate(1.15);`,
      },
      {
        label: ".feed-tag backdrop-filter -> blur(3px)",
        finds: [
`  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);`,
`  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);`,
        ],
        replace:
`  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);`,
      },
      {
        label: ".gallery-all-pop backdrop-filter -> blur(8px) saturate(1.08)",
        finds: [
`  background: rgba(8, 9, 11, 0.55);
  backdrop-filter: blur(22px) saturate(1.2);
  -webkit-backdrop-filter: blur(22px) saturate(1.2);
  padding: 3vh 3vw;
}
.gallery-all-pop.open { display: flex; animation: mg-fade 0.16s ease-out; }`,
`  background: rgba(8, 9, 11, 0.55);
  backdrop-filter: blur(10px) saturate(1.1);
  -webkit-backdrop-filter: blur(10px) saturate(1.1);
  padding: 3vh 3vw;
}
.gallery-all-pop.open { display: flex; animation: mg-fade 0.16s ease-out; }`,
        ],
        replace:
`  background: rgba(8, 9, 11, 0.55);
  backdrop-filter: blur(8px) saturate(1.08);
  -webkit-backdrop-filter: blur(8px) saturate(1.08);
  padding: 3vh 3vw;
}
.gallery-all-pop.open { display: flex; animation: mg-fade 0.16s ease-out; }`,
      },
      {
        label: ".mg-pop backdrop-filter -> blur(8px) saturate(1.08)",
        finds: [
`  background: rgba(8, 9, 11, 0.55);
  backdrop-filter: blur(22px) saturate(1.2);
  -webkit-backdrop-filter: blur(22px) saturate(1.2);
  padding: 3vh 3vw;
}

.mg-pop.open { display: flex; animation: mg-fade 0.16s ease-out; }`,
`  background: rgba(8, 9, 11, 0.55);
  backdrop-filter: blur(10px) saturate(1.1);
  -webkit-backdrop-filter: blur(10px) saturate(1.1);
  padding: 3vh 3vw;
}

.mg-pop.open { display: flex; animation: mg-fade 0.16s ease-out; }`,
        ],
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
      `${totalMissing} patch location(s) could not be found -- static/style.css has diverged in a way neither the original nor the earlier patch's text accounts for. Check those spots by hand.`
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
