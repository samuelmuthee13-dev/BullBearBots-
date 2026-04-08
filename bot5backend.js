/* ═══════════════════════════════════════════════════════════════
   BOTS5-BACKEND.JS  —  All 8 bot engines adapted for Node.js
   No DOM. No browser globals.
   All UI events are sent via broadcast() to the WebSocket server.
   Exports: launchBot(cfg, broadcast, onStop)
═══════════════════════════════════════════════════════════════ */

'use strict';
const NodeWebSocket = require('ws');
const WS_URL = 'wss://ws.derivws.com/websockets/v3?app_id=1089';

/* ── Backend shims replacing store.js DOM functions ─────────── */
/* These are injected per-bot via cfg so each bot is self-contained */
function noop() {}

/* ── Bot instance registry (mirrors store.js activeBotInstances) */
const activeBotInstances = {};
function botNameToKey(name) {
  return name.toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
}

/* ── Launcher ─────────────────────────────────────────────────── */
/*
  cfg must include:
    token, stake, sl, tp, maxRuns, botName,
    broadcast(eventName, data) — sends update to UI via WS,
    onStop(botName)            — called when bot stops itself
*/
function launchBot(cfg) {
  const name = botNameToKey(cfg.botName);
  // Register instance
  activeBotInstances[name] = { botName: cfg.botName, running: true, ws: null };
  switch (name) {
    case 'OVER0':        runOver0Bot(cfg);        break;
    case 'OVER2':        runOver2Bot(cfg);        break;
    case 'UNDER7':       runUnder7Bot(cfg);       break;
    case 'UNDER8':       runUnder8Bot(cfg);       break;
    case 'UNDER9':       runUnder9Bot(cfg);       break;
    case 'EVENODD':      runEvenOddBot(cfg);      break;
    case 'ACCUMULATORS': runAccumulatorsBot(cfg); break;
    case 'RISEFALL':     runRiseFallBot(cfg);     break;
    default:
      cfg.broadcast('bot_error', { botName: cfg.botName, message: 'Bot not implemented.' });
      cfg.onStop(cfg.botName);
  }
}

function stopBotByName(botName) {
  const k = botNameToKey(botName);
  const inst = activeBotInstances[k];
  if (!inst) return;
  inst.running = false;
  if (inst.ws) { try { inst.ws.close(); } catch(e){} inst.ws = null; }
  delete activeBotInstances[k];
}

module.exports = { launchBot, stopBotByName, activeBotInstances };

