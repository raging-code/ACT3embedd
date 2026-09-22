#!/usr/bin/env node
/**
 * apply-header-modules-move.mjs
 * ----------------------------------------------------------------------
 * Camera dashboard (templates/camera.html) only:
 *
 *   1. Removes the header text:
 *        <span class="bar-name">PERIMETER</span>
 *        <span class="bar-sub">Fig. 3.1 · camera watch</span>
 *      (the back-link arrow and the pulse dot stay -- only the two text
 *      labels are removed).
 *
 *   2. Moves the "PIR sensor" / "Webcam" status modules out of the
 *      sidebar stat block and into the header, immediately to the left
 *      of the ARMED/DISARMED toggle button -- so the header reads:
 *      [back] [dot]  ...  [PIR sensor] [Webcam] [clock] [ARM/DISARM]
 *      The moved modules keep their existing element ids
 *      (modSensor/modSensorState, modCamera/modCameraState) so
 *      static/camera.js keeps working with zero JS changes.
 *
 *   3. Adds compact CSS for the new header-mounted modules
 *      (.bar-modules / .bar-module) to static/style.css, and a small
 *      mobile tweak so the header doesn't overflow on narrow screens.
 *
 * Only templates/camera.html and static/style.css are touched.
 * templates/buzzer.html is a different dashboard (Fig. 3.3, no PIR/
 * webcam modules) and is intentionally left alone.
 *
 * Usage:
 *   node apply-header-modules-move.mjs             # run from repo root
 *   node apply-header-modules-move.mjs --dry-run   # preview only
 *   node apply-header-modules-move.mjs --root /path/to/ACT3embedd
 *
 * Safe to re-run: if a target is already at its final value, it's
 * reported as already applied and left alone.
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

const CAMERA_HTML_PATH = path.join(projectRoot, "templates", "camera.html");
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
 * wins).
 */
function applyReplacements(content, replacements) {
  let applied = 0;
  let alreadyPresent = 0;
  let missing = 0;

  for (const { finds, replace, label } of replacements) {
    // A non-empty `replace` string already present means this target is
    // done. An empty `replace` (pure deletion) can't use that check --
    // "".includes("") is always true -- so for deletions, "done" means
    // none of the find candidates are present anymore.
    const alreadyDone =
      replace !== ""
        ? content.includes(replace)
        : !finds.some((find) => content.includes(find));
    if (alreadyDone) {
      console.log(`  [already applied] ${label}`);
      alreadyPresent++;
      continue;
    }
    let matched = false;
    for (const find of finds) {
      if (content.includes(find)) {
        content = content.replace(find, replace);
        console.log(`  [applied] ${label}`);
        applied++;
        matched = true;
        break;
      }
    }
    if (!matched) {
      console.log(`  [MISSING] ${label} -- no candidate string found`);
      missing++;
    }
  }

  return { content, applied, alreadyPresent, missing };
}

async function patchCameraHtml(backupDir) {
  console.log("\nPatching templates/camera.html ...");
  if (!(await exists(CAMERA_HTML_PATH))) {
    console.log("  (skip -- templates/camera.html not found)");
    return { applied: 0, missing: 0 };
  }

  let content = await fs.readFile(CAMERA_HTML_PATH, "utf8");

  const result = applyReplacements(content, [
    {
      label: "header: drop PERIMETER / Fig. 3.1 text, add PIR+Webcam modules beside arm toggle",
      finds: [
        // Original state (bar-name/bar-sub present, sidebar module-row present)
`      <span class="dot" id="pulse-dot"></span>
      <span class="bar-name">PERIMETER</span>
      <span class="bar-sub">Fig. 3.1 · camera watch</span>
    </div>
    <div class="bar-right">
      <span class="bar-clock" id="clock">--:--:--</span>
      <button class="arm-toggle" id="armToggle" data-armed="true">
        <span class="arm-toggle-label">ARMED</span>
      </button>
    </div>`,
      ],
      replace:
`      <span class="dot" id="pulse-dot"></span>
    </div>
    <div class="bar-right">
      <div class="bar-modules">
        <div class="bar-module glass" id="modSensor">
          <span class="bar-module-name">PIR sensor</span>
          <span class="bar-module-state" id="modSensorState">checking</span>
        </div>
        <div class="bar-module glass" id="modCamera">
          <span class="bar-module-name">Webcam</span>
          <span class="bar-module-state" id="modCameraState">checking</span>
        </div>
      </div>
      <span class="bar-clock" id="clock">--:--:--</span>
      <button class="arm-toggle" id="armToggle" data-armed="true">
        <span class="arm-toggle-label">ARMED</span>
      </button>
    </div>`,
    },
    {
      label: "sidebar: remove the now-relocated PIR sensor / Webcam module-row",
      finds: [
`      <div class="module-row">
        <div class="module glass" id="modSensor">
          <span class="module-name">PIR sensor</span>
          <span class="module-state" id="modSensorState">checking</span>
        </div>
        <div class="module glass" id="modCamera">
          <span class="module-name">Webcam</span>
          <span class="module-state" id="modCameraState">checking</span>
        </div>
      </div>

`,
      ],
      replace: "",
    },
  ]);

  content = result.content;

  if (result.applied > 0) {
    await backupFile(CAMERA_HTML_PATH, backupDir);
    await writeFile(CAMERA_HTML_PATH, content);
  }

  return result;
}

