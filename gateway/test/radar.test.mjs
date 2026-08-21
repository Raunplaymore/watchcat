// Radar observation intake: validation gates, the allowlist, and the freshness
// window. Runs with a 150 ms window/online threshold so staleness is testable
// without real waiting.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.TEST_PORT || 3197);
const BASE = `http://127.0.0.1:${PORT}`;
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

const status = () => fetch(`${BASE}/api/v1/radar/status`).then(r => r.json());
const post = (value, raw) =>
  fetch(`${BASE}/api/v1/radar/observations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw ?? JSON.stringify(value) });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const uploadDir = await mkdtemp(path.join(tmpdir(), 'watchcat-test-'));
const server = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env, PORT: String(PORT), WATCHCAT_UPLOAD_DIR: uploadDir, WATCHCAT_TOKEN: '',
    HAILO_CAMERA_URL: 'http://127.0.0.1:9',
    WATCHCAT_RADAR_SENSORS: 'living-room-radar-1',
    WATCHCAT_RADAR_WINDOW_MS: '150', WATCHCAT_RADAR_ONLINE_MS: '150',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { await status(); return; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  throw new Error('gateway did not start');
}

const target = { xMm: -420, yMm: 2150, speedMmPerSec: 310 };

try {
  await waitForServer();
  const rest = await status();
  check('starts offline with no targets', rest.sensorOnline === false && rest.targets.length === 0);

  const accepted = await post({ sensorId: 'living-room-radar-1', sequence: 7, targets: [target] });
  check('valid batch is accepted', accepted.status === 202);
  const live = await status();
  check('sensor reports online after a batch', live.sensorOnline === true);
  check('latest targets are served', live.targets.length === 1 && live.targets[0].xMm === -420, JSON.stringify(live.targets));
  check('sequence rides along', live.lastSequence === 7);

  const empty = await post({ sensorId: 'living-room-radar-1', sequence: 8, targets: [] });
  check('empty batch is accepted (motion stopped)', empty.status === 202);
  const afterEmpty = await status();
  check('empty batch clears the served targets', afterEmpty.targets.length === 0);
  check('radarOk defaults to true', afterEmpty.radarOk === true);

  await post({ sensorId: 'living-room-radar-1', sequence: 9, radarOk: false, targets: [] });
  check('heartbeat marks the radar silent', (await status()).radarOk === false);

  check('unknown sensor is rejected', (await post({ sensorId: 'intruder', targets: [target] })).status === 403);
  check('missing sensorId is rejected', (await post({ targets: [target] })).status === 400);
  check('non-numeric target is rejected', (await post({ sensorId: 'living-room-radar-1', targets: [{ xMm: 'a', yMm: 1, speedMmPerSec: 1 }] })).status === 400);
  check('out-of-range target is rejected', (await post({ sensorId: 'living-room-radar-1', targets: [{ ...target, yMm: 99999 }] })).status === 400);
  check('too many targets are rejected', (await post({ sensorId: 'living-room-radar-1', targets: [target, target, target, target] })).status === 400);
  check('broken JSON is rejected', (await post(null, '{nope')).status === 400);
  check('oversized body is rejected', (await post(null, JSON.stringify({ sensorId: 'living-room-radar-1', pad: 'x'.repeat(5000) }))).status === 413);
  check('rejected batches leave the sensor readable', (await status()).ok === true);

  await new Promise(r => setTimeout(r, 300));
  const stale = await status();
  check('sensor goes offline past the window', stale.sensorOnline === false);
  check('window pruning empties the buffer', stale.observationsInWindow === 0, String(stale.observationsInWindow));
} finally {
  server.kill();
  await rm(uploadDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
