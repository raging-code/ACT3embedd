#!/usr/bin/env node
/**
 * patch-buzzer-pin.mjs
 * ---------------------------------------------------------------------------
 * Moves the ACT3 (Perimeter / PIR+webcam) buzzer off BCM GPIO17 so ACT3 and
 * ACT4 (act4embed) can be wired to the SAME Raspberry Pi 5 at the same time
 * without a pin conflict.
 *
 * THE CONFLICT
 *   ACT3 buzzer  -> GPIO17   \
 *   ACT4 LED     -> GPIO17   /  both boards drive GPIO17 -- collision
 *
 *   Everything else is already clear between the two repos:
 *     ACT3 PIR sensor -> GPIO4   (ACT4 doesn't touch GPIO4 -- left alone)
 *     ACT4 buzzer      -> GPIO22
 *     ACT4 vibration   -> GPIO27
 *     ACT4 MCP3008 SPI -> GPIO7/8/9/10/11 (present in code, no longer wired
 *                          per config.py's own comment, but avoided anyway)
 *
 * THE FIX
 *   ACT3 buzzer moves from GPIO17 -> GPIO23. GPIO23 is a plain GPIO pin (not
 *   shared with SPI/I2C/UART) and isn't used anywhere in either repo, so it's
 *   free on both boards. ACT3's PIR sensor is left on GPIO4 -- it was never
 *   in conflict.
 *
 * Combined wiring after this patch (BCM numbering):
 *   ACT3 PIR sensor   -> GPIO4
 *   ACT3 buzzer       -> GPIO23   (was 17)
 *   ACT4 LED          -> GPIO17
 *   ACT4 vibration    -> GPIO27
 *   ACT4 buzzer       -> GPIO22
 *   ACT4 MCP3008 SPI  -> GPIO7/8/9/10/11 (unused per config.py, left as-is)
 *
 * This script only touches the ACT3 repo (raging-code/ACT3embedd) -- ACT4's
 * pins don't need to change.
 *
 * Usage (run from anywhere; default target is the current folder):
 *
 *     node patch-buzzer-pin.mjs                 # patch ./ (expects ACT3embedd)
 *     node patch-buzzer-pin.mjs /path/to/repo   # patch another folder
 *     node patch-buzzer-pin.mjs --dry-run       # show what would change
 *
 * Safe to re-run: if app.py is already patched, it's skipped. The original
 * is saved next to it as app.py.bak before anything is written. If the file
 * doesn't match what this script expects, NOTHING is written.
 *
 * Files changed: app.py
 *
 * AFTER RUNNING THIS SCRIPT:
 *   Move the physical buzzer wire from GPIO17 (physical pin 11) to GPIO23
 *   (physical pin 16) on the Pi's header, then restart ACT3's app.py.
 *   ACT4 needs no wiring or code changes at all.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const root = path.resolve(args.find((a) => !a.startsWith("--")) || ".");

const OLD_PIN = 17;
const NEW_PIN = 23;

/* ------------------------------------------------------------- helpers */

function replaceOnce(src, oldStr, newStr, label) {
  const first = src.indexOf(oldStr);
  if (first === -1) throw new Error(`could not find: ${label}`);
  if (src.indexOf(oldStr, first + 1) !== -1) throw new Error(`found more than once: ${label}`);
  return src.slice(0, first) + newStr + src.slice(first + oldStr.length);
}

/* --------------------------------------------------------------- app.py */
function patchAppPy(s) {
  s = replaceOnce(
    s,
    `BUZZER_PIN = 17             # BCM GPIO pin connected to the active buzzer's +/signal wire`,
    `BUZZER_PIN = 23             # BCM GPIO pin connected to the active buzzer's +/signal wire
                             # (moved from 17 -> 23: this app now shares a Pi 5
                             # with act4embed, whose LED is on GPIO17)`,
    "BUZZER_PIN constant"
  );
  return s;
}

/* --------------------------------------------------------------- main */

// [file, patch function, text that only exists once the file is patched]
const targets = [["app.py", patchAppPy, "moved from 17 -> 23"]];

console.log(`Target folder: ${root}${dryRun ? "  (dry run)" : ""}`);

const planned = [];
let failed = false;

for (const [rel, fn, marker] of targets) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.error(`  ✗ ${rel}: file not found (is this the ACT3embedd repo folder?)`);
    failed = true;
    continue;
  }
  const raw = fs.readFileSync(file, "utf8");
  const crlf = raw.includes("\r\n");
  const text = crlf ? raw.replace(/\r\n/g, "\n") : raw;

  if (text.includes(marker)) {
    console.log(`  • ${rel}: already patched, skipping`);
    continue;
  }
  try {
    let out = fn(text);
    if (crlf) out = out.replace(/\n/g, "\r\n");
    planned.push({ rel, file, out });
    console.log(`  ✓ ${rel}: ok`);
  } catch (err) {
    console.error(`  ✗ ${rel}: ${err.message}`);
    failed = true;
  }
}

if (failed) {
  console.error("\nNothing was written. The file differs from what this patch expects.");
  process.exit(1);
}

if (dryRun || planned.length === 0) {
  console.log(planned.length === 0 ? "\nNothing to do." : "\nDry run finished, no files written.");
  process.exit(0);
}

for (const { rel, file, out } of planned) {
  fs.copyFileSync(file, file + ".bak");
  fs.writeFileSync(file, out, "utf8");
  console.log(`  wrote ${rel}  (backup: ${rel}.bak)`);
}

console.log(`
Done. Combined GPIO map for running ACT3 + ACT4 on the same Pi 5:

  ACT3 PIR sensor   -> GPIO4    (physical pin 7)   -- unchanged
  ACT3 buzzer       -> GPIO${NEW_PIN}   (physical pin 16)  -- moved from GPIO${OLD_PIN}
  ACT4 LED          -> GPIO17   (physical pin 11)  -- unchanged
  ACT4 vibration    -> GPIO27   (physical pin 13)  -- unchanged
  ACT4 buzzer       -> GPIO22   (physical pin 15)  -- unchanged

Next steps:
  1. Move ACT3's buzzer wire from GPIO${OLD_PIN} (physical pin 11) to GPIO${NEW_PIN}
     (physical pin 16) on the Pi 5's header.
  2. Restart ACT3's app (python3 app.py). No change needed on the ACT4 side.
`);
