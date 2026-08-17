// Regression tests for the command queue's redelivery ceiling.
//
// A command is redelivered once its lease expires so a sensor that drops offline
// mid-command still receives it. Without a ceiling, an unreachable sensor would be
// handed the same command forever and the operator would never see an error.
// Runs with a zero lease and a ceiling of 2 so redelivery is immediate.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.TEST_PORT || 3196);
const BASE = `http://127.0.0.1:${PORT}`;
const MAX_ATTEMPTS = 2;
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

const next = () => fetch(`${BASE}/api/v1/commands/next`).then(r => r.json());
const status = () => fetch(`${BASE}/api/v1/status`).then(r => r.json());
const postJson = (route, value) =>
  fetch(`${BASE}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }).then(r => r.json());

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
    WATCHCAT_COMMAND_LEASE_MS: '0', WATCHCAT_COMMAND_MAX_ATTEMPTS: String(MAX_ATTEMPTS),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { await status(); return; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  throw new Error('gateway did not start');
}

try {
  await waitForServer();
  check('no command pending at rest', (await next()).command === null);

  // --- capture: delivered MAX_ATTEMPTS times, then abandoned ---
  await postJson('/api/v1/capture', {});
  check('capture request is queued', (await status()).capturePending === true);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const delivered = await next();
    check(`capture delivered on attempt ${attempt}`, delivered.command === 'capture', delivered.command);
  }
  const exhausted = await next();
  check('capture stops being delivered past the ceiling', exhausted.command === null, exhausted.command);
  const afterCapture = await status();
  check('abandoned capture clears capturePending', afterCapture.capturePending === false);
  check('abandoned capture surfaces lastError', /abandoned/.test(afterCapture.lastError || ''), afterCapture.lastError);
  check('abandoned capture is not redelivered later', (await next()).command === null);

  // --- stream: same ceiling applies ---
  await postJson('/api/v1/stream', { active: true });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const delivered = await next();
    check(`stream-start delivered on attempt ${attempt}`, delivered.command === 'stream-start', delivered.command);
  }
  check('stream stops being delivered past the ceiling', (await next()).command === null);
  const afterStream = await status();
  check('abandoned stream clears streamPending', afterStream.streamPending === false);
  check('abandoned stream leaves streamActive false', afterStream.streamActive === false);

  // --- acknowledged stream command is retired, not redelivered ---
  await postJson('/api/v1/stream', { active: true });
  const toAck = await next();
  check('stream command is delivered before ack', toAck.command === 'stream-start');
  const acked = await postJson('/api/v1/commands/ack', { id: toAck.id });
  check('ack activates the stream', acked.ok === true && acked.streamActive === true, JSON.stringify(acked));
  check('acked stream command is not redelivered', (await next()).command === null);

  // --- uploaded frame retires its capture command ---
  const queued = await postJson('/api/v1/capture', {});
  const handed = await next();
  check('capture command carries the request id', handed.id === queued.requestId, `${handed.id} vs ${queued.requestId}`);
  await fetch(`${BASE}/api/v1/frames`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', 'X-Watchcat-Command-Id': handed.id },
    body: Buffer.alloc(1024, 0xd4),
  });
  check('uploaded frame clears the capture command', (await status()).capturePending === false);
  check('completed capture is not redelivered', (await next()).command === null);
} finally {
  server.kill();
  await rm(uploadDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
