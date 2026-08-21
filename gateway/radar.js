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

  return {
    handle(req, res, url) {
      if (req.method === 'POST' && url.pathname === '/api/v1/radar/observations') return acceptObservations(req, res);
      if (req.method === 'GET' && url.pathname === '/api/v1/radar/status') return reportStatus(req, res);
      return json(res, 404, { ok: false, error: 'Not found' });
    },
  };
};
