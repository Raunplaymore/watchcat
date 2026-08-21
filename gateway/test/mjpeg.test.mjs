// The MJPEG endpoint: a viewer gets each streamed frame as a multipart part,
// and the viewer cap turns extra connections away instead of piling them up.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.TEST_PORT || 3194);
const BASE = `http://127.0.0.1:${PORT}`;
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const uploadDir = await mkdtemp(path.join(tmpdir(), 'watchcat-test-'));
const server = spawn(process.execPath, [serverPath], {
  env: { ...process.env, PORT: String(PORT), WATCHCAT_UPLOAD_DIR: uploadDir, WATCHCAT_TOKEN: '', HAILO_CAMERA_URL: 'http://127.0.0.1:9', WATCHCAT_LIVE_VIEWER_LIMIT: '1' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/api/v1/status`); return; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  throw new Error('gateway did not start');
}
const postFrame = () => fetch(`${BASE}/api/v1/frames`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Watchcat-Stream': 'true' }, body: Buffer.alloc(2048, 0xd4) });

try {
  await waitForServer();
  const chunks = [];
  const viewer = await new Promise(resolve => http.get(`${BASE}/api/v1/live.mjpeg`, res => { res.on('data', c => chunks.push(c)); resolve(res); }));
  check('viewer connects as multipart', String(viewer.headers['content-type']).startsWith('multipart/x-mixed-replace'));
  await postFrame();
  await postFrame();
  await new Promise(r => setTimeout(r, 200));
  const body = Buffer.concat(chunks).toString('latin1');
  const parts = body.split('--frame').length - 1;
  check('streamed frames arrive as parts', parts >= 2, `${parts} part(s)`);
  check('parts carry the jpeg payload', body.includes('Content-Length: 2048'));
  const second = await fetch(`${BASE}/api/v1/live.mjpeg`);
  check('viewer cap rejects the overflow connection', second.status === 503);
  viewer.destroy();
} finally {
  server.kill();
  await rm(uploadDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