/* ═══════════════════════════════════════════════════════════════
   OVER 0 BOT
   Window  : 100-second rolling window
   Qualify : Digits 0–3 below their weakness thresholds;
             highest-% digit must be 6, 7, 8, or 9
   Entry   : Tick lands on digit 0  →  DIGITOVER barrier 0, 1 tick
═══════════════════════════════════════════════════════════════ */
function runOver0Bot(cfg) {
  const MARKETS   = ['R_10','R_25','R_50','R_75','R_100','1HZ10V','1HZ25V','1HZ30V','1HZ50V','1HZ75V','1HZ100V','1HZ90V'];
  const WINDOW_MS = 100000;

  const ws = new NodeWebSocket(WS_URL);
  // ws registered below in activeBotInstances
  if (activeBotInstances[botNameToKey(cfg.botName)]) activeBotInstances[botNameToKey(cfg.botName)].ws = ws;

  function isBotActive() {
    const k = botNameToKey(cfg.botName);
    return !!(activeBotInstances[k] && activeBotInstances[k].running);
  }

  const state = {
    activeTrade: false, currentContractId: null, currentTradingMarket: null,
    runs: 0, wins: 0, losses: 0, consecutiveLosses: 0,
    totalProfit: 0, totalLoss: 0, currentBalance: 0,
    markets: {}, pipSizes: {}, reqId: 1000
  };

  MARKETS.forEach(sym => {
    state.markets[sym] = { symbol: sym, ticks: [], qualified: false, windowFull: false, greenDigit: null, greenPct: 0 };
  });

  function send(msg)  { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
  function nextId()   { return state.reqId++; }

  function getLastDigit(price, sym) {
    const pip = state.pipSizes[sym] || 0.01;
    const dec = Math.abs(Math.round(Math.log10(pip)));
    const fmt = price.toFixed(dec);
    return parseInt(fmt.charAt(fmt.length - 1));
  }

  function addTick(market, price, timestamp) {
    const digit = getLastDigit(price, market.symbol);
    const now   = timestamp || Date.now();
    market.ticks.push({ digit, time: now });
    const cutoff = now - WINDOW_MS;
    while (market.ticks.length && market.ticks[0].time < cutoff) market.ticks.shift();
    return digit;
  }

  function isWindowFull(market) {
    if (!market.ticks.length) return false;
    return (market.ticks[market.ticks.length - 1].time - market.ticks[0].time) >= WINDOW_MS;
  }

  function checkQualification(market) {
    if (!market.windowFull) { market.qualified = false; return false; }
    const counts = Array(10).fill(0);
    market.ticks.forEach(t => counts[t.digit]++);
    const pcts = counts.map(c => (c / market.ticks.length) * 100);
    // Low-digit weakness thresholds
    if (pcts[0] > 8.0 || pcts[1] > 9.0 || pcts[2] > 9.0 || pcts[3] > 10.0) {
      market.qualified = false; return false;
    }
    // Highest % digit must be 6–9
    let maxPct = -1, greenDigit = null;
    for (let i = 0; i <= 9; i++) { if (pcts[i] > maxPct) { maxPct = pcts[i]; greenDigit = i; } }
    if (greenDigit === null || greenDigit < 6) { market.qualified = false; return false; }
    market.qualified = true; market.greenDigit = greenDigit; market.greenPct = maxPct;
    return true;
  }

  ws.onopen = () => send({ authorize: cfg.token });

  ws.onmessage = function(e) {
    if (!isBotActive()) return;
    const data = JSON.parse(e.data);
    if (data.error) return;

    if (data.msg_type === 'authorize') {
      send({ balance: 1, subscribe: 1, req_id: nextId() });
      send({ active_symbols: 'brief', product_type: 'basic', req_id: nextId() });
    }
    if (data.msg_type === 'balance') {
      state.currentBalance = parseFloat(data.balance.balance);
      cfg.broadcast('balance_update', { botName: cfg.botName, balance: state.currentBalance });
    }
    if (data.msg_type === 'active_symbols') {
      data.active_symbols.forEach(s => { if (MARKETS.includes(s.symbol)) state.pipSizes[s.symbol] = parseFloat(s.pip); });
      MARKETS.forEach(sym => send({ ticks: sym, subscribe: 1, req_id: nextId() }));
    }
    if (data.msg_type === 'tick') {
      if (state.activeTrade) return;
      const sym    = data.tick.symbol;
      const market = state.markets[sym];
      if (!market) return;
      const digit = addTick(market, parseFloat(data.tick.quote), data.tick.epoch * 1000);
      if (!market.windowFull) market.windowFull = isWindowFull(market);
      checkQualification(market);
      if (market.qualified && !state.activeTrade && digit === 0) {
        state.activeTrade = true;
        state.currentTradingMarket = sym;
        send({ buy: 1, price: cfg.stake, parameters: {
          contract_type: 'DIGITOVER', symbol: sym, duration: 1, duration_unit: 't',
          barrier: '0', amount: cfg.stake, basis: 'stake', currency: 'USD'
        }, req_id: nextId() });
      }
    }
    if (data.msg_type === 'buy') {
      if (data.error) { state.activeTrade = false; state.currentTradingMarket = null; return; }
      state.currentContractId = data.buy.contract_id;
      cfg.broadcast('trade_open', { botName: cfg.botName, contractId: state.currentContractId, market: state.currentTradingMarket || 'OVER0', contractType: 'Over 0' });
      send({ proposal_open_contract: 1, contract_id: state.currentContractId, subscribe: 1, req_id: nextId() });
    }
    if (data.msg_type === 'proposal_open_contract') {
      const c = data.proposal_open_contract;
      if (!c || !c.is_sold) return;
      const profit = parseFloat(c.profit);
      const won    = profit > 0;
      state.runs++;
      state.totalProfit += won ? profit : 0;
      state.totalLoss   += won ? 0 : Math.abs(profit);
      if (won) { state.wins++; state.consecutiveLosses = 0; }
      else     { state.losses++; state.consecutiveLosses++; }
      cfg.broadcast('trade_result', { botName: cfg.botName, market: c.underlying || state.currentTradingMarket || 'OVER0', contractId: state.currentContractId, won: won, profit: profit, contractType: 'Over 0' });
      cfg.broadcast('pnl_update', { botName: cfg.botName, totalProfit: state.totalProfit, totalLoss: state.totalLoss, runs: state.runs, wins: state.wins, losses: state.losses });
      const net = state.totalProfit - state.totalLoss;
      const shouldStop = state.runs >= cfg.maxRuns || state.consecutiveLosses >= 3 ||
        net <= -Math.abs(cfg.sl) || net >= Math.abs(cfg.tp);
      if (shouldStop) { stopBotByName(cfg.botName); cfg.onStop(cfg.botName); return; }
      state.activeTrade = false; state.currentContractId = null; state.currentTradingMarket = null;
      MARKETS.forEach(s => { state.markets[s].qualified = false; });
    }
  };

  ws.onclose = function() { if (isBotActive()) { stopBotByName(cfg.botName); cfg.onStop(cfg.botName); } };
}

/* ═══════════════════════════════════════════════════════════════
   OVER 2 BOT
   Window  : 100-second rolling window (must be full before analysis)
   Qualify : Green digit (highest % among 5–9) > Red digit (lowest % among 5–9);
             gap between green% and highest% of digits 0/1/2 >= BASE_GAP_MIN (8.5%)
   Adaptive: gap threshold increases by 1% after a loss, resets after a win
   Entry   : Two consecutive ticks in digits 0/1/2  →  DIGITOVER barrier 2, 1 tick
═══════════════════════════════════════════════════════════════ */
function runOver2Bot(cfg) {
  const MARKETS          = ['R_10','R_25','R_50','R_75','R_100','1HZ10V','1HZ25V','1HZ30V','1HZ50V','1HZ75V','1HZ100V','1HZ90V'];
  const WINDOW_MS        = 100000;
  const BASE_GAP_MIN     = 8.5;
  const FILTER_INCREMENT = 1.0;

  const ws = new NodeWebSocket(WS_URL);
  // ws registered below in activeBotInstances
  if (activeBotInstances[botNameToKey(cfg.botName)]) activeBotInstances[botNameToKey(cfg.botName)].ws = ws;

  function isBotActive() {
    const k = botNameToKey(cfg.botName);
    return !!(activeBotInstances[k] && activeBotInstances[k].running);
  }

  const state = {
    activeTrade: false, currentContractId: null,
    selectedMarket: null, currentTradingMarket: null,
    runs: 0, wins: 0, losses: 0, consecutiveLosses: 0,
    totalProfit: 0, totalLoss: 0, currentBalance: 0,
    markets: {}, pipSizes: {}, reqId: 1000
  };

  MARKETS.forEach(sym => {
    state.markets[sym] = {
      symbol: sym, ticks: [], qualified: false,
      greenDigit: null, redDigit: null, greenPct: 0, redPct: 0,
      topUnderDigit: null, topUnderPct: 0, entryDigit: null,
      hasLost: false, requiredGapMin: BASE_GAP_MIN,
      windowFull: false, lastTickInUnder: false
    };
  });

  function send(msg)  { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
  function nextId()   { return state.reqId++; }

  function getLastDigit(price, sym) {
    const pip = state.pipSizes[sym] || 0.01;
    const dec = Math.abs(Math.log10(pip));
    const fmt = price.toFixed(dec);
    return parseInt(fmt.charAt(fmt.length - 1));
  }

  function addTick(market, price, timestamp) {
    const digit = getLastDigit(price, market.symbol);
    const now   = timestamp || Date.now();
    market.ticks.push({ digit, time: now });
    const cutoff = now - WINDOW_MS;
    while (market.ticks.length && market.ticks[0].time < cutoff) market.ticks.shift();
    return digit;
  }

  function isWindowFull(market) {
    if (!market.ticks.length) return false;
    return (market.ticks[market.ticks.length - 1].time - market.ticks[0].time) >= WINDOW_MS;
  }

  function calcPcts(market) {
    if (!market.ticks.length) return Array(10).fill(0);
    const counts = Array(10).fill(0);
    market.ticks.forEach(t => counts[t.digit]++);
    return counts.map(c => (c / market.ticks.length) * 100);
  }

  function checkQualification(market) {
    if (!market.windowFull) { market.qualified = false; return false; }
    const pcts = calcPcts(market);
    // Green: highest % among digits 5–9
    let greenDigit = null, greenPct = -1;
    for (let i = 5; i <= 9; i++) { if (pcts[i] > greenPct) { greenPct = pcts[i]; greenDigit = i; } }
    // Red: lowest % among digits 5–9
    let redDigit = null, redPct = Infinity;
    for (let i = 5; i <= 9; i++) { if (pcts[i] < redPct) { redPct = pcts[i]; redDigit = i; } }
    // Green digit number must be higher than red digit number
    if (greenDigit <= redDigit) { market.qualified = false; return false; }
    // Top-under: highest % among digits 0/1/2
    let topUnderDigit = 0, topUnderPct = pcts[0];
    for (let i = 1; i <= 2; i++) { if (pcts[i] > topUnderPct) { topUnderPct = pcts[i]; topUnderDigit = i; } }
    // Dominance gap must meet threshold
    if ((greenPct - topUnderPct) < market.requiredGapMin) { market.qualified = false; return false; }
    market.qualified    = true;
    market.greenDigit   = greenDigit;  market.greenPct    = greenPct;
    market.redDigit     = redDigit;    market.redPct      = redPct;
    market.topUnderDigit= topUnderDigit; market.topUnderPct = topUnderPct;
    return true;
  }

  function isUnderDigit(d) { return d === 0 || d === 1 || d === 2; }

  function checkEntryTrigger(market, digit) {
    // Fire when current tick AND previous tick are both in digits 0/1/2
    if (isUnderDigit(digit) && market.lastTickInUnder) return true;
    market.lastTickInUnder = isUnderDigit(digit);
    return false;
  }

  function applyLossFilters(market) {
    if (!market.hasLost) { market.hasLost = true; market.requiredGapMin = BASE_GAP_MIN + FILTER_INCREMENT; }
  }

  function resetFilters(market) {
    if (market.hasLost) { market.hasLost = false; market.requiredGapMin = BASE_GAP_MIN; }
  }

  ws.onopen = () => send({ authorize: cfg.token });

  ws.onmessage = function(e) {
    if (!isBotActive()) return;
    const data = JSON.parse(e.data);
    if (data.error) return;

    if (data.msg_type === 'authorize') {
      send({ balance: 1, subscribe: 1, req_id: nextId() });
      send({ active_symbols: 'brief', product_type: 'basic', req_id: nextId() });
    }
    if (data.msg_type === 'balance') {
      state.currentBalance = parseFloat(data.balance.balance);
      cfg.broadcast('balance_update', { botName: cfg.botName, balance: state.currentBalance });
    }
    if (data.msg_type === 'active_symbols') {
      data.active_symbols.forEach(s => { if (MARKETS.includes(s.symbol)) state.pipSizes[s.symbol] = parseFloat(s.pip); });
      MARKETS.forEach(sym => send({ ticks: sym, subscribe: 1, req_id: nextId() }));
    }
    if (data.msg_type === 'tick') {
      const sym    = data.tick.symbol;
      const market = state.markets[sym];
      if (!market) return;
      const digit = addTick(market, parseFloat(data.tick.quote), data.tick.epoch * 1000);
      if (!market.windowFull) market.windowFull = isWindowFull(market);
      checkQualification(market);
      if (market.qualified && !state.activeTrade) {
        if (!state.selectedMarket || state.selectedMarket !== sym) state.selectedMarket = sym;
        if (checkEntryTrigger(market, digit)) {
          state.activeTrade = true; state.currentTradingMarket = sym;
          send({ buy: 1, price: cfg.stake, parameters: {
            contract_type: 'DIGITOVER', symbol: sym, duration: 1, duration_unit: 't',
            barrier: '2', amount: cfg.stake, basis: 'stake', currency: 'USD'
          }, req_id: nextId() });
        }
      } else if (!market.qualified) {
        // Keep lastTickInUnder updated even when not watching for entry
        market.lastTickInUnder = isUnderDigit(digit);
      }
    }
    if (data.msg_type === 'buy') {
      if (data.error) { state.activeTrade = false; state.selectedMarket = null; state.currentTradingMarket = null; return; }
      state.currentContractId = data.buy.contract_id;
      cfg.broadcast('trade_open', { botName: cfg.botName, contractId: state.currentContractId, market: state.currentTradingMarket || 'OVER2', contractType: 'Over 2' });
      send({ proposal_open_contract: 1, contract_id: state.currentContractId, subscribe: 1, req_id: nextId() });
    }
    if (data.msg_type === 'proposal_open_contract') {
      const c = data.proposal_open_contract;
      if (!c || !c.is_sold) return;
      const profit = parseFloat(c.profit);
      const won    = profit > 0;
      state.runs++;
      state.totalProfit += won ? profit : 0;
      state.totalLoss   += won ? 0 : Math.abs(profit);
      const tm = state.markets[state.currentTradingMarket];
      if (won) { state.wins++; state.consecutiveLosses = 0; if (tm) resetFilters(tm); }
      else     { state.losses++; state.consecutiveLosses++; if (tm) applyLossFilters(tm); }
      cfg.broadcast('trade_result', { botName: cfg.botName, market: state.currentTradingMarket, contractId: state.currentContractId, won: won, profit: profit, contractType: 'Over 2' });
      cfg.broadcast('pnl_update', { botName: cfg.botName, totalProfit: state.totalProfit, totalLoss: state.totalLoss, runs: state.runs, wins: state.wins, losses: state.losses });
      const net = state.totalProfit - state.totalLoss;
      const shouldStop = state.runs >= cfg.maxRuns || state.consecutiveLosses >= 3 ||
        net <= -Math.abs(cfg.sl) || net >= Math.abs(cfg.tp);
      if (shouldStop) { stopBotByName(cfg.botName); cfg.onStop(cfg.botName); return; }
      state.activeTrade = false; state.currentContractId = null;
      state.selectedMarket = null; state.currentTradingMarket = null;
      MARKETS.forEach(s => {
        state.markets[s].qualified      = false;
        state.markets[s].entryDigit     = null;
        state.markets[s].lastTickInUnder= false;
      });
    }
  };

  ws.onclose = function() { if (isBotActive()) { stopBotByName(cfg.botName); cfg.onStop(cfg.botName); } };
}

/* ═══════════════════════════════════════════════════════════════
   UNDER 7 BOT
   Window  : 100-second rolling window
   Qualify : Green digit (highest % overall) must be 0–4;
             Red digit (lowest % > 0) must be 5–9;
             Digits 7/8/9 each <= BASE_HIGH_DIGITS_MAX (7%);
             Dominance gap (green% − max(7,8,9)%) >= BASE_GAP (5%)
   Adaptive: gap increases +1%, high-digits max decreases −1% after loss
   Entry   : Tick touches 7, 8, or 9  →  DIGITUNDER barrier 7, 1 tick
═══════════════════════════════════════════════════════════════ */
function runUnder7Bot(cfg) {
  const MARKETS              = ['R_10','R_25','R_50','R_75','R_100','1HZ10V','1HZ25V','1HZ30V','1HZ50V','1HZ75V','1HZ100V','1HZ90V'];
  const WINDOW_MS            = 200000;
  const BASE_GAP             = 5.0;
  const BASE_HIGH_DIGITS_MAX = 8.5;
  const FILTER_INCREMENT     = -1.0;

  const ws = new NodeWebSocket(WS_URL);
  // ws registered below in activeBotInstances
  if (activeBotInstances[botNameToKey(cfg.botName)]) activeBotInstances[botNameToKey(cfg.botName)].ws = ws;

  function isBotActive() {
    const k = botNameToKey(cfg.botName);
    return !!(activeBotInstances[k] && activeBotInstances[k].running);
  }

  const state = {
    activeTrade: false, currentContractId: null,
    selectedMarket: null, currentTradingMarket: null,
    runs: 0, wins: 0, losses: 0, consecutiveLosses: 0,
    totalProfit: 0, totalLoss: 0, currentBalance: 0,
    markets: {}, pipSizes: {}, reqId: 1000
  };

  MARKETS.forEach(sym => {
    state.markets[sym] = {
      symbol: sym, ticks: [], qualified: false,
      greenDigit: null, greenPct: 0, maxHighPct: 0, entryDigit: null,
      hasLost: false, requiredGap: BASE_GAP, maxHighDigitPct: BASE_HIGH_DIGITS_MAX
    };
  });

  function send(msg)  { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
  function nextId()   { return state.reqId++; }

  function getLastDigit(price, sym) {
    const pip = state.pipSizes[sym] || 0.01;
    const dec = Math.abs(Math.log10(pip));
    const fmt = price.toFixed(dec);
    return parseInt(fmt.charAt(fmt.length - 1));
  }

  function addTick(market, price, timestamp) {
    const digit = getLastDigit(price, market.symbol);
    const now   = timestamp || Date.now();
    market.ticks.push({ digit, time: now });
    const cutoff = now - WINDOW_MS;
    while (market.ticks.length && market.ticks[0].time < cutoff) market.ticks.shift();
    return digit;
  }

  function checkQualification(market) {
    if (market.ticks.length < 100) { market.qualified = false; return false; }
    const counts = Array(10).fill(0);
    market.ticks.forEach(t => counts[t.digit]++);
    const pcts = counts.map(c => (c / market.ticks.length) * 100);
    // Green: highest % across all digits, must land on 0–4
    let maxPct = -1, greenDigit = null;
    for (let i = 0; i <= 9; i++) { if (pcts[i] > maxPct) { maxPct = pcts[i]; greenDigit = i; } }
    if (greenDigit === null || greenDigit > 4) { market.qualified = false; return false; }
    // Red: lowest % (>0) across all digits, must land on 5–9
    let minPct = Infinity, redDigit = null;
    for (let i = 0; i <= 9; i++) { if (pcts[i] > 0 && pcts[i] < minPct) { minPct = pcts[i]; redDigit = i; } }
    if (redDigit === null || redDigit < 5) { market.qualified = false; return false; }
    // Digits 7/8/9 must each stay within adaptive ceiling
    if (pcts[7] > market.maxHighDigitPct || pcts[8] > market.maxHighDigitPct || pcts[9] > market.maxHighDigitPct) {
      market.qualified = false; return false;
    }
    // Dominance gap
    const maxHighPct = Math.max(pcts[7], pcts[8], pcts[9]);
    if ((pcts[greenDigit] - maxHighPct) < market.requiredGap) { market.qualified = false; return false; }
    market.qualified  = true;
    market.greenDigit = greenDigit;
    market.greenPct   = pcts[greenDigit];
    market.maxHighPct = maxHighPct;
    return true;
  }

  function applyLossFilters(market) {
    if (!market.hasLost) {
      market.hasLost        = true;
      market.requiredGap    = BASE_GAP + FILTER_INCREMENT;
      market.maxHighDigitPct= BASE_HIGH_DIGITS_MAX + FILTER_INCREMENT;
    }
  }

  function resetFilters(market) {
    if (market.hasLost) {
      market.hasLost        = false;
      market.requiredGap    = BASE_GAP;
      market.maxHighDigitPct= BASE_HIGH_DIGITS_MAX;
    }
  }

  ws.onopen = () => send({ authorize: cfg.token });

  ws.onmessage = function(e) {
    if (!isBotActive()) return;
    const data = JSON.parse(e.data);
    if (data.error) return;

    if (data.msg_type === 'authorize') {
      send({ balance: 1, subscribe: 1, req_id: nextId() });
      send({ active_symbols: 'brief', product_type: 'basic', req_id: nextId() });
    }
    if (data.msg_type === 'balance') {
      state.currentBalance = parseFloat(data.balance.balance);
      cfg.broadcast('balance_update', { botName: cfg.botName, balance: state.currentBalance });
    }
    if (data.msg_type === 'active_symbols') {
      data.active_symbols.forEach(s => { if (MARKETS.includes(s.symbol)) state.pipSizes[s.symbol] = parseFloat(s.pip); });
      MARKETS.forEach(sym => send({ ticks: sym, subscribe: 1, req_id: nextId() }));
    }
    if (data.msg_type === 'tick') {
      const sym    = data.tick.symbol;
      const market = state.markets[sym];
      if (!market) return;
      const digit = addTick(market, parseFloat(data.tick.quote), data.tick.epoch * 1000);
      checkQualification(market);
      if (market.qualified && !state.activeTrade && digit >= 7 && digit <= 9) {
        if (!state.selectedMarket || state.selectedMarket !== sym) state.selectedMarket = sym;
        market.entryDigit = digit;
        state.activeTrade = true; state.currentTradingMarket = sym;
        send({ buy: 1, price: cfg.stake, parameters: {
          contract_type: 'DIGITUNDER', symbol: sym, duration: 1, duration_unit: 't',
          barrier: '7', amount: cfg.stake, basis: 'stake', currency: 'USD'
        }, req_id: nextId() });
      }
    }
    if (data.msg_type === 'buy') {
      if (data.error) { state.activeTrade = false; state.selectedMarket = null; state.currentTradingMarket = null; return; }
      state.currentContractId = data.buy.contract_id;
      cfg.broadcast('trade_open', { botName: cfg.botName, contractId: state.currentContractId, market: state.currentTradingMarket || 'UNDER7', contractType: 'Under 7' });
      send({ proposal_open_contract: 1, contract_id: state.currentContractId, subscribe: 1, req_id: nextId() });
    }
    if (data.msg_type === 'proposal_open_contract') {
      const c = data.proposal_open_contract;
      if (!c || !c.is_sold) return;
      const profit = parseFloat(c.profit);
      const won    = profit > 0;
      state.runs++;
      state.totalProfit += won ? profit : 0;
      state.totalLoss   += won ? 0 : Math.abs(profit);
      const tm = state.markets[state.currentTradingMarket];
      if (won) { state.wins++; state.consecutiveLosses = 0; if (tm) resetFilters(tm); }
      else     { state.losses++; state.consecutiveLosses++; if (tm) applyLossFilters(tm); }
      cfg.broadcast('trade_result', { botName: cfg.botName, market: state.currentTradingMarket, contractId: state.currentContractId, won: won, profit: profit, contractType: 'Under 7' });
      cfg.broadcast('pnl_update', { botName: cfg.botName, totalProfit: state.totalProfit, totalLoss: state.totalLoss, runs: state.runs, wins: state.wins, losses: state.losses });
      const net = state.totalProfit - state.totalLoss;
      const shouldStop = state.runs >= cfg.maxRuns || state.consecutiveLosses >= 3 ||
        net <= -Math.abs(cfg.sl) || net >= Math.abs(cfg.tp);
      if (shouldStop) { stopBotByName(cfg.botName); cfg.onStop(cfg.botName); return; }
      state.activeTrade = false; state.currentContractId = null;
      state.selectedMarket = null; state.currentTradingMarket = null;
      MARKETS.forEach(s => { state.markets[s].qualified = false; state.markets[s].entryDigit = null; });
    }
  };

  ws.onclose = function() { if (isBotActive()) { stopBotByName(cfg.botName); cfg.onStop(cfg.botName); } };
}

/* ═══════════════════════════════════════════════════════════════
   UNDER 8 BOT
   Window  : 100-second rolling window (must be full before analysis)
   Qualify : Digits 8 & 9 each <= BASE_DIGIT89_MAX (8.5%);
             Green digit (highest % among 0–5) and Red digit (lowest % among 0–5)
             must satisfy: red digit index > green digit index
   Adaptive: digit 8 & 9 ceiling decreases −1% after loss, resets after win
   Entry   : Tick lands on digit 9  →  DIGITUNDER barrier 8, 1 tick
═══════════════════════════════════════════════════════════════ */
function runUnder8Bot(cfg) {
  const MARKETS          = ['R_10','R_25','R_50','R_75','R_100','1HZ10V','1HZ25V','1HZ30V','1HZ50V','1HZ75V','1HZ100V','1HZ90V'];
  const WINDOW_MS        = 100000;
  const BASE_DIGIT89_MAX = 8.5;
  const FILTER_DECREMENT = 1.0;

  const ws = new NodeWebSocket(WS_URL);
  // ws registered below in activeBotInstances
  if (activeBotInstances[botNameToKey(cfg.botName)]) activeBotInstances[botNameToKey(cfg.botName)].ws = ws;

  function isBotActive() {
    const k = botNameToKey(cfg.botName);
    return !!(activeBotInstances[k] && activeBotInstances[k].running);
  }

  const state = {
    activeTrade: false, currentContractId: null,
    selectedMarket: null, currentTradingMarket: null,
    runs: 0, wins: 0, losses: 0, consecutiveLosses: 0,
    totalProfit: 0, totalLoss: 0, currentBalance: 0,
    markets: {}, pipSizes: {}, reqId: 1000
  };

  MARKETS.forEach(sym => {
    state.markets[sym] = {
      symbol: sym, ticks: [], qualified: false,
      greenDigit: null, redDigit: null, greenPct: 0, redPct: 0, entryDigit: null,
      hasLost: false, maxDigit89Pct: BASE_DIGIT89_MAX, windowFull: false
    };
  });

  function send(msg)  { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
  function nextId()   { return state.reqId++; }

  function getLastDigit(price, sym) {
    const pip = state.pipSizes[sym] || 0.01;
    const dec = Math.abs(Math.log10(pip));
    const fmt = price.toFixed(dec);
    return parseInt(fmt.charAt(fmt.length - 1));
  }

  function addTick(market, price, timestamp) {
    const digit = getLastDigit(price, market.symbol);
    const now   = timestamp || Date.now();
    market.ticks.push({ digit, time: now });
    const cutoff = now - WINDOW_MS;
    while (market.ticks.length && market.ticks[0].time < cutoff) market.ticks.shift();
    return digit;
  }

  function isWindowFull(market) {
    if (!market.ticks.length) return false;
    return (market.ticks[market.ticks.length - 1].time - market.ticks[0].time) >= WINDOW_MS;
  }

  function checkQualification(market) {
    if (!market.windowFull) { market.qualified = false; return false; }
    const counts = Array(10).fill(0);
    market.ticks.forEach(t => counts[t.digit]++);
    const pcts = counts.map(c => (c / market.ticks.length) * 100);
    // Digits 8 & 9 each must be <= adaptive ceiling
    if (pcts[8] > market.maxDigit89Pct || pcts[9] > market.maxDigit89Pct) { market.qualified = false; return false; }
    // Green: highest % among digits 0–5
    let greenDigit = null, greenPct = -1;
    for (let i = 0; i <= 5; i++) { if (pcts[i] > greenPct) { greenPct = pcts[i]; greenDigit = i; } }
    // Red: lowest % among digits 0–5
    let redDigit = null, redPct = Infinity;
    for (let i = 0; i <= 5; i++) { if (pcts[i] < redPct) { redPct = pcts[i]; redDigit = i; } }
    // Red digit index must be higher than green digit index
    if (redDigit <= greenDigit) { market.qualified = false; return false; }
    market.qualified  = true;
    market.greenDigit = greenDigit; market.greenPct = greenPct;
    market.redDigit   = redDigit;   market.redPct   = redPct;
    return true;
  }

  function applyLossFilters(market) {
    if (!market.hasLost) { market.hasLost = true; market.maxDigit89Pct = BASE_DIGIT89_MAX - FILTER_DECREMENT; }
  }

  function resetFilters(market) {
    if (market.hasLost) { market.hasLost = false; market.maxDigit89Pct = BASE_DIGIT89_MAX; }
  }

  ws.onopen = () => send({ authorize: cfg.token });

  ws.onmessage = function(e) {
    if (!isBotActive()) return;
    const data = JSON.parse(e.data);
    if (data.error) return;

    if (data.msg_type === 'authorize') {
      send({ balance: 1, subscribe: 1, req_id: nextId() });
      send({ active_symbols: 'brief', product_type: 'basic', req_id: nextId() });
    }
    if (data.msg_type === 'balance') {
      state.currentBalance = parseFloat(data.balance.balance);
      cfg.broadcast('balance_update', { botName: cfg.botName, balance: state.currentBalance });
    }
    if (data.msg_type === 'active_symbols') {
      data.active_symbols.forEach(s => { if (MARKETS.includes(s.symbol)) state.pipSizes[s.symbol] = parseFloat(s.pip); });
      MARKETS.forEach(sym => send({ ticks: sym, subscribe: 1, req_id: nextId() }));
    }
    if (data.msg_type === 'tick') {
      const sym    = data.tick.symbol;
      const market = state.markets[sym];
      if (!market) return;
      const digit = addTick(market, parseFloat(data.tick.quote), data.tick.epoch * 1000);
      if (!market.windowFull) market.windowFull = isWindowFull(market);
      checkQualification(market);
      if (market.qualified && !state.activeTrade && digit === 9) {
        if (!state.selectedMarket || state.selectedMarket !== sym) state.selectedMarket = sym;
        market.entryDigit = digit;
        state.activeTrade = true; state.currentTradingMarket = sym;
        send({ buy: 1, price: cfg.stake, parameters: {
          contract_type: 'DIGITUNDER', symbol: sym, duration: 1, duration_unit: 't',
          barrier: '8', amount: cfg.stake, basis: 'stake', currency: 'USD'
        }, req_id: nextId() });
      }
    }
    if (data.msg_type === 'buy') {
      if (data.error) { state.activeTrade = false; state.selectedMarket = null; state.currentTradingMarket = null; return; }
      state.currentContractId = data.buy.contract_id;
      cfg.broadcast('trade_open', { botName: cfg.botName, contractId: state.currentContractId, market: state.currentTradingMarket || 'UNDER8', contractType: 'Under 8' });
      send({ proposal_open_contract: 1, contract_id: state.currentContractId, subscribe: 1, req_id: nextId() });
    }
    if (data.msg_type === 'proposal_open_contract') {
      const c = data.proposal_open_contract;
      if (!c || !c.is_sold) return;
      const profit = parseFloat(c.profit);
      const won    = profit > 0;
      state.runs++;
      state.totalProfit += won ? profit : 0;
      state.totalLoss   += won ? 0 : Math.abs(profit);
      const tm = state.markets[state.currentTradingMarket];
      if (won) { state.wins++; state.consecutiveLosses = 0; if (tm) resetFilters(tm); }
      else     { state.losses++; state.consecutiveLosses++; if (tm) applyLossFilters(tm); }
      cfg.broadcast('trade_result', { botName: cfg.botName, market: state.currentTradingMarket, contractId: state.currentContractId, won: won, profit: profit, contractType: 'Under 8' });
      cfg.broadcast('pnl_update', { botName: cfg.botName, totalProfit: state.totalProfit, totalLoss: state.totalLoss, runs: state.runs, wins: state.wins, losses: state.losses });
      const net = state.totalProfit - state.totalLoss;
      const shouldStop = state.runs >= cfg.maxRuns || state.consecutiveLosses >= 3 ||
        net <= -Math.abs(cfg.sl) || net >= Math.abs(cfg.tp);
      if (shouldStop) { stopBotByName(cfg.botName); cfg.onStop(cfg.botName); return; }
      state.activeTrade = false; state.currentContractId = null;
      state.selectedMarket = null; state.currentTradingMarket = null;
      MARKETS.forEach(s => { state.markets[s].qualified = false; state.markets[s].entryDigit = null; });
    }
  };

  ws.onclose = function() { if (isBotActive()) { stopBotByName(cfg.botName); cfg.onStop(cfg.botName); } };
}

/* ═══════════════════════════════════════════════════════════════
   UNDER 9 BOT
   Window  : 100-second rolling window (must be full before analysis)
   Qualify : Digit 0 >= BASE_GREEN_MIN (14%);
             Digit 9 <= BASE_RED_MAX (6.5%)
   Adaptive: green min increases +1%, red max decreases −1% after loss
   Entry   : Tick lands on digit 9  →  DIGITUNDER barrier 9, 1 tick
═══════════════════════════════════════════════════════════════ */
function runUnder9Bot(cfg) {
  const MARKETS          = ['R_10','R_25','R_50','R_75','R_100','1HZ10V','1HZ25V','1HZ30V','1HZ50V','1HZ75V','1HZ100V','1HZ90V'];
  const WINDOW_MS        = 100000;
  const BASE_GREEN_MIN   = 13.5;
  const BASE_RED_MAX     = 7.5;
  const FILTER_INCREMENT = 1.0;

  const ws = new NodeWebSocket(WS_URL);
  // ws registered below in activeBotInstances
  if (activeBotInstances[botNameToKey(cfg.botName)]) activeBotInstances[botNameToKey(cfg.botName)].ws = ws;

  function isBotActive() {
    const k = botNameToKey(cfg.botName);
    return !!(activeBotInstances[k] && activeBotInstances[k].running);
  }

  const state = {
    activeTrade: false, currentContractId: null,
    selectedMarket: null, currentTradingMarket: null,
    runs: 0, wins: 0, losses: 0, consecutiveLosses: 0,
    totalProfit: 0, totalLoss: 0, currentBalance: 0,
    markets: {}, pipSizes: {}, reqId: 1000
  };

  MARKETS.forEach(sym => {
    state.markets[sym] = {
      symbol: sym, ticks: [], qualified: false,
      greenPct: 0, redPct: 0, entryDigit: null,
      hasLost: false, requiredGreenMin: BASE_GREEN_MIN, maxRedPct: BASE_RED_MAX,
      windowFull: false
    };
  });

  function send(msg)  { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
  function nextId()   { return state.reqId++; }

  function getLastDigit(price, sym) {
    const pip = state.pipSizes[sym] || 0.01;
    const dec = Math.abs(Math.log10(pip));
    const fmt = price.toFixed(dec);
    return parseInt(fmt.charAt(fmt.length - 1));
  }

  function addTick(market, price, timestamp) {
    const digit = getLastDigit(price, market.symbol);
    const now   = timestamp || Date.now();
    market.ticks.push({ digit, time: now });
    const cutoff = now - WINDOW_MS;
    while (market.ticks.length && market.ticks[0].time < cutoff) market.ticks.shift();
    return digit;
  }

  function isWindowFull(market) {
    if (!market.ticks.length) return false;
    return (market.ticks[market.ticks.length - 1].time - market.ticks[0].time) >= WINDOW_MS;
  }

  function checkQualification(market) {
    if (!market.windowFull) { market.qualified = false; return false; }
    const counts = Array(10).fill(0);
    market.ticks.forEach(t => counts[t.digit]++);
    const pcts = counts.map(c => (c / market.ticks.length) * 100);
    if (pcts[0] < market.requiredGreenMin) { market.qualified = false; return false; }
    if (pcts[9] > market.maxRedPct)        { market.qualified = false; return false; }
    market.qualified = true; market.greenPct = pcts[0]; market.redPct = pcts[9];
    return true;
  }

  function applyLossFilters(market) {
    if (!market.hasLost) {
      market.hasLost          = true;
      market.requiredGreenMin = BASE_GREEN_MIN + FILTER_INCREMENT;
      market.maxRedPct        = BASE_RED_MAX   - FILTER_INCREMENT;
    }
  }

  function resetFilters(market) {
    if (market.hasLost) {
      market.hasLost          = false;
      market.requiredGreenMin = BASE_GREEN_MIN;
      market.maxRedPct        = BASE_RED_MAX;
    }
  }

  ws.onopen = () => send({ authorize: cfg.token });

  ws.onmessage = function(e) {
    if (!isBotActive()) return;
    const data = JSON.parse(e.data);
    if (data.error) return;

    if (data.msg_type === 'authorize') {
      send({ balance: 1, subscribe: 1, req_id: nextId() });
      send({ active_symbols: 'brief', product_type: 'basic', req_id: nextId() });
    }
    if (data.msg_type === 'balance') {
      state.currentBalance = parseFloat(data.balance.balance);
      cfg.broadcast('balance_update', { botName: cfg.botName, balance: state.currentBalance });
    }
    if (data.msg_type === 'active_symbols') {
      data.active_symbols.forEach(s => { if (MARKETS.includes(s.symbol)) state.pipSizes[s.symbol] = parseFloat(s.pip); });
      MARKETS.forEach(sym => send({ ticks: sym, subscribe: 1, req_id: nextId() }));
    }
    if (data.msg_type === 'tick') {
      const sym    = data.tick.symbol;
      const market = state.markets[sym];
      if (!market) return;
      const digit = addTick(market, parseFloat(data.tick.quote), data.tick.epoch * 1000);
      if (!market.windowFull) market.windowFull = isWindowFull(market);
      checkQualification(market);
      if (market.qualified && !state.activeTrade && digit === 9) {
        if (!state.selectedMarket || state.selectedMarket !== sym) state.selectedMarket = sym;
        market.entryDigit = digit;
        state.activeTrade = true; state.currentTradingMarket = sym;
        send({ buy: 1, price: cfg.stake, parameters: {
          contract_type: 'DIGITUNDER', symbol: sym, duration: 1, duration_unit: 't',
          barrier: '9', amount: cfg.stake, basis: 'stake', currency: 'USD'
        }, req_id: nextId() });
      }
    }
    if (data.msg_type === 'buy') {
      if (data.error) { state.activeTrade = false; state.selectedMarket = null; state.currentTradingMarket = null; return; }
      state.currentContractId = data.buy.contract_id;
      cfg.broadcast('trade_open', { botName: cfg.botName, contractId: state.currentContractId, market: state.currentTradingMarket || 'UNDER9', contractType: 'Under 9' });
      send({ proposal_open_contract: 1, contract_id: state.currentContractId, subscribe: 1, req_id: nextId() });
    }
    if (data.msg_type === 'proposal_open_contract') {
      const c = data.proposal_open_contract;
      if (!c || !c.is_sold) return;
      const profit = parseFloat(c.profit);
      const won    = profit > 0;
      state.runs++;
      state.totalProfit += won ? profit : 0;
      state.totalLoss   += won ? 0 : Math.abs(profit);
      const tm = state.markets[state.currentTradingMarket];
      if (won) { state.wins++; state.consecutiveLosses = 0; if (tm) resetFilters(tm); }
      else     { state.losses++; state.consecutiveLosses++; if (tm) applyLossFilters(tm); }
      cfg.broadcast('trade_result', { botName: cfg.botName, market: state.currentTradingMarket, contractId: state.currentContractId, won: won, profit: profit, contractType: 'Under 9' });
      cfg.broadcast('pnl_update', { botName: cfg.botName, totalProfit: state.totalProfit, totalLoss: state.totalLoss, runs: state.runs, wins: state.wins, losses: state.losses });
      const net = state.totalProfit - state.totalLoss;
      const shouldStop = state.runs >= cfg.maxRuns || state.consecutiveLosses >= 3 ||
        net <= -Math.abs(cfg.sl) || net >= Math.abs(cfg.tp);
      if (shouldStop) { stopBotByName(cfg.botName); cfg.onStop(cfg.botName); return; }
      state.activeTrade = false; state.currentContractId = null;
      state.selectedMarket = null; state.currentTradingMarket = null;
      MARKETS.forEach(s => { state.markets[s].qualified = false; state.markets[s].entryDigit = null; });
    }
  };

  ws.onclose = function() { if (isBotActive()) { stopBotByName(cfg.botName); cfg.onStop(cfg.botName); } };
}

/* ═══════════════════════════════════════════════════════════════
   EVEN / ODD BOT
   Window  : 1000-tick rolling window per market
   Qualify : Count of even digits >= 10% vs count of odd digits >= 10%;
             whichever side has more qualifiers → that is the market type.
             Draw (equal counts) → no trade.
   Cooldown: After a loss, market enters 30s cooldown then must show
             changed digit percentages before re-activating.
   Entry   : Even market → 2 consecutive odd ticks  → DIGITEVEN, 1 tick
             Odd market  → 2 consecutive even ticks → DIGITODD,  1 tick
═══════════════════════════════════════════════════════════════ */
function runEvenOddBot(cfg) {
  const MARKETS           = ['1HZ10V','1HZ25V','1HZ30V','1HZ50V','1HZ75V','1HZ100V','1HZ90V','R_10','R_25','R_50','R_75','R_100'];
  const WINDOW_TICKS      = 1000;
  const QUALIFY_THRESHOLD = 10.0;
  const ENTRY_CONSECUTIVE = 2;
  const COOLDOWN_MS       = 30000;

  const ws = new NodeWebSocket(WS_URL);
  // ws registered below in activeBotInstances
  if (activeBotInstances[botNameToKey(cfg.botName)]) activeBotInstances[botNameToKey(cfg.botName)].ws = ws;

  function isBotActive() {
    const k = botNameToKey(cfg.botName);
    return !!(activeBotInstances[k] && activeBotInstances[k].running);
  }

  const state = {
    activeTrade: false, currentContractId: null,
    selectedMarket: null, currentTradingMarket: null, currentTradeType: null,
    runs: 0, wins: 0, losses: 0, consecutiveLosses: 0,
    totalProfit: 0, totalLoss: 0, currentBalance: 0,
    markets: {}, pipSizes: {}, reqId: 1000
  };

  MARKETS.forEach(sym => {
    state.markets[sym] = {
      symbol: sym, ticks: [], qualified: false, marketType: null,
      consecutiveCount: 0, windowFull: false,
      inCooldown: false, cooldownEndTime: null, lossPercentages: null
    };
  });

  function send(msg)  { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
  function nextId()   { return state.reqId++; }

  function getLastDigit(price, sym) {
    const pip = state.pipSizes[sym] || 0.01;
    const dec = Math.abs(Math.log10(pip));
    const fmt = price.toFixed(dec);
    return parseInt(fmt.charAt(fmt.length - 1));
  }

  function addTick(market, price, timestamp) {
    const digit = getLastDigit(price, market.symbol);
    market.ticks.push({ digit, time: timestamp || Date.now() });
    if (market.ticks.length > WINDOW_TICKS) market.ticks.shift();
    return digit;
  }

  function calcPcts(market) {
    if (!market.ticks.length) return Array(10).fill(0);
    const counts = Array(10).fill(0);
    market.ticks.forEach(t => counts[t.digit]++);
    return counts.map(c => (c / market.ticks.length) * 100);
  }

  function snapshotPcts(market) {
    return calcPcts(market).map(p => parseFloat(p.toFixed(2)));
  }

  function pctChanged(market) {
    if (!market.lossPercentages) return true;
    const cur = snapshotPcts(market);
    for (let i = 0; i <= 9; i++) { if (cur[i] !== market.lossPercentages[i]) return true; }
    return false;
  }

  function checkCooldown(market) {
    if (!market.inCooldown) return false;
    if (Date.now() < market.cooldownEndTime) return true;
    if (!pctChanged(market)) return true;
    // Cooldown expired and percentages changed — release
    market.inCooldown = false; market.cooldownEndTime = null; market.lossPercentages = null;
    return false;
  }

  function enterCooldown(market) {
    market.inCooldown      = true;
    market.cooldownEndTime = Date.now() + COOLDOWN_MS;
    market.lossPercentages = snapshotPcts(market);
    market.qualified       = false;
    market.marketType      = null;
    market.consecutiveCount= 0;
  }

  function checkQualification(market) {
    if (!market.windowFull) { market.qualified = false; market.marketType = null; return false; }
    const pcts = calcPcts(market);
    let evenCount = 0, oddCount = 0;
    [0,2,4,6,8].forEach(d => { if (pcts[d] >= QUALIFY_THRESHOLD) evenCount++; });
    [1,3,5,7,9].forEach(d => { if (pcts[d] >= QUALIFY_THRESHOLD) oddCount++; });
    const diff = evenCount - oddCount;
    if (diff === 0) { market.qualified = false; market.marketType = null; return false; }
    market.qualified  = true;
    market.marketType = diff > 0 ? 'EVEN' : 'ODD';
    return true;
  }

  function checkEntryTrigger(market, digit) {
    // Even market waits for opposing (odd) ticks; Odd market waits for opposing (even) ticks
    const opposing = market.marketType === 'EVEN' ? (digit % 2 !== 0) : (digit % 2 === 0);
    if (opposing) market.consecutiveCount++; else market.consecutiveCount = 0;
    if (market.consecutiveCount >= ENTRY_CONSECUTIVE) { market.consecutiveCount = 0; return true; }
    return false;
  }

  ws.onopen = () => send({ authorize: cfg.token });

  ws.onmessage = function(e) {
    if (!isBotActive()) return;
    const data = JSON.parse(e.data);
    if (data.error) return;

    if (data.msg_type === 'authorize') {
      send({ balance: 1, subscribe: 1, req_id: nextId() });
      send({ active_symbols: 'brief', product_type: 'basic', req_id: nextId() });
    }
    if (data.msg_type === 'balance') {
      state.currentBalance = parseFloat(data.balance.balance);
      cfg.broadcast('balance_update', { botName: cfg.botName, balance: state.currentBalance });
    }
    if (data.msg_type === 'active_symbols') {
      data.active_symbols.forEach(s => { if (MARKETS.includes(s.symbol)) state.pipSizes[s.symbol] = parseFloat(s.pip); });
      MARKETS.forEach(sym => send({ ticks: sym, subscribe: 1, req_id: nextId() }));
    }
    if (data.msg_type === 'tick') {
      const sym    = data.tick.symbol;
      const market = state.markets[sym];
      if (!market) return;
      const digit = addTick(market, parseFloat(data.tick.quote), data.tick.epoch * 1000);
      if (!market.windowFull && market.ticks.length >= WINDOW_TICKS) market.windowFull = true;
      if (checkCooldown(market)) return;
      checkQualification(market);
      if (market.qualified && !state.activeTrade && !market.inCooldown) {
        if (!state.selectedMarket || state.selectedMarket === sym) {
          state.selectedMarket = sym;
          if (checkEntryTrigger(market, digit)) {
            state.activeTrade      = true;
            state.currentTradeType = market.marketType;
            state.currentTradingMarket = sym;
            send({ buy: 1, price: cfg.stake, parameters: {
              contract_type: market.marketType === 'EVEN' ? 'DIGITEVEN' : 'DIGITODD',
              symbol: sym, duration: 1, duration_unit: 't',
              amount: cfg.stake, basis: 'stake', currency: 'USD'
            }, req_id: nextId() });
          }
        }
      }
    }
    if (data.msg_type === 'buy') {
      if (data.error) {
        state.activeTrade = false; state.selectedMarket = null;
        state.currentTradingMarket = null; state.currentTradeType = null; return;
      }
      state.currentContractId = data.buy.contract_id;
      cfg.broadcast('trade_open', { botName: cfg.botName, contractId: state.currentContractId, market: state.currentTradingMarket || 'EVENODD', contractType: state.currentTradeType === 'EVEN' ? 'Even' : 'Odd' });
      send({ proposal_open_contract: 1, contract_id: state.currentContractId, subscribe: 1, req_id: nextId() });
    }
    if (data.msg_type === 'proposal_open_contract') {
      const c = data.proposal_open_contract;
      if (!c || !c.is_sold) return;
      const profit = parseFloat(c.profit);
      const won    = profit > 0;
      state.runs++;
      state.totalProfit += won ? profit : 0;
      state.totalLoss   += won ? 0 : Math.abs(profit);
      if (won) { state.wins++; state.consecutiveLosses = 0; }
      else {
        state.losses++; state.consecutiveLosses++;
        if (state.markets[state.currentTradingMarket]) enterCooldown(state.markets[state.currentTradingMarket]);
      }
      cfg.broadcast('trade_result', { botName: cfg.botName, market: state.currentTradingMarket, contractId: state.currentContractId, won: won, profit: profit, contractType: state.currentTradeType === 'EVEN' ? 'Even' : 'Odd' });
      cfg.broadcast('pnl_update', { botName: cfg.botName, totalProfit: state.totalProfit, totalLoss: state.totalLoss, runs: state.runs, wins: state.wins, losses: state.losses });
      const net = state.totalProfit - state.totalLoss;
      const shouldStop = state.runs >= cfg.maxRuns || state.consecutiveLosses >= 3 ||
        net <= -Math.abs(cfg.sl) || net >= Math.abs(cfg.tp);
      if (shouldStop) { stopBotByName(cfg.botName); cfg.onStop(cfg.botName); return; }
      state.activeTrade = false; state.currentContractId = null;
      state.selectedMarket = null; state.currentTradingMarket = null; state.currentTradeType = null;
      MARKETS.forEach(s => {
        if (!state.markets[s].inCooldown) { state.markets[s].qualified = false; state.markets[s].marketType = null; }
        state.markets[s].consecutiveCount = 0;
      });
    }
  };

  ws.onclose = function() { if (isBotActive()) { stopBotByName(cfg.botName); cfg.onStop(cfg.botName); } };
}

/* ═══════════════════════════════════════════════════════════════
   ACCUMULATORS BOT
   Strategy : Monitors ticks_stayed_in resets across all markets;
              builds a 20-reset history per market.
              Eligibility: avg of last 20 resets >= 15, min of last 10 >= 5,
              min of all 20 >= 2.
   Entry    : On the next reset after a market is armed  →  ACCU contract
   Per-run TP: 10% of stake (e.g. $10 stake → $1.00 take_profit sent to Deriv)
   Session  : Stops on cfg.maxRuns, 3 consecutive losses, or session SL hit.
              Session TP (cfg.tp) checked against cumulative net P&L.
═══════════════════════════════════════════════════════════════ */
function runAccumulatorsBot(cfg) {
  const MARKETS     = ['R_10','R_25','R_50','R_75','R_100','1HZ10V','1HZ25V','1HZ30V','1HZ50V','1HZ75V','1HZ90V','1HZ100V'];
  const GROWTH_RATE = 0.05;

  const ws = new NodeWebSocket(WS_URL);
  // ws registered below in activeBotInstances
  if (activeBotInstances[botNameToKey(cfg.botName)]) activeBotInstances[botNameToKey(cfg.botName)].ws = ws;

  function isBotActive() {
    const k = botNameToKey(cfg.botName);
    return !!(activeBotInstances[k] && activeBotInstances[k].running);
  }

  const state = {
    runs: 0, wins: 0, losses: 0, consecutiveLosses: 0,
    totalProfit: 0, totalLoss: 0,
    activeTrade: false, tradeLocked: false, selectedMarket: null,
    reqId: 1, marketState: {}, reqIdToSymbol: {}
  };

  MARKETS.forEach(sym => {
    state.marketState[sym] = {
      lastTicksStayed: null, changes: [],
      ready: false, eligible: false, armedForEntry: false
    };
  });

  function send(msg)  { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
  function nextId()   { return state.reqId++; }

  function evaluateMarket(symbol) {
    const s = state.marketState[symbol];
    if (!s.ready) return;
    const avg20 = s.changes.reduce((a, b) => a + b, 0) / 20;
    const min10 = Math.min(...s.changes.slice(-10));
    const min20 = Math.min(...s.changes);
    if (avg20 >= 15 && min10 >= 5 && min20 >= 2) {
      s.eligible = true;
      if (!state.selectedMarket) { state.selectedMarket = symbol; s.armedForEntry = true; }
    }
  }

  ws.onopen = () => send({ authorize: cfg.token });

  ws.onmessage = function(e) {
    if (!isBotActive()) return;
    const data = JSON.parse(e.data);
    if (data.error) return;

    if (data.msg_type === 'authorize') {
      MARKETS.forEach(sym => {
        const rid = nextId();
        state.reqIdToSymbol[rid] = sym;
        send({ proposal: 1, subscribe: 1, contract_type: 'ACCU', symbol: sym,
               amount: 1, basis: 'stake', growth_rate: GROWTH_RATE, currency: 'USD', req_id: rid });
      });
    }

    if (data.msg_type === 'proposal') {
      const sym = state.reqIdToSymbol[data.req_id];
      if (!sym) return;
      const ms      = state.marketState[sym];
      const ticksArr= data.proposal?.contract_details?.ticks_stayed_in;
      if (!Array.isArray(ticksArr)) return;
      const current = ticksArr[0];
      const prev    = ms.lastTicksStayed;
      ms.lastTicksStayed = current;
      // A reset is detected when ticks_stayed_in drops back to 0
      if (prev !== null && current === 0) {
        ms.changes.push(prev);
        if (ms.changes.length > 20) ms.changes.shift();
        if (ms.changes.length === 20 && !ms.ready) ms.ready = true;
        if (ms.changes.length >= 20) evaluateMarket(sym);
        // Fire trade on reset after armed
        if (sym === state.selectedMarket && ms.armedForEntry && !state.activeTrade && !state.tradeLocked) {
          ms.armedForEntry = false;
          state.activeTrade = true;
          state.tradeLocked = true;
          // Per-run TP = 10% of stake (strategy-defined, not user-configurable)
          const perRunTp = parseFloat((cfg.stake * 0.10).toFixed(2));
          send({ buy: 1, price: cfg.stake, parameters: {
            amount: cfg.stake, basis: 'stake', contract_type: 'ACCU', symbol: sym,
            currency: 'USD', growth_rate: GROWTH_RATE, limit_order: { take_profit: perRunTp }
          }});
        }
      }
    }

    if (data.msg_type === 'buy') {
      if (data.error) { state.activeTrade = false; state.tradeLocked = false; return; }
      state.runs++;
      cfg.broadcast('trade_open', { botName: cfg.botName, contractId: data.buy.contract_id, market: state.selectedMarket || 'ACCU', contractType: 'Accumulator' });
      send({ proposal_open_contract: 1, contract_id: data.buy.contract_id, subscribe: 1 });
    }

    if (data.msg_type === 'proposal_open_contract') {
      const c = data.proposal_open_contract;
      if (!c || !c.is_sold) return;
      const profit = parseFloat(c.profit);
      const won    = profit > 0;
      state.activeTrade = false; state.tradeLocked = false;
      state.totalProfit += won ? profit : 0;
      state.totalLoss   += won ? 0 : Math.abs(profit);
      if (won) { state.wins++; state.consecutiveLosses = 0; }
      else     { state.losses++; state.consecutiveLosses++; }
      cfg.broadcast('trade_result', { botName: cfg.botName, market: state.selectedMarket || 'ACCU', contractId: c.contract_id, won: won, profit: profit, contractType: 'Accumulator' });
      cfg.broadcast('pnl_update', { botName: cfg.botName, totalProfit: state.totalProfit, totalLoss: state.totalLoss, runs: state.runs, wins: state.wins, losses: state.losses });
      const net = state.totalProfit - state.totalLoss;
      // Accumulators: SL + maxRuns + consecutive losses + session TP all checked
      const shouldStop = state.runs >= cfg.maxRuns || state.consecutiveLosses >= 3 ||
        net <= -Math.abs(cfg.sl) || net >= Math.abs(cfg.tp);
      if (shouldStop) { stopBotByName(cfg.botName); cfg.onStop(cfg.botName); return; }
      state.selectedMarket = null;
      MARKETS.forEach(m => { state.marketState[m].eligible = false; state.marketState[m].armedForEntry = false; });
    }
  };

  ws.onclose = function() { if (isBotActive()) { stopBotByName(cfg.botName); cfg.onStop(cfg.botName); } };
}

/* ═══════════════════════════════════════════════════════════════
   RISE / FALL BOT
   Engine  : Full price-action engine — swing detection, S/R zone
             building (with merge tolerance), trend detection via
             consecutive HH/HL (UP) or LH/LL (DOWN) structure,
             momentum confirmation (body/range >= 0.5).
   Scan    : Re-selects best market every 5 minutes and on candle close.
   Cooldown: 2 candles after a loss before next trade.
   Contracts: CALL (RISE) or PUT (FALL), 2-minute duration.
   Early exit:
     - Profit >= 50% of stake in first 50s  → sell early
     - Loss   >= 50% of stake in last 45s   → sell early
═══════════════════════════════════════════════════════════════ */
function runRiseFallBot(cfg) {
  const MARKETS             = ['R_10','R_25','R_50','R_75','R_100','1HZ10V','1HZ25V','1HZ50V','1HZ75V','1HZ100V'];
  const CANDLE_COUNT        = 100;
  const GRANULARITY         = 60;
  const ZONE_TOLERANCE      = 2.5;
  const ZONE_MERGE_DIST     = 3.0;
  const MOMENTUM_RATIO      = 0.5;
  const MIN_SWINGS          = 3;
  const DURATION            = 2;
  const DURATION_UNIT       = 'm';
  const COOLDOWN_CANDLES    = 2;
  const SCAN_INTERVAL_MS    = 300000;
  const EARLY_PROFIT_PCT    = 0.50;
  const EARLY_LOSS_PCT      = 0.50;
  const EARLY_PROFIT_WINDOW_S = 50;
  const EARLY_LOSS_WINDOW_S   = 45;

  const ws = new NodeWebSocket(WS_URL);
  // ws registered below in activeBotInstances
  if (activeBotInstances[botNameToKey(cfg.botName)]) activeBotInstances[botNameToKey(cfg.botName)].ws = ws;

  function isBotActive() {
    const k = botNameToKey(cfg.botName);
    return !!(activeBotInstances[k] && activeBotInstances[k].running);
  }

  const state = {
    runs: 0, wins: 0, losses: 0, consecutiveLosses: 0,
    totalProfit: 0, totalLoss: 0, currentBalance: 0,
    activeTrade: false, activeContract: null, currentContractId: null,
    selectedMarket: null, cooldownRemaining: 0,
    reqId: 1000, candles: {}, currentCandle: {}, zones: {}, trend: {},
    // Contract tracking state (set when trade opens)
    _settle: null, _startTime: 0, _durationS: 0, _buyPrice: 0, _monitorInterval: null,
    _scanInterval: null
  };

  MARKETS.forEach(sym => {
    state.candles[sym]       = [];
    state.currentCandle[sym] = null;
    state.zones[sym]         = [];
    state.trend[sym]         = 'RANGE';
  });

  function send(msg)  { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
  function nextId()   { return state.reqId++; }

  /* ── Price-action analysis ── */
  function detectSwings(candles) {
    const highs = [], lows = [];
    for (let i = 1; i < candles.length - 1; i++) {
      const prev = candles[i-1], c = candles[i], next = candles[i+1];
      if (c.high >= prev.high && c.high >= next.high) highs.push({ price: c.high, epoch: c.epoch });
      if (c.low  <= prev.low  && c.low  <= next.low)  lows.push({ price: c.low,  epoch: c.epoch });
    }
    return { highs, lows };
  }

  function buildZones(swings) {
    const raw = [];
    swings.highs.forEach(h => raw.push({ price: h.price, type: 'resistance' }));
    swings.lows.forEach(l  => raw.push({ price: l.price, type: 'support'    }));
    raw.sort((a, b) => a.price - b.price);
    const merged = [];
    raw.forEach(z => {
      const last = merged[merged.length - 1];
      if (last && Math.abs(z.price - last.price) < ZONE_MERGE_DIST) {
        last.price = (last.price + z.price) / 2;
      } else {
        merged.push({ price: z.price, type: z.type });
      }
    });
    return merged;
  }

  function detectTrend(swings) {
    const n     = MIN_SWINGS;
    const highs = swings.highs.slice(-n);
    const lows  = swings.lows.slice(-n);
    if (highs.length < n || lows.length < n) return 'RANGE';
    let decH = true, decL = true, incH = true, incL = true;
    for (let i = 1; i < highs.length; i++) {
      if (highs[i].price >= highs[i-1].price) decH = false;
      if (highs[i].price <= highs[i-1].price) incH = false;
    }
    for (let i = 1; i < lows.length; i++) {
      if (lows[i].price >= lows[i-1].price) decL = false;
      if (lows[i].price <= lows[i-1].price) incL = false;
    }
    if (decH && decL) return 'DOWN';
    if (incH && incL) return 'UP';
    return 'RANGE';
  }

  function isMomentum(candle) {
    const body  = Math.abs(candle.close - candle.open);
    const range = candle.high - candle.low;
    return range > 0 && (body / range) >= MOMENTUM_RATIO;
  }

  function nearZone(price, zones, type) {
    return zones.some(z => z.type === type && Math.abs(price - z.price) <= ZONE_TOLERANCE);
  }

  function analyzeMarket(sym) {
    const candles = state.candles[sym];
    if (candles.length < 10) return null;
    const swings = detectSwings(candles);
    const zones  = buildZones(swings);
    const trend  = detectTrend(swings);
    state.zones[sym] = zones;
    state.trend[sym] = trend;
    const last     = candles[candles.length - 1];
    const price    = last.close;
    const bullish  = last.close > last.open;
    const bearish  = last.close < last.open;
    const momentum = isMomentum(last);
    let signal = null;
    if (trend === 'UP') {
      if (nearZone(price, zones, 'support')    && bullish && momentum) signal = 'RISE';
    } else if (trend === 'DOWN') {
      if (nearZone(price, zones, 'resistance') && bearish && momentum) signal = 'FALL';
    } else {
      if (nearZone(price, zones, 'support')    && bullish && momentum) signal = 'RISE';
      if (nearZone(price, zones, 'resistance') && bearish && momentum) signal = 'FALL';
    }
    const trendBonus = trend !== 'RANGE' ? 2 : 1;
    const score      = zones.length * trendBonus + (signal ? 5 : 0);
    return { symbol: sym, trend, zones, signal, score, price };
  }

  function selectBestMarket() {
    if (!isBotActive()) return;
    const results = [];
    MARKETS.forEach(sym => {
      if (state.candles[sym].length < 10) return;
      const a = analyzeMarket(sym);
      if (a) results.push(a);
    });
    results.sort((a, b) => b.score - a.score);
    if (results.length > 0) state.selectedMarket = results[0].symbol;
  }

  /* ── Candle close handler ── */
  function onCandleClose(sym, closed) {
    const candles = state.candles[sym];
    if (candles.length && candles[candles.length - 1].epoch === closed.epoch) return;
    candles.push(closed);
    if (candles.length > CANDLE_COUNT) candles.shift();
    if (state.activeContract) return;   // don't re-scan while trade is live
    if (sym !== state.selectedMarket) return;
    if (!isBotActive()) return;
    if (state.cooldownRemaining > 0) { state.cooldownRemaining--; return; }
    const a = analyzeMarket(sym);
    if (!a || !a.signal) return;
    executeTrade(sym, a.signal);
  }

  /* ── Trade execution ── */
  function executeTrade(sym, direction) {
    if (!isBotActive() || state.activeContract) return;
    state.activeContract = { symbol: sym, direction, buyPrice: cfg.stake };
    send({ proposal: 1, amount: cfg.stake, basis: 'stake',
           contract_type: direction === 'RISE' ? 'CALL' : 'PUT',
           currency: 'USD', duration: DURATION, duration_unit: DURATION_UNIT,
           symbol: sym, req_id: nextId() });
  }

  /* ── Contract tracking with early-exit monitoring ── */
  function trackContract(contractId, sym, buyPrice) {
    let settled   = false;
    const startTime = Date.now();
    const durationS = DURATION * 60;

    function settle(soldPrice, won) {
      if (settled) return;
      settled = true;
      clearInterval(monitorInterval);
      state.activeTrade      = false;
      state.activeContract   = null;
      state.currentContractId= null;
      state._settle          = null;
      const profit = won ? parseFloat((soldPrice - buyPrice).toFixed(2)) : 0;
      const loss   = won ? 0 : parseFloat((buyPrice - soldPrice).toFixed(2));
      state.runs++;
      state.totalProfit += profit;
      state.totalLoss   += loss;
      if (won) { state.wins++; state.consecutiveLosses = 0; }
      else     { state.losses++; state.consecutiveLosses++; state.cooldownRemaining = COOLDOWN_CANDLES; }
      const direction = state.activeContract ? (state.activeContract.direction === 'RISE' ? 'Rise' : 'Fall') : (won ? 'Rise' : 'Fall');
      cfg.broadcast('trade_result', { botName: cfg.botName, market: sym, contractId: contractId, won: won, profit: won ? profit : -loss, contractType: direction });
      cfg.broadcast('pnl_update', { botName: cfg.botName, totalProfit: state.totalProfit, totalLoss: state.totalLoss, runs: state.runs, wins: state.wins, losses: state.losses });
      const net = state.totalProfit - state.totalLoss;
      const shouldStop = state.runs >= cfg.maxRuns || state.consecutiveLosses >= 3 ||
        net <= -Math.abs(cfg.sl) || net >= Math.abs(cfg.tp);
      if (shouldStop) { stopBotByName(cfg.botName); cfg.onStop(cfg.botName); return; }
      selectBestMarket();
    }

    // Poll every 2s for P&L monitoring and early-exit checks
    const monitorInterval = setInterval(function() {
      if (settled || !isBotActive()) { clearInterval(monitorInterval); return; }
      send({ proposal_open_contract: 1, contract_id: contractId, req_id: nextId() });
    }, 2000);

    // Store settle + context on state so the onmessage handler can reach it
    state._settle     = settle;
    state._startTime  = startTime;
    state._durationS  = durationS;
    state._buyPrice   = buyPrice;
    state._monitorInterval = monitorInterval;

    // Fallback hard poll after full duration + 15s safety buffer
    setTimeout(function() {
      if (settled) return;
      send({ proposal_open_contract: 1, contract_id: contractId, req_id: nextId() });
    }, (durationS + 15) * 1000);
  }

  ws.onopen = () => send({ authorize: cfg.token });

  ws.onmessage = function(e) {
    if (!isBotActive()) return;
    const data = JSON.parse(e.data);
    if (data.error) return;

    if (data.msg_type === 'authorize') {
      send({ balance: 1, subscribe: 1, req_id: nextId() });
      // Fetch historical candles for every market
      MARKETS.forEach(sym => send({
        ticks_history: sym, granularity: GRANULARITY, count: CANDLE_COUNT,
        end: 'latest', style: 'candles', req_id: nextId()
      }));
    }

    if (data.msg_type === 'balance') {
      state.currentBalance = parseFloat(data.balance.balance);
      cfg.broadcast('balance_update', { botName: cfg.botName, balance: state.currentBalance });
    }

    if (data.msg_type === 'candles') {
      const raw = data.candles || [];
      if (!raw.length) return;
      // Assign to the first market that still has no candles
      const sym = MARKETS.find(s => state.candles[s].length === 0);
      if (sym) {
        state.candles[sym] = raw.map(c => ({
          open: parseFloat(c.open), high: parseFloat(c.high),
          low:  parseFloat(c.low),  close: parseFloat(c.close), epoch: c.epoch
        }));
      }
      // Once all markets have candle history, start live OHLC streams
      if (MARKETS.every(s => state.candles[s].length > 0)) {
        selectBestMarket();
        MARKETS.forEach(s => send({
          ticks_history: s, granularity: GRANULARITY, end: 'latest',
          count: 1, style: 'candles', subscribe: 1, req_id: nextId()
        }));
        if (!state._scanInterval) {
          state._scanInterval = setInterval(function() {
            if (!isBotActive()) { clearInterval(state._scanInterval); return; }
            selectBestMarket();
          }, SCAN_INTERVAL_MS);
        }
      }
    }

    if (data.msg_type === 'ohlc') {
      const o = data.ohlc;
      if (!o) return;
      const candle = {
        open: parseFloat(o.open), high: parseFloat(o.high),
        low:  parseFloat(o.low),  close: parseFloat(o.close), epoch: o.epoch
      };
      const prev = state.currentCandle[o.symbol];
      if (prev && prev.epoch !== candle.epoch) onCandleClose(o.symbol, prev);
      state.currentCandle[o.symbol] = candle;
    }

    if (data.msg_type === 'proposal') {
      if (!data.proposal) return;
      // Proposal received → immediately buy
      send({ buy: data.proposal.id, price: cfg.stake, req_id: nextId() });
    }

    if (data.msg_type === 'buy') {
      if (data.error) { state.activeTrade = false; state.activeContract = null; return; }
      state.currentContractId = data.buy.contract_id;
      state.activeTrade = true;
      const buyPrice = parseFloat(data.buy.buy_price);
      if (state.activeContract) state.activeContract.buyPrice = buyPrice;
      const direction = state.activeContract ? state.activeContract.direction : '';
      cfg.broadcast('trade_open', { botName: cfg.botName, contractId: state.currentContractId, market: state.activeContract?.symbol || state.selectedMarket || 'RISEFALL', contractType: direction === 'RISE' ? 'Rise' : 'Fall' });
      send({ proposal_open_contract: 1, contract_id: state.currentContractId, subscribe: 1, req_id: nextId() });
      trackContract(state.currentContractId, state.activeContract?.symbol || state.selectedMarket, buyPrice);
    }

    if (data.msg_type === 'proposal_open_contract') {
      const poc = data.proposal_open_contract;
      if (!poc || !state._settle) return;
      // If contract already sold, settle immediately
      if (poc.is_sold || poc.status === 'won' || poc.status === 'lost') {
        const soldPrice   = parseFloat(poc.sell_price || 0);
        const derivProfit = parseFloat(poc.profit || 0);
        state._settle(soldPrice, derivProfit >= 0);
        return;
      }
      const elapsed    = Math.floor((Date.now() - state._startTime) / 1000);
      const remaining  = Math.max(0, state._durationS - elapsed);
      const buyPrice   = state._buyPrice;
      const currentVal = parseFloat(poc.bid_price || 0);
      // Skip early-exit checks if bid_price is not yet priced (0 or within first 5s)
      if (currentVal <= 0 || elapsed < 5) return;
      const pl = currentVal - buyPrice;
      // Early profit: gain >= 50% of stake within first 50s
      if (elapsed <= EARLY_PROFIT_WINDOW_S && pl >= buyPrice * EARLY_PROFIT_PCT) {
        // Forget the settle ref to prevent double-settle from lingering poc subscription
        const settleFn = state._settle;
        state._settle = null;
        send({ sell: poc.contract_id, price: 0, req_id: nextId() });
        // Use sell response to settle; fallback after 10s if sell response missing
        state._settle = settleFn;
        return;
      }
      // Early loss: loss >= 50% of stake within last 45s
      if (remaining <= EARLY_LOSS_WINDOW_S && pl <= -(buyPrice * EARLY_LOSS_PCT)) {
        const settleFn = state._settle;
        state._settle = null;
        send({ sell: poc.contract_id, price: 0, req_id: nextId() });
        state._settle = settleFn;
        return;
      }
    }

    if (data.msg_type === 'sell') {
      // Response to an early-close sell request
      if (!data.sell || !state._settle) return;
      const soldPrice = parseFloat(data.sell.sold_for || 0);
      state._settle(soldPrice, soldPrice > state._buyPrice);
    }
  };

  ws.onclose = function() { if (isBotActive()) { stopBotByName(cfg.botName); cfg.onStop(cfg.botName); } };
}
