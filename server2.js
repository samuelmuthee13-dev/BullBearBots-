/* ═══════════════════════════════════════════════════════════════
   SERVER.JS — Bull Bear Trading Backend
   Deploy to Render as a Node.js web service.
   Start command: node server.js

   Endpoints:
     POST /start   — start a bot
     POST /stop    — stop a bot
     GET  /status  — get all running bots + their stats
     GET  /health  — health check for Render

   WebSocket (same port):
     Client connects → receives live events:
       balance_update | trade_open | trade_result | pnl_update |
       bot_stopped    | bot_error
═══════════════════════════════════════════════════════════════ */

'use strict';

const http       = require('http');
const { WebSocketServer } = require('ws');
const { launchBot, stopBotByName, activeBotInstances } = require('./bot5backend');

const PORT = process.env.PORT || 3000;

/* ── In-memory stats store (per session) ────────────────────── */
const botStats = {};

function getBotStats(botName) {
  const k = botName.toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
  if (!botStats[k]) {
    botStats[k] = { botName, runs: 0, wins: 0, losses: 0, totalProfit: 0, totalLoss: 0, trades: [] };
  }
  return botStats[k];
}

function resetBotStats(botName) {
  const k = botName.toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
  botStats[k] = { botName, runs: 0, wins: 0, losses: 0, totalProfit: 0, totalLoss: 0, trades: [] };
}

/* ── HTTP Server ─────────────────────────────────────────────── */
const server = http.createServer((req, res) => {
  /* CORS headers — allow your APK / WebView origin */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  /* ── GET /health ── */
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  /* ── GET /status ── */
  if (req.method === 'GET' && req.url === '/status') {
    const running = Object.keys(activeBotInstances).map(k => {
      const inst  = activeBotInstances[k];
      const stats = botStats[k] || {};
      return {
        botName:     inst.botName,
        running:     inst.running,
        runs:        stats.runs        || 0,
        wins:        stats.wins        || 0,
        losses:      stats.losses      || 0,
        totalProfit: stats.totalProfit || 0,
        totalLoss:   stats.totalLoss   || 0,
        netPnl:      (stats.totalProfit || 0) - (stats.totalLoss || 0),
      };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ bots: running }));
    return;
  }

  /* ── POST /start ── */
  if (req.method === 'POST' && req.url === '/start') {
    readBody(req, (body) => {
      let cfg;
      try { cfg = JSON.parse(body); } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
        return;
      }

      const { botName, token, stake, sl, tp, maxRuns } = cfg;

      if (!botName || !token || !stake || !sl || !tp || !maxRuns) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Missing required fields: botName, token, stake, sl, tp, maxRuns' }));
        return;
      }

      const k = botName.toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');

      if (activeBotInstances[k] && activeBotInstances[k].running) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: botName + ' is already running' }));
        return;
      }

      resetBotStats(botName);

      const botCfg = {
        botName,
        token,
        stake:   parseFloat(stake),
        sl:      parseFloat(sl),
        tp:      parseFloat(tp),
        maxRuns: parseInt(maxRuns),

        broadcast: (eventName, data) => {
          broadcast(eventName, data);

          if (eventName === 'trade_result') {
            const stats = getBotStats(data.botName);
            stats.runs++;
            if (data.won) { stats.wins++;   stats.totalProfit += Math.abs(data.profit); }
            else          { stats.losses++; stats.totalLoss   += Math.abs(data.profit); }
            stats.trades.unshift({
              contractId:   data.contractId,
              market:       data.market,
              contractType: data.contractType,
              won:          data.won,
              profit:       data.profit,
              time:         new Date().toISOString(),
            });
            if (stats.trades.length > 100) stats.trades.pop();
          }
        },

        onStop: (stoppedBotName) => {
          console.log(`[${stoppedBotName}] stopped`);
          broadcast('bot_stopped', { botName: stoppedBotName });
        },
      };

      try {
        launchBot(botCfg);
        console.log(`[${botName}] started — stake:${stake} sl:${sl} tp:${tp} maxRuns:${maxRuns}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, botName }));
      } catch(e) {
        console.error(`[${botName}] launch error:`, e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  /* ── POST /stop ── */
  if (req.method === 'POST' && req.url === '/stop') {
    readBody(req, (body) => {
      let cfg;
      try { cfg = JSON.parse(body); } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
        return;
      }

      const { botName } = cfg;
      if (!botName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Missing botName' }));
        return;
      }

      stopBotByName(botName);
      broadcast('bot_stopped', { botName });
      console.log(`[${botName}] stopped by UI request`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, botName }));
    });
    return;
  }

  /* ── 404 for everything else ── */
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

/* ── WebSocket Server (shares same HTTP port) ────────────────── */
const wss = new WebSocketServer({ server });
const uiClients = new Set();

wss.on('connection', (ws) => {
  uiClients.add(ws);
  console.log(`[WS] UI client connected (${uiClients.size} total)`);

  const running = Object.values(activeBotInstances).map(inst => ({
    botName: inst.botName,
    running: inst.running,
  }));
  safeSend(ws, { type: 'connected', runningBots: running });

  ws.on('close', () => {
    uiClients.delete(ws);
    console.log(`[WS] UI client disconnected (${uiClients.size} total)`);
  });

  ws.on('error', (err) => {
    console.error('[WS] client error:', err.message);
    uiClients.delete(ws);
  });
});

function safeSend(ws, payload) {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  } catch(e) {
    console.error('[WS] send error:', e.message);
  }
}

function broadcast(eventName, data) {
  const payload = JSON.stringify({ type: eventName, ...data });
  uiClients.forEach(ws => {
    try {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    } catch(e) { /* client disconnected mid-send */ }
  });
}

/* ── Utility: read POST body ─────────────────────────────────── */
function readBody(req, cb) {
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', () => cb(body));
}

/* ── Keep-alive: prevents Render free tier from sleeping ─────── */
/* Render auto-sets RENDER_EXTERNAL_URL so this only runs on Render */
if (process.env.RENDER_EXTERNAL_URL) {
  const https = require('https');
  const pingUrl = process.env.RENDER_EXTERNAL_URL + '/health';
  setInterval(() => {
    https.get(pingUrl, r => {
      console.log(`[keepalive] ping → ${r.statusCode}`);
    }).on('error', e => {
      console.error('[keepalive] ping failed:', e.message);
    });
  }, 10 * 60 * 1000); // every 10 minutes
  console.log(`[keepalive] scheduled — pinging ${pingUrl} every 10 min`);
}

/* ── Start ───────────────────────────────────────────────────── */
server.listen(PORT, () => {
  console.log(`✅ Bull Bear backend running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Status: http://localhost:${PORT}/status`);
});
