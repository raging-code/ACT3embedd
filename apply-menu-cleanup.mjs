#!/usr/bin/env node
/**
 * apply-menu-cleanup.mjs
 * ----------------------------------------------------------------------
 * Cleans up the Perimeter landing menu page (/) and applies the refined
 * icon style (bold pure-white outline, no container, no shine) to its
 * two activity cards.
 *
 * Changes to templates/menu.html:
 *   - Removes the "PERIMETER / motion watch" header bar entirely
 *   - Removes the subtitle "Both dashboards run on the same PIR sensor
 *     and camera. Pick which one to open."
 *   - Removes the footer line "Raspberry Pi - PIR + USB webcam + active
 *     buzzer"
 *   - Swaps both card icons (camera, buzzer) to the refined style: bold
 *     pure-white 2.6px stroke, no background badge/container, no shine
 *
 * Changes to static/style.css:
 *   - Centers the whole menu page (vertically + horizontally)
 *   - Shrinks the activity cards (smaller padding, title, description)
 *     and centers all content inside each card
 *   - Adds the .icon-c rule used by the new icon markup
 *   - Removes the now-unused .menu-subtitle and .menu-card-icon rules
 *
 * templates/camera.html, templates/buzzer.html, static/camera.js,
 * static/buzzer.js, and app.py are NOT touched by this patch.
 *
 * Usage:
 *   node apply-menu-cleanup.mjs             # run from the repo root
 *   node apply-menu-cleanup.mjs --dry-run   # preview only, writes nothing
 *   node apply-menu-cleanup.mjs --root /path/to/ACT3embedd
 *
 * Safe to re-run: if the patch has already been applied, running again
 * is a no-op for the parts already in place.
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
const STYLE_PATH = path.join(projectRoot, "static", "style.css");

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
  await fs.mkdir(backupDir, { recursive: true });
  const dest = path.join(backupDir, path.basename(filePath));
  await fs.copyFile(filePath, dest);
  console.log(`  backed up -> ${path.relative(projectRoot, dest)}`);
}

async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
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

// ---------------------------------------------------------------------
// templates/menu.html -- full replacement (verified, tested content)
// ---------------------------------------------------------------------
const MENU_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>Perimeter — Choose Activity</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link href=\"https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Geist+Mono:wght@400;500;600;700&display=swap\" rel=\"stylesheet\">\n<link rel=\"stylesheet\" href=\"/static/style.css\">\n</head>\n<body>\n\n<div class=\"blob blob-a\"></div>\n<div class=\"blob blob-b\"></div>\n<div class=\"blob blob-c\"></div>\n<div class=\"blob blob-d\"></div>\n<div class=\"blob blob-e\"></div>\n\n<div class=\"console menu-console\">\n\n  <div class=\"menu-intro\">\n    <h1 class=\"menu-title\">Choose an activity</h1>\n  </div>\n\n  <main class=\"menu-grid\">\n\n    <a class=\"menu-card glass\" href=\"/camera\">\n      <div class=\"icon-c\">\n        <svg width=\"40\" height=\"40\" viewBox=\"0 0 27 27\" fill=\"none\">\n          <rect x=\"2.5\" y=\"7.5\" width=\"17\" height=\"13\" rx=\"3\" stroke=\"white\" stroke-width=\"2.6\"/>\n          <path d=\"M19.5 12 25 8.3v11.4l-5.5-3.3\" stroke=\"white\" stroke-width=\"2.6\" stroke-linejoin=\"round\"/>\n          <circle cx=\"11\" cy=\"14\" r=\"2.9\" stroke=\"white\" stroke-width=\"2.6\"/>\n        </svg>\n      </div>\n      <span class=\"menu-card-tag\">Fig. 3.1 – 3.2</span>\n      <span class=\"menu-card-title\">Camera Watch</span>\n      <p class=\"menu-card-desc\">Live camera feed, motion-triggered snapshots, event log, and arm/disarm control.</p>\n      <span class=\"menu-card-cta\">Open dashboard →</span>\n    </a>\n\n    <a class=\"menu-card glass\" href=\"/buzzer\">\n      <div class=\"icon-c\">\n        <svg width=\"40\" height=\"40\" viewBox=\"0 0 27 27\" fill=\"none\">\n          <circle cx=\"13.5\" cy=\"13.5\" r=\"10.8\" stroke=\"white\" stroke-width=\"2.6\"/>\n          <path d=\"M7.8 13.5a5.7 5.7 0 0 1 11.4 0\" stroke=\"white\" stroke-width=\"2.6\" stroke-linecap=\"round\"/>\n          <circle cx=\"13.5\" cy=\"13.5\" r=\"2.1\" fill=\"white\"/>\n        </svg>\n      </div>\n      <span class=\"menu-card-tag\">Fig. 3.3</span>\n      <span class=\"menu-card-title\">Buzzer + Graph</span>\n      <p class=\"menu-card-desc\">Active buzzer alert, live sensor-reading graph, and 5-second motion recordings.</p>\n      <span class=\"menu-card-cta\">Open dashboard →</span>\n    </a>\n\n  </main>\n\n</div>\n\n</body>\n</html>\n";

// ---------------------------------------------------------------------
// static/style.css -- surgical replacement of the menu-page rules
// ---------------------------------------------------------------------
const CSS_REPLACEMENTS = [
  {
    label: ".menu-console / .menu-intro / .menu-title / .menu-subtitle / .menu-grid / .menu-card / .menu-card-icon / .menu-card-tag / .menu-card-title / .menu-card-desc / .menu-card-cta -> centered, smaller, new icon style",
    find: `.menu-console {
  max-width: 900px;
  justify-content: center;
}

.menu-intro {
  text-align: center;
  margin: 32px 0 28px;
  position: relative;
  z-index: 1;
}

.menu-title {
  font-family: var(--grot);
  font-size: 30px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--text);
  margin: 0 0 8px;
}

.menu-subtitle {
  font-size: 14px;
  color: var(--text-dim);
  margin: 0;
  max-width: 480px;
  margin-inline: auto;
}

.menu-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  flex: 1;
}

@media (max-width: 720px) {
  .menu-grid { grid-template-columns: 1fr; }
}

.menu-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 28px 26px;
  text-decoration: none;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.menu-card > * { position: relative; z-index: 1; }
.menu-card:hover {
  transform: translateY(-3px);
}

.menu-card-icon {
  width: 52px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
  color: var(--signal);
  background: var(--signal-dim);
  border: 1px solid rgba(95,176,240,0.3);
  margin-bottom: 4px;
}

.menu-card-tag {
  font-family: var(--mono);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--signal);
}

.menu-card-title {
  font-family: var(--grot);
  font-size: 20px;
  font-weight: 800;
  letter-spacing: -0.01em;
  color: var(--text);
}

.menu-card-desc {
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--text-dim);
  margin: 0;
}

.menu-card-cta {
  margin-top: auto;
  padding-top: 10px;
  font-size: 13px;
  font-weight: 700;
  color: var(--signal);
}`,
    replace: `.menu-console {
  max-width: 720px;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  padding-top: 0;
  padding-bottom: 0;
}

.menu-intro {
  text-align: center;
  margin: 0 0 28px;
  position: relative;
  z-index: 1;
}

.menu-title {
  font-family: var(--grot);
  font-size: 26px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--text);
  margin: 0;
}

.menu-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  width: 100%;
}

@media (max-width: 560px) {
  .menu-grid { grid-template-columns: 1fr; }
}

.menu-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 8px;
  padding: 22px 20px;
  text-decoration: none;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.menu-card > * { position: relative; z-index: 1; }
.menu-card:hover {
  transform: translateY(-3px);
}

.icon-c {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 2px;
}
.icon-c svg {
  filter: drop-shadow(0 2px 4px rgba(0,0,0,0.4));
}

.menu-card-tag {
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--signal);
}

.menu-card-title {
  font-family: var(--grot);
  font-size: 16px;
  font-weight: 800;
  letter-spacing: -0.01em;
  color: var(--text);
}

.menu-card-desc {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-dim);
  margin: 0;
}

.menu-card-cta {
  margin-top: 4px;
  padding-top: 8px;
  font-size: 12px;
  font-weight: 700;
  color: var(--signal);
}`,
  },
];

async function main() {
  console.log(`Perimeter -- menu page cleanup + icon patch`);
  console.log(`Project root: ${projectRoot}${dryRun ? "  (dry run -- no files will be written)" : ""}\n`);

  if (!(await exists(MENU_PATH)) || !(await exists(STYLE_PATH))) {
    console.error(
      "Could not find templates/menu.html and static/style.css under the given root.\n" +
        "Run this from the repo root (ACT3embedd/), or pass --root /path/to/ACT3embedd"
    );
    process.exitCode = 1;
    return;
  }

  if (!dryRun) {
    const backupDir = path.join(projectRoot, "backup", timestamp());
    console.log(`Backing up existing files to backup/${timestamp()}/ ...`);
    await backupFile(MENU_PATH, backupDir);
    await backupFile(STYLE_PATH, backupDir);
  } else {
    console.log(`[dry-run] would back up to backup/${timestamp()}/ (skipped)`);
  }

  console.log("\nWriting templates/menu.html (full replacement)...");
  await writeFile(MENU_PATH, MENU_HTML);

  console.log("\nPatching static/style.css ...");
  let css = await fs.readFile(STYLE_PATH, "utf8");
  const cssResult = applyReplacements(css, CSS_REPLACEMENTS);
  await writeFile(STYLE_PATH, cssResult.content);

  console.log(
    `\nSummary: ${cssResult.applied} CSS rule(s) applied, ${cssResult.alreadyPresent} already in place, ${cssResult.missing} not found.`
  );

  if (cssResult.missing > 0) {
    console.log(
      "\nThe CSS rule could not be located -- this usually means static/style.css was\n" +
        "edited since the last design patch. Check the ! line above; menu.html was still\n" +
        "replaced, so the page will work but the sizing/centering may need a manual check."
    );
  }

  console.log(
    dryRun
      ? "\nDry run complete -- no files were changed."
      : "\nDone. templates/camera.html, templates/buzzer.html, static/camera.js,\n" +
        "static/buzzer.js, and app.py were not touched.\nRun the app and open / to see the cleaned-up menu."
  );
}

main().catch((err) => {
  console.error("Patch failed:", err);
  process.exitCode = 1;
});