async function patchStyleCss(backupDir) {
  console.log("\nPatching static/style.css ...");
  if (!(await exists(STYLE_CSS_PATH))) {
    console.log("  (skip -- static/style.css not found)");
    return { applied: 0, missing: 0 };
  }

  let content = await fs.readFile(STYLE_CSS_PATH, "utf8");

  const result = applyReplacements(content, [
    {
      label: "add .bar-modules / .bar-module header styles (after .arm-toggle rules)",
      finds: [
`.arm-toggle[data-armed="false"] {
  background: linear-gradient(155deg, rgba(224,133,133,0.85), rgba(224,133,133,0.45));
  box-shadow:
    0 1px 2px rgba(0,0,0,0.3),
    0 6px 16px -4px rgba(224,133,133,0.4),
    inset 0 1px 1px rgba(255,255,255,0.3);
}`,
      ],
      replace:
`.arm-toggle[data-armed="false"] {
  background: linear-gradient(155deg, rgba(224,133,133,0.85), rgba(224,133,133,0.45));
  box-shadow:
    0 1px 2px rgba(0,0,0,0.3),
    0 6px 16px -4px rgba(224,133,133,0.4),
    inset 0 1px 1px rgba(255,255,255,0.3);
}

/* ---------- header-mounted status modules (beside arm/disarm) ---------- */

.bar-modules {
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
  z-index: 1;
}

.bar-module {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 6px 10px;
  border-radius: var(--radius-s);
  overflow: hidden;
}
.bar-module > * { position: relative; z-index: 1; }

.bar-module-name {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
  white-space: nowrap;
}

.bar-module-state {
  font-family: var(--mono);
  font-size: 11.5px;
  font-weight: 700;
  color: var(--text-faint);
  white-space: nowrap;
}
.bar-module-state.ok { color: var(--ok); }
.bar-module-state.fail { color: var(--off); }

@media (max-width: 860px) {
  .bar-module-name { display: none; }
  .bar-module { padding: 6px 8px; }
}
@media (max-width: 560px) {
  .bar-modules { gap: 6px; }
  .bar-clock { display: none; }
}`,
    },
  ]);

  content = result.content;

  if (result.applied > 0) {
    await backupFile(STYLE_CSS_PATH, backupDir);
    await writeFile(STYLE_CSS_PATH, content);
  }

  return result;
}

async function main() {
  console.log(`Project root: ${projectRoot}`);
  if (dryRun) console.log("Mode: DRY RUN (no files will be written)\n");

  const backupDir = path.join(projectRoot, "backup", timestamp());

  const htmlResult = await patchCameraHtml(backupDir);
  const cssResult = await patchStyleCss(backupDir);

  const totalApplied = htmlResult.applied + cssResult.applied;
  const totalMissing = htmlResult.missing + cssResult.missing;

  console.log(`\n${"-".repeat(60)}`);
  if (totalApplied > 0) {
    console.log(`Applied ${totalApplied} change(s).${dryRun ? " (dry run -- nothing written)" : ""}`);
  }
  if (totalMissing > 0) {
    console.log(
      `${totalMissing} patch location(s) could not be found -- the files have diverged in a way this script doesn't account for. Check those spots by hand.`
    );
  }
  if (totalApplied === 0 && totalMissing === 0) {
    console.log(`Already up to date -- nothing to do.`);
  }
  if (!dryRun && totalApplied > 0) {
    console.log(`\nHard-refresh (or clear cache) to see the updated header.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
