#!/usr/bin/env node
/**
 * apply-fig-green-bg-v4-darker.mjs
 * ----------------------------------------------------------------------
 * Darkens the green background introduced by the earlier green-bg
 * patches. Every stop of the body gradient and every ambient .blob
 * color is scaled down to ~58% of its previous brightness, keeping the
 * same hue and the same gradient shape/shadow structure -- just darker
 * green throughout instead of the previous mid-tone green. The glass
 * (backdrop-filter) values are left exactly as they are; only color is
 * touched. Only static/style.css is touched -- markup and JS untouched.
 *
 * Like the v3 script, each target tries multiple candidate "find"
 * strings so this works no matter which prior state the checkout is in:
 * the untouched original (charcoal), the first green-bg patch's output,
 * or the v3 (mid-tone green) patch's output -- whichever is present
 * gets rewritten to the same final darker-green value.
 *
 * Final values this script converges on:
 *
 *   body background gradient stops:
 *     #1B3E2E 0%   #153325 14%  #10291D 28%  #0C2217 42%  #091B12 55%
 *     #0D251A 68%  #133021 80%  #18392A 92%  #1B3E2E 100%
 *   .blob-a #254734   .blob-b #1B3627   .blob-c #2D523C
 *   .blob-d #10251A   .blob-e #1F3E2C
 *
 * Usage:
 *   node apply-fig-green-bg-v4-darker.mjs             # run from the repo root
 *   node apply-fig-green-bg-v4-darker.mjs --dry-run   # preview only, writes nothing
 *   node apply-fig-green-bg-v4-darker.mjs --root /path/to/ACT3embed
 *
 * Safe to re-run: if a target is already at its final v4 value, that
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
 * state.
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

  console.log(`Perimeter -- darker green background (v4)`);
  console.log(`root: ${projectRoot}`);
  if (dryRun) console.log(`(dry run -- no files will be written)`);

  const styleResult = await patchFile(
    STYLE_CSS_PATH,
    [
      {
        label: "body background -> darker green diagonal gradient",
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
          // state left by apply-fig-glass-lessen-green-bg.mjs (v1)
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
          // state left by apply-fig-green-bg-v2/v3-lighter-glass.mjs (mid-tone green)
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
        ],
        replace:
`body {
  min-height: 100vh;
  position: relative;
  overflow-x: hidden;
  background:
    linear-gradient(160deg,
      #1B3E2E 0%,
      #153325 14%,
      #10291D 28%,
      #0C2217 42%,
      #091B12 55%,
      #0D251A 68%,
      #133021 80%,
      #18392A 92%,
      #1B3E2E 100%);
  background-attachment: fixed;
}`,
      },
      {
        label: "ambient blobs darkened to match",
        finds: [
          // original gray/graphite
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
          // mid-tone green from v2/v3
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
        ],
        replace:
`.blob-a { width: 560px; height: 560px; top: -180px; left: -140px;
  background: radial-gradient(circle, #254734 0%, transparent 72%); opacity: 0.8; }
.blob-b { width: 620px; height: 620px; bottom: -220px; right: -160px;
  background: radial-gradient(circle, #1B3627 0%, transparent 70%); opacity: 0.85; }
.blob-c { width: 460px; height: 460px; top: 30%; left: 55%;
  background: radial-gradient(circle, #2D523C 0%, transparent 72%); opacity: 0.55; }
.blob-d { width: 380px; height: 380px; top: 5%; right: 8%;
  background: radial-gradient(circle, #10251A 0%, transparent 72%); opacity: 0.6; }
.blob-e { width: 420px; height: 420px; bottom: 10%; left: 8%;
  background: radial-gradient(circle, #1F3E2C 0%, transparent 72%); opacity: 0.5; }`,
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
      `${totalMissing} patch location(s) could not be found -- static/style.css has diverged in a way none of the known prior states account for. Check those spots by hand.`
    );
  }
  if (totalApplied === 0 && totalMissing === 0) {
    console.log(`Already up to date -- nothing to do.`);
  }
  if (!dryRun && totalApplied > 0) {
    console.log(`\nHard-refresh (or clear cache) to see the darker green background.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
