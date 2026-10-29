// Filler Killer API: one job for now. The phone app sends a saved session's audio (16 kHz WAV) and gets back where
// Deepgram heard filler words, to compare with what the phone caught. The Deepgram key stays here (DEEPGRAM_API_KEY).
// There is no secret in the app, so spending is capped instead: per caller per hour, and for everyone per day
// (DAILY_AUDIO_HOURS, default 10). Audio is passed straight through and never stored.
const http = require('http');

const PORT = process.env.PORT || 10000, KEY = process.env.DEEPGRAM_API_KEY;
const PER_HOUR = 20, DAILY_S = (+process.env.DAILY_AUDIO_HOURS || 10) * 3600;
const calls = new Map();   // caller address -> times of recent checks
let day = '', usedS = 0;   // audio seconds checked today (UTC), for everyone
function allowed(ip, seconds) {
  const now = Date.now(), recent = (calls.get(ip) || []).filter(t => now - t < 3600e3);
  const today = new Date().toISOString().slice(0, 10); if (today !== day) { day = today; usedS = 0; }
  if (recent.length >= PER_HOUR) return 'too many checks from this phone; try again in an hour';
  if (usedS + seconds > DAILY_S) return 'the daily checking limit has been reached; try again tomorrow';
  recent.push(now); calls.set(ip, recent); usedS += seconds; return null;
}
const DG = process.env.DEEPGRAM_URL || 'https://api.deepgram.com';
const MAX = 45 * 1024 * 1024;   // a 20-minute session is about 38 MB
const FILLERS = new Set(['um', 'uh', 'mhmm', 'mm-mm', 'uh-uh', 'uh-huh', 'nuh-uh', 'hmm', 'er', 'erm', 'ah']);

const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true, deepgram: !!KEY });
  if (req.method !== 'POST' || req.url !== '/v1/fillers') return send(res, 404, { error: 'not found' });
  if (!KEY) return send(res, 503, { error: 'Deepgram key not set on the server' });

  const parts = []; let size = 0;
  try {
    for await (const c of req) { size += c.length; if (size > MAX) return send(res, 413, { error: 'recording too long' }); parts.push(c); }
  } catch { return send(res, 400, { error: 'upload failed' }); }
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const no = allowed(ip, size / 32000);   // 16 kHz 16-bit mono = 32,000 bytes a second
  if (no) return send(res, 429, { error: no });

  // filler_words keeps um/uh; mip_opt_out stops Deepgram keeping the audio for its own training
  const q = new URLSearchParams({ model: 'nova-3', language: 'en', filler_words: 'true', punctuate: 'false', smart_format: 'false', mip_opt_out: 'true' });
  try {
    const r = await fetch(`${DG}/v1/listen?${q}`, { method: 'POST', headers: { Authorization: `Token ${KEY}`, 'content-type': 'audio/wav' }, body: Buffer.concat(parts) });
    if (!r.ok) { console.error('deepgram', r.status, (await r.text()).slice(0, 300)); return send(res, 502, { error: `Deepgram said ${r.status}` }); }
    const j = await r.json(), words = j.results?.channels?.[0]?.alternatives?.[0]?.words || [];
    const fillers = words.filter(w => FILLERS.has(String(w.word).toLowerCase())).map(w => ({ w: String(w.word).toLowerCase(), s: +w.start.toFixed(2), e: +w.end.toFixed(2), c: +(w.confidence ?? 0).toFixed(2) }));
    console.log(`checked ${(size / 32000).toFixed(0)} s: ${words.length} words, ${fillers.length} fillers`);
    send(res, 200, { words: words.length, fillers, transcript: words.map(w => w.word).join(' ').slice(0, 20000) });
  } catch (e) { console.error(e); send(res, 502, { error: 'could not reach Deepgram' }); }
}).listen(PORT, () => console.log('filler-killer-api on', PORT));
