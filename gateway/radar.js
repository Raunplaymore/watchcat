// Radar observations live in their own module so the image pipeline's state and
// the radar's never share globals (docs/ld2454-cat-tracker-design.md §2). The
// gateway is the radar's clock: the node reports uptime sequence numbers, not
// wall time, so receivedAt here is the authoritative observation time.
const WINDOW_MS = Number(process.env.WATCHCAT_RADAR_WINDOW_MS || 30_000);
const ONLINE_MS = Number(process.env.WATCHCAT_RADAR_ONLINE_MS || 3_000);
// One batch is a handful of targets; anything bigger than this is not a radar node.
const MAX_BODY_BYTES = 4096;
const MAX_TARGETS = 3;
// Hard cap behind the time window so a fast sender cannot grow the buffer unbounded.
const MAX_OBSERVATIONS = 1200;
const SENSORS = (process.env.WATCHCAT_RADAR_SENSORS || '').split(',').map(id => id.trim()).filter(Boolean);

module.exports = function createRadar({ authorized }) {
  let observations = [];

  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

  async function readBody(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Body exceeds size limit'), { status: 413 }); chunks.push(chunk); }
    return Buffer.concat(chunks).toString();
  }

  const finiteIn = (value, low, high) => Number.isFinite(value) && value >= low && value <= high;
  // Bounds come from the sensor's physics: 8 m spec plus slack. A value outside
  // them is a parser or wiring fault on the node, and storing it would poison
  // the map, so the whole batch is rejected for the node's log to surface.
  function normalizeTargets(raw) {
    if (!Array.isArray(raw) || raw.length > MAX_TARGETS) return null;
    const targets = [];
    for (const target of raw) {
      const x = Number(target?.xMm), y = Number(target?.yMm), speed = Number(target?.speedMmPerSec);
      if (!finiteIn(x, -10000, 10000) || !finiteIn(y, 0, 10000) || !finiteIn(speed, -20000, 20000)) return null;
      targets.push({ xMm: Math.round(x), yMm: Math.round(y), speedMmPerSec: Math.round(speed) });
    }
    return targets;
  }

  function prune(now) {
    while (observations.length && (now - observations[0].receivedAt > WINDOW_MS || observations.length > MAX_OBSERVATIONS)) observations.shift();
  }

  async function acceptObservations(req, res) {
    if (!authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized' });
    let payload;
    try { payload = JSON.parse(await readBody(req) || '{}'); }
    catch (error) { return json(res, error.status || 400, { ok: false, error: error.status ? error.message : 'Invalid JSON' }); }
    const sensorId = typeof payload.sensorId === 'string' ? payload.sensorId.slice(0, 64) : '';
    if (!sensorId) return json(res, 400, { ok: false, error: 'sensorId is required' });
    if (SENSORS.length && !SENSORS.includes(sensorId)) return json(res, 403, { ok: false, error: 'Unknown sensor' });
    const targets = normalizeTargets(payload.targets ?? []);
    if (!targets) return json(res, 400, { ok: false, error: 'Invalid targets' });
    const sequence = Number.isFinite(Number(payload.sequence)) ? Number(payload.sequence) : null;
    const now = Date.now();
    observations.push({ receivedAt: now, sensorId, sequence, targets });
    prune(now);
    return json(res, 202, { ok: true, accepted: true });
  }

  function reportStatus(req, res) {
    const now = Date.now();
    prune(now);
    const latest = observations[observations.length - 1];
    return json(res, 200, {
      ok: true,
      sensorOnline: Boolean(latest && now - latest.receivedAt <= ONLINE_MS),
      sensorId: latest ? latest.sensorId : null,
      lastObservedAt: latest ? new Date(latest.receivedAt).toISOString() : null,
      lastSequence: latest ? latest.sequence : null,
      targets: latest ? latest.targets : [],
      observationsInWindow: observations.length,
    });
  }

  // Sector view: the sensor sits at the wedge's apex, +Y points away from it,
  // ±60° matches the LD2454's azimuth. Trails live client-side (10 s fade) since
  // the status endpoint only serves the latest batch.
  const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>watchcat radar</title><style>body{margin:0;background:#0b0e13;color:#dde;font:14px system-ui}main{max-width:640px;margin:auto;padding:1rem}h2{margin:.2rem 0 .6rem}canvas{width:100%;background:#10141c;border-radius:12px;margin-top:.6rem}#s{color:#8ab;margin:.2rem 0}.on{color:#5ee87f}.off{color:#f66}button{background:#1c2330;color:#dde;border:1px solid #334;border-radius:8px;padding:.3rem .9rem;margin-right:.4rem}button.sel{background:#2c4a66}</style><main><h2>WATCHCAT RADAR</h2><p id=s>연결 중…</p><div id=z><button data-r=2000>2m</button><button data-r=4000 class=sel>4m</button><button data-r=8000>8m</button></div><canvas id=c width=640 height=560></canvas></main><script>
const cv=document.getElementById('c'),g=cv.getContext('2d'),st=document.getElementById('s');
let maxR=4000;const trails=[];const colors=['#5ee87f','#5ec8e8','#e8d45e'];
document.querySelectorAll('#z button').forEach(b=>b.onclick=()=>{maxR=Number(b.dataset.r);document.querySelectorAll('#z button').forEach(x=>x.classList.toggle('sel',x===b))});
// Size proxy: the radar reports a point, but a bigger body wanders more around
// its own path (the reflection centre migrates over the torso). Track each
// target across polls by nearest-neighbour and measure RMS deviation from the
// straight line through its 3-second window — drawn as a bubble.
const blobs=[];
function updateBlobs(targets,now){
 for(const b of blobs)b.matched=false;
 for(const t of targets){let best=null,bd=600;
  for(const b of blobs){if(b.matched)continue;const d=Math.hypot(t.xMm-b.x,t.yMm-b.y);if(d<bd){bd=d;best=b}}
  if(best){best.matched=true;best.x=t.xMm;best.y=t.yMm;best.speed=t.speedMmPerSec;best.hist.push({x:t.xMm,y:t.yMm,t:now})}
  else blobs.push({x:t.xMm,y:t.yMm,speed:t.speedMmPerSec,matched:true,hist:[{x:t.xMm,y:t.yMm,t:now}]})}
 for(let i=blobs.length-1;i>=0;i--){const b=blobs[i];b.hist=b.hist.filter(h=>now-h.t<3000);
  if(!b.matched&&(!b.hist.length||now-b.hist[b.hist.length-1].t>1500))blobs.splice(i,1)}
}
function spreadOf(hist){
 if(hist.length<3)return 0;
 const a=hist[0],z=hist[hist.length-1],dx=z.x-a.x,dy=z.y-a.y,len2=dx*dx+dy*dy||1;
 let s=0;
 for(const h of hist){const t=((h.x-a.x)*dx+(h.y-a.y)*dy)/len2,px=a.x+t*dx,py=a.y+t*dy;s+=(h.x-px)*(h.x-px)+(h.y-py)*(h.y-py)}
 return Math.sqrt(s/hist.length);
}
function draw(targets,online){
 const W=cv.width,H=cv.height,cx=W/2,cy=H-36,sc=(H-84)/maxR,a0=-Math.PI/2-Math.PI/3,a1=-Math.PI/2+Math.PI/3;
 g.clearRect(0,0,W,H);
 g.fillStyle='#141a26';g.strokeStyle='#2a3550';g.beginPath();g.moveTo(cx,cy);g.arc(cx,cy,maxR*sc,a0,a1);g.closePath();g.fill();g.stroke();
 g.font='12px system-ui';g.textAlign='left';
 for(let r=1000;r<=maxR;r+=1000){g.strokeStyle='#233049';g.beginPath();g.arc(cx,cy,r*sc,a0,a1);g.stroke();g.fillStyle='#5a6a85';g.fillText((r/1000)+'m',cx+6,cy-r*sc+14)}
 g.strokeStyle='#233049';g.beginPath();g.moveTo(cx,cy);g.lineTo(cx,cy-maxR*sc);g.stroke();
 const now=Date.now();
 for(const p of trails){const age=(now-p.t)/10000;if(age>1)continue;g.fillStyle='rgba(94,232,127,'+(0.45*(1-age)).toFixed(3)+')';g.beginPath();g.arc(cx+p.x*sc,cy-p.y*sc,3,0,7);g.fill()}
 // Bubble is drawn at 3x the measured spread: real spreads run only a few cm
 // (the radar's internal tracker smooths most wander), too small to see at map
 // scale. The ±cm label stays the true value.
 blobs.forEach((b,i)=>{const px=cx+b.x*sc,py=cy-b.y*sc,sp=spreadOf(b.hist),rr=Math.max(sp*3*sc,10);
  g.fillStyle='rgba(94,232,127,0.14)';g.strokeStyle='rgba(94,232,127,0.4)';g.beginPath();g.arc(px,py,rr,0,7);g.fill();g.stroke();
  g.fillStyle=colors[i%3];g.beginPath();g.arc(px,py,7,0,7);g.fill();
  g.fillStyle='#dde';g.fillText((b.y/1000).toFixed(2)+'m · '+Math.round(b.speed/10)+'cm/s'+(sp?' · ±'+Math.round(sp/10)+'cm':''),px+10,py-8)});
 g.fillStyle=online?'#5ee87f':'#e85e5e';g.beginPath();g.arc(cx,cy,6,0,7);g.fill();
}
let timer=0;
async function tick(){clearTimeout(timer);let q=null;
 try{q=await fetch('/api/v1/radar/status').then(r=>r.json())}catch(e){}
 const targets=q&&q.sensorOnline?q.targets:[];
 const now=Date.now();
 for(const t of targets)trails.push({x:t.xMm,y:t.yMm,t:now});
 while(trails.length&&now-trails[0].t>10000)trails.shift();
 updateBlobs(targets,now);
 st.innerHTML=q?((q.sensorOnline?'<span class=on>레이더 온라인</span>':'<span class=off>레이더 오프라인</span>')+' · 타겟 '+((q.targets||[]).length)+' · '+(q.lastObservedAt?new Date(q.lastObservedAt).toLocaleTimeString():'-')):'게이트웨이 연결 실패';
 draw(targets,Boolean(q&&q.sensorOnline));
 timer=setTimeout(tick,500)}
tick();
</script>`;

  return {
    page,
    handle(req, res, url) {
      if (req.method === 'POST' && url.pathname === '/api/v1/radar/observations') return acceptObservations(req, res);
      if (req.method === 'GET' && url.pathname === '/api/v1/radar/status') return reportStatus(req, res);
      return json(res, 404, { ok: false, error: 'Not found' });
    },
  };
};
