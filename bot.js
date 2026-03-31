/**
 * LC79 Tài Xỉu Prediction Bot
 * Node.js + Telegram Bot API
 * Deploy: Render.com
 */

'use strict';

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════
const CONFIG = {
  BOT_TOKEN:    process.env.BOT_TOKEN    || 'YOUR_BOT_TOKEN_HERE',
  ADMIN_ID:     process.env.ADMIN_ID     || 'YOUR_ADMIN_CHAT_ID',
  PORT:         process.env.PORT         || 3000,

  API_V1: 'https://living-telecommunications-start-consoles.trycloudflare.com/api/txmd5',
  API_V2: 'https://lc79-betvip-api-production.up.railway.app/api/lc79_md5?key=apihdx',

  MAX_HISTORY:   1000,
  AUTO_INTERVAL: 60000,
  API_TIMEOUT:   8000,

  KEYS_FILE:   './data/keys.json',
  USERS_FILE:  './data/users.json',
  STATS_FILE:  './data/stats.json',
  HISTORY_FILE:'./data/history.json',
};

// ═══════════════════════════════════════════════════════
//  LOGGER
// ═══════════════════════════════════════════════════════
function ts() { return new Date().toLocaleString('vi-VN'); }
const log = {
  info:  (...a) => console.log(`[${ts()}] [INFO]`, ...a),
  warn:  (...a) => console.warn(`[${ts()}] [WARN]`, ...a),
  error: (...a) => console.error(`[${ts()}] [ERR]`,  ...a),
  ok:    (...a) => console.log(`[${ts()}] [OK]`,   ...a),
};

// ═══════════════════════════════════════════════════════
//  DATA LAYER — JSON
// ═══════════════════════════════════════════════════════
if (!fs.existsSync('./data')) fs.mkdirSync('./data');

