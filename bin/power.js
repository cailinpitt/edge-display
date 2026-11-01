// Runs inside the cage session: turns the monitor off during sleep hours.
const { execFile } = require('node:child_process');
const { readConfig, isAsleep } = require('../lib/config');

const CHECK_MS = 30 * 1000;
let last = null;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, (err, _out, stderr) => resolve(err ? stderr || err.message : null));
  });
}

async function apply(asleep) {
  const err = await run('wlopm', [asleep ? '--off' : '--on', '*']);
  console.log(`${new Date().toISOString()} display ${asleep ? 'off' : 'on'}${err ? ` (wlopm failed: ${err.trim()})` : ''}`);
}

async function tick() {
  const asleep = isAsleep(readConfig());
  if (asleep !== last) {
    last = asleep;
    await apply(asleep);
  }
}

tick();
setInterval(tick, CHECK_MS);
