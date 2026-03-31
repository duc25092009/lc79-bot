/**
 * LC79 Tài Xỉu Bot – Ultimate Edition (ĐÃ SỬA LỖI)
 * - SQLite database, cache 3s, trọng số động, RSI, dashboard, backup, webhook
 */

'use strict';

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const NodeCache = require('node-cache');
const i18n = require('i18n');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ========== CẤU HÌNH ==========
const CONFIG = {
  BOT_TOKEN:    process.env.BOT_TOKEN    || 'YOUR_BOT_TOKEN_HERE',
  ADMIN_ID:     process.env.ADMIN_ID     || 'YOUR_ADMIN_CHAT_ID',
  PORT:         process.env.PORT         || 3000,
  API_V1:       'https://living-telecommunications-start-consoles.trycloudflare.com/api/txmd5',
  API_V2:       'https://lc79-betvip-api-production.up.railway.app/api/lc79_md5?key=apihdx',
  WEBHOOK_URL:  process.env.WEBHOOK_URL  || '',
  DATA_DIR:     './data',
  DB_PATH:      './data/lc79.db',
  BACKUP_DIR:   './backups',
  AUTO_INTERVAL: 60000,      // 60 giây
  API_TIMEOUT:   6000,       // 6 giây timeout
  CACHE_TTL:     3,          // Cache 3 giây (đủ nhanh)
  MAX_HISTORY:   500,
};

// Tạo thư mục
if (!fs.existsSync(CONFIG.DATA_DIR)) fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
if (!fs.existsSync(CONFIG.BACKUP_DIR)) fs.mkdirSync(CONFIG.BACKUP_DIR, { recursive: true });

// ========== CACHE ==========
const apiCache = new NodeCache({ stdTTL: CONFIG.CACHE_TTL });
let globalPredictionData = null;     // Cache dữ liệu dự đoán cho tất cả user trong 1 phiên
let lastGlobalFetch = 0;

// ========== SQLITE ==========
const db = new sqlite3.Database(CONFIG.DB_PATH);
const promisify = (fn) => (...args) => new Promise((resolve, reject) => {
  fn.call(db, ...args, (err, result) => err ? reject(err) : resolve(result));
});
db.getAsync = promisify(db.get.bind(db));
db.allAsync = promisify(db.all.bind(db));
db.runAsync = promisify(db.run.bind(db));

