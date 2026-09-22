#!/usr/bin/env node
/**
 * apply-unified-motion-graph-fig-lock.mjs
 * ----------------------------------------------------------------------
 * Fixes the motion-timeline graph (static/graph.js + the .motion-graph
 * section in templates/camera.html and templates/buzzer.html) so each
 * dashboard shows ONLY its own figure instead of a toggle between both:
 *
 *   - Camera Watch  (/camera) is Fig. 3.1 -> always opens the still
 *     snapshot popup. No "Fig 3.3 - video" button.
 *   - Buzzer + Graph (/buzzer) is Fig. 3.3 -> always opens the recorded
 *     clip popup. No "Fig 3.1 - image" button.
 *
 * Root cause: the "Unified 24h motion graph" patch (graph.js) pasted the
 * exact same two-button <span class="mg-seg"> toggle into BOTH
 * templates, so both pages let you flip between image/video regardless
 * of which figure the page is supposed to be.
 *
 * Changes:
 *   static/graph.js
 *     - initMotionGraph(rootId, fixedFig) now takes an optional second
 *       argument. When given ("31" or "33"), the graph locks to that
 *       figure permanently: no toggle listener is attached, and popups
 *       always use the fixed figure.
 *     - When no .mg-seg toggle exists in the DOM (both templates no
 *       longer have one after this patch), the toggle wiring is skipped
 *       instead of throwing on a null element.
 *
 *   templates/camera.html
 *     - Replaces the two-button <span class="mg-seg"> with a single
 *       static "Fig 3.1 - image" badge (no button, nothing to click).
 *
 *   templates/buzzer.html
 *     - Replaces the two-button <span class="mg-seg"> with a single
 *       static "Fig 3.3 - video" badge.
 *
 *   static/camera.js
 *     - initMotionGraph() call -> initMotionGraph("motionGraph", "31")
 *
 *   static/buzzer.js
 *     - initMotionGraph() call -> initMotionGraph("motionGraph", "33")
 *
 * static/style.css is NOT touched -- the existing .mg-seg / .mg-seg
 * button rules are reused as-is to style the new static single badge,
 * so it keeps the same look the "on" toggle button had.
 *
 * Usage:
 *   node apply-unified-motion-graph-fig-lock.mjs             # run from repo root
 *   node apply-unified-motion-graph-fig-lock.mjs --dry-run   # preview only
 *   node apply-unified-motion-graph-fig-lock.mjs --root /path/to/ACT3embedd
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

const GRAPH_JS_PATH = path.join(projectRoot, "static", "graph.js");
const CAMERA_HTML_PATH = path.join(projectRoot, "templates", "camera.html");
const BUZZER_HTML_PATH = path.join(projectRoot, "templates", "buzzer.html");
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
// static/graph.js replacements
// ---------------------------------------------------------------------
const GRAPH_JS_REPLACEMENTS = [
  {
    label: "initMotionGraph signature: accept an optional fixedFig argument",
    find: `  function initMotionGraph(rootId) {
    const root = document.getElementById(rootId || "motionGraph");
    if (!root) return;`,
    replace: `  function initMotionGraph(rootId, fixedFig) {
    const root = document.getElementById(rootId || "motionGraph");
    if (!root) return;`,
  },
  {
    label: "fig state: default to fixedFig when provided, else '31'",
    find: `    let hover = null, drag = null, selected = null;
    let fig = "31"; // '31' = image popup, '33' = video popup`,
    replace: `    let hover = null, drag = null, selected = null;
    let fig = fixedFig || "31"; // '31' = image popup, '33' = video popup -- locked when fixedFig is set`,
  },
  {
    label: "toggle wiring: only attach when a .mg-seg element exists (no toggle on fig-locked pages)",
    find: `    segEl.addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (!b) return;
      fig = b.dataset.fig;
      segEl.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    });`,
    replace: `    if (segEl && !fixedFig) {
      segEl.addEventListener("click", (ev) => {
        const b = ev.target.closest("button");
        if (!b) return;
        fig = b.dataset.fig;
        segEl.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      });
    }`,
  },
];

// ---------------------------------------------------------------------
// templates/camera.html -- Fig. 3.1, image only, no toggle
// ---------------------------------------------------------------------
const CAMERA_HTML_REPLACEMENTS = [
  {
    label: 'motion-graph toggle -> static "Fig 3.1 · image" badge',
    find: `            <span class="mg-seg">
              <button data-fig="31" class="on" title="Click a spike to view the snapshot">Fig 3.1 · image</button>
              <button data-fig="33" title="Click a spike to view the recorded clip">Fig 3.3 · video</button>
            </span>`,
    replace: `            <span class="mg-seg"><button class="on" disabled title="This dashboard always opens the snapshot">Fig 3.1 · image</button></span>`,
  },
];

// ---------------------------------------------------------------------
// templates/buzzer.html -- Fig. 3.3, video only, no toggle
// ---------------------------------------------------------------------
const BUZZER_HTML_REPLACEMENTS = [
  {
    label: 'motion-graph toggle -> static "Fig 3.3 · video" badge',
    find: `            <span class="mg-seg">
              <button data-fig="31" class="on" title="Click a spike to view the snapshot">Fig 3.1 · image</button>
              <button data-fig="33" title="Click a spike to view the recorded clip">Fig 3.3 · video</button>
            </span>`,
    replace: `            <span class="mg-seg"><button class="on" disabled title="This dashboard always opens the recorded clip">Fig 3.3 · video</button></span>`,
  },
];

// ---------------------------------------------------------------------
// static/camera.js -- lock to Fig. 3.1 (image)
// ---------------------------------------------------------------------
const CAMERA_JS_REPLACEMENTS = [
  {
    label: 'initMotionGraph() call -> initMotionGraph("motionGraph", "31")',
    find: `if (window.initMotionGraph) window.initMotionGraph();`,
    replace: `if (window.initMotionGraph) window.initMotionGraph("motionGraph", "31");`,
  },
];

// ---------------------------------------------------------------------
// static/buzzer.js -- lock to Fig. 3.3 (video)
// ---------------------------------------------------------------------
const BUZZER_JS_REPLACEMENTS = [
  {
    label: 'initMotionGraph() call -> initMotionGraph("motionGraph", "33")',
    find: `if (window.initMotionGraph) window.initMotionGraph();`,
    replace: `if (window.initMotionGraph) window.initMotionGraph("motionGraph", "33");`,
  },
];

async function main() {
  const backupDir = path.join(projectRoot, "backup", timestamp());

  console.log(`Perimeter -- lock motion graph to one figure per dashboard`);
  console.log(`root: ${projectRoot}`);
  if (dryRun) console.log(`(dry run -- no files will be written)`);

  const results = [];
  results.push(await patchFile(GRAPH_JS_PATH, GRAPH_JS_REPLACEMENTS, backupDir));
  results.push(await patchFile(CAMERA_HTML_PATH, CAMERA_HTML_REPLACEMENTS, backupDir));
  results.push(await patchFile(BUZZER_HTML_PATH, BUZZER_HTML_REPLACEMENTS, backupDir));
  results.push(await patchFile(CAMERA_JS_PATH, CAMERA_JS_REPLACEMENTS, backupDir));
  results.push(await patchFile(BUZZER_JS_PATH, BUZZER_JS_REPLACEMENTS, backupDir));

  const totals = results.reduce(
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
