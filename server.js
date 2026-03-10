/**
 * Hurricane Center PR — aprs.fi Cache Server
 * Fetches Puerto Rico CWOP stations from aprs.fi every 10 minutes,
 * caches in memory, and serves unlimited users without hitting API limits.
 */

const express  = require('express');
const https    = require('https');
const app      = express();
const PORT     = process.env.PORT || 3000;

// ── Config ────────────────────────────────────────────────────────────────────
const APRS_API_KEY   = '225758.uKsCfwzQElkk2';
const FETCH_INTERVAL = 10 * 60 * 1000; // 10 minutes = 144 calls/day

// ── Puerto Rico station list ──────────────────────────────────────────────────
const PR_CWOP_IDS = [
  'KP4GA','KP4FJC','DW5492',
  'FW8412','FW8644','GW4841','GW5186','KP4OZ',
  'WP3OF-1','WP4PW','WP3XM','FW2480','FW4300','FW7712','GW6493',
  'CW9754','EW7791','FW4325','FW8269','GW5647','GW5857','GW5869','GW5988','GW7025',
  'WP3OF','WP3OF-5','CW8756','DW0435','DW8435','EW9889','FW2250','FW2454','FW8993',
  'GW0536','GW0931','GW1345','GW4429','GW4457','GW5402','GW6997','GW7070','GW5985',
  'WP3OF-2','CW8822','EW6246','EW6754','GW0907','GW5842','GW5997','GW6435','GW6960','GW6961','GW6979'
];

// ── In-memory cache ───────────────────────────────────────────────────────────
let cache = {
  stations:   {},
  lastFetch:  null,
  fetchCount: 0,
  error:      null
};

// ── aprs.fi fetch ─────────────────────────────────────────────────────────────
function fetchFromAprsfi(ids) {
  return new Promise((resolve, reject) => {
    const url = `https://api.aprs.fi/api/get?name=${ids.join(',')}&what=wx&apikey=${APRS_API_KEY}&format=json`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

function parseEntry(e) {
  const dirs   = ['N','NE','E','SE','S','SW','W','NW'];
  const windDeg = e.wind_direction != null ? parseInt(e.wind_direction) : null;
  return {
    id:       e.name,
    tempF:    e.temp     != null ? parseFloat((e.temp * 9/5 + 32).toFixed(1)) : null,
    windMph:  e.wind_speed != null ? Math.round(e.wind_speed * 0.621371) : null,
    windDir:  windDeg != null ? dirs[Math.round(windDeg / 45) % 8] : null,
    windDeg,
    humidity: e.humidity  != null ? parseInt(e.humidity)  : null,
    rain1h:   e.rain_1h   != null ? parseFloat(e.rain_1h)   : 0,
    rain24h:  e.rain_24h  != null ? parseFloat(e.rain_24h)  : 0,
    pressure: e.pressure  != null ? parseFloat(e.pressure)  : null,
    ts:       parseInt(e.time)
  };
}

async function refreshCache() {
  console.log('[CACHE] Fetching from aprs.fi...');
  try {
    const newStations = {};
    // Fetch in batches of 20
    for (let i = 0; i < PR_CWOP_IDS.length; i += 20) {
      const batch  = PR_CWOP_IDS.slice(i, i + 20);
      const result = await fetchFromAprsfi(batch);
      if (result.result === 'ok' && result.entries) {
        result.entries.forEach(e => {
          if (e.name && e.time) newStations[e.name] = parseEntry(e);
        });
      }
      if (i + 20 < PR_CWOP_IDS.length) await new Promise(r => setTimeout(r, 300));
    }
    cache.stations   = newStations;
    cache.lastFetch  = Math.floor(Date.now() / 1000);
    cache.fetchCount++;
    cache.error      = null;
    console.log(`[CACHE] OK: ${Object.keys(newStations).length} stations (fetch #${cache.fetchCount})`);
  } catch(err) {
    cache.error = err.message;
    console.error('[CACHE] Error:', err.message);
  }
}

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const now = Date.now() / 1000;
  res.json({
    status:     'ok',
    source:     'aprs.fi',
    stations:   Object.keys(cache.stations).length,
    lastFetch:  cache.lastFetch ? Math.floor(now - cache.lastFetch) + 's ago' : 'never',
    fetchCount: cache.fetchCount,
    nextFetch:  cache.lastFetch ? Math.max(0, Math.round((cache.lastFetch + FETCH_INTERVAL/1000) - now)) + 's' : 'soon',
    error:      cache.error,
    uptime:     Math.floor(process.uptime()) + 's'
  });
});

app.get('/cwop', (req, res) => {
  const cutoff = Math.floor(Date.now() / 1000) - 45 * 60;
  const fresh = {}, stale = {};
  Object.values(cache.stations).forEach(s => {
    (s.ts >= cutoff ? fresh : stale)[s.id] = s;
  });
  res.json({
    stations:   fresh,
    staleCount: Object.keys(stale).length,
    totalCount: Object.keys(cache.stations).length,
    lastFetch:  cache.lastFetch,
    ts:         Math.floor(Date.now() / 1000)
  });
});

app.get('/cwop/batch', (req, res) => {
  const ids    = (req.query.ids || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const cutoff = Math.floor(Date.now() / 1000) - 45 * 60;
  const result = {};
  ids.forEach(id => {
    const s = cache.stations[id];
    if (s && s.ts >= cutoff) result[id] = s;
  });
  res.json({ stations: result, found: Object.keys(result).length, queried: ids.length, ts: Math.floor(Date.now() / 1000) });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[HTTP] Hurricane PR cache server on port ${PORT}`);
  refreshCache();
  setInterval(refreshCache, FETCH_INTERVAL);
});