async function initDB() {
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS keys (
      code TEXT PRIMARY KEY,
      name TEXT,
      created INTEGER,
      expires INTEGER,
      duration TEXT,
      usedBy TEXT,
      createdBy TEXT
    )
  `);
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      first_name TEXT,
      last_name TEXT,
      username TEXT,
      key TEXT,
      key_expires INTEGER,
      source INTEGER DEFAULT 3,
      auto_on INTEGER DEFAULT 0,
      activated_at INTEGER,
      lang TEXT DEFAULT 'vi'
    )
  `);
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS stats (
      user_id TEXT PRIMARY KEY,
      total INTEGER DEFAULT 0,
      correct INTEGER DEFAULT 0,
      break_correct INTEGER DEFAULT 0
    )
  `);
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phien INTEGER,
      actual TEXT,
      ai_pred TEXT,
      ai_conf INTEGER,
      source TEXT,
      ts INTEGER
    )
  `);
  await db.runAsync(`
    CREATE INDEX IF NOT EXISTS idx_history_phien ON history(phien)
  `);
  await db.runAsync(`
    CREATE INDEX IF NOT EXISTS idx_history_ts ON history(ts)
  `);
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS predictions (
      user_id TEXT,
      phien INTEGER,
      prediction TEXT,
      confidence INTEGER,
      source TEXT,
      ts INTEGER,
      actual TEXT,
      correct INTEGER,
      PRIMARY KEY (user_id, phien)
    )
  `);
  console.log('✅ Database initialized');
}
initDB().catch(console.error);

// ========== I18N ==========
const localesDir = path.join(__dirname, 'locales');
if (!fs.existsSync(localesDir)) fs.mkdirSync(localesDir, { recursive: true });
i18n.configure({
  locales: ['vi', 'en'],
  directory: localesDir,
  defaultLocale: 'vi',
  objectNotation: true,
  updateFiles: false,
});
// Tạo file ngôn ngữ mẫu (nếu chưa có)
if (!fs.existsSync(path.join(localesDir, 'vi.json'))) {
  fs.writeFileSync(path.join(localesDir, 'vi.json'), JSON.stringify({
    welcome: "🎮 Chào mừng đến LC79 AI Bot!",
    key_expired: "⛔ Key của bạn đã hết hạn!",
    prediction: "DỰ ĐOÁN",
    tai: "TÀI",
    xiu: "XỈU",
    error_api: "⚠️ Lỗi API, thử lại sau.",
    rate_limit: "⏳ Bạn đã dùng lệnh gần đây, vui lòng chờ.",
    not_activated: "❌ Tài khoản chưa kích hoạt hoặc key đã hết hạn.\nDùng /key MÃ_KEY để kích hoạt.",
    activated: "✅ Kích hoạt thành công!",
    help_user: "📖 Hướng dẫn sử dụng\n• /key MÃ → Kích hoạt key\n• /now → Dự đoán ngay\n• /startbot → Bật auto 60s\n• /stop → Tắt auto\n• /stats → Thống kê cá nhân\n• /V1 /V2 /V3 → Chọn nguồn",
    help_admin: "📋 LỆNH ADMIN\n• /addkey tên [thời gian] → Tạo key\n• /delkey MÃ → Xóa key\n• /keys → Danh sách key\n• /users → Danh sách user\n• /info [ID] → Chi tiết user\n• /deluser ID → Xóa user\n• /resetstats → Reset thống kê\n• /admincmds → Danh sách lệnh admin"
  }, null, 2));
}
if (!fs.existsSync(path.join(localesDir, 'en.json'))) {
  fs.writeFileSync(path.join(localesDir, 'en.json'), JSON.stringify({
    welcome: "🎮 Welcome to LC79 AI Bot!",
    key_expired: "⛔ Your key has expired!",
    prediction: "PREDICTION",
    tai: "TAI",
    xiu: "XIU",
    error_api: "⚠️ API error, please try again.",
    rate_limit: "⏳ You used command recently, please wait.",
    not_activated: "❌ Account not activated or key expired.\nUse /key YOUR_KEY to activate.",
    activated: "✅ Activation successful!",
    help_user: "📖 User commands\n• /key CODE → Activate\n• /now → Get prediction\n• /startbot → Enable auto\n• /stop → Disable auto\n• /stats → Your stats\n• /V1 /V2 /V3 → Select source",
    help_admin: "📋 ADMIN COMMANDS\n• /addkey name [duration] → Create key\n• /delkey CODE → Delete key\n• /keys → List keys\n• /users → List users\n• /info [ID] → User details\n• /deluser ID → Delete user\n• /resetstats → Reset stats\n• /admincmds → Admin commands list"
  }, null, 2));
}

// ========== API HELPERS ==========
async function apiFetch(url, timeout = CONFIG.API_TIMEOUT) {
  const cached = apiCache.get(url);
  if (cached) return cached;

  const proxies = ['https://api.allorigins.win/raw?url=', 'https://corsproxy.io/?', ''];
  for (const proxy of proxies) {
    try {
      const fetchUrl = proxy ? proxy + encodeURIComponent(url) : url;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(fetchUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      apiCache.set(url, data);
      return data;
    } catch(e) { /* log */ }
  }
  throw new Error('All proxies failed');
}

async function fetchV1() {
  const raw = await apiFetch(CONFIG.API_V1);
  const betting = raw.betting_info || {};
  const taiPeople = betting.nguoi_cuoc?.tai || 0;
  const xiuPeople = betting.nguoi_cuoc?.xiu || 0;
  const taiMoneyRaw = betting.tien_cuoc?.tai || '0';
  const xiuMoneyRaw = betting.tien_cuoc?.xiu || '0';
  const taiMoney = parseFloat(String(taiMoneyRaw).replace(/\./g, ''));
  const xiuMoney = parseFloat(String(xiuMoneyRaw).replace(/\./g, ''));
  const phien = raw.phien || 0;

  const totalPeople = taiPeople + xiuPeople || 1;
  const totalMoney  = taiMoney + xiuMoney  || 1;

  let score = 0.5;
  if (totalPeople > 0) score += (taiPeople - xiuPeople) / totalPeople * 0.25;
  if (totalMoney  > 0) score += (taiMoney - xiuMoney)  / totalMoney  * 0.25;

  const pTai = Math.min(0.93, Math.max(0.07, score));
  const result = pTai >= 0.5 ? 'Tài' : 'Xỉu';
  const conf = Math.round(Math.max(pTai, 1 - pTai) * 100);

  return {
    source: 'V1',
    phien,
    result,
    conf,
    pTai,
    taiPeople, xiuPeople, taiMoney, xiuMoney,
    raw,
  };
}

async function fetchV2() {
  const raw = await apiFetch(CONFIG.API_V2);
  const du_doan = raw.du_doan || '';
  const do_tin_cay = Number(raw.do_tin_cay || 50);
  const phien = raw.phien || 0;
  const ket_qua = raw.ket_qua || '';
  const xuc_xac = [raw.xuc_xac_1, raw.xuc_xac_2, raw.xuc_xac_3].map(v => Number(v));
  const tong = Number(raw.tong || xuc_xac.reduce((a,b)=>a+b,0));

  let result = du_doan.toLowerCase();
  if (result.includes('tài') || result === 'tai') result = 'Tài';
  else if (result.includes('xỉu') || result === 'xiu') result = 'Xỉu';
  else result = null;

  let actual = ket_qua.toLowerCase();
  if (actual.includes('tài') || actual === 'tai') actual = 'Tài';
  else if (actual.includes('xỉu') || actual === 'xiu') actual = 'Xỉu';
  else actual = null;

  return {
    source: 'V2',
    phien,
    result,
    conf: do_tin_cay,
    actual,
    dice: xuc_xac,
    tong,
    raw,
  };
}

async function getDynamicWeights() {
  try {
    const hist = await db.allAsync(`
      SELECT source, COUNT(*) as total,
             SUM(CASE WHEN actual = ai_pred THEN 1 ELSE 0 END) as correct
      FROM history
      WHERE actual IS NOT NULL AND source IN ('V1','V2')
      GROUP BY source
    `);
    const v1 = hist.find(r => r.source === 'V1');
    const v2 = hist.find(r => r.source === 'V2');
    const v1Acc = v1 ? v1.correct / v1.total : 0.5;
    const v2Acc = v2 ? v2.correct / v2.total : 0.5;
    const total = v1Acc + v2Acc;
    return { v1Weight: v1Acc / total, v2Weight: v2Acc / total };
  } catch(e) {
    return { v1Weight: 0.5, v2Weight: 0.5 };
  }
}

async function fetchV3Dynamic() {
  const [v1, v2] = await Promise.allSettled([fetchV1(), fetchV2()]);
  const v1Ok = v1.status === 'fulfilled' ? v1.value : null;
  const v2Ok = v2.status === 'fulfilled' ? v2.value : null;

  if (!v1Ok && !v2Ok) throw new Error('Cả V1 và V2 đều thất bại');
  if (!v1Ok) return { ...v2Ok, source: 'V3(→V2)' };
  if (!v2Ok) return { ...v1Ok, source: 'V3(→V1)' };

  const weights = await getDynamicWeights();
  if (v2Ok.conf >= 60 && weights.v2Weight > 0.4) {
    return { ...v2Ok, source: 'V3(Dyn→V2)', dynamicNote: `V2 trọng số ${Math.round(weights.v2Weight*100)}%` };
  }
  return { ...v1Ok, source: 'V3(Dyn→V1)', dynamicNote: `V1 trọng số ${Math.round(weights.v1Weight*100)}%` };
}

// Hàm lấy dữ liệu chung (có cache global)
async function getGlobalPrediction(source = 'V3') {
  const now = Date.now();
  if (globalPredictionData && (now - lastGlobalFetch < 5000)) {
    // Dùng cache 5 giây để tránh gọi quá nhiều
    return globalPredictionData;
  }
  let data;
  if (source === 'V1') data = await fetchV1();
  else if (source === 'V2') data = await fetchV2();
  else data = await fetchV3Dynamic();

  globalPredictionData = data;
  lastGlobalFetch = now;
  return data;
}

// ========== HÀM TIỆN ÍCH ==========
function formatDuration(ms) {
  if (!ms) return '0 giây';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)} giây`;
  if (s < 3600) return `${(s/60).toFixed(0)} phút`;
  if (s < 86400) return `${(s/3600).toFixed(1)} giờ`;
  if (s < 2592000) return `${(s/86400).toFixed(1)} ngày`;
  return `${(s/2592000).toFixed(1)} tháng`;
}

