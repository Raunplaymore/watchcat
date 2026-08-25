const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3102);
const UPLOAD_DIR = path.resolve(process.env.WATCHCAT_UPLOAD_DIR || '/home/ray/uploads/watchcat');
const HAILO_URL = (process.env.HAILO_CAMERA_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const TOKEN = process.env.WATCHCAT_TOKEN || '';
const HAILO_TOKEN = process.env.HAILO_CAMERA_TOKEN || '';
const MAX_FRAME_BYTES = Number(process.env.WATCHCAT_MAX_FRAME_BYTES || 2 * 1024 * 1024);
let inferenceTail = Promise.resolve();
// latestFilename/capturedAt describe the last inferred still. Live-stream frames
// are tracked separately so a live frame never gets served next to a stale verdict.
let state = { cameraOnline: false, inferenceState: 'idle', catPresent: false, confidence: null, catBoxes: [], personPresent: false, personBoxes: [], capturedAt: null, processedAt: null, lastCatAt: null, lastError: null, latestFilename: null, requestId: null, liveFilename: null, liveAt: null };
let captureCommand = null;
let streamCommand = null;
let streamActive = false;
// A command is redelivered once its lease expires, so a sensor that drops offline
// mid-command still gets it. Attempts are bounded: without a ceiling an unreachable
// sensor would be handed the same command forever and never surface an error.
const COMMAND_LEASE_MS = Number(process.env.WATCHCAT_COMMAND_LEASE_MS || 30_000);
const COMMAND_MAX_ATTEMPTS = Number(process.env.WATCHCAT_COMMAND_MAX_ATTEMPTS || 3);

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
  state = { ...state, cameraOnline: true, inferenceState: 'waiting', catPresent: false, confidence: null, catBoxes: [], personPresent: false, personBoxes: [], lastError: null, latestFilename: job.filename, capturedAt: job.capturedAt, requestId: job.id };
  const run = inferenceTail.then(() => infer(job), () => infer(job)); inferenceTail = run.catch(() => {});
}
async function infer(job) {
  state = { ...state, inferenceState: 'running' };
  try {
    await post(`${HAILO_URL}/api/meta/from-file`, { jobId: job.id, inputPath: job.file, filename: job.filename, model: 'watchcat-cat', width: job.width, height: job.height, force: true }, hailoHeaders());
    const response = await fetch(`${HAILO_URL}/api/session/${encodeURIComponent(job.id)}/meta?model=watchcat-cat`, { headers: HAILO_TOKEN ? { Authorization: `Bearer ${HAILO_TOKEN}` } : {} });
    const meta = await response.json().catch(() => ({})); if (!response.ok) throw new Error(meta.error || `Metadata HTTP ${response.status}`);
    const detections = (meta.frames || []).flatMap(frame => frame.detections || []);
    // No dog lives here, so a 'dog' verdict is in practice the cat — the COCO
    // model reads the white cat's back-turned posture as dog and misses 'cat'.
    const cats = detections.filter(item => item.label === 'cat' || item.label === 'dog');
    const persons = detections.filter(item => item.label === 'person');
    const confidence = cats.reduce((best, item) => Math.max(best, Number(item.conf) || 0), 0);
    // Boxes ride along normalized [x, y, w, h] so the monitor can paint them over
    // the photo. Rounded to 3 decimals — the monitor parses this JSON by hand and
    // full doubles would only bloat what it has to scan.
    // Hailo runs the same still through several frames, so identical detections
    // repeat; dedupe or one cat shows up as four stacked boxes.
    const boxesOf = items => [...new Set(items.map(item => Array.isArray(item.bbox) && item.bbox.length === 4 ? JSON.stringify(item.bbox.map(value => Math.round(Number(value) * 1000) / 1000)) : null).filter(Boolean))].slice(0, 4).map(JSON.parse);
    state = { ...state, inferenceState: 'complete', catPresent: cats.length > 0, confidence: cats.length ? confidence : null, catBoxes: boxesOf(cats), personPresent: persons.length > 0, personBoxes: boxesOf(persons), processedAt: new Date().toISOString(), lastCatAt: cats.length ? new Date().toISOString() : state.lastCatAt, lastError: null };
  } catch (error) { state = { ...state, inferenceState: 'error', catPresent: false, confidence: null, catBoxes: [], personPresent: false, personBoxes: [], processedAt: new Date().toISOString(), lastError: error.message }; }
}
// MJPEG fan-out: one long-lived multipart response per viewer, each new live
// frame pushed the moment the sensor uploads it. A viewer whose socket has
// unsent bytes piled up simply skips frames — memory per viewer stays bounded
// by one frame instead of growing with a slow connection.
const LIVE_VIEWER_LIMIT = Number(process.env.WATCHCAT_LIVE_VIEWER_LIMIT || 6);
const liveViewers = new Set();
function writeFramePart(res, image) {
  if (res.writableLength > 200_000) return;
  res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${image.length}\r\n\r\n`);
  res.write(image);
  res.write('\r\n');
}
async function liveStream(req, res) {
  if (liveViewers.size >= LIVE_VIEWER_LIMIT) return json(res, 503, { ok: false, error: 'Too many live viewers' });
  res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store' });
  // Node holds headers back until the first body write; without a flush a viewer
  // that connects before any frame arrives would wait on headers forever.
  res.flushHeaders();
  liveViewers.add(res);
  req.on('close', () => liveViewers.delete(res));
  // Seed with the stored live frame so the viewer is not blank until the next tick.
  if (state.liveFilename) { try { writeFramePart(res, await fsp.readFile(path.join(UPLOAD_DIR, state.liveFilename))); } catch {} }
}
async function frame(req, res) {
  if (!authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized' });
  if (!String(req.headers['content-type'] || '').startsWith('image/jpeg')) return json(res, 415, { ok: false, error: 'Content-Type must be image/jpeg' });
  try {
    const image = await body(req); if (!image.length) return json(res, 400, { ok: false, error: 'Empty frame' });
    await fsp.mkdir(UPLOAD_DIR, { recursive: true });
    const streaming = req.headers['x-watchcat-stream'] === 'true';
    const id = streaming ? 'watchcat_live' : `watchcat_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`, filename = `${id}.jpg`, file = path.join(UPLOAD_DIR, filename);
    await fsp.writeFile(`${file}.part`, image); await fsp.rename(`${file}.part`, file);
    if (streaming) {
      state = { ...state, cameraOnline: true, liveFilename: filename, liveAt: req.headers['x-watchcat-captured-at'] || new Date().toISOString() };
      for (const viewer of liveViewers) writeFramePart(viewer, image);
      return json(res, 202, { ok: true, streaming: true });
    }
    if (captureCommand && req.headers['x-watchcat-command-id'] === captureCommand.id) captureCommand = null;
    queue({ id, filename, file, capturedAt: req.headers['x-watchcat-captured-at'] || new Date().toISOString(), width: Number(req.headers['x-watchcat-width']) || undefined, height: Number(req.headers['x-watchcat-height']) || undefined });
    return json(res, 202, { ok: true, requestId: id, inferenceState: 'waiting' });
  } catch (error) { return json(res, error.status || 500, { ok: false, error: error.message }); }
}
async function stream(req, res) {
  if (!authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized' });
  try {
    const payload = JSON.parse((await body(req)).toString() || '{}');
    if (typeof payload.active !== 'boolean') return json(res, 400, { ok: false, error: 'active must be boolean' });
    streamCommand = { id: crypto.randomUUID(), active: payload.active, deliveredAt: null, attempts: 0 };
    return json(res, 202, { ok: true, active: payload.active });
  } catch { return json(res, 400, { ok: false, error: 'Invalid JSON' }); }
}
async function capture(req, res) {
  if (!authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized' });
  if (!captureCommand) captureCommand = { id: crypto.randomUUID(), requestedAt: new Date().toISOString(), deliveredAt: null, attempts: 0 };
  return json(res, 202, { ok: true, accepted: true, requestId: captureCommand.id });
}
function nextCommand(req, res) {
  if (!authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized' });
  const now = Date.now();
  const due = command => command && (!command.deliveredAt || now - command.deliveredAt >= COMMAND_LEASE_MS);
  const abandon = label => { state = { ...state, lastError: `${label} command abandoned after ${COMMAND_MAX_ATTEMPTS} delivery attempts` }; };
  if (due(captureCommand)) {
    if (captureCommand.attempts >= COMMAND_MAX_ATTEMPTS) { abandon('Capture'); captureCommand = null; }
    else {
      captureCommand.attempts++; captureCommand.deliveredAt = now;
      return json(res, 200, { ok: true, command: 'capture', id: captureCommand.id, requestedAt: captureCommand.requestedAt });
    }
  }
  if (due(streamCommand)) {
    if (streamCommand.attempts >= COMMAND_MAX_ATTEMPTS) { abandon('Stream'); streamCommand = null; }
    else {
      streamCommand.attempts++; streamCommand.deliveredAt = now;
      return json(res, 200, { ok: true, command: streamCommand.active ? 'stream-start' : 'stream-stop', id: streamCommand.id });
    }
  }
  return json(res, 200, { ok: true, command: null });
}
async function acknowledgeCommand(req, res) {
  if (!authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized' });
  try {
    const payload = JSON.parse((await body(req)).toString() || '{}');
    if (payload.id !== streamCommand?.id) return json(res, 404, { ok: false, error: 'Unknown command' });
    streamActive = streamCommand.active;
    streamCommand = null;
    return json(res, 200, { ok: true, streamActive });
  } catch { return json(res, 400, { ok: false, error: 'Invalid JSON' }); }
}
async function serveJpeg(res, filename) {
  if (!filename) return json(res, 404, { ok: false, error: 'No frame available' });
  let handle;
  try { handle = await fsp.open(path.join(UPLOAD_DIR, filename), 'r'); }
  catch { return json(res, 404, { ok: false, error: 'Frame missing' }); }
  // Size the open descriptor, not the path. A live frame is replaced by rename on
  // every stream tick, so a path stat can describe a different file than we read.
  try {
    const { size } = await handle.stat();
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': size, 'Cache-Control': 'no-store' });
    const stream = handle.createReadStream({ autoClose: true });
    stream.on('error', () => res.destroy());
    return stream.pipe(res);
  } catch (error) { await handle.close(); return json(res, 500, { ok: false, error: error.message }); }
}
const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>watchcat camera</title><style>
body{margin:0;background:#0b0e13;color:#dde;font:15px system-ui}main{max-width:420px;margin:auto;padding:1rem}
h1{margin:.2rem 0 .8rem;letter-spacing:.06em;font-size:1.1rem;color:#9ab8dd}h1 a{color:#5a6a85;text-decoration:none;font-size:.75rem;float:right;margin-top:.2rem}
#tft{background:#000;border:3px solid #26314a;border-radius:26px;padding:16px 14px;aspect-ratio:240/300;max-width:340px;margin:auto;font-family:ui-monospace,SFMono-Regular,monospace;display:flex;flex-direction:column;overflow:hidden}
#ct{color:#e8d45e;font-size:.85rem;letter-spacing:.12em}#dv{border:0;border-top:2px solid #e8d45e;margin:.4rem 0 .8rem}
#body{flex:1;min-height:0;overflow:hidden}
#big{font-size:1.5rem;margin:1.2rem 0 .8rem;font-weight:700}#msg{color:#bcd;font-size:.8rem;line-height:1.5;word-break:break-all}
table{border-collapse:collapse;font-size:.78rem}td{padding:.18rem .6rem .18rem 0}td:first-child{color:#5ec8e8}
.ph{position:relative;margin-top:.2rem}.ph img{width:100%;display:block;border-radius:4px;background:#0d1118}.bx{position:absolute;border:2px solid #5ee87f}.bxp{position:absolute;border:2px dashed #5ec8e8}
#cap{color:#bcd;font-size:.72rem;margin-top:.4rem}
#nav{margin-top:auto;padding-top:.5rem;font-size:.8rem;color:#fff}#act{font-size:.8rem;color:#fff}
#pads{display:flex;justify-content:center;gap:1.6rem;margin:1.1rem 0}
#pads button{width:64px;height:64px;border-radius:50%;background:#1c2330;border:2px solid #334;color:#dde;font-size:1.1rem}
#pads button:active{background:#2c4a66}#pads span{display:block;text-align:center;color:#5a6a85;font-size:.7rem;margin-top:.3rem}
</style><main><h1>📷 WATCHCAT CAMERA <a href="https://watchcat.linkus-plz.com/">홈</a></h1>
<div id=tft><div id=ct>WATCHCAT</div><hr id=dv><div id=body></div><div id=nav></div><div id=act></div></div>
<div id=pads><div><button id=b1>&#9664;</button><span>B1</span></div><div><button id=b2>&#9679;</button><span>B2</span></div><div><button id=b3>&#9654;</button><span>B3</span></div></div>
</main><script>
const $=id=>document.getElementById(id);
const pages=['STATUS','PHOTO','LIVE','DETAIL'];
const S={q:null,page:0,livePaused:false,token:localStorage.getItem('wcToken')||''};
async function api(path,opts,retried){opts=opts||{};opts.headers=Object.assign({},opts.headers||{},S.token?{Authorization:'Bearer '+S.token}:{});const r=await fetch(path,opts);if(r.status===401&&!retried){const t=prompt('게이트웨이 토큰을 입력하세요 (한 번만)');if(t){S.token=t.trim();localStorage.setItem('wcToken',S.token);return api(path,opts,true)}}return r}
function verdict(q){if(!q)return['대기','#e8d45e','게이트웨이 연결 중'];
 const pend=q.capturePending||q.inferenceState==='waiting'||q.inferenceState==='running';
 if(pend)return['기다리는 중','#e8d45e','Waiting for the sensor'];
 if(q.catPresent)return['CAT FOUND','#5ee87f','confidence '+String(q.confidence||'').slice(0,5)];
 if(q.inferenceState==='error')return['ERROR','#f66',q.lastError||''];
 if(q.cameraOnline)return['NO CAT','#fff',q.confidence?'confidence '+String(q.confidence).slice(0,5):'Pi status received'];
 return['CAMERA OFFLINE','#f66',q.lastError||'Gateway unavailable']}
function actionOf(){return['CAPTURE','RELOAD',S.livePaused?'RESUME':'PAUSE','REFRESH'][S.page]}
function chrome(){$('nav').textContent='< '+pages[S.page]+' >';$('act').textContent='B2: '+actionOf()}
function renderStatus(){const[t,c,m]=verdict(S.q);$('body').innerHTML='<div id=big></div><div id=msg></div>';$('big').textContent=t;$('big').style.color=c;$('dv').style.borderColor=c;$('msg').textContent=m;chrome()}
function renderPhoto(){const q=S.q||{};let bx='';(q.catBoxes||[]).forEach(b=>{bx+='<div class=bx style="left:'+(b[0]*100)+'%;top:'+(b[1]*100)+'%;width:'+(b[2]*100)+'%;height:'+(b[3]*100)+'%"></div>'});
 (q.personBoxes||[]).forEach(b=>{bx+='<div class=bxp style="left:'+(b[0]*100)+'%;top:'+(b[1]*100)+'%;width:'+(b[2]*100)+'%;height:'+(b[3]*100)+'%"></div>'});
 $('body').innerHTML='<div class=ph><img src="/api/v1/latest.jpg?t='+Date.now()+'">'+bx+'</div><div id=cap>'+verdict(q)[0]+(q.processedAt?' · '+new Date(q.processedAt).toLocaleTimeString():'')+'</div>';$('dv').style.borderColor='#e8d45e';chrome()}
function renderLive(){const src=S.livePaused?'/api/v1/live.jpg?t='+Date.now():'/api/v1/live.mjpeg';$('body').innerHTML='<div class=ph><img id=lv src="'+src+'"></div><div id=cap>'+(S.livePaused?'일시정지':'live (mjpeg)')+'</div>';$('dv').style.borderColor='#e8d45e';chrome()}
function renderDetail(){const q=S.q||{};const rows=[['CONF',String(q.confidence||'-').slice(0,5)],['STATE',q.inferenceState||'-'],['CAT',q.catPresent?'yes':'no'],['PERSON',q.personPresent?'yes':'no'],['SHOT',q.capturedAt||'-'],['DONE',q.processedAt?String(q.processedAt).slice(11,19):'-'],['FILE',q.latestFilename||'-'],['ERR',q.lastError||'-']];
 $('body').innerHTML='<table>'+rows.map(r=>'<tr><td>'+r[0]+'</td><td>'+String(r[1]).replace(/</g,'&lt;')+'</td></tr>').join('')+'</table>';$('dv').style.borderColor='#5ec8e8';chrome()}
function render(){[renderStatus,renderPhoto,renderLive,renderDetail][S.page]()}
async function setStream(active){try{await api('/api/v1/stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({active:active})})}catch(e){}}
function movePage(d){const from=S.page;S.page=(S.page+d+4)%4;if(from===2&&S.page!==2)setStream(false);if(S.page===2){S.livePaused=false;setStream(true)}render()}
async function select(){if(S.page===0){$('body').firstChild&&($('msg').textContent='Requesting...');const r=await api('/api/v1/capture',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!r.ok)$('msg').textContent='요청 실패 HTTP '+r.status;else{poll()}}
 else if(S.page===1)renderPhoto();
 else if(S.page===2){S.livePaused=!S.livePaused;render()}
 else{await poll()}}
$('b1').onclick=()=>movePage(-1);$('b3').onclick=()=>movePage(1);$('b2').onclick=select;
async function poll(){try{S.q=await fetch('/api/v1/status').then(r=>r.json())}catch(e){S.q=null}
 if(S.page===0||S.page===3)render()}
setInterval(poll,2000);poll().then(render);
</script>`;
const radar = require('./radar')({ authorized });
// The hub at watchcat.* fronts both projects: one glance-summary card each,
// clicking through to the 1-depth pages /camera and /radar.
const hubPage = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>watchcat</title><style>body{margin:0;background:#0b0e13;color:#dde;font:15px system-ui}main{max-width:720px;margin:auto;padding:1.2rem}h1{margin:.2rem 0 .1rem;letter-spacing:.06em}#tg{color:#8ab;margin:0 0 1rem}a.card{display:block;background:#141a26;border:1px solid #26314a;border-radius:14px;padding:1rem 1.1rem;margin-bottom:1rem;text-decoration:none;color:#dde}a.card:active{background:#1a2233}h2{margin:0 0 .4rem;font-size:1.05rem;color:#9ab8dd}strong{font-size:1.5rem}p{margin:.3rem 0 0;color:#9ab}img{width:100%;margin-top:.7rem;border-radius:10px;background:#0d1118}.on{color:#5ee87f}.warn{color:#e8b45e}.off{color:#f66}#go{color:#5a6a85;font-size:.85rem;float:right;margin-top:.2rem}</style><main><h1>WATCHCAT</h1><p id=tg>오월이 관측 시스템</p><a class=card href="/camera"><span id=go>카메라 →</span><h2>📷 카메라 · Hailo 판정</h2><strong id=cs>…</strong><p id=cd></p></a><a class=card href="/radar"><span id=go2 style="color:#5a6a85;font-size:.85rem;float:right;margin-top:.2rem">레이더 →</span><h2>📡 레이더 · 위치 추적</h2><strong id=rs>…</strong><p id=rd3></p></a></main><script>
const cs=document.getElementById('cs'),cd=document.getElementById('cd'),rs=document.getElementById('rs'),rd3=document.getElementById('rd3');
let timer=0;
async function tick(){clearTimeout(timer);
 try{const s=await fetch('/api/v1/status').then(v=>v.json());
  const pend=s.capturePending||s.inferenceState==='waiting'||s.inferenceState==='running';
  cs.textContent=pend?'판정 중…':s.catPresent?'CAT FOUND':s.inferenceState==='error'?'ERROR':s.cameraOnline?'NO CAT':'대기';
  cs.className=s.catPresent?'on':'';
  cd.textContent=s.lastCatAt?'마지막 발견 '+new Date(s.lastCatAt).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit'}):'발견 기록 없음';
 }catch(e){cs.textContent='게이트웨이 오류';cs.className='off'}
 try{const q=await fetch('/api/v1/radar/status').then(v=>v.json());
  const t=q.targets&&q.targets[0];
  rs.textContent=q.sensorOnline?(q.radarOk?(q.targets.length?'움직임 '+q.targets.length+'건':'움직임 없음'):'레이더 무신호'):'오프라인';
  rs.className=q.sensorOnline?(q.radarOk?'on':'warn'):'off';
  rd3.textContent=t?('전방 '+(t.yMm/1000).toFixed(2)+'m · 좌우 '+(t.xMm/1000).toFixed(2)+'m · '+Math.round(t.speedMmPerSec/10)+'cm/s'):(q.lastObservedAt?'마지막 신호 '+new Date(q.lastObservedAt).toLocaleTimeString():'신호 기록 없음');
 }catch(e){rs.textContent='게이트웨이 오류';rs.className='off'}
 timer=setTimeout(tick,2000)}
tick();
</script>`;
// A restart used to blank the photo on every page until the next capture: the
// latest filename lived only in memory while the stills sit on disk. Restore
// the newest still at startup — its verdict is unknown, so only the filename
// comes back, never a stale catPresent.
async function seedLatestPhoto() {
  try {
    const files = (await fsp.readdir(UPLOAD_DIR)).filter(f => f.startsWith('watchcat_') && f.endsWith('.jpg') && f !== 'watchcat_live.jpg');
    let best = null, bestMtime = 0;
    for (const f of files) {
      const { mtimeMs } = await fsp.stat(path.join(UPLOAD_DIR, f));
      if (mtimeMs > bestMtime) { bestMtime = mtimeMs; best = f; }
    }
    if (best) state = { ...state, latestFilename: best };
  } catch {}
}
seedLatestPhoto();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/v1/radar/')) return radar.handle(req, res, url);
  // The radar map lives at its own hostname (radar.*) and at /radar on any host.
  if (req.method === 'GET' && (url.pathname === '/radar' || (url.pathname === '/' && String(req.headers.host || '').startsWith('radar.')))) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(radar.page);
  }
  // Host-based fronts: watchcat.* gets the hub; radar.* keeps its map at /;
  // every other host (watchcat-api, the monitor's base URL) keeps the camera
  // page at / so nothing that already points there changes behaviour.
  const host = String(req.headers.host || '');
  if (req.method === 'GET' && url.pathname === '/' && host.startsWith('watchcat.')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(hubPage); }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/camera')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page); }
  if (req.method === 'GET' && url.pathname === '/api/v1/status') return json(res, 200, { ok: true, ...state, capturePending: Boolean(captureCommand), streamPending: Boolean(streamCommand), streamActive });
  if (req.method === 'GET' && url.pathname === '/api/v1/latest.jpg') return serveJpeg(res, state.latestFilename);
  if (req.method === 'GET' && url.pathname === '/api/v1/live.jpg') return serveJpeg(res, state.liveFilename);
  if (req.method === 'GET' && url.pathname === '/api/v1/live.mjpeg') return liveStream(req, res);
  if (req.method === 'POST' && url.pathname === '/api/v1/frames') return frame(req, res);
  if (req.method === 'POST' && url.pathname === '/api/v1/capture') return capture(req, res);
  if (req.method === 'POST' && url.pathname === '/api/v1/stream') return stream(req, res);
  if (req.method === 'GET' && url.pathname === '/api/v1/commands/next') return nextCommand(req, res);
  if (req.method === 'POST' && url.pathname === '/api/v1/commands/ack') return acknowledgeCommand(req, res);
  return json(res, 404, { ok: false, error: 'Not found' });
});
server.listen(PORT, () => console.log(`watchcat gateway listening on :${PORT}`));
module.exports = { authorized };
