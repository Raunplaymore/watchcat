const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3102);
const UPLOAD_DIR = path.resolve(process.env.WATCHCAT_UPLOAD_DIR || '/home/ray/uploads/watchcat');
const HAILO_URL = (process.env.HAILO_CAMERA_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const CAMERA_URL = (process.env.WATCHCAT_CAMERA_URL || '').replace(/\/$/, '');
const TOKEN = process.env.WATCHCAT_TOKEN || '';
const HAILO_TOKEN = process.env.HAILO_CAMERA_TOKEN || '';
const MAX_FRAME_BYTES = Number(process.env.WATCHCAT_MAX_FRAME_BYTES || 2 * 1024 * 1024);
let inferenceTail = Promise.resolve();
let state = { cameraOnline: false, inferenceState: 'idle', catPresent: false, confidence: null, capturedAt: null, processedAt: null, lastError: null, latestFilename: null, requestId: null };

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
function authorized(req) {
  if (!TOKEN) return true;
  const actual = req.headers.authorization || '', expected = `Bearer ${TOKEN}`;
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
const hailoHeaders = () => ({ 'Content-Type': 'application/json', ...(HAILO_TOKEN ? { Authorization: `Bearer ${HAILO_TOKEN}` } : {}) });
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_FRAME_BYTES) throw Object.assign(new Error('Frame exceeds size limit'), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function post(url, value, headers) {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(value) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
function queue(job) {
  state = { ...state, cameraOnline: true, inferenceState: 'waiting', catPresent: false, confidence: null, lastError: null, latestFilename: job.filename, capturedAt: job.capturedAt, requestId: job.id };
  const run = inferenceTail.then(() => infer(job), () => infer(job)); inferenceTail = run.catch(() => {});
}
async function infer(job) {
  state = { ...state, inferenceState: 'running' };
  try {
    await post(`${HAILO_URL}/api/meta/from-file`, { jobId: job.id, inputPath: job.file, filename: job.filename, model: 'watchcat-cat', width: job.width, height: job.height, force: true }, hailoHeaders());
    const response = await fetch(`${HAILO_URL}/api/session/${encodeURIComponent(job.id)}/meta?model=watchcat-cat`, { headers: HAILO_TOKEN ? { Authorization: `Bearer ${HAILO_TOKEN}` } : {} });
    const meta = await response.json().catch(() => ({})); if (!response.ok) throw new Error(meta.error || `Metadata HTTP ${response.status}`);
    const cats = (meta.frames || []).flatMap(frame => frame.detections || []).filter(item => item.label === 'cat');
    const confidence = cats.reduce((best, item) => Math.max(best, Number(item.conf) || 0), 0);
    state = { ...state, inferenceState: 'complete', catPresent: cats.length > 0, confidence: cats.length ? confidence : null, processedAt: new Date().toISOString(), lastError: null };
  } catch (error) { state = { ...state, inferenceState: 'error', catPresent: false, confidence: null, processedAt: new Date().toISOString(), lastError: error.message }; }
}
async function frame(req, res) {
  if (!authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized' });
  if (!String(req.headers['content-type'] || '').startsWith('image/jpeg')) return json(res, 415, { ok: false, error: 'Content-Type must be image/jpeg' });
  try {
    const image = await body(req); if (!image.length) return json(res, 400, { ok: false, error: 'Empty frame' });
    await fsp.mkdir(UPLOAD_DIR, { recursive: true });
    const id = `watchcat_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`, filename = `${id}.jpg`, file = path.join(UPLOAD_DIR, filename);
    await fsp.writeFile(`${file}.part`, image); await fsp.rename(`${file}.part`, file);
    queue({ id, filename, file, capturedAt: req.headers['x-watchcat-captured-at'] || new Date().toISOString(), width: Number(req.headers['x-watchcat-width']) || undefined, height: Number(req.headers['x-watchcat-height']) || undefined });
    return json(res, 202, { ok: true, requestId: id, inferenceState: 'waiting' });
  } catch (error) { return json(res, error.status || 500, { ok: false, error: error.message }); }
}
async function capture(req, res) {
  if (!authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized' });
  if (!CAMERA_URL) return json(res, 503, { ok: false, error: 'WATCHCAT_CAMERA_URL is not configured' });
  try { await post(`${CAMERA_URL}/api/v1/capture`, {}, TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}); return json(res, 202, { ok: true, accepted: true }); }
  catch (error) { state = { ...state, cameraOnline: false, lastError: error.message }; return json(res, 503, { ok: false, error: error.message }); }
}
function latest(res) {
  if (!state.latestFilename) return json(res, 404, { ok: false, error: 'No captured frame' });
  const stream = fs.createReadStream(path.join(UPLOAD_DIR, state.latestFilename));
  stream.on('error', () => json(res, 404, { ok: false, error: 'Latest frame missing' }));
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); stream.pipe(res);
}
const page = `<!doctype html><meta charset="utf-8"><title>watchcat</title><style>body{background:#101216;color:white;font:16px system-ui;margin:2rem}main{max-width:720px;margin:auto}strong{font-size:2rem}img{max-width:100%;margin-top:1rem;background:#222;border-radius:12px}.error{color:#ff7777}</style><main><h1>WATCHCAT</h1><strong id=r>Loading…</strong><p id=d></p><button id=b>사진 촬영</button><img id=i alt="최근 사진"><script>const r=document.querySelector('#r'),d=document.querySelector('#d'),i=document.querySelector('#i');async function x(){try{let s=await fetch('/api/v1/status').then(v=>v.json());r.textContent=s.inferenceState==='waiting'||s.inferenceState==='running'?'INFERENCE WAITING':s.catPresent?'CAT FOUND':'NO CAT';d.textContent=s.lastError||'confidence: '+(s.confidence??'-')+' · '+(s.processedAt??'-');d.className=s.lastError?'error':'';if(s.latestFilename)i.src='/api/v1/latest.jpg?t='+Date.now()}catch(e){r.textContent='GATEWAY ERROR';d.textContent=e.message}}b.onclick=()=>fetch('/api/v1/capture',{method:'POST'}).then(x);setInterval(x,2000);x();</script></main>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page); }
  if (req.method === 'GET' && url.pathname === '/api/v1/status') return json(res, 200, { ok: true, ...state });
  if (req.method === 'GET' && url.pathname === '/api/v1/latest.jpg') return latest(res);
  if (req.method === 'POST' && url.pathname === '/api/v1/frames') return frame(req, res);
  if (req.method === 'POST' && url.pathname === '/api/v1/capture') return capture(req, res);
  return json(res, 404, { ok: false, error: 'Not found' });
});
server.listen(PORT, () => console.log(`watchcat gateway listening on :${PORT}`));
module.exports = { authorized };
