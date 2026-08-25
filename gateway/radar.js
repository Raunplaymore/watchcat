// Radar observations live in their own module so the image pipeline's state and
// the radar's never share globals (docs/ld2454-cat-tracker-design.md §2). The
// gateway is the radar's clock: the node reports uptime sequence numbers, not
// wall time, so receivedAt here is the authoritative observation time.
const fsp = require('fs').promises;
const path = require('path');

const WINDOW_MS = Number(process.env.WATCHCAT_RADAR_WINDOW_MS || 30_000);
const ONLINE_MS = Number(process.env.WATCHCAT_RADAR_ONLINE_MS || 3_000);
// Movement events: the 30 s ring answers "what is moving now"; these answer
// "what moved while nobody watched". A point is recorded only after real travel
// (EVENT_STEP_MM), so the jitter of a parked reflector — the radar holds a
// sitting person for minutes — never stretches an episode for hours: a target
// that stops moving (idle) or vanishes (lost) closes its episode.
const EVENT_STEP_MM = Number(process.env.WATCHCAT_RADAR_EVENT_STEP_MM || 250);
const EVENT_IDLE_MS = Number(process.env.WATCHCAT_RADAR_EVENT_IDLE_MS || 8_000);
const EVENT_LOST_MS = Number(process.env.WATCHCAT_RADAR_EVENT_LOST_MS || 3_000);
const EVENT_MIN_PATH_MM = Number(process.env.WATCHCAT_RADAR_EVENT_MIN_PATH_MM || 600);
const EVENT_MAX_POINTS = 120;
const EVENT_MEMORY = 200;
const EVENT_RETENTION_DAYS = Math.max(1, Number(process.env.WATCHCAT_RADAR_EVENT_RETENTION_DAYS || 7));
// One batch is a handful of targets; anything bigger than this is not a radar node.
const MAX_BODY_BYTES = 4096;
const MAX_TARGETS = 3;
// Hard cap behind the time window so a fast sender cannot grow the buffer unbounded.
const MAX_OBSERVATIONS = 1200;
const SENSORS = (process.env.WATCHCAT_RADAR_SENSORS || '').split(',').map(id => id.trim()).filter(Boolean);

