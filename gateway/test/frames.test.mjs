// Regression tests for frame bookkeeping. Boots a real gateway on a scratch
// upload dir; no camera, Pi, or Hailo needed. Run with `npm test`.
//
// Guards two defects:
//   1. A live-stream frame used to overwrite latestFilename, so the web UI served
//      a live frame beside the previous still's cat verdict and confidence.
//   2. Frame responses used to stat the path and then reopen it. Because a live
//      frame is replaced by rename on every stream tick, Content-Length could
//      describe a different file than the body, truncating the response.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.TEST_PORT || 3197);
const BASE = `http://127.0.0.1:${PORT}`;
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

const jpeg = (byte, size) => Buffer.alloc(size, byte);
const post = (route, buf, extra = {}) =>
  fetch(`${BASE}${route}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', ...extra }, body: buf });
const status = () => fetch(`${BASE}/api/v1/status`).then(r => r.json());
const bytes = async route => Buffer.from(await fetch(`${BASE}${route}`).then(r => r.arrayBuffer()));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const uploadDir = await mkdtemp(path.join(tmpdir(), 'watchcat-test-'));
const server = spawn(process.execPath, [serverPath], {
  env: { ...process.env, PORT: String(PORT), WATCHCAT_UPLOAD_DIR: uploadDir, WATCHCAT_TOKEN: '', HAILO_CAMERA_URL: 'http://127.0.0.1:9' },
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

  await post('/api/v1/frames', jpeg(0xa1, 4096));
  const still = await status();
  check('still frame sets latestFilename', Boolean(still.latestFilename), still.latestFilename);
  check('still frame leaves liveFilename unset', still.liveFilename === null);

  await post('/api/v1/frames', jpeg(0xb2, 8192), { 'X-Watchcat-Stream': 'true' });
  const live = await status();
  check('live frame keeps latestFilename', live.latestFilename === still.latestFilename, `${still.latestFilename} -> ${live.latestFilename}`);
  check('live frame keeps capturedAt', live.capturedAt === still.capturedAt);
  check('live frame records liveFilename', live.liveFilename === 'watchcat_live.jpg', live.liveFilename);

  check('latest.jpg serves the still', (await bytes('/api/v1/latest.jpg')).equals(jpeg(0xa1, 4096)));
  check('live.jpg serves the live frame', (await bytes('/api/v1/live.jpg')).equals(jpeg(0xb2, 8192)));

  // Read live.jpg while it is rewritten at varying sizes; every response must
  // deliver exactly the bytes it declared.
  const sizes = [2048, 65536, 4096, 131072, 1024];
  let mismatches = 0, reads = 0, aborted = 0;
  await Promise.all([
    (async () => { for (let i = 0; i < 60; i++) await post('/api/v1/frames', jpeg(0xc3, sizes[i % sizes.length]), { 'X-Watchcat-Stream': 'true' }); })(),
    (async () => {
      for (let i = 0; i < 60; i++) {
        try {
          const res = await fetch(`${BASE}/api/v1/live.jpg?t=${i}`);
          if (res.status !== 200) continue;
          const declared = Number(res.headers.get('content-length'));
          const actual = (Buffer.from(await res.arrayBuffer())).length;
          reads++;
          if (declared !== actual) { mismatches++; console.log(`     declared ${declared}, received ${actual}`); }
        } catch (error) { aborted++; console.log(`     read aborted: ${error.message}`); }
      }
    })(),
  ]);
  check('live.jpg body matches Content-Length under rewrite', mismatches === 0 && aborted === 0, `${reads} reads, ${mismatches} mismatched, ${aborted} aborted`);

  const after = await status();
  check('latestFilename survives a live session', after.latestFilename === still.latestFilename);
  check('latest.jpg still returns the still', (await bytes('/api/v1/latest.jpg')).equals(jpeg(0xa1, 4096)));
} finally {
  server.kill();
  await rm(uploadDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
