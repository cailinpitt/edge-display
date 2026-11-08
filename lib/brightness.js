// Sets the monitor's real backlight over DDC/CI (ddcutil) at the sleep/wake
// switches. Only changes it on a transition, so manual daytime adjustments stick.
const { execFile } = require('node:child_process');
const { readConfig, isAsleep } = require('./config');

const CHECK_MS = 30 * 1000;
const BRIGHTNESS_VCP = '10';

let lastAsleep = null;
let ok = null;

function ddcutil(args, bus) {
  const busArgs = bus != null ? ['--bus', String(bus)] : [];
  return new Promise((resolve, reject) => {
    execFile('ddcutil', [...busArgs, ...args], { timeout: 15000 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout),
    );
  });
}

async function getBrightness(bus) {
  const out = await ddcutil(['getvcp', BRIGHTNESS_VCP, '--brief'], bus);
  return Number(out.trim().split(/\s+/)[3]);
}

function target(cfg, asleep) {
  const { day, night } = cfg.sleep.monitorBrightness;
  if (!asleep) return day;
  return cfg.sleep.mode === 'black' ? 0 : night;
}

async function tick() {
  const cfg = readConfig();
  if (!cfg.sleep?.enabled || !cfg.sleep.monitorBrightness) return;
  const asleep = isAsleep(cfg);
  if (asleep === lastAsleep && ok) return;
  const { ddcBus: bus } = cfg.sleep;
  try {
    // At startup during the day, only restore brightness if it was left dimmed.
    if (lastAsleep === null && !asleep && (await getBrightness(bus)) > cfg.sleep.monitorBrightness.night) {
      lastAsleep = asleep;
      ok = true;
      return;
    }
    const value = target(cfg, asleep);
    await ddcutil(['setvcp', BRIGHTNESS_VCP, String(value)], bus);
    console.log(`monitor brightness → ${value} (${asleep ? 'sleep' : 'wake'})`);
    lastAsleep = asleep;
    ok = true;
  } catch (err) {
    if (ok !== false) console.error(`ddcutil failed: ${err.message}`);
    ok = false;
  }
}

function start() {
  tick();
  setInterval(tick, CHECK_MS);
}

module.exports = { start };
