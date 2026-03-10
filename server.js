/**
 * Hurricane Center PR — APRS-IS Proxy Server
 * Connects to APRS-IS network, filters Puerto Rico CWOP stations,
 * caches data in memory, and exposes a REST API for the PWA.
 */

const net     = require('net');
const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── APRS-IS config ────────────────────────────────────────────────────────────
const APRS_HOST    = 'rotate.aprs2.net';
const APRS_PORT    = 14580;
const APRS_USER    = 'WP4TEST';
const APRS_PASS    = '437';

// ── Puerto Rico CWOP station list ─────────────────────────────────────────────
const PR_STATIONS = new Set([
  'KP4GA','WP3OF','WP3OF-1','WP3OF-2','KP4FJC','WP4PW','WP3XM','WP3OF-5',
  'CW8756','CW8822','CW9754',
  'DW0435','DW5492','DW8435',
  'EW6246','EW6754','EW7791','EW9889',
  'FW2250','FW2454','FW2480','FW4300','FW4325','FW7712','FW8269','FW8412','FW8644','FW8993',
  'GW0536','GW0907','GW0931','GW1345','GW4429','GW4457','GW4841','GW5186','GW5402',
  'GW5647','GW5842','GW5857','GW5869','GW5985','GW5988','GW5997',
  'GW6435','GW6493','GW6960','GW6961','GW6979','GW6997','GW7025','GW7070',
  'KP4OZ'
]);

// ── In-memory store ───────────────────────────────────────────────────────────
// { stationId: { tempF, windMph, windDir, humidity, rain1h, rain24h, pressure, ts } }
const stationData = {};
const recentCallsigns = new Set(); // debug: all parsed callsigns seen
let   connectionStatus = 'disconnected';
let   lastPacketTime   = null;
let   packetsReceived  = 0;

// ── APRS packet parser ────────────────────────────────────────────────────────
function degToCompass(deg) {
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(deg / 45) % 8];
}

function parseAPRSWeather(line) {
  try {
    // Format: CALLSIGN>APRS,...:@DDHHMMz/LLLL.LLN/LLLL.LLW_WWW/GGGtTTTrRRRpPPPhHHHbBBBBB
    // Also handles compressed and other formats
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) return null;

    const callRaw = line.substring(0, line.indexOf('>'));
    const call    = callRaw.trim().toUpperCase();
    const body    = line.substring(colonIdx + 1);

    // Must contain weather data marker
    if (!body.includes('_') && !body.includes('t') && !body.includes('T')) return null;

    let tempF    = null;
    let windMph  = null;
    let windDeg  = null;
    let humidity = null;
    let rain1h   = null;
    let rain24h  = null;
    let pressure = null;

    // Wind direction: _DDD
    const windDirMatch = body.match(/_(\d{3})\//);
    if (windDirMatch) windDeg = parseInt(windDirMatch[1]);

    // Wind speed mph: /GGG (sustained) or /SSS
    const windMatch = body.match(/\/(\d{3})(g\d{3})?/);
    if (windMatch) windMph = parseInt(windMatch[1]);

    // Temperature °F: tTTT or t-TT
    const tempMatch = body.match(/t(-?\d{2,3})/);
    if (tempMatch) tempF = parseInt(tempMatch[1]);

    // Rain last hour: rRRR (hundredths of inch)
    const rain1hMatch = body.match(/r(\d{3,4})/);
    if (rain1hMatch) rain1h = parseFloat((parseInt(rain1hMatch[1]) * 0.254).toFixed(2)); // hundredths inch → mm

    // Rain last 24h: pPPP (hundredths of inch)
    const rain24hMatch = body.match(/p(\d{3,4})/);
    if (rain24hMatch) rain24h = parseFloat((parseInt(rain24hMatch[1]) * 0.254).toFixed(2));

    // Humidity: hHH (percent, 00=100%)
    const humMatch = body.match(/h(\d{2})/);
    if (humMatch) humidity = humMatch[1] === '00' ? 100 : parseInt(humMatch[1]);

    // Pressure: bBBBBB (tenths of mbar)
    const pressMatch = body.match(/b(\d{5})/);
    if (pressMatch) pressure = parseFloat((parseInt(pressMatch[1]) / 10).toFixed(1));

    if (tempF === null && windMph === null && rain1h === null) return null;

    return {
      id:       call,
      tempF:    tempF,
      windMph:  windMph,
      windDir:  windDeg !== null ? degToCompass(windDeg) : null,
      windDeg:  windDeg,
      humidity: humidity,
      rain1h:   rain1h  !== null ? rain1h  : 0,
      rain24h:  rain24h !== null ? rain24h : 0,
      pressure: pressure,
      ts:       Math.floor(Date.now() / 1000)
    };
  } catch(e) {
    return null;
  }
}

// ── APRS-IS TCP connection ────────────────────────────────────────────────────
let client     = null;
let reconnectTimer = null;
let buffer     = '';

