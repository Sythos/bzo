/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// Says when the main thread stops coming back to the event loop: a loop that
// never yields, synchronous or a chain of promises that never drains, leaves
// the server taking no connections and reading no sockets while its process
// looks alive. The main thread ticks a counter; a worker thread, which keeps
// running however stuck the main one is, writes `[LOOP]` to the log once the
// counter has stood still for `stallMs`. The main thread logs how long it was
// gone when it comes back, if it does.

const { Worker } = require('node:worker_threads');

const WORKER = `
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const beat = new Int32Array(workerData.buffer);
let seen = Atomics.load(beat, 0);
let since = Date.now();
let reported = false;
setInterval(() => {
  const now = Atomics.load(beat, 0);
  if (now !== seen) {
    seen = now;
    since = Date.now();
    reported = false;
    return;
  }
  const stalled = Date.now() - since;
  if (reported || stalled < workerData.stallMs) return;
  reported = true;
  const line = '[' + new Date().toISOString() + '] [LOOP] main thread stalled ' + stalled + 'ms and counting';
  console.error(line);
  fs.appendFileSync(workerData.logPath, line + '\\n');
}, 250);
`;

function startLoopWatchdog({ logPath, log = () => {}, stallMs = 2000, beatMs = 250 }) {
  const beat = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(WORKER, { eval: true, workerData: { buffer: beat.buffer, logPath, stallMs } });
  worker.unref();
  worker.on('error', (error) => log(`[LOOP] watchdog stopped: ${error.message}`));
  let last = Date.now();
  setInterval(() => {
    Atomics.add(beat, 0, 1);
    const now = Date.now();
    const gone = now - last - beatMs;
    last = now;
    if (gone >= stallMs) log(`[LOOP] main thread back after ${gone}ms`);
  }, beatMs).unref();
  return worker;
}

module.exports = { startLoopWatchdog };