module.exports = function createRadar({ authorized, eventDir }) {
  eventDir = eventDir || path.join(process.cwd(), 'radar-events');
  let observations = [];
  let events = [];  // closed movement episodes, oldest first, capped at EVENT_MEMORY
  let tracks = [];  // open nearest-neighbour tracks feeding events
  let cleanupStamp = '';

  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

  const eventFile = ts => path.join(eventDir, 'events-' + new Date(ts).toISOString().slice(0, 10) + '.jsonl');

  // Restart survival: reload the freshest day files into memory. Two days always
  // cover EVENT_MEMORY at realistic event rates.
  (async () => {
    try {
      await fsp.mkdir(eventDir, { recursive: true });
      await cleanupEvents();
      const names = (await fsp.readdir(eventDir)).filter(name => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().slice(-2);
      const loaded = [];
      for (const name of names) for (const line of (await fsp.readFile(path.join(eventDir, name), 'utf8')).split('\n')) {
        if (!line) continue;
        try { loaded.push(JSON.parse(line)); } catch {}
      }
      events = loaded.concat(events).slice(-EVENT_MEMORY);
    } catch (error) { console.error('radar event reload failed:', error.message); }
  })();

  // Files are named by day, so one is deletable only when its whole day sits
  // past the retention cutoff.
  async function cleanupEvents() {
    const cutoff = Date.now() - EVENT_RETENTION_DAYS * 86_400_000;
    for (const name of await fsp.readdir(eventDir).catch(() => [])) {
      const day = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (day && Date.parse(day[1]) + 86_400_000 < cutoff) await fsp.unlink(path.join(eventDir, name)).catch(() => {});
    }
  }

  async function appendEvent(event) {
    try {
      await fsp.mkdir(eventDir, { recursive: true });
      await fsp.appendFile(eventFile(Date.now()), JSON.stringify(event) + '\n');
      const stamp = new Date().toISOString().slice(0, 10);
      if (stamp !== cleanupStamp) { cleanupStamp = stamp; await cleanupEvents(); }
    } catch (error) { console.error('radar event write failed:', error.message); }
  }

  // Server-side twin of the map page's nearest-neighbour blobs, cut into
  // movement episodes for the history feed.
  function updateTracks(targets, now) {
    for (const track of tracks) track.matched = false;
    for (const target of targets) {
      let best = null, bestDistance = 600;
      for (const track of tracks) {
        if (track.matched) continue;
        const distance = Math.hypot(target.xMm - track.x, target.yMm - track.y);
        if (distance < bestDistance) { bestDistance = distance; best = track; }
      }
      if (!best) {
        tracks.push({ x: target.xMm, y: target.yMm, matched: true, startAt: now, lastSeen: now, lastMoveAt: now, pathMm: 0, maxSpeed: Math.abs(target.speedMmPerSec), points: [[0, target.xMm, target.yMm]] });
        continue;
      }
      best.matched = true;
      best.lastSeen = now;
      best.maxSpeed = Math.max(best.maxSpeed, Math.abs(target.speedMmPerSec));
      const tail = best.points[best.points.length - 1];
      const step = Math.hypot(target.xMm - tail[1], target.yMm - tail[2]);
      if (step >= EVENT_STEP_MM && best.points.length < EVENT_MAX_POINTS) {
        best.points.push([now - best.startAt, target.xMm, target.yMm]);
        best.pathMm += step;
        best.lastMoveAt = now;
      }
      best.x = target.xMm;
      best.y = target.yMm;
    }
    for (let i = tracks.length - 1; i >= 0; i--) {
      const track = tracks[i];
      if (now - track.lastSeen > EVENT_LOST_MS || now - track.lastMoveAt > EVENT_IDLE_MS) { tracks.splice(i, 1); closeTrack(track); }
    }
  }

  function closeTrack(track) {
    if (track.pathMm < EVENT_MIN_PATH_MM || track.points.length < 3) return;
    const event = {
      startAt: new Date(track.startAt).toISOString(),
      endAt: new Date(track.lastMoveAt).toISOString(),
      durationMs: track.lastMoveAt - track.startAt,
      pathMm: Math.round(track.pathMm),
      maxSpeedMmPerSec: track.maxSpeed,
      points: track.points,
    };
    events.push(event);
    if (events.length > EVENT_MEMORY) events.shift();
    appendEvent(event);
  }

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
    // radarOk:false marks a node heartbeat sent while the radar itself is silent,
    // so the map can tell "node dead" from "radar unplugged". Absent means true.
    const radarOk = payload.radarOk !== false;
    const now = Date.now();
    observations.push({ receivedAt: now, sensorId, sequence, targets, radarOk });
    prune(now);
    updateTracks(targets, now);
    return json(res, 202, { ok: true, accepted: true });
  }

  function reportStatus(req, res) {
    const now = Date.now();
    prune(now);
    // A dead node stops delivering batches, so the close sweep would never run;
    // the page's status polling doubles as its clock.
    updateTracks([], now);
    const latest = observations[observations.length - 1];
    return json(res, 200, {
      ok: true,
      sensorOnline: Boolean(latest && now - latest.receivedAt <= ONLINE_MS),
      radarOk: Boolean(latest && latest.radarOk !== false),
      sensorId: latest ? latest.sensorId : null,
      lastObservedAt: latest ? new Date(latest.receivedAt).toISOString() : null,
      lastSequence: latest ? latest.sequence : null,
      targets: latest ? latest.targets : [],
      observationsInWindow: observations.length,
      eventsToday: countEventsToday(now),
    });
  }

  function countEventsToday(now) {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    return events.filter(event => Date.parse(event.startAt) >= dayStart.getTime()).length;
  }

  async function reportEvents(req, res, url) {
    const from = Date.parse(url.searchParams.get('from') || '');
    const to = Date.parse(url.searchParams.get('to') || '');
    if (!Number.isFinite(from) && !Number.isFinite(to)) {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), EVENT_MEMORY);
      return json(res, 200, { ok: true, retentionDays: EVENT_RETENTION_DAYS, events: events.slice(-limit).reverse() });
    }
    // Ranged queries read the day files directly, so they reach past the
    // in-memory cap to everything retention still holds. Files are named by
    // UTC day while the range is wall-clock, so scan one file each side.
    const lo = Number.isFinite(from) ? from : 0;
    const hi = Number.isFinite(to) ? to : Date.now();
    if (hi < lo) return json(res, 400, { ok: false, error: 'to precedes from' });
    const matched = [];
    try {
      for (let day = lo - 86_400_000; day <= hi + 86_400_000; day += 86_400_000) {
        const text = await fsp.readFile(eventFile(day), 'utf8').catch(() => '');
        for (const line of text.split('\n')) {
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            const at = Date.parse(event.startAt);
            if (at >= lo && at <= hi) matched.push(event);
          } catch {}
        }
      }
    } catch (error) { return json(res, 500, { ok: false, error: error.message }); }
    return json(res, 200, { ok: true, retentionDays: EVENT_RETENTION_DAYS, ranged: true, events: matched.slice(-500).reverse() });
  }

  // Per-hour counts for one day, bucketed from the client-supplied day start so
  // the server never guesses the viewer's timezone. Feeds the hour chips.
  async function reportEventHours(req, res, url) {
    const from = Date.parse(url.searchParams.get('from') || '');
    if (!Number.isFinite(from)) return json(res, 400, { ok: false, error: 'from is required' });
    const hi = from + 86_400_000;
    const hours = new Array(24).fill(0);
    for (let day = from - 86_400_000; day <= hi + 86_400_000; day += 86_400_000) {
      const text = await fsp.readFile(eventFile(day), 'utf8').catch(() => '');
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const at = Date.parse(JSON.parse(line).startAt);
          if (at >= from && at < hi) hours[Math.floor((at - from) / 3_600_000)]++;
        } catch {}
      }
    }
    return json(res, 200, { ok: true, hours });
  }

  // Sector view: the sensor sits at the wedge's apex, +Y points away from it,
  // ±60° matches the LD2454's azimuth. Trails live client-side (10 s fade) since
  // the status endpoint only serves the latest batch.
  const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>watchcat radar</title><style>body{margin:0;background:#0b0e13;color:#dde;font:14px system-ui}main{max-width:640px;margin:auto;padding:1rem}h2{margin:.2rem 0 .6rem}h2 a{color:#5a6a85;text-decoration:none;font-size:.72rem;float:right;margin-top:.35rem}canvas{width:100%;background:#10141c;border-radius:12px;margin-top:.6rem}#s{color:#8ab;margin:.2rem 0}.on{color:#5ee87f}.off{color:#f66}.warn{color:#e8b45e}button{background:#1c2330;color:#dde;border:1px solid #334;border-radius:8px;padding:.3rem .9rem;margin-right:.4rem}button.sel{background:#2c4a66}
h3{margin:1.1rem 0 .3rem;font-size:.95rem;color:#9ab8dd}h3 span{color:#5a6a85;font-weight:400;font-size:.75rem}
.row{display:flex;gap:.7rem;align-items:center;padding:.35rem .2rem;border-bottom:1px solid #1a2233;cursor:pointer;font-size:.82rem;color:#bcd}.row:active{background:#141a26}
#fl{display:flex;gap:.35rem;align-items:center;flex-wrap:wrap;margin:.2rem 0 .4rem}#fl input{background:#1c2330;color:#dde;border:1px solid #334;border-radius:8px;padding:.25rem .4rem;font:inherit;color-scheme:dark}
#fh{display:flex;flex-wrap:wrap;gap:.15rem;align-items:center}
.hc{background:#1c2330;border:1px solid #334;color:#dde;border-radius:6px;padding:.2rem .35rem;margin:0;font-size:.72rem}.hc span{color:#5ee87f;margin-left:.15rem}.hc.sel{background:#2c4a66}
.hd{color:#31405c;padding:.2rem .15rem;font-size:.72rem}</style><main><h2>📡 WATCHCAT RADAR <a href="https://watchcat.linkus-plz.com/">홈</a></h2><p id=s>연결 중…</p><div id=z><button data-r=2000>2m</button><button data-r=4000 class=sel>4m</button><button data-r=8000>8m</button></div><canvas id=c width=640 height=560></canvas><h3>최근 움직임 <span id=evn></span></h3><div id=fl><input type=date id=fd><div id=fh></div></div><div id=ev></div></main><script>
const cv=document.getElementById('c'),g=cv.getContext('2d'),st=document.getElementById('s');
let maxR=4000;const trails=[];const colors=['#5ee87f','#5ec8e8','#e8d45e'];
let ghost=null,evData=[],retDays=7;
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
 if(ghost){if(now>ghost.until)ghost=null;else{g.strokeStyle='#e8d45e';g.lineWidth=2;g.beginPath();ghost.points.forEach((p,i)=>{i?g.lineTo(cx+p[1]*sc,cy-p[2]*sc):g.moveTo(cx+p[1]*sc,cy-p[2]*sc)});g.stroke();g.lineWidth=1;const gz=ghost.points[ghost.points.length-1];g.fillStyle='#e8d45e';g.beginPath();g.arc(cx+gz[1]*sc,cy-gz[2]*sc,5,0,7);g.fill()}}
 blobs.forEach((b,i)=>{const px=cx+b.x*sc,py=cy-b.y*sc,sp=spreadOf(b.hist),rr=Math.max(sp*sc,10);
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
 st.innerHTML=q?((q.sensorOnline?(q.radarOk?'<span class=on>레이더 온라인</span>':'<span class=warn>노드 온라인 · 레이더 무신호</span>'):'<span class=off>레이더 오프라인</span>')+' · 타겟 '+((q.targets||[]).length)+' · '+(q.lastObservedAt?new Date(q.lastObservedAt).toLocaleTimeString():'-')):'게이트웨이 연결 실패';
 draw(targets,Boolean(q&&q.sensorOnline));
 timer=setTimeout(tick,500)}
// Movement history: each row is one recorded episode; the thumbnail keeps the
// sector shape so a path reads in the same frame as the live map, and tapping a
// row replays the path on the map as a 6-second ghost.
const ev=document.getElementById('ev');
function thumb(e){const W=84,H=60,tx=W/2,ty=H-5;let reach=4000;for(const p of e.points)if(p[2]>reach)reach=p[2];const ts=(H-10)/reach;
 let pts='';for(const p of e.points)pts+=(tx+p[1]*ts).toFixed(1)+','+(ty-p[2]*ts).toFixed(1)+' ';
 const r=(reach*ts).toFixed(1),x0=(tx+reach*ts*Math.cos(-Math.PI/2-Math.PI/3)).toFixed(1),y0=(ty+reach*ts*Math.sin(-Math.PI/2-Math.PI/3)).toFixed(1),x1=(tx+reach*ts*Math.cos(-Math.PI/2+Math.PI/3)).toFixed(1),y1=(ty+reach*ts*Math.sin(-Math.PI/2+Math.PI/3)).toFixed(1);
 const z=e.points[e.points.length-1];
 return '<svg width='+W+' height='+H+'><path d="M'+tx+' '+ty+' L'+x0+' '+y0+' A'+r+' '+r+' 0 0 1 '+x1+' '+y1+' Z" fill="#141a26" stroke="#2a3550"/><polyline points="'+pts+'" fill="none" stroke="#e8d45e" stroke-width="1.5"/><circle cx="'+(tx+z[1]*ts).toFixed(1)+'" cy="'+(ty-z[2]*ts).toFixed(1)+'" r="2.5" fill="#e8d45e"/></svg>'}
function evLine(e){const dur=Math.max(1,Math.round(e.durationMs/1000));return new Date(e.startAt).toLocaleTimeString()+' · '+dur+'초 · '+(e.pathMm/1000).toFixed(1)+'m 이동 · 최고 '+Math.round(e.maxSpeedMmPerSec/10)+'cm/s'}
function renderEvents(){document.getElementById('evn').textContent=(filter?filter.label+' · '+evData.length+'건':(evData.length?'최근 '+evData.length+'건':''))+' · 보관 '+retDays+'일';
 ev.innerHTML=evData.length?evData.map((e,i)=>'<div class=row data-i='+i+'>'+thumb(e)+'<div>'+evLine(e)+'</div></div>').join(''):'<p style="color:#5a6a85">'+(filter?'이 시간대엔 기록된 움직임이 없습니다':'기록된 움직임이 없습니다')+'</p>';
 ev.querySelectorAll('.row').forEach(row=>row.onclick=()=>{const e=evData[Number(row.dataset.i)];ghost={points:e.points,until:Date.now()+6000}})}
// Hour chips: pick a day and the row shows one chip per hour with its episode
// count — the empty hours stay dim, so paging skips straight to where something
// moved. Tapping a chip swaps the list to that hour; 최근 returns to the live 10.
let filter=null;
const fd=document.getElementById('fd'),fh=document.getElementById('fh');
const two=n=>String(n).padStart(2,'0');const today=new Date();fd.value=today.getFullYear()+'-'+two(today.getMonth()+1)+'-'+two(today.getDate());
function dayStart(){return new Date(fd.value+'T00:00')}
async function loadHours(){if(!fd.value){fh.innerHTML='';return}
 try{const q=await fetch('/api/v1/radar/events/hours?from='+encodeURIComponent(dayStart().toISOString())).then(r=>r.json());
  fh.innerHTML='<button class="hc'+(filter?'':' sel')+'" id=hall>최근</button>'+(q.hours||[]).map((n,h)=>n?'<button class="hc'+(filter&&filter.h===h?' sel':'')+'" data-h='+h+'>'+two(h)+'<span>'+n+'</span></button>':'<span class=hd>'+two(h)+'</span>').join('');
  document.getElementById('hall').onclick=()=>{filter=null;loadHours();loadEvents()};
  fh.querySelectorAll('[data-h]').forEach(b=>b.onclick=()=>{const h=Number(b.dataset.h),from=new Date(dayStart().getTime()+h*3600000);
   filter={h,from,to:new Date(from.getTime()+3599999),label:fd.value.slice(5).replace('-','/')+' '+two(h)+'시'};loadHours();loadEvents()})}catch(e){}}
fd.onchange=()=>{filter=null;loadHours();loadEvents()};
async function loadEvents(){try{const path=filter?'/api/v1/radar/events?from='+encodeURIComponent(filter.from.toISOString())+'&to='+encodeURIComponent(filter.to.toISOString()):'/api/v1/radar/events?limit=10';
 const q=await fetch(path).then(r=>r.json());evData=q.events||[];retDays=q.retentionDays||7;renderEvents()}catch(e){}}
setInterval(()=>{if(!filter){loadEvents();loadHours()}},10000);loadHours();loadEvents();
tick();
</script>`;

  return {
    page,
    handle(req, res, url) {
      if (req.method === 'POST' && url.pathname === '/api/v1/radar/observations') return acceptObservations(req, res);
      if (req.method === 'GET' && url.pathname === '/api/v1/radar/status') return reportStatus(req, res);
      if (req.method === 'GET' && url.pathname === '/api/v1/radar/events') return reportEvents(req, res, url);
      if (req.method === 'GET' && url.pathname === '/api/v1/radar/events/hours') return reportEventHours(req, res, url);
      return json(res, 404, { ok: false, error: 'Not found' });
    },
  };
};