function connect() {
  if (client) {
    try { client.destroy(); } catch(e) {}
    client = null;
  }

  console.log(`[APRS] Connecting to ${APRS_HOST}:${APRS_PORT}...`);
  connectionStatus = 'connecting';
  // Clear old data from previous connection (may have been unfiltered)
  Object.keys(stationData).forEach(k => delete stationData[k]);
  packetsReceived = 0;

  client = new net.Socket();
  client.setEncoding('utf8');
  client.setTimeout(120000); // 2 min timeout

  client.connect(APRS_PORT, APRS_HOST, () => {
    console.log('[APRS] Connected. Logging in...');
    connectionStatus = 'connected';
    // Login + filter in one line (correct APRS-IS format)
    client.write(`user ${APRS_USER} pass ${APRS_PASS} vers HurricanePR 1.0\r\n`);
    console.log('[APRS] Login sent with filter r/18.2/-66.5/250 t/w');
  });

  client.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line

    lines.forEach(line => {
      line = line.trim();
      if (!line) return;

      packetsReceived++; // count everything including # server msgs
      if (line.startsWith('#')) {
        console.log('[APRS] Server msg:', line.substring(0, 100));
        return;
      }

      lastPacketTime = Date.now();
      const parsed = parseAPRSWeather(line);
      if (parsed) {
        recentCallsigns.add(parsed.id);
        if (recentCallsigns.size > 200) recentCallsigns.clear();
        if (PR_STATIONS.has(parsed.id)) {
          stationData[parsed.id] = parsed;
        }
      }
    });
  });

  client.on('timeout', () => {
    console.log('[APRS] Connection timeout — reconnecting...');
    connectionStatus = 'timeout';
    client.destroy();
  });

  client.on('error', (err) => {
    console.error('[APRS] Error:', err.message);
    connectionStatus = 'error';
  });

  client.on('close', () => {
    console.log('[APRS] Connection closed — reconnecting in 30s...');
    connectionStatus = 'disconnected';
    client = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 30000);
  });
}

// Start connection
connect();

// Keepalive ping every 10 minutes (APRS-IS drops idle connections)
setInterval(() => {
  if (client && connectionStatus === 'connected') {
    client.write('#keepalive\r\n');
    console.log('[APRS] Keepalive sent');
  }
}, 10 * 60 * 1000);

// Purge stale data older than 2 hours every 30 min
setInterval(() => {
  const cutoff = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
  let purged = 0;
  Object.keys(stationData).forEach(id => {
    if (stationData[id].ts < cutoff) { delete stationData[id]; purged++; }
  });
  if (purged > 0) console.log(`[APRS] Purged ${purged} stale stations`);
}, 30 * 60 * 1000);

// ── REST API ──────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Health check — UptimeRobot pings this
app.get('/', (req, res) => {
  res.json({
    status:        'ok',
    aprs:          connectionStatus,
    stations:      Object.keys(stationData).length,
    lastPacket:    lastPacketTime ? Math.floor((Date.now() - lastPacketTime) / 1000) + 's ago' : 'none',
    packetsTotal:  packetsReceived,
    uptime:        Math.floor(process.uptime()) + 's'
  });
});

// Debug: see all callsigns being parsed (to verify station IDs)
app.get('/debug/callsigns', (req, res) => {
  res.json({
    seen: Array.from(recentCallsigns).sort(),
    count: recentCallsigns.size,
    prMatches: Array.from(recentCallsigns).filter(id => PR_STATIONS.has(id)),
    packetsTotal: packetsReceived
  });
});

// Get all PR stations data
// GET /cwop  →  { stations: { CALLSIGN: { tempF, windMph, ... , ts } }, ts: unixtime }
app.get('/cwop', (req, res) => {
  const cutoff  = Math.floor(Date.now() / 1000) - 45 * 60; // 45 min stale limit
  const result  = {};
  const stale   = {};

  Object.keys(stationData).forEach(id => {
    const d = stationData[id];
    if (d.ts >= cutoff) result[id] = d;
    else stale[id] = d;
  });

  res.json({
    stations:    result,
    staleCount:  Object.keys(stale).length,
    totalCount:  Object.keys(stationData).length,
    aprs:        connectionStatus,
    ts:          Math.floor(Date.now() / 1000)
  });
});

// Get specific stations by name
// GET /cwop?ids=CW4917,CW5930,TJSJ
app.get('/cwop/batch', (req, res) => {
  const ids    = (req.query.ids || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const cutoff = Math.floor(Date.now() / 1000) - 45 * 60;
  const result = {};

  ids.forEach(id => {
    const d = stationData[id];
    if (d && d.ts >= cutoff) result[id] = d;
  });

  res.json({
    stations: result,
    found:    Object.keys(result).length,
    queried:  ids.length,
    ts:       Math.floor(Date.now() / 1000)
  });
});

app.listen(PORT, () => {
  console.log(`[HTTP] Hurricane PR APRS server running on port ${PORT}`);
});
