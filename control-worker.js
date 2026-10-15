// Worker thread for the control crawler: decompresses one EVE Ref daily killmail archive and tallies
// it (control.js addKillmail), off the server's main thread. A day is ~2 MB of bzip2 holding ~40 MB
// of JSON, a few seconds of work that would otherwise stall every request.

import { parentPort, workerData } from 'node:worker_threads';
import { bunzip2, untar } from './archive.js';
import { addKillmail, newDay } from './public/js/control.js';

const { bytes, date, space } = workerData;
const inSpace = new Set(space);
const day = newDay(date);
const decoder = new TextDecoder();
let files = 0, bad = 0;
untar(bunzip2(bytes), (name, data) => {
  if (!name.endsWith('.json')) return;
  files++;
  try { addKillmail(day, JSON.parse(decoder.decode(data)), (id) => inSpace.has(id)); } catch { bad++; }
});
parentPort.postMessage({ ...day, files, bad });