function readJSON(file, def = {}) {
  try {
    if (!fs.existsSync(file)) { writeJSON(file, def); return def; }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch(e) { log.error(`readJSON ${file}:`, e.message); return def; }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch(e) { log.error(`writeJSON ${file}:`, e.message); }
}

const DB = {
  get keys()    { return readJSON(CONFIG.KEYS_FILE,    {}); },
  get users()   { return readJSON(CONFIG.USERS_FILE,   {}); },
  get stats()   { return readJSON(CONFIG.STATS_FILE,   {}); },
  get history() { return readJSON(CONFIG.HISTORY_FILE, []); },
  saveKeys(d)    { writeJSON(CONFIG.KEYS_FILE,    d); },
  saveUsers(d)   { writeJSON(CONFIG.USERS_FILE,   d); },
  saveStats(d)   { writeJSON(CONFIG.STATS_FILE,   d); },
  saveHistory(d) { writeJSON(CONFIG.HISTORY_FILE, d); },
};

// ═══════════════════════════════════════════════════════
//  PARSE THỜI GIAN
// ═══════════════════════════════════════════════════════
function parseDuration(str) {
  if (!str) return 30 * 24 * 60 * 60 * 1000;
  str = str.toLowerCase().trim();
  const num = parseFloat(str);
  if (isNaN(num)) return null;
  if (str.endsWith('th')) return num * 30 * 24 * 60 * 60 * 1000;
  if (str.endsWith('t'))  return num * 7  * 24 * 60 * 60 * 1000;
  if (str.endsWith('d'))  return num * 24 * 60 * 60 * 1000;
  if (str.endsWith('h'))  return num * 60 * 60 * 1000;
  if (str.endsWith('p'))  return num * 60 * 1000;
  return null;
}

function formatDuration(ms) {
  const s = ms / 1000;
  if (s < 60)          return `${s.toFixed(0)} giây`;
  if (s < 3600)        return `${(s/60).toFixed(0)} phút`;
  if (s < 86400)       return `${(s/3600).toFixed(1)} giờ`;
  if (s < 2592000)     return `${(s/86400).toFixed(1)} ngày`;
  return `${(s/2592000).toFixed(1)} tháng`;
}

function formatExpiry(exp) {
  if (!exp) return 'Không giới hạn';
  const diff = exp - Date.now();
  if (diff <= 0) return '⛔ Đã hết hạn';
  return `⏳ Còn ${formatDuration(diff)}`;
}

// ═══════════════════════════════════════════════════════
//  API HELPERS (dùng fetch native, không cần node-fetch)
// ═══════════════════════════════════════════════════════
async function apiFetch(url, timeout = CONFIG.API_TIMEOUT) {
  const proxies = ['https://api.allorigins.win/raw?url=', 'https://corsproxy.io/?', ''];
  for (const proxy of proxies) {
    try {
      const fetchUrl = proxy ? proxy + encodeURIComponent(url) : url;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(fetchUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch(e) {}
  }
  throw new Error('All proxies failed');
}

async function fetchV1() {
  const data = await apiFetch(CONFIG.API_V1);
  const item = Array.isArray(data) ? data[0] : (data.data || data);
  if (!item) throw new Error('V1: empty');

  const taiPeople = Number(item.tai_count || item.taiCount || item.nguoi_cuoc?.tai || 0);
  const xiuPeople = Number(item.xiu_count || item.xiuCount || item.nguoi_cuoc?.xiu || 0);
  const taiMoney = Number((item.tai_money || item.taiMoney || item.tien_cuoc?.tai || '0').toString().replace(/\./g, ''));
  const xiuMoney = Number((item.xiu_money || item.xiuMoney || item.tien_cuoc?.xiu || '0').toString().replace(/\./g, ''));
  const phien = Number(item.phien || item.session || 0);

  const totalPeople = taiPeople + xiuPeople || 1;
  const totalMoney = taiMoney + xiuMoney || 1;

  const pTai = 0.5
    + (taiPeople - xiuPeople) / totalPeople * 0.25
    + (taiMoney - xiuMoney) / totalMoney * 0.25;

  const clampedP = Math.min(0.93, Math.max(0.07, pTai));
  const result = clampedP >= 0.5 ? 'tai' : 'xiu';
  const conf = Math.round(Math.max(clampedP, 1 - clampedP) * 100);

  return {
    source: 'V1',
    phien,
    result,
    conf,
    taiPeople, xiuPeople, taiMoney, xiuMoney,
    raw: item,
  };
}

async function fetchV2() {
  const data = await apiFetch(CONFIG.API_V2);
  const item = Array.isArray(data) ? data[0] : (data.data || data);
  if (!item) throw new Error('V2: empty');

  const du_doan = item.du_doan || item.prediction || '';
  const do_tin_cay = Number(item.do_tin_cay || item.confidence || 50);
  const phien = Number(item.phien || 0);
  const ket_qua = item.ket_qua || '';

  let result = du_doan.toLowerCase();
  if (result.includes('tài') || result === 'tai') result = 'tai';
  else if (result.includes('xỉu') || result === 'xiu') result = 'xiu';
  else result = null;

  let actual = ket_qua.toLowerCase();
  if (actual.includes('tài') || actual === 'tai') actual = 'tai';
  else if (actual.includes('xỉu') || actual === 'xiu') actual = 'xiu';
  else actual = null;

  const dice = [
    Number(item.xuc_xac_1 || item.d1 || 0),
    Number(item.xuc_xac_2 || item.d2 || 0),
    Number(item.xuc_xac_3 || item.d3 || 0),
  ];
  const tong = Number(item.tong || dice.reduce((a,b)=>a+b,0));

  return {
    source: 'V2',
    phien,
    result,
    conf: do_tin_cay,
    actual,
    dice,
    tong,
    raw: item,
  };
}

async function fetchV3() {
  const [v1Res, v2Res] = await Promise.allSettled([fetchV1(), fetchV2()]);
  const v1 = v1Res.status === 'fulfilled' ? v1Res.value : null;
  const v2 = v2Res.status === 'fulfilled' ? v2Res.value : null;

  if (v2 && v2.conf >= 60) {
    return { ...v2, source: 'V3(→V2)' };
  }
  if (v1) {
    return { ...v1, source: 'V3(→V1)' };
  }
  if (v2) {
    return { ...v2, source: 'V3(→V2)' };
  }
  throw new Error('Cả V1 và V2 đều thất bại');
}

async function fetchBySource(source) {
  switch (source) {
    case 'V1': return fetchV1();
    case 'V2': return fetchV2();
    default:   return fetchV3();
  }
}

// ═══════════════════════════════════════════════════════
//  HISTORY & STATS
// ═══════════════════════════════════════════════════════
function getHistoryStats() {
  const hist = DB.history;
  if (hist.length < 3) return null;

  const seq = hist.filter(h => h.actual).map(h => h.actual);
  if (seq.length === 0) return null;

  const cur = seq[0];
  let streak = 0;
  for (const v of seq) { if (v === cur) streak++; else break; }

  let breaks = 0;
  for (let i = 0; i < seq.length - 1; i++) if (seq[i] !== seq[i+1]) breaks++;
  const breakRate = breaks / Math.max(seq.length - 1, 1);

  const withPred = hist.filter(h => h.ai_pred && h.actual);
  const correct = withPred.filter(h => h.ai_pred === h.actual).length;
  const accuracy = withPred.length > 0 ? correct / withPred.length : null;

  return { streak, streakVal: cur, breakRate, accuracy, total: hist.length };
}

function updateHistory(phien, actual, aiPred, aiConf, source) {
  let hist = DB.history;
  const existing = hist.find(h => h.phien === phien);
  if (existing) {
    if (actual && !existing.actual) {
      existing.actual = actual;
      if (existing.ai_pred) existing.correct = existing.ai_pred === actual;
    }
    DB.saveHistory(hist);
    return;
  }
  hist.unshift({ phien, actual, ai_pred: aiPred, ai_conf: aiConf, source, ts: Date.now() });
  if (hist.length > CONFIG.MAX_HISTORY) hist = hist.slice(0, CONFIG.MAX_HISTORY);
  DB.saveHistory(hist);
}

// ═══════════════════════════════════════════════════════
//  FORMAT MESSAGES
// ═══════════════════════════════════════════════════════
const DICE_ICONS = { 1:'⚀', 2:'⚁', 3:'⚂', 4:'⚃', 5:'⚄', 6:'⚅' };
function diceStr(arr) {
  return arr.map(d => DICE_ICONS[d] || '🎲').join(' ');
}
function fmtMoney(n) {
  if (n >= 1e9) return (n/1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(0) + 'K';
  return String(n);
}

function formatPrediction(data, histStats) {
  const isTai = data.result === 'tai';
  const icon = isTai ? '🟢' : '🔴';
  const word = isTai ? '⬆️ TÀI' : '⬇️ XỈU';
  const conf = data.conf || 50;
  const bar = '█'.repeat(Math.round(conf/10)) + '░'.repeat(10-Math.round(conf/10));

  let msg = `╔══ 🎯 DỰ ĐOÁN LC79 ══╗\n`;
  msg += `║ ${icon} <b>${word}</b>  |  Tin cậy: <b>${conf}%</b>\n`;
  msg += `║ ${bar}\n`;
  msg += `║ Nguồn: <b>${data.source}</b>\n`;

  if (data.phien) msg += `║ Phiên: <b>${data.phien}</b>\n`;

  if (data.dice && data.dice[0]) {
    msg += `╠══ Phiên vừa xong ══\n`;
    msg += `║ 🎲 ${diceStr(data.dice)} = <b>${data.tong}</b>\n`;
    if (data.actual) {
      const actIcon = data.actual === 'tai' ? '🟢' : '🔴';
      msg += `║ Kết quả: ${actIcon} <b>${data.actual === 'tai' ? 'TÀI' : 'XỈU'}</b>\n`;
    }
  }

  if (data.taiPeople !== undefined) {
    const total = (data.taiPeople + data.xiuPeople) || 1;
    const tPct = Math.round(data.taiPeople / total * 100);
    const xPct = 100 - tPct;
    msg += `╠══ Dữ liệu cược ══\n`;
    msg += `║ 👥 Tài: ${data.taiPeople} (${tPct}%) | Xỉu: ${data.xiuPeople} (${xPct}%)\n`;
    if (data.taiMoney) {
      const totalM = (data.taiMoney + data.xiuMoney) || 1;
      const tmPct = Math.round(data.taiMoney / totalM * 100);
      msg += `║ 💰 Tài: ${fmtMoney(data.taiMoney)} (${tmPct}%) | Xỉu: ${fmtMoney(data.xiuMoney)} (${100-tmPct}%)\n`;
    }
  }

  if (histStats && histStats.total >= 5) {
    const bPct = Math.round(histStats.breakRate * 100);
    const strVal = histStats.streakVal === 'tai' ? 'TÀI' : 'XỈU';
    msg += `╠══ Phân tích cầu ══\n`;
    msg += `║ 📊 Cầu: <b>${strVal} ×${histStats.streak}</b>\n`;
    msg += `║ 🔄 Tỉ lệ bẻ: <b>${bPct}%</b>\n`;
    if (histStats.accuracy !== null) {
      msg += `║ ✅ Độ chính xác AI: <b>${Math.round(histStats.accuracy*100)}%</b> (${histStats.total} ván)\n`;
    }
  }

  msg += `╚══════════════════\n`;
  msg += `<i>⏱ ${ts()} | ${isTai ? '⬆️' : '⬇️'} ${conf < 55 ? 'Tín hiệu yếu' : conf < 65 ? 'Tín hiệu trung bình' : 'Tín hiệu mạnh'}</i>`;
  return msg;
}

// ═══════════════════════════════════════════════════════
//  BOT INIT
// ═══════════════════════════════════════════════════════
log.info('Khởi động bot...');
const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
bot.on('polling_error', (e) => log.error('Polling error:', e.message));
bot.on('error', (e) => log.error('Bot error:', e.message));

function isAdmin(chatId) {
  return String(chatId) === String(CONFIG.ADMIN_ID);
}

function requireAdmin(msg, fn) {
  if (!isAdmin(msg.chat.id)) {
    bot.sendMessage(msg.chat.id, '❌ Lệnh này chỉ dành cho admin.');
    return;
  }
  fn();
}

// ═══════════════════════════════════════════════════════
//  KEY MANAGEMENT
// ═══════════════════════════════════════════════════════
bot.onText(/\/addkey(?:\s+(.+))?/, (msg, match) => {
  requireAdmin(msg, () => {
    const args = (match[1] || '').trim().split(/\s+/);
    const name = args[0] || `KEY_${Date.now()}`;
    const durStr = args[1] || '30d';
    const dur = parseDuration(durStr);
    if (!dur) {
      bot.sendMessage(msg.chat.id, '❌ Định dạng thời gian không hợp lệ.\nVí dụ: 1p, 2h, 7d, 1t, 1th');
      return;
    }
    const code = `${name.toUpperCase()}_${Math.random().toString(36).substr(2,6).toUpperCase()}`;
    const expires = Date.now() + dur;
    const keys = DB.keys;
    keys[code] = { name, code, created: Date.now(), expires, duration: durStr, usedBy: null, createdBy: msg.chat.id };
    DB.saveKeys(keys);
    bot.sendMessage(msg.chat.id,
      `✅ <b>Tạo key thành công!</b>\n\n🔑 Mã key: <code>${code}</code>\n👤 Tên: ${name}\n⏰ Thời hạn: ${durStr} → ${formatExpiry(expires)}\n\n<i>User kích hoạt bằng: /key ${code}</i>`,
      { parse_mode: 'HTML' }
    );
    log.info(`Admin tạo key: ${code} (${durStr})`);
  });
});

bot.onText(/\/delkey(?:\s+(.+))?/, (msg, match) => {
  requireAdmin(msg, () => {
    const code = (match[1] || '').trim().toUpperCase();
    if (!code) { bot.sendMessage(msg.chat.id, '❌ Cú pháp: /delkey MÃ_KEY'); return; }
    const keys = DB.keys;
    if (!keys[code]) { bot.sendMessage(msg.chat.id, `❌ Không tìm thấy key: ${code}`); return; }
    const name = keys[code].name;
    delete keys[code];
    DB.saveKeys(keys);
    bot.sendMessage(msg.chat.id, `✅ Đã xóa key <code>${code}</code> (${name})`, { parse_mode: 'HTML' });
    log.info(`Admin xóa key: ${code}`);
  });
});

bot.onText(/\/keys$/, (msg) => {
  requireAdmin(msg, () => {
    const keys = DB.keys;
    const list = Object.values(keys);
    if (list.length === 0) { bot.sendMessage(msg.chat.id, '📭 Chưa có key nào.'); return; }
    let text = `🔑 <b>Danh sách Keys (${list.length})</b>\n\n`;
    list.forEach((k, i) => {
      const status = !k.expires || k.expires > Date.now() ? (k.usedBy ? '🟢 Đã dùng' : '🟡 Chưa dùng') : '🔴 Hết hạn';
      text += `${i+1}. <code>${k.code}</code>\n   ${status} | ${k.name} | ${formatExpiry(k.expires)}\n`;
      if (k.usedBy) text += `   👤 Dùng bởi: ${k.usedBy}\n`;
      text += '\n';
    });
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
  });
});

bot.onText(/\/users$/, (msg) => {
  requireAdmin(msg, () => {
    const users = DB.users;
    const list = Object.values(users);
    if (list.length === 0) { bot.sendMessage(msg.chat.id, '📭 Chưa có user nào.'); return; }
    let text = `👥 <b>Danh sách Users (${list.length})</b>\n\n`;
    list.forEach((u, i) => {
      const active = u.keyExpires && u.keyExpires > Date.now();
      const auto = u.autoOn ? '▶️' : '⏹';
      text += `${i+1}. ${active ? '🟢' : '🔴'} <b>${u.firstName || u.username || 'N/A'}</b> [${u.id}]\n   ${auto} V${u.source || 3} | ${formatExpiry(u.keyExpires)}\n\n`;
    });
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
  });
});

bot.onText(/\/info(?:\s+(\d+))?/, (msg, match) => {
  requireAdmin(msg, () => {
    const uid = match[1] ? match[1] : String(msg.chat.id);
    const u = DB.users[uid];
    if (!u) { bot.sendMessage(msg.chat.id, `❌ Không tìm thấy user: ${uid}`); return; }
    const s = DB.stats[uid] || {};
    let text = `👤 <b>Thông tin User</b>\n\n🆔 ID: <code>${u.id}</code>\n👤 Tên: ${u.firstName || ''} ${u.lastName || ''}\n🏷 Username: @${u.username || 'N/A'}\n🔑 Key: <code>${u.key || 'N/A'}</code>\n⏰ Hạn key: ${formatExpiry(u.keyExpires)}\n📡 Nguồn: V${u.source || 3}\n▶️ Auto: ${u.autoOn ? 'Bật' : 'Tắt'}\n📅 Kích hoạt: ${u.activatedAt ? new Date(u.activatedAt).toLocaleString('vi') : 'N/A'}\n\n📊 <b>Thống kê</b>\n🎯 Tổng dự đoán: ${s.total || 0}\n✅ Đúng: ${s.correct || 0} (${s.total ? Math.round((s.correct||0)/s.total*100) : 0}%)\n🔄 Lần bẻ cầu đúng: ${s.breakCorrect || 0}\n`;
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
  });
});

bot.onText(/\/deluser\s+(\d+)/, (msg, match) => {
  requireAdmin(msg, () => {
    const uid = match[1];
    const users = DB.users;
    if (!users[uid]) { bot.sendMessage(msg.chat.id, `❌ User ${uid} không tồn tại`); return; }
    const u = users[uid];
    stopUserAuto(uid);
    delete users[uid];
    DB.saveUsers(users);
    bot.sendMessage(msg.chat.id, `✅ Đã xóa user <b>${u.firstName || uid}</b> [${uid}]`, { parse_mode: 'HTML' });
    log.info(`Admin xóa user: ${uid}`);
  });
});

// ═══════════════════════════════════════════════════════
//  USER COMMANDS
// ═══════════════════════════════════════════════════════
function checkActive(uid, msg) {
  const users = DB.users;
  const u = users[uid];
  if (!u || !u.keyExpires || u.keyExpires < Date.now()) {
    bot.sendMessage(uid, '❌ Tài khoản chưa kích hoạt hoặc key đã hết hạn.\nDùng /key MÃ_KEY để kích hoạt.', { parse_mode: 'HTML' });
    return false;
  }
  return true;
}

bot.onText(/\/start$/, (msg) => {
  const uid = String(msg.chat.id);
  const u = DB.users[uid];
  const active = u && u.keyExpires && u.keyExpires > Date.now();
  let text = `🎮 <b>Chào mừng đến LC79 AI Bot!</b>\n\n`;
  if (active) {
    text += `✅ Tài khoản đang hoạt động\n⏰ Hết hạn: ${formatExpiry(u.keyExpires)}\n\n<b>Lệnh:</b>\n• /now — Xem dự đoán ngay\n• /startbot — Bật tự động nhận dự đoán\n• /stop — Tắt tự động\n• /stats — Xem thống kê\n• /V1 /V2 /V3 — Chọn nguồn dự đoán\n`;
  } else {
    text += `🔑 Để sử dụng, hãy kích hoạt key:\n<code>/key MÃ_KEY_CỦA_BẠN</code>\n\n📞 Liên hệ admin để mua key.`;
  }
  bot.sendMessage(uid, text, { parse_mode: 'HTML' });
});

bot.onText(/\/key\s+(.+)/, async (msg, match) => {
  const uid = String(msg.chat.id);
  const code = match[1].trim().toUpperCase();
  const keys = DB.keys;
  const k = keys[code];
  if (!k) { bot.sendMessage(uid, '❌ Key không hợp lệ hoặc không tồn tại.'); return; }
  if (k.expires && k.expires < Date.now()) { bot.sendMessage(uid, '❌ Key này đã hết hạn.'); return; }
  if (k.usedBy && k.usedBy !== uid) { bot.sendMessage(uid, '❌ Key này đã được sử dụng bởi người khác.'); return; }

  k.usedBy = uid;
  DB.saveKeys(keys);
  const users = DB.users;
  users[uid] = {
    id: uid, firstName: msg.from.first_name || '', lastName: msg.from.last_name || '',
    username: msg.from.username || '', key: code, keyExpires: k.expires,
    source: 3, autoOn: false, activatedAt: Date.now(),
  };
  DB.saveUsers(users);
  bot.sendMessage(uid, `✅ <b>Kích hoạt thành công!</b>\n\n🔑 Key: <code>${code}</code>\n⏰ Hạn: ${formatExpiry(k.expires)}\n\n📡 Nguồn mặc định: <b>V3 (Thông minh)</b>\n\n<b>Bắt đầu:</b>\n• /now — Dự đoán ngay\n• /startbot — Tự động 60 giây`, { parse_mode: 'HTML' });
  log.ok(`User ${uid} (${msg.from.first_name}) kích hoạt key ${code}`);
  try {
    await bot.sendMessage(CONFIG.ADMIN_ID, `🔔 <b>User mới kích hoạt key!</b>\n\n👤 ${msg.from.first_name || ''} ${msg.from.last_name || ''} (@${msg.from.username || 'N/A'})\n🆔 ID: <code>${uid}</code>\n🔑 Key: <code>${code}</code>\n⏰ Hạn: ${formatExpiry(k.expires)}\n🕐 Lúc: ${ts()}`, { parse_mode: 'HTML' });
  } catch(e) {}
});

bot.onText(/\/now$/, async (msg) => {
  const uid = String(msg.chat.id);
  if (!checkActive(uid, msg)) return;
  const u = DB.users[uid];
  const loadingMsg = await bot.sendMessage(uid, '⏳ Đang lấy dữ liệu...', { parse_mode: 'HTML' });
  try {
    const data = await fetchBySource(`V${u.source || 3}`);
    const hist = getHistoryStats();
    if (data.phien && data.actual) updateHistory(data.phien, data.actual, data.result, data.conf, data.source);
    const text = formatPrediction(data, hist);
    await bot.editMessageText(text, { chat_id: uid, message_id: loadingMsg.message_id, parse_mode: 'HTML' });
  } catch(e) {
    log.error(`/now error for ${uid}:`, e.message);
    await bot.editMessageText(`❌ Lỗi lấy dữ liệu: ${e.message}`, { chat_id: uid, message_id: loadingMsg.message_id });
  }
});

bot.onText(/\/startbot$/, (msg) => {
  const uid = String(msg.chat.id);
  if (!checkActive(uid, msg)) return;
  const users = DB.users;
  users[uid].autoOn = true;
  DB.saveUsers(users);
  startUserAuto(uid);
  bot.sendMessage(uid, `▶️ <b>Đã bật auto!</b>\nDự đoán sẽ được gửi mỗi <b>60 giây</b>.\nDùng /stop để tắt.`, { parse_mode: 'HTML' });
  log.info(`User ${uid} bật auto`);
});

bot.onText(/\/stop$/, (msg) => {
  const uid = String(msg.chat.id);
  const users = DB.users;
  if (users[uid]) { users[uid].autoOn = false; DB.saveUsers(users); }
  stopUserAuto(uid);
  bot.sendMessage(uid, '⏹ <b>Đã tắt auto.</b>\nDùng /now để lấy dự đoán thủ công.', { parse_mode: 'HTML' });
  log.info(`User ${uid} tắt auto`);
});

bot.onText(/\/stats$/, (msg) => {
  const uid = String(msg.chat.id);
  if (!checkActive(uid, msg)) return;
  const u = DB.users[uid];
  const s = DB.stats[uid] || {};
  const hist = getHistoryStats();
  let text = `📊 <b>Thống kê của bạn</b>\n\n📡 Nguồn: <b>V${u.source || 3}</b>\n▶️ Auto: ${u.autoOn ? 'Đang bật' : 'Đang tắt'}\n⏰ Key: ${formatExpiry(u.keyExpires)}\n\n`;
  if (s.total) {
    const acc = Math.round((s.correct || 0) / s.total * 100);
    text += `🎯 <b>Độ chính xác AI: ${acc}%</b>\n📈 Tổng dự đoán: ${s.total}\n✅ Đúng: ${s.correct || 0} | ❌ Sai: ${s.total - (s.correct||0)}\n\n`;
  } else { text += `📈 Chưa có dữ liệu thống kê\n\n`; }
  if (hist) {
    const bPct = Math.round(hist.breakRate * 100);
    text += `📊 <b>Phân tích cầu (${hist.total} ván)</b>\n🔄 Cầu hiện tại: <b>${hist.streakVal === 'tai' ? 'TÀI' : 'XỈU'} ×${hist.streak}</b>\n🔀 Tỉ lệ bẻ cầu: <b>${bPct}%</b>\n`;
    if (hist.accuracy !== null) text += `🤖 Độ chính xác global: <b>${Math.round(hist.accuracy*100)}%</b>\n`;
  }
  bot.sendMessage(uid, text, { parse_mode: 'HTML' });
});

[1, 2, 3].forEach(v => {
  bot.onText(new RegExp(`^\\/V${v}$`), (msg) => {
    const uid = String(msg.chat.id);
    if (!checkActive(uid, msg)) return;
    const users = DB.users;
    users[uid].source = v;
    DB.saveUsers(users);
    const desc = { 1: 'V1 — Phân tích dữ liệu cược (người + tiền)', 2: 'V2 — Dự đoán ML từ API', 3: 'V3 — Kết hợp thông minh V1+V2' };
    bot.sendMessage(uid, `✅ Đã chuyển sang <b>${desc[v]}</b>`, { parse_mode: 'HTML' });
    log.info(`User ${uid} chuyển sang V${v}`);
  });
});

bot.onText(/\/help$/, (msg) => {
  const uid = String(msg.chat.id);
  let text = `📖 <b>Hướng dẫn sử dụng</b>\n\n<b>Lệnh user:</b>\n• /key MÃ → Kích hoạt key\n• /now → Dự đoán ngay\n• /startbot → Bật auto 60s\n• /stop → Tắt auto\n• /stats → Thống kê cá nhân\n• /V1 /V2 /V3 → Chọn nguồn\n\n`;
  if (isAdmin(uid)) text += `<b>Lệnh admin:</b>\n• /addkey tên [thời gian] → Tạo key\n  Thời gian: 1p 2h 7d 1t 1th\n• /delkey MÃ → Xóa key\n• /keys → Danh sách key\n• /users → Danh sách user\n• /info [ID] → Chi tiết user\n• /deluser ID → Xóa user\n`;
  bot.sendMessage(uid, text, { parse_mode: 'HTML' });
});

// ═══════════════════════════════════════════════════════
//  AUTO SEND SYSTEM
// ═══════════════════════════════════════════════════════
const autoTimers = {};

function startUserAuto(uid) {
  stopUserAuto(uid);
  autoTimers[uid] = setInterval(async () => {
    const users = DB.users;
    const u = users[uid];
    if (!u || !u.autoOn) { stopUserAuto(uid); return; }
    if (u.keyExpires && u.keyExpires < Date.now()) {
      stopUserAuto(uid);
      u.autoOn = false;
      DB.saveUsers(users);
      try {
        bot.sendMessage(uid, '⛔ <b>Key của bạn đã hết hạn!</b>\nAuto đã tắt. Liên hệ admin để gia hạn.', { parse_mode: 'HTML' });
        bot.sendMessage(CONFIG.ADMIN_ID, `⚠️ Key hết hạn: User ${u.firstName || uid} [${uid}]`, { parse_mode: 'HTML' });
      } catch(e) {}
      return;
    }
    try {
      const data = await fetchBySource(`V${u.source || 3}`);
      const hist = getHistoryStats();
      if (data.phien && data.actual) updateHistory(data.phien, data.actual, data.result, data.conf, data.source);
      const text = formatPrediction(data, hist);
      await bot.sendMessage(uid, text, { parse_mode: 'HTML' });
    } catch(e) {
      log.error(`Auto send error for ${uid}:`, e.message);
    }
  }, CONFIG.AUTO_INTERVAL);
  log.info(`Bắt đầu auto cho user ${uid}`);
}

function stopUserAuto(uid) {
  if (autoTimers[uid]) {
    clearInterval(autoTimers[uid]);
    delete autoTimers[uid];
    log.info(`Dừng auto cho user ${uid}`);
  }
}

function restoreAutoUsers() {
  const users = DB.users;
  let count = 0;
  for (const [uid, u] of Object.entries(users)) {
    if (u.autoOn && u.keyExpires && u.keyExpires > Date.now()) {
      startUserAuto(uid);
      count++;
    }
  }
  if (count > 0) log.info(`Khôi phục auto cho ${count} user`);
}

// ═══════════════════════════════════════════════════════
//  KEY EXPIRY CHECKER
// ═══════════════════════════════════════════════════════
setInterval(() => {
  const keys = DB.keys;
  let expired = [];
  for (const [code, k] of Object.entries(keys)) {
    if (k.expires && k.expires < Date.now() && !k.notifiedExpiry) {
      k.notifiedExpiry = true;
      expired.push(code);
    }
  }
  if (expired.length > 0) {
    DB.saveKeys(keys);
    log.info(`Keys hết hạn: ${expired.join(', ')}`);
    try {
      bot.sendMessage(CONFIG.ADMIN_ID, `⚠️ <b>${expired.length} key vừa hết hạn:</b>\n${expired.map(c => `• <code>${c}</code>`).join('\n')}`, { parse_mode: 'HTML' });
    } catch(e) {}
  }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════
//  EXPRESS SERVER
// ═══════════════════════════════════════════════════════
const app = express();
app.use(express.json());
app.get('/', (req, res) => {
  const users = DB.users;
  const activeCount = Object.values(users).filter(u => u.keyExpires && u.keyExpires > Date.now()).length;
  res.json({ status: 'running', uptime: Math.round(process.uptime()) + 's', activeUsers: activeCount, autoUsers: Object.keys(autoTimers).length, time: ts() });
});
app.get('/health', (req, res) => res.send('OK'));
app.listen(CONFIG.PORT, () => log.ok(`Express server chạy trên port ${CONFIG.PORT}`));

// ═══════════════════════════════════════════════════════
//  KHỞI ĐỘNG
// ═══════════════════════════════════════════════════════
restoreAutoUsers();
log.ok('✅ Bot đã khởi động thành công!');
log.info(`Admin ID: ${CONFIG.ADMIN_ID}`);
try {
  bot.sendMessage(CONFIG.ADMIN_ID, `🟢 <b>Bot LC79 đã online!</b>\n🕐 ${ts()}`, { parse_mode: 'HTML' });
} catch(e) {}

process.on('uncaughtException',  (e) => log.error('uncaughtException:', e.message));
process.on('unhandledRejection', (e) => log.error('unhandledRejection:', e));
