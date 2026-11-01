const Fs = require('node:fs');
const Path = require('node:path');

const CONFIG_PATH = Path.join(__dirname, '..', 'config.json');

let cached = null;
let cachedMtime = 0;

// Re-read on change so sleep hours etc. can be edited without a restart.
function readConfig() {
  const { mtimeMs } = Fs.statSync(CONFIG_PATH);
  if (!cached || mtimeMs !== cachedMtime) {
    cached = JSON.parse(Fs.readFileSync(CONFIG_PATH, 'utf8'));
    cachedMtime = mtimeMs;
  }
  return cached;
}

function minutesOf(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function isAsleep(cfg, date = new Date()) {
  const { sleep, timezone } = cfg;
  if (!sleep?.enabled) return false;
  const [h, m] = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(date)
    .split(':')
    .map(Number);
  const now = h * 60 + m;
  const start = minutesOf(sleep.start);
  const end = minutesOf(sleep.end);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

module.exports = { readConfig, isAsleep };
