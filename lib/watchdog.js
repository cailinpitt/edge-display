// Restarts the kiosk when the page stops drawing. The page reports a running
// frame count with every poll; if it stops climbing while the page should be
// animating, or the polls stop altogether, Chromium or cage has stalled (a page
// reload can't fix a stuck cage).
const { execFile } = require('node:child_process');

const STALL_MS = 60 * 1000;
const MIN_RESTART_GAP_MS = 10 * 60 * 1000;

let lastFrames = null;
let lastProgressAt = Date.now();
let lastPollAt = Date.now();
let lastRestartAt = 0;

function restart(reason) {
  const now = Date.now();
  if (now - lastRestartAt < MIN_RESTART_GAP_MS) return;
  lastRestartAt = now;
  console.error(`${reason}; restarting kiosk`);
  execFile('sudo', ['-n', 'systemctl', 'restart', 'edge-kiosk.service'], (err) => {
    if (err) console.error(`kiosk restart failed: ${err.message}`);
  });
}

function report(frames, drawing) {
  const now = Date.now();
  lastPollAt = now;
  if (!drawing || frames !== lastFrames) {
    lastFrames = frames;
    lastProgressAt = now;
    return;
  }
  if (now - lastProgressAt > STALL_MS) {
    restart(`page stopped drawing at frame ${frames} (since ${new Date(lastProgressAt).toISOString()})`);
  }
}

setInterval(() => {
  if (Date.now() - lastPollAt > STALL_MS) {
    restart(`no poll from the page since ${new Date(lastPollAt).toISOString()}`);
  }
}, 15 * 1000).unref();

module.exports = { report };
