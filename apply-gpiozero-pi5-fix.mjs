#!/usr/bin/env node
/**
 * apply-gpiozero-pi5-fix.mjs
 * ----------------------------------------------------------------------
 * Fixes "PIR sensor: offline" on Raspberry Pi 5.
 *
 * ROOT CAUSE: app.py drives the PIR sensor and buzzer with the classic
 * RPi.GPIO library. RPi.GPIO talks to the old BCM283x GPIO peripheral
 * directly and does NOT support the Pi 5's new RP1 I/O controller.
 * GPIO.setup() raises a RuntimeError on a Pi 5, which app.py's
 * `except (ImportError, RuntimeError)` silently swallows -- leaving
 * GPIO_AVAILABLE = False forever, so the dashboard shows "PIR sensor:
 * offline" and motion is never read, even though the import itself
 * succeeds and nothing crashes.
 *
 * FIX: migrate app.py from RPi.GPIO to gpiozero (matching the user's
 * own known-working standalone script), which auto-selects the lgpio
 * backend and supports the Pi 5's RP1 chip.
 *
 * Changes to app.py:
 *   - GPIO setup block: `import RPi.GPIO as GPIO` + GPIO.setmode/setup
 *     -> `from gpiozero import MotionSensor, DigitalOutputDevice` and
 *     construct pir_sensor / buzzer_device objects. queue_len=5,
 *     threshold=0.6 match the user's own working script so the PIR
 *     gets the same debounce/smoothing behavior.
 *   - sound_buzzer(): GPIO.output(BUZZER_PIN, HIGH/LOW)
 *     -> buzzer_device.on() / buzzer_device.off()
 *   - read_pir(): GPIO.input(PIR_PIN) -> pir_sensor.motion_detected
 *   - Exception handling broadened from (ImportError, RuntimeError) to
 *     Exception, since gpiozero can raise other exception types
 *     (e.g. BadPinFactory) on unsupported/misconfigured hardware, and
 *     the goal is the same graceful SIMULATE-style fallback either way.
 *
 * Changes to requirements.txt:
 *   - RPi.GPIO dependency line -> gpiozero + lgpio (the Pi-5-capable
 *     backend gpiozero needs on Linux/aarch64)
 *
 * templates/*.html, static/*.js are NOT touched.
 *
 * IMPORTANT -- run this on the Raspberry Pi itself (or wherever app.py
 * actually runs), then install the new dependencies before starting the
 * app again:
 *     pip install gpiozero lgpio --break-system-packages
 * (or `pip install -r requirements.txt` after this patch updates it)
 *
 * Usage:
 *   node apply-gpiozero-pi5-fix.mjs             # run from the repo root
 *   node apply-gpiozero-pi5-fix.mjs --dry-run   # preview only
 *   node apply-gpiozero-pi5-fix.mjs --root /path/to/ACT3embedd
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

const APP_PY_PATH = path.join(projectRoot, "app.py");
const REQUIREMENTS_PATH = path.join(projectRoot, "requirements.txt");

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
// app.py replacements
// ---------------------------------------------------------------------
const APP_PY_REPLACEMENTS = [
  {
    label: "GPIO setup block: RPi.GPIO -> gpiozero (MotionSensor + DigitalOutputDevice, Pi 5 / RP1 compatible)",
    find: `GPIO_AVAILABLE = False
if not SIMULATE:
    try:
        import RPi.GPIO as GPIO
        GPIO.setmode(GPIO.BCM)
        GPIO.setup(PIR_PIN, GPIO.IN)
        GPIO.setup(BUZZER_PIN, GPIO.OUT)
        GPIO.output(BUZZER_PIN, GPIO.LOW)
        GPIO_AVAILABLE = True
    except (ImportError, RuntimeError):
        GPIO_AVAILABLE = False`,
    replace: `GPIO_AVAILABLE = False
pir_sensor = None
buzzer_device = None
if not SIMULATE:
    try:
        # gpiozero (lgpio backend) instead of RPi.GPIO: RPi.GPIO only
        # talks to the classic BCM283x GPIO peripheral and does not
        # support the Raspberry Pi 5's RP1 I/O controller -- GPIO.setup()
        # raises there even though the import succeeds. gpiozero picks
        # the right backend for whichever Pi this runs on.
        # queue_len/threshold match the known-working standalone PIR
        # test script: 5 consistent readings before the state flips,
        # smoothing out a noisy sensor.
        from gpiozero import MotionSensor, DigitalOutputDevice
        pir_sensor = MotionSensor(PIR_PIN, queue_len=5, threshold=0.6)
        buzzer_device = DigitalOutputDevice(BUZZER_PIN, initial_value=False)
        GPIO_AVAILABLE = True
    except Exception:
        GPIO_AVAILABLE = False`,
  },
  {
    label: "sound_buzzer(): GPIO.output(HIGH/LOW) -> buzzer_device.on()/.off()",
    find: `        if GPIO_AVAILABLE:
            GPIO.output(BUZZER_PIN, GPIO.HIGH)
        time.sleep(seconds)
        if GPIO_AVAILABLE:
            GPIO.output(BUZZER_PIN, GPIO.LOW)`,
    replace: `        if GPIO_AVAILABLE and buzzer_device is not None:
            buzzer_device.on()
        time.sleep(seconds)
        if GPIO_AVAILABLE and buzzer_device is not None:
            buzzer_device.off()`,
  },
  {
    label: "read_pir(): GPIO.input(PIR_PIN) -> pir_sensor.motion_detected",
    find: `    if not GPIO_AVAILABLE:
        return False
    return bool(GPIO.input(PIR_PIN))`,
    replace: `    if not GPIO_AVAILABLE or pir_sensor is None:
        return False
    return bool(pir_sensor.motion_detected)`,
  },
];

// ---------------------------------------------------------------------
// requirements.txt replacements
// ---------------------------------------------------------------------
const REQUIREMENTS_REPLACEMENTS = [
  {
    label: "RPi.GPIO dependency -> gpiozero + lgpio (Pi 5 / RP1 compatible)",
    find: `RPi.GPIO>=0.7.1 ; platform_machine == "armv7l" or platform_machine == "aarch64"`,
    replace: `gpiozero>=2.0 ; platform_machine == "armv7l" or platform_machine == "aarch64"
lgpio>=0.2 ; platform_machine == "armv7l" or platform_machine == "aarch64"`,
  },
];

async function main() {
  const backupDir = path.join(projectRoot, "backup", timestamp());

  console.log(`Perimeter -- migrate GPIO from RPi.GPIO to gpiozero (Pi 5 / RP1 fix)`);
  console.log(`root: ${projectRoot}`);
  if (dryRun) console.log(`(dry run -- no files will be written)`);

  const appResult = await patchFile(APP_PY_PATH, APP_PY_REPLACEMENTS, backupDir);
  const reqResult = await patchFile(REQUIREMENTS_PATH, REQUIREMENTS_REPLACEMENTS, backupDir);

  const totals = [appResult, reqResult].reduce(
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
  if (dryRun) {
    console.log(`Re-run without --dry-run to write changes.`);
  } else if (totals.applied > 0) {
    console.log(
      `\nNext step on the Pi: pip install gpiozero lgpio --break-system-packages\n(or: pip install -r requirements.txt)\nThen restart app.py.`
    );
  }
}

main().catch((err) => {
  console.error("Patch failed:", err);
  process.exit(1);
});