function formatExpiry(exp) {
  if (!exp) return 'Không giới hạn';
  const diff = exp - Date.now();
  if (diff <= 0) return '⛔ Đã hết hạn';
  return `⏳ Còn ${formatDuration(diff)}`;
}

function parseDuration(str) {
  if (!str) return 30 * 24 * 60 * 60 * 1000;
  str = str.toLowerCase().trim();
  const num = parseFloat(str);
  if (isNaN(num)) return null;
  if (str.endsWith('th')) return num * 30 * 24 * 60 * 60 * 1000;
  if (str.endsWith('t')) return num * 7 * 24 * 60 * 60 * 1000;
  if (str.endsWith('d')) return num * 24 * 60 * 60 * 1000;
  if (str.endsWith('h')) return num * 60 * 60 * 1000;
  if (str.endsWith('p')) return num * 60 * 1000;
  return null;
}

function formatVietnamTime(timestamp) {
  if (!timestamp) return 'Vĩnh viễn';
  const date = new Date(timestamp);
  return date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// ========== THỐNG KÊ & PHÂN TÍCH ==========
async function getHistoryStats() {
  const history = await db.allAsync('SELECT actual, ai_pred FROM history ORDER BY ts DESC LIMIT 1000');
  if (history.length < 3) return null;

  const seq = history.filter(h => h.actual).map(h => h.actual);
  if (seq.length === 0) return null;

  const cur = seq[0];
  let streak = 0;
  for (const v of seq) if (v === cur) streak++; else break;

  let breaks = 0;
  for (let i = 0; i < seq.length - 1; i++) if (seq[i] !== seq[i+1]) breaks++;
  const breakRate = breaks / Math.max(seq.length - 1, 1);

  const withPred = history.filter(h => h.ai_pred && h.actual);
  const correct = withPred.filter(h => h.ai_pred === h.actual).length;
  const accuracy = withPred.length > 0 ? correct / withPred.length : null;

  return { streak, streakVal: cur, breakRate, accuracy, total: history.length };
}

function advancedBreakAnalysis(history) {
  if (!history || history.length < 10) return null;
  const seq = history.slice(0, 20).map(h => h.actual === 'Tài' ? 1 : 0);
  let gains = 0, losses = 0;
  for (let i = 1; i < Math.min(7, seq.length); i++) {
    const diff = seq[i] - seq[i-1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const rs = gains / (losses || 0.001);
  const rsi = 100 - (100 / (1 + rs));
  const signal = rsi > 70 ? 'reverse' : (rsi < 30 ? 'reverse' : 'hold');
  return { rsi: Math.round(rsi), signal };
}

async function updateHistory(phien, actual, aiPred, aiConf, source) {
  try {
    const existing = await db.getAsync('SELECT 1 FROM history WHERE phien = ?', phien);
    if (existing) return;
    await db.runAsync(
      `INSERT INTO history (phien, actual, ai_pred, ai_conf, source, ts) VALUES (?, ?, ?, ?, ?, ?)`,
      phien, actual, aiPred, aiConf, source, Date.now()
    );
    const count = await db.getAsync('SELECT COUNT(*) as c FROM history');
    if (count.c > CONFIG.MAX_HISTORY) {
      await db.runAsync(`DELETE FROM history WHERE id IN (SELECT id FROM history ORDER BY ts ASC LIMIT ?)`, count.c - CONFIG.MAX_HISTORY);
    }
  } catch(e) { console.error('Update history error:', e.message); }
}

async function updateUserStats(userId, prediction, actual) {
  if (!actual) return;
  const correct = (prediction === actual) ? 1 : 0;
  await db.runAsync(`
    INSERT INTO stats (user_id, total, correct) VALUES (?, 1, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      total = total + 1,
      correct = correct + excluded.correct
  `, userId, correct);
}

function formatPrediction(data, histStats, userStats, breakAnalysis, lang = 'vi') {
  i18n.setLocale(lang);
  const isTai = data.result === 'Tài';
  const icon = isTai ? '🟢' : '🔴';
  const word = isTai ? '⬆️ ' + i18n.__('tai') : '⬇️ ' + i18n.__('xiu');
  const conf = data.conf || 50;
  const bar = '█'.repeat(Math.round(conf/10)) + '░'.repeat(10-Math.round(conf/10));

  let msg = `╔══ 🎯 ${i18n.__('prediction')} LC79 ══╗\n`;
  msg += `║ ${icon} <b>${word}</b>  |  Tin cậy: <b>${conf}%</b>\n`;
  msg += `║ ${bar}\n`;
  msg += `║ Nguồn: <b>${data.source}</b>\n`;

  if (data.phien) msg += `║ Phiên: <b>${data.phien}</b>\n`;

  if (data.dice && data.dice[0]) {
    const diceStr = data.dice.map(d => ['⚀','⚁','⚂','⚃','⚄','⚅'][d-1] || '?').join(' ');
    msg += `╠══ Phiên vừa xong ══\n`;
    msg += `║ 🎲 ${diceStr} = <b>${data.tong}</b>\n`;
    if (data.actual) {
      const actIcon = data.actual === 'Tài' ? '🟢' : '🔴';
      msg += `║ Kết quả: ${actIcon} <b>${data.actual === 'Tài' ? i18n.__('tai') : i18n.__('xiu')}</b>\n`;
    }
  }

  if (data.taiPeople !== undefined) {
    const total = (data.taiPeople + data.xiuPeople) || 1;
    const tPct = Math.round(data.taiPeople / total * 100);
    const xPct = 100 - tPct;
    msg += `╠══ Dữ liệu cược ══\n`;
    msg += `║ 👥 ${i18n.__('tai')}: ${data.taiPeople} (${tPct}%) | ${i18n.__('xiu')}: ${data.xiuPeople} (${xPct}%)\n`;
    if (data.taiMoney) {
      const totalM = (data.taiMoney + data.xiuMoney) || 1;
      const tmPct = Math.round(data.taiMoney / totalM * 100);
      const fm = n => n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(0)+'K' : String(n);
      msg += `║ 💰 ${i18n.__('tai')}: ${fm(data.taiMoney)} (${tmPct}%) | ${i18n.__('xiu')}: ${fm(data.xiuMoney)} (${100-tmPct}%)\n`;
    }
  }

  if (data.dynamicNote) msg += `║ 💡 ${data.dynamicNote}\n`;

  if (histStats && histStats.total >= 5) {
    const bPct = Math.round(histStats.breakRate * 100);
    const strVal = histStats.streakVal === 'Tài' ? i18n.__('tai') : i18n.__('xiu');
    msg += `╠══ Phân tích cầu ══\n`;
    msg += `║ 📊 Cầu: <b>${strVal} ×${histStats.streak}</b>\n`;
    msg += `║ 🔄 Tỉ lệ bẻ: <b>${bPct}%</b>\n`;
    if (histStats.accuracy !== null) {
      msg += `║ ✅ Độ chính xác global: <b>${Math.round(histStats.accuracy*100)}%</b>\n`;
    }
  }

  if (breakAnalysis && breakAnalysis.signal === 'reverse') {
    msg += `╠══ ⚠️ CẢNH BÁO BẺ CẦU ══\n`;
    msg += `║ 📈 RSI: ${breakAnalysis.rsi} → khả năng bẻ cao!\n`;
  }

  if (userStats && userStats.total) {
    const acc = Math.round((userStats.correct || 0) / userStats.total * 100);
    msg += `╠══ Thống kê cá nhân ══\n`;
    msg += `║ 🎯 Đúng: ${userStats.correct}/${userStats.total} (${acc}%)\n`;
  }

  msg += `╚══════════════════\n`;
  msg += `<i>⏱ ${new Date().toLocaleString('vi-VN')} | ${isTai ? '⬆️' : '⬇️'} ${conf < 55 ? 'Tín hiệu yếu' : conf < 65 ? 'Tín hiệu trung bình' : 'Tín hiệu mạnh'}</i>`;
  return msg;
}

// ========== BOT ==========
const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
bot.on('polling_error', e => console.error('Polling error:', e.message));

// ========== USER COMMANDS ==========
async function checkActive(uid, msg) {
  const user = await db.getAsync('SELECT * FROM users WHERE id = ?', uid);
  if (!user || user.key_expires < Date.now()) {
    const lang = user?.lang || 'vi';
    bot.sendMessage(uid, i18n.__({phrase: 'not_activated', locale: lang}), { parse_mode: 'HTML' });
    return null;
  }
  return user;
}

const rateCache = new NodeCache({ stdTTL: 60 });

bot.onText(/\/start/, async (msg) => {
  const uid = msg.chat.id;
  const user = await db.getAsync('SELECT * FROM users WHERE id = ?', uid);
  const lang = user?.lang || 'vi';
  i18n.setLocale(lang);
  if (user && user.key_expires > Date.now()) {
    const text = i18n.__('welcome') + `\n\n✅ ` + i18n.__('activated') + `\n⏰ Hết hạn: ${formatExpiry(user.key_expires)}\n\n` + i18n.__('help_user');
    bot.sendMessage(uid, text, { parse_mode: 'HTML' });
  } else {
    bot.sendMessage(uid, i18n.__('welcome') + '\n\n' + i18n.__('help_user'), { parse_mode: 'HTML' });
  }
});

bot.onText(/\/key\s+(.+)/, async (msg, match) => {
  const uid = String(msg.chat.id);
  const code = match[1].trim().toUpperCase();
  const keyData = await db.getAsync('SELECT * FROM keys WHERE code = ?', code);
  if (!keyData) { bot.sendMessage(uid, '❌ Key không hợp lệ.'); return; }
  if (keyData.expires && keyData.expires < Date.now()) { bot.sendMessage(uid, '⛔ Key đã hết hạn.'); return; }
  if (keyData.usedBy && keyData.usedBy !== uid) { bot.sendMessage(uid, '⚠️ Key đã được dùng.'); return; }

  await db.runAsync('UPDATE keys SET usedBy = ? WHERE code = ?', uid, code);
  const user = await db.getAsync('SELECT * FROM users WHERE id = ?', uid);
  const lang = user?.lang || 'vi';
  await db.runAsync(
    `INSERT OR REPLACE INTO users (id, first_name, last_name, username, key, key_expires, source, auto_on, activated_at, lang)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uid, msg.from.first_name || '', msg.from.last_name || '', msg.from.username || '',
    code, keyData.expires, 3, 0, Date.now(), lang
  );

  bot.sendMessage(uid, `✅ <b>Kích hoạt thành công!</b>\n\n🔑 Key: <code>${code}</code>\n⏰ Hạn: ${formatExpiry(keyData.expires)}\n\n📡 Nguồn mặc định: V3 (Thông minh)`, { parse_mode: 'HTML' });
  try {
    await bot.sendMessage(CONFIG.ADMIN_ID, `🔔 User mới kích hoạt key!\n👤 ${msg.from.first_name || ''} ${msg.from.last_name || ''} (@${msg.from.username || 'N/A'})\n🆔 ID: ${uid}\n🔑 Key: <code>${code}</code>\n⏰ Hạn: ${formatExpiry(keyData.expires)}`, { parse_mode: 'HTML' });
  } catch(e) {}
});

bot.onText(/\/now/, async (msg) => {
  const uid = String(msg.chat.id);
  if (rateCache.get(uid)) {
    const user = await db.getAsync('SELECT lang FROM users WHERE id = ?', uid);
    const lang = user?.lang || 'vi';
    return bot.sendMessage(uid, i18n.__({phrase: 'rate_limit', locale: lang}));
  }
  rateCache.set(uid, true);

  const user = await checkActive(uid, msg);
  if (!user) return;

  const source = `V${user.source || 3}`;
  let data;
  try {
    if (source === 'V1') data = await fetchV1();
    else if (source === 'V2') data = await fetchV2();
    else data = await fetchV3Dynamic();
  } catch(e) {
    bot.sendMessage(uid, i18n.__({phrase: 'error_api', locale: user.lang}), { parse_mode: 'HTML' });
    return;
  }

  if (data.phien && data.actual) {
    await updateHistory(data.phien, data.actual, data.result, data.conf, data.source);
  }

  const histStats = await getHistoryStats();
  const historyForBreak = await db.allAsync('SELECT actual FROM history ORDER BY ts DESC LIMIT 20');
  const breakAnalysis = advancedBreakAnalysis(historyForBreak);
  const userStats = await db.getAsync('SELECT total, correct FROM stats WHERE user_id = ?', uid);
  const msgText = formatPrediction(data, histStats, userStats, breakAnalysis, user.lang);
  bot.sendMessage(uid, msgText, { parse_mode: 'HTML' });
  await db.runAsync(
    `INSERT INTO predictions (user_id, phien, prediction, confidence, source, ts) VALUES (?, ?, ?, ?, ?, ?)`,
    uid, data.phien, data.result, data.conf, data.source, Date.now()
  );
  if (data.actual) await updateUserStats(uid, data.result, data.actual);
  if (CONFIG.WEBHOOK_URL) axios.post(CONFIG.WEBHOOK_URL, { user: uid, prediction: data.result }).catch(e=>{});
});

bot.onText(/\/startbot/, async (msg) => {
  const uid = String(msg.chat.id);
  const user = await checkActive(uid, msg);
  if (!user) return;
  await db.runAsync('UPDATE users SET auto_on = 1 WHERE id = ?', uid);
  startUserAuto(uid);
  bot.sendMessage(uid, '▶️ <b>Đã bật auto!</b>\nDự đoán sẽ được gửi mỗi 60 giây.\nDùng /stop để tắt.', { parse_mode: 'HTML' });
});

bot.onText(/\/stop/, async (msg) => {
  const uid = String(msg.chat.id);
  await db.runAsync('UPDATE users SET auto_on = 0 WHERE id = ?', uid);
  stopUserAuto(uid);
  bot.sendMessage(uid, '⏹ <b>Đã tắt auto.</b>\nDùng /now để lấy dự đoán thủ công.', { parse_mode: 'HTML' });
});

bot.onText(/\/stats/, async (msg) => {
  const uid = String(msg.chat.id);
  const user = await checkActive(uid, msg);
  if (!user) return;
  const stats = await db.getAsync('SELECT total, correct FROM stats WHERE user_id = ?', uid);
  const histStats = await getHistoryStats();
  let text = `📊 <b>Thống kê của bạn</b>\n\n`;
  text += `📡 Nguồn: <b>V${user.source || 3}</b>\n`;
  text += `▶️ Auto: ${user.auto_on ? 'Đang bật' : 'Đang tắt'}\n`;
  text += `⏰ Key: ${formatExpiry(user.key_expires)}\n\n`;
  if (stats && stats.total) {
    const acc = Math.round((stats.correct || 0) / stats.total * 100);
    text += `🎯 <b>Độ chính xác AI: ${acc}%</b>\n`;
    text += `📈 Tổng dự đoán: ${stats.total}\n`;
    text += `✅ Đúng: ${stats.correct || 0} | ❌ Sai: ${stats.total - (stats.correct||0)}\n\n`;
  } else {
    text += `📈 Chưa có dữ liệu thống kê\n\n`;
  }
  if (histStats) {
    const bPct = Math.round(histStats.breakRate * 100);
    const strVal = histStats.streakVal === 'Tài' ? 'TÀI' : 'XỈU';
    text += `📊 <b>Phân tích cầu (${histStats.total} ván)</b>\n`;
    text += `🔄 Cầu hiện tại: <b>${strVal} ×${histStats.streak}</b>\n`;
    text += `🔀 Tỉ lệ bẻ cầu: <b>${bPct}%</b>\n`;
    if (histStats.accuracy !== null) {
      text += `🤖 Độ chính xác global: <b>${Math.round(histStats.accuracy*100)}%</b>\n`;
    }
  }
  bot.sendMessage(uid, text, { parse_mode: 'HTML' });
});

[1,2,3].forEach(v => {
  bot.onText(new RegExp(`^\\/V${v}$`), async (msg) => {
    const uid = String(msg.chat.id);
    const user = await checkActive(uid, msg);
    if (!user) return;
    await db.runAsync('UPDATE users SET source = ? WHERE id = ?', v, uid);
    const desc = { 1: 'V1 — Phân tích dữ liệu cược', 2: 'V2 — Dự đoán ML từ API', 3: 'V3 — Kết hợp thông minh' };
    bot.sendMessage(uid, `✅ Đã chuyển sang <b>${desc[v]}</b>`, { parse_mode: 'HTML' });
  });
});

bot.onText(/\/help/, async (msg) => {
  const uid = String(msg.chat.id);
  const user = await db.getAsync('SELECT lang FROM users WHERE id = ?', uid);
  const lang = user?.lang || 'vi';
  let text = i18n.__({phrase: 'help_user', locale: lang});
  if (String(uid) === CONFIG.ADMIN_ID) text += '\n\n' + i18n.__({phrase: 'help_admin', locale: lang});
  bot.sendMessage(uid, text, { parse_mode: 'HTML' });
});

// ========== ADMIN COMMANDS ==========
function requireAdmin(msg, fn) {
  if (String(msg.chat.id) !== CONFIG.ADMIN_ID) {
    bot.sendMessage(msg.chat.id, '❌ Lệnh này chỉ dành cho admin.');
    return;
  }
  fn();
}

bot.onText(/\/admincmds/, (msg) => requireAdmin(msg, async () => {
  const lang = (await db.getAsync('SELECT lang FROM users WHERE id = ?', msg.chat.id))?.lang || 'vi';
  bot.sendMessage(msg.chat.id, i18n.__({phrase: 'help_admin', locale: lang}), { parse_mode: 'HTML' });
}));

bot.onText(/\/addkey(?:\s+(.+))?/, (msg, match) => requireAdmin(msg, async () => {
  const args = (match[1] || '').trim().split(/\s+/);
  const name = args[0] || `KEY_${Date.now()}`;
  const durStr = args[1] || '30d';
  const dur = parseDuration(durStr);
  if (!dur) { bot.sendMessage(msg.chat.id, '❌ Sai định dạng thời gian.'); return; }
  const code = `${name.toUpperCase()}_${Math.random().toString(36).substr(2,6).toUpperCase()}`;
  const expires = Date.now() + dur;
  await db.runAsync(
    `INSERT INTO keys (code, name, created, expires, duration, createdBy) VALUES (?, ?, ?, ?, ?, ?)`,
    code, name, Date.now(), expires, durStr, msg.chat.id
  );
  bot.sendMessage(msg.chat.id, `✅ Key: <code>${code}</code> - Hạn: ${formatExpiry(expires)}`, { parse_mode: 'HTML' });
}));

bot.onText(/\/delkey\s+(.+)/, (msg, match) => requireAdmin(msg, async () => {
  const code = match[1].trim().toUpperCase();
  const key = await db.getAsync('SELECT * FROM keys WHERE code = ?', code);
  if (!key) { bot.sendMessage(msg.chat.id, `❌ Không tìm thấy key ${code}`); return; }
  await db.runAsync('DELETE FROM keys WHERE code = ?', code);
  await db.runAsync('UPDATE users SET key = NULL, key_expires = NULL, auto_on = 0 WHERE key = ?', code);
  bot.sendMessage(msg.chat.id, `✅ Đã xóa key ${code}`, { parse_mode: 'HTML' });
}));

bot.onText(/\/keys/, (msg) => requireAdmin(msg, async () => {
  const keys = await db.allAsync('SELECT * FROM keys ORDER BY created DESC');
  if (keys.length === 0) { bot.sendMessage(msg.chat.id, '📭 Chưa có key.'); return; }
  let text = '🔑 <b>Danh sách Keys</b>\n\n';
  for (const k of keys) {
    const status = !k.expires || k.expires > Date.now()
      ? (k.usedBy ? '🟢 Đã dùng' : '🟡 Chưa dùng')
      : '🔴 Hết hạn';
    text += `${k.code}\n   ${status} | ${k.name} | ${formatExpiry(k.expires)}\n`;
    if (k.usedBy) text += `   👤 Dùng bởi: ${k.usedBy}\n`;
    text += '\n';
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
}));

bot.onText(/\/users/, (msg) => requireAdmin(msg, async () => {
  const users = await db.allAsync('SELECT * FROM users');
  if (users.length === 0) { bot.sendMessage(msg.chat.id, '📭 Chưa có user.'); return; }
  let text = '👥 <b>Danh sách Users</b>\n\n';
  for (const u of users) {
    const active = u.key_expires && u.key_expires > Date.now();
    const auto = u.auto_on ? '▶️' : '⏹';
    text += `${active ? '🟢' : '🔴'} <b>${u.first_name || u.username || u.id}</b> [${u.id}]\n`;
    text += `   ${auto} V${u.source || 3} | ${formatExpiry(u.key_expires)}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
}));

bot.onText(/\/info(?:\s+(\d+))?/, (msg, match) => requireAdmin(msg, async () => {
  const uid = match[1] || String(msg.chat.id);
  const user = await db.getAsync('SELECT * FROM users WHERE id = ?', uid);
  if (!user) { bot.sendMessage(msg.chat.id, `❌ Không tìm thấy user ${uid}`); return; }
  const stats = await db.getAsync('SELECT total, correct FROM stats WHERE user_id = ?', uid);
  let text = `👤 <b>Thông tin User</b>\n\n`;
  text += `🆔 ID: <code>${user.id}</code>\n`;
  text += `👤 Tên: ${user.first_name || ''} ${user.last_name || ''}\n`;
  text += `🏷 Username: @${user.username || 'N/A'}\n`;
  text += `🔑 Key: <code>${user.key || 'N/A'}</code>\n`;
  text += `⏰ Hạn key: ${formatExpiry(user.key_expires)}\n`;
  text += `📡 Nguồn: V${user.source || 3}\n`;
  text += `▶️ Auto: ${user.auto_on ? 'Bật' : 'Tắt'}\n`;
  text += `📅 Kích hoạt: ${user.activated_at ? formatVietnamTime(user.activated_at) : 'N/A'}\n\n`;
  text += `📊 <b>Thống kê</b>\n`;
  text += `🎯 Tổng dự đoán: ${stats?.total || 0}\n`;
  text += `✅ Đúng: ${stats?.correct || 0} (${stats?.total ? Math.round((stats.correct||0)/stats.total*100) : 0}%)\n`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
}));

bot.onText(/\/deluser\s+(\d+)/, (msg, match) => requireAdmin(msg, async () => {
  const uid = match[1];
  const user = await db.getAsync('SELECT * FROM users WHERE id = ?', uid);
  if (!user) { bot.sendMessage(msg.chat.id, `❌ User ${uid} không tồn tại`); return; }
  stopUserAuto(uid);
  await db.runAsync('DELETE FROM users WHERE id = ?', uid);
  if (user.key) await db.runAsync('UPDATE keys SET usedBy = NULL WHERE code = ?', user.key);
  bot.sendMessage(msg.chat.id, `✅ Đã xóa user ${user.first_name || uid}`, { parse_mode: 'HTML' });
  try { await bot.sendMessage(uid, `⛔ Tài khoản của bạn đã bị admin vô hiệu hóa.`); } catch(e) {}
}));

bot.onText(/\/resetstats/, (msg) => requireAdmin(msg, async () => {
  await db.runAsync('DELETE FROM stats');
  await db.runAsync('DELETE FROM history');
  await db.runAsync('DELETE FROM predictions');
  bot.sendMessage(msg.chat.id, '✅ Đã reset thống kê.');
}));

// ========== AUTO SEND ==========
const autoTimers = {};

async function startUserAuto(uid) {
  if (autoTimers[uid]) clearInterval(autoTimers[uid]);
  autoTimers[uid] = setInterval(async () => {
    const user = await db.getAsync('SELECT * FROM users WHERE id = ?', uid);
    if (!user || !user.auto_on) { stopUserAuto(uid); return; }
    if (user.key_expires < Date.now()) {
      stopUserAuto(uid);
      await db.runAsync('UPDATE users SET auto_on = 0 WHERE id = ?', uid);
      bot.sendMessage(uid, '⛔ Key hết hạn! Auto tắt.', { parse_mode: 'HTML' });
      return;
    }

    const source = `V${user.source || 3}`;
    let data;
    try {
      if (source === 'V1') data = await fetchV1();
      else if (source === 'V2') data = await fetchV2();
      else data = await fetchV3Dynamic();
    } catch(e) { return; }

    if (data.phien && data.actual) {
      await updateHistory(data.phien, data.actual, data.result, data.conf, data.source);
    }
    const histStats = await getHistoryStats();
    const historyForBreak = await db.allAsync('SELECT actual FROM history ORDER BY ts DESC LIMIT 20');
    const breakAnalysis = advancedBreakAnalysis(historyForBreak);
    const userStats = await db.getAsync('SELECT total, correct FROM stats WHERE user_id = ?', uid);
    const msgText = formatPrediction(data, histStats, userStats, breakAnalysis, user.lang);
    bot.sendMessage(uid, msgText, { parse_mode: 'HTML' });
    await db.runAsync(
      `INSERT INTO predictions (user_id, phien, prediction, confidence, source, ts) VALUES (?, ?, ?, ?, ?, ?)`,
      uid, data.phien, data.result, data.conf, data.source, Date.now()
    );
    if (data.actual) await updateUserStats(uid, data.result, data.actual);
  }, CONFIG.AUTO_INTERVAL);
}

function stopUserAuto(uid) {
  if (autoTimers[uid]) { clearInterval(autoTimers[uid]); delete autoTimers[uid]; }
}

async function restoreAutoUsers() {
  const users = await db.allAsync('SELECT id FROM users WHERE auto_on = 1 AND key_expires > ?', Date.now());
  for (const u of users) startUserAuto(u.id);
  console.log(`Restored auto for ${users.length} users`);
}

// ========== WEB DASHBOARD ==========
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('Bot đang chạy!'));
app.get('/dashboard', async (req, res) => {
  try {
    const users = await db.allAsync('SELECT id, first_name, username, key, key_expires, source, auto_on FROM users');
    const keys = await db.allAsync('SELECT code, name, expires, usedBy FROM keys');
    const stats = await db.getAsync('SELECT COUNT(*) as total, SUM(correct) as correct FROM stats');
    const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>LC79 Dashboard</title><style>
      body{font-family:monospace;background:#0a0c14;color:#eee;padding:20px;}
      table{border-collapse:collapse;width:100%;}
      th,td{border:1px solid #2a3a5e;padding:8px;text-align:left;}
      th{background:#1e2a45;}
    </style></head>
    <body><h1>📊 LC79 Admin Dashboard</h1>
    <h2>Users (${users.length})</h2>
    <table>
       <thead><tr><th>ID</th><th>Name</th><th>Username</th><th>Key</th><th>Expiry</th><th>Source</th><th>Auto</th></tr></thead>
       <tbody>${users.map(u => `<tr><td>${u.id}</td><td>${u.first_name||''}</td><td>${u.username||''}</td><td>${u.key||''}</td><td>${u.key_expires ? new Date(u.key_expires).toLocaleString('vi') : '∞'}</td><td>V${u.source||3}</td><td>${u.auto_on?'✅':'⏹'}</td></tr>`).join('')}</tbody>
     </table>
    <h2>Keys (${keys.length})</h2>
    <table>
       <thead><tr><th>Code</th><th>Name</th><th>Expires</th><th>UsedBy</th></tr></thead>
       <tbody>${keys.map(k => `<tr><td>${k.code}</td><td>${k.name}</td><td>${k.expires ? new Date(k.expires).toLocaleString('vi') : '∞'}</td><td>${k.usedBy||''}</td></tr>`).join('')}</tbody>
     </table>
    <h2>Stats</h2>
    <p>Total predictions: ${stats?.total||0}<br>Correct: ${stats?.correct||0} (${stats?.total ? (stats.correct/stats.total*100).toFixed(1) : 0}%)</p>
    </body></html>`;
    res.send(html);
  } catch(e) { res.status(500).send('Error'); }
});
app.listen(CONFIG.PORT, () => console.log(`🌐 Dashboard: http://localhost:${CONFIG.PORT}/dashboard`));

// ========== BACKUP & KHỞI ĐỘNG ==========
function backupDatabase() {
  try {
    const src = CONFIG.DB_PATH;
    const dest = path.join(CONFIG.BACKUP_DIR, `lc79_${new Date().toISOString().slice(0,10)}.db`);
    fs.copyFileSync(src, dest);
    console.log(`📁 Backup created: ${dest}`);
  } catch(e) {}
}
setInterval(backupDatabase, 24 * 60 * 60 * 1000);

restoreAutoUsers();
console.log('✅ Bot đã khởi động thành công!');
bot.sendMessage(CONFIG.ADMIN_ID, `🟢 <b>Bot LC79 đã online!</b>`, { parse_mode: 'HTML' }).catch(()=>{});
