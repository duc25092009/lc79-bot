/**
 * LC79 Tài Xỉu Bot – Tích hợp tự ping + health check
 * Deploy trên Render, tự động giữ bot chạy (không sleep)
 */

'use strict';

const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ========== CẤU HÌNH ==========
const CONFIG = {
  BOT_TOKEN:     process.env.BOT_TOKEN    || 'YOUR_BOT_TOKEN_HERE',
  ADMIN_ID:      process.env.ADMIN_ID     || 'YOUR_ADMIN_CHAT_ID',
  API_V1:        'https://living-telecommunications-start-consoles.trycloudflare.com/api/txmd5',
  API_V2:        'https://lc79-betvip-api-production.up.railway.app/api/lc79_md5?key=apihdx',
  DATA_DIR:      './data',
  DB_PATH:       './data/lc79.db',
  BACKUP_DIR:    './backups',
  AUTO_INTERVAL: 30000,
  API_TIMEOUT:   6000,
  CACHE_TTL:     2,
  MAX_HISTORY:   500,
  PORT:          process.env.PORT || 3000,
};

// Tạo thư mục
if (!fs.existsSync(CONFIG.DATA_DIR)) fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
if (!fs.existsSync(CONFIG.BACKUP_DIR)) fs.mkdirSync(CONFIG.BACKUP_DIR, { recursive: true });

const apiCache = new NodeCache({ stdTTL: CONFIG.CACHE_TTL });

// ========== SQLITE ==========
const db = new sqlite3.Database(CONFIG.DB_PATH);
const promisify = (fn) => (...args) => new Promise((resolve, reject) => {
  fn.call(db, ...args, (err, result) => err ? reject(err) : resolve(result));
});
db.getAsync = promisify(db.get.bind(db));
db.allAsync = promisify(db.all.bind(db));
db.runAsync = promisify(db.run.bind(db));

async function initDB() {
  await db.runAsync(`CREATE TABLE IF NOT EXISTS keys (code TEXT PRIMARY KEY, name TEXT, created INTEGER, expires INTEGER, duration TEXT, usedBy TEXT, createdBy TEXT)`);
  await db.runAsync(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, username TEXT, key TEXT, key_expires INTEGER, source INTEGER DEFAULT 3, auto_on INTEGER DEFAULT 0, activated_at INTEGER)`);
  await db.runAsync(`CREATE TABLE IF NOT EXISTS stats (user_id TEXT PRIMARY KEY, total INTEGER DEFAULT 0, correct INTEGER DEFAULT 0)`);
  await db.runAsync(`CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, phien INTEGER, actual TEXT, ai_pred TEXT, ai_conf INTEGER, source TEXT, ts INTEGER)`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_history_phien ON history(phien)`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_history_ts ON history(ts)`);
  console.log('✅ Database initialized');
}
initDB().catch(console.error);

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
    } catch(e) {}
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
  const totalPeople = taiPeople + xiuPeople || 1;
  const totalMoney = taiMoney + xiuMoney || 1;

  let score = 0.5;
  if (totalPeople > 0) score += (taiPeople - xiuPeople) / totalPeople * 0.25;
  if (totalMoney > 0) score += (taiMoney - xiuMoney) / totalMoney * 0.25;
  const pTai = Math.min(0.93, Math.max(0.07, score));
  const prediction = pTai >= 0.5 ? 'Tài' : 'Xỉu';
  const confidence = Math.round(Math.max(pTai, 1 - pTai) * 100);

  return {
    source: 'V1',
    prediction,
    confidence,
    phien: raw.phien || 0,
    nextPhien: raw.phien ? raw.phien + 1 : 0,
    dice: [raw.xuc_xac_1, raw.xuc_xac_2, raw.xuc_xac_3],
    tong: raw.tong || 0,
    actual: raw.ket_qua || '',
    taiPeople, xiuPeople, taiMoney, xiuMoney
  };
}

async function fetchV2() {
  const raw = await apiFetch(CONFIG.API_V2);
  let prediction = null;
  if (raw.du_doan) {
    prediction = raw.du_doan === 'Tài' ? 'Tài' : 'Xỉu';
  }
  let confidence = 50;
  if (raw.do_tin_cay) {
    const match = raw.do_tin_cay.match(/\d+/);
    if (match) confidence = parseInt(match[0]);
  }

  return {
    source: 'V2',
    prediction,
    confidence,
    phien: raw.phien || 0,
    nextPhien: raw.phien_hien_tai || (raw.phien ? raw.phien + 1 : 0),
    dice: [raw.xuc_xac_1, raw.xuc_xac_2, raw.xuc_xac_3],
    tong: raw.tong || 0,
    actual: raw.ket_qua || ''
  };
}

async function getStreakAnalysis() {
  const history = await db.allAsync('SELECT actual FROM history ORDER BY ts DESC LIMIT 50');
  if (history.length < 5) return null;

  const seq = history.filter(h => h.actual).map(h => h.actual);
  if (seq.length === 0) return null;

  const cur = seq[0];
  let streak = 1;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] === cur) streak++;
    else break;
  }

  let breaks = 0;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] !== seq[i-1]) breaks++;
  }
  const breakRate = seq.length > 1 ? (breaks / (seq.length - 1)) * 100 : 0;

  return { cur, streak, breakRate, total: seq.length };
}

async function getPredictionBySource(source) {
  const [v1, v2, streak] = await Promise.all([fetchV1(), fetchV2(), getStreakAnalysis()]);

  if (source === 'V1') return v1;
  if (source === 'V2') return v2;
  if (source === 'V3') {
    if (v2.prediction && v2.confidence >= 65) {
      return { ...v2, source: 'V3(→V2)' };
    }
    if (streak && streak.streak >= 4) {
      const opposite = streak.cur === 'Tài' ? 'Xỉu' : 'Tài';
      return {
        source: 'V3(→Streak)',
        prediction: opposite,
        confidence: Math.min(85, 55 + streak.streak * 5),
        phien: v1.phien || v2.phien,
        nextPhien: v2.nextPhien || (v1.phien + 1),
        dice: v1.dice || v2.dice,
        tong: v1.tong || v2.tong,
        actual: v1.actual || v2.actual,
        taiPeople: v1.taiPeople,
        xiuPeople: v1.xiuPeople,
        taiMoney: v1.taiMoney,
        xiuMoney: v1.xiuMoney
      };
    }
    return { ...v1, source: 'V3(→V1)' };
  }
  return v1;
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
  if (!exp) return 'Vĩnh viễn';
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
  return new Date(timestamp).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

async function updateHistory(phien, actual, aiPred, aiConf, source) {
  const existing = await db.getAsync('SELECT 1 FROM history WHERE phien = ?', phien);
  if (existing) return;
  await db.runAsync(`INSERT INTO history (phien, actual, ai_pred, ai_conf, source, ts) VALUES (?, ?, ?, ?, ?, ?)`, phien, actual, aiPred, aiConf, source, Date.now());
  const count = await db.getAsync('SELECT COUNT(*) as c FROM history');
  if (count.c > CONFIG.MAX_HISTORY) {
    await db.runAsync(`DELETE FROM history WHERE id IN (SELECT id FROM history ORDER BY ts ASC LIMIT ?)`, count.c - CONFIG.MAX_HISTORY);
  }
}

async function updateUserStats(userId, prediction, actual) {
  if (!actual) return;
  const correct = (prediction === actual) ? 1 : 0;
  await db.runAsync(`INSERT INTO stats (user_id, total, correct) VALUES (?, 1, ?) ON CONFLICT(user_id) DO UPDATE SET total = total + 1, correct = correct + excluded.correct`, userId, correct);
}

async function getUserStats(userId) {
  return await db.getAsync('SELECT total, correct FROM stats WHERE user_id = ?', userId);
}

function formatPrediction(data, userStats, streakAnalysis) {
  const isTai = data.prediction === 'Tài';
  const icon = isTai ? '🟢' : '🔴';
  const word = isTai ? '⬆️ TÀI' : '⬇️ XỈU';
  const conf = data.confidence || 50;
  const bar = '█'.repeat(Math.round(conf/10)) + '░'.repeat(10-Math.round(conf/10));

  let msg = `╔══ 🎯 DỰ ĐOÁN LC79 ══╗\n`;
  msg += `║ ${icon} <b>${word}</b>  |  Tin cậy: <b>${conf}%</b>\n`;
  msg += `║ ${bar}\n`;
  msg += `║ Nguồn: <b>${data.source}</b>\n`;
  msg += `║ 📌 Phiên hiện tại: <b>${data.phien}</b>\n`;
  msg += `║ 🔮 Dự đoán phiên <b>${data.nextPhien}</b>:\n\n`;

  const diceMap = ['⚀','⚁','⚂','⚃','⚄','⚅'];
  const diceStr = data.dice.map(d => diceMap[d-1] || '?').join(' ');
  msg += `╠══ Phiên vừa xong ══\n`;
  msg += `║ 🎲 ${diceStr} = <b>${data.tong}</b>\n`;
  if (data.actual) {
    const actIcon = data.actual === 'Tài' ? '🟢' : '🔴';
    msg += `║ Kết quả: ${actIcon} <b>${data.actual === 'Tài' ? 'TÀI' : 'XỈU'}</b>\n`;
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
      const fm = n => n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(0)+'K' : String(n);
      msg += `║ 💰 Tài: ${fm(data.taiMoney)} (${tmPct}%) | Xỉu: ${fm(data.xiuMoney)} (${100-tmPct}%)\n`;
    }
  }

  if (streakAnalysis && streakAnalysis.total >= 5) {
    msg += `╠══ PHÂN TÍCH CẦU ══\n`;
    msg += `║ 📊 Cầu hiện tại: <b>${streakAnalysis.cur} ×${streakAnalysis.streak}</b>\n`;
    msg += `║ 🔄 Tỉ lệ bẻ cầu lịch sử: <b>${streakAnalysis.breakRate.toFixed(1)}%</b>\n`;
    if (streakAnalysis.streak >= 4) {
      msg += `║ ⚠️ CẢNH BÁO: Chuỗi ${streakAnalysis.streak} dài → khả năng bẻ cao!\n`;
    }
  }

  if (userStats && userStats.total) {
    const acc = Math.round((userStats.correct || 0) / userStats.total * 100);
    msg += `╠══ THỐNG KÊ CÁ NHÂN ══\n`;
    msg += `║ 🎯 Độ chính xác: ${acc}% (${userStats.correct}/${userStats.total})\n`;
  }

  msg += `╚══════════════════\n`;
  msg += `<i>⏱ ${new Date().toLocaleString('vi-VN')} | ${isTai ? '⬆️' : '⬇️'} ${conf < 55 ? 'Tín hiệu yếu' : conf < 65 ? 'Tín hiệu trung bình' : 'Tín hiệu mạnh'}</i>`;
  return msg;
}

// ========== BOT ==========
const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
bot.on('polling_error', e => console.error('Polling error:', e.message));

const rateCache = new NodeCache({ stdTTL: 60 });

async function checkActive(uid) {
  const user = await db.getAsync('SELECT * FROM users WHERE id = ?', uid);
  if (!user || user.key_expires < Date.now()) return null;
  return user;
}

// Lệnh user
bot.onText(/\/start/, async (msg) => {
  const uid = msg.chat.id;
  const user = await db.getAsync('SELECT * FROM users WHERE id = ?', uid);
  if (user && user.key_expires > Date.now()) {
    bot.sendMessage(uid, `🔐 BẠN ĐÃ KÍCH HOẠT\n⏰ Hết hạn: ${formatExpiry(user.key_expires)}\n\n📌 /now - Dự đoán ngay\n📌 /startbot - Bật auto 30s\n📌 /stop - Tắt auto\n📌 /stats - Thống kê\n📌 /V1 /V2 /V3 - Chọn nguồn`, { parse_mode: 'HTML' });
  } else {
    bot.sendMessage(uid, `🔐 CHÀO MỪNG ĐẾN LC79 PREDICTOR\n\nNhập KEY để kích hoạt: /key MÃ_KEY\n\n💡 Chưa có key? Liên hệ admin @mdlvepa`, { parse_mode: 'HTML' });
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
  await db.runAsync(`INSERT OR REPLACE INTO users (id, first_name, last_name, username, key, key_expires, source, auto_on, activated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uid, msg.from.first_name || '', msg.from.last_name || '', msg.from.username || '',
    code, keyData.expires, 3, 0, Date.now()
  );
  bot.sendMessage(uid, `✅ Kích hoạt thành công!\n🔑 Key: <code>${code}</code>\n⏰ Hạn: ${formatExpiry(keyData.expires)}\n📡 Nguồn mặc định: V3`, { parse_mode: 'HTML' });
  if (CONFIG.ADMIN_ID) {
    bot.sendMessage(CONFIG.ADMIN_ID, `🔔 User mới kích hoạt key!\n👤 ${msg.from.first_name || ''} ${msg.from.last_name || ''} (@${msg.from.username || 'N/A'})\n🆔 ID: ${uid}\n🔑 Key: <code>${code}</code>`, { parse_mode: 'HTML' });
  }
});

bot.onText(/\/now/, async (msg) => {
  const uid = String(msg.chat.id);
  if (rateCache.get(uid)) return bot.sendMessage(uid, '⏳ Bạn đã dùng lệnh gần đây, vui lòng chờ.');
  rateCache.set(uid, true);

  const user = await checkActive(uid);
  if (!user) { bot.sendMessage(uid, '🔐 Chưa kích hoạt. Dùng /key MÃ_KEY'); return; }

  try {
    const source = user.source === 1 ? 'V1' : (user.source === 2 ? 'V2' : 'V3');
    const data = await getPredictionBySource(source);
    const userStats = await getUserStats(uid);
    const streakAnalysis = await getStreakAnalysis();
    const msgText = formatPrediction(data, userStats, streakAnalysis);
    bot.sendMessage(uid, msgText, { parse_mode: 'HTML' });
    if (data.actual) {
      await updateHistory(data.phien, data.actual, data.prediction, data.confidence, data.source);
      await updateUserStats(uid, data.prediction, data.actual);
    }
  } catch(e) {
    bot.sendMessage(uid, '⚠️ Lỗi API, thử lại sau');
    console.error(e);
  }
});

[1,2,3].forEach(v => {
  bot.onText(new RegExp(`^\\/V${v}$`), async (msg) => {
    const uid = String(msg.chat.id);
    const user = await checkActive(uid);
    if (!user) return;
    await db.runAsync('UPDATE users SET source = ? WHERE id = ?', v, uid);
    const desc = { 1: 'V1 — Dữ liệu cược', 2: 'V2 — AI LC79', 3: 'V3 — Kết hợp + phân tích cầu' };
    bot.sendMessage(uid, `✅ Đã chuyển sang <b>${desc[v]}</b>`, { parse_mode: 'HTML' });
  });
});

bot.onText(/\/startbot/, async (msg) => {
  const uid = String(msg.chat.id);
  const user = await checkActive(uid);
  if (!user) return;
  await db.runAsync('UPDATE users SET auto_on = 1 WHERE id = ?', uid);
  startUserAuto(uid);
  bot.sendMessage(uid, '▶️ Đã bật auto! Dự đoán mỗi 30 giây. Dùng /stop để tắt.', { parse_mode: 'HTML' });
});

bot.onText(/\/stop/, async (msg) => {
  const uid = String(msg.chat.id);
  await db.runAsync('UPDATE users SET auto_on = 0 WHERE id = ?', uid);
  stopUserAuto(uid);
  bot.sendMessage(uid, '⏹ Đã tắt auto. Dùng /now để xem ngay.', { parse_mode: 'HTML' });
});

bot.onText(/\/stats/, async (msg) => {
  const uid = String(msg.chat.id);
  const user = await checkActive(uid);
  if (!user) return;
  const stats = await getUserStats(uid);
  const streak = await getStreakAnalysis();
  let text = `📊 THỐNG KÊ CỦA BẠN\n\n📡 Nguồn: V${user.source || 3}\n▶️ Auto: ${user.auto_on ? 'Bật' : 'Tắt'}\n⏰ Key: ${formatExpiry(user.key_expires)}\n\n`;
  if (stats && stats.total) {
    const acc = Math.round((stats.correct || 0) / stats.total * 100);
    text += `🎯 Độ chính xác: ${acc}%\n📈 Đúng: ${stats.correct}/${stats.total}\n\n`;
  } else {
    text += `📈 Chưa có dữ liệu thống kê\n\n`;
  }
  if (streak && streak.total >= 5) {
    text += `📊 PHÂN TÍCH CẦU\n🔄 Cầu hiện tại: <b>${streak.cur} ×${streak.streak}</b>\n🔀 Tỉ lệ bẻ cầu: <b>${streak.breakRate.toFixed(1)}%</b>\n`;
    if (streak.streak >= 4) text += `⚠️ Chuỗi dài → khả năng bẻ cao!\n`;
  }
  bot.sendMessage(uid, text, { parse_mode: 'HTML' });
});

bot.onText(/\/help/, async (msg) => {
  const uid = msg.chat.id;
  const user = await checkActive(uid);
  let text = `📖 HƯỚNG DẪN\n/key MÃ - Kích hoạt\n/now - Dự đoán ngay\n/startbot - Bật auto 30s\n/stop - Tắt auto\n/stats - Thống kê\n/V1 /V2 /V3 - Chọn nguồn`;
  if (String(uid) === CONFIG.ADMIN_ID) {
    text += `\n\n👑 LỆNH ADMIN\n/addkey tên [time] - Tạo key\n/delkey MÃ - Xóa key\n/keys - DS key\n/users - DS user\n/info [ID] - Chi tiết user\n/deluser ID - Xóa user\n/resetstats - Reset thống kê`;
  }
  bot.sendMessage(uid, text, { parse_mode: 'HTML' });
});

// ========== ADMIN COMMANDS ==========
function requireAdmin(msg, fn) {
  if (String(msg.chat.id) !== CONFIG.ADMIN_ID) { bot.sendMessage(msg.chat.id, '❌ Lệnh admin'); return; }
  fn();
}

bot.onText(/\/addkey(?:\s+(.+))?/, (msg, match) => requireAdmin(msg, async () => {
  const args = (match[1] || '').trim().split(/\s+/);
  const name = args[0] || `KEY_${Date.now()}`;
  const durStr = args[1] || '30d';
  const dur = parseDuration(durStr);
  if (!dur) { bot.sendMessage(msg.chat.id, '❌ Sai định dạng. Dùng: 1p,1h,1d,1t,1th'); return; }
  const code = `${name.toUpperCase()}_${Math.random().toString(36).substr(2,6).toUpperCase()}`;
  const expires = Date.now() + dur;
  await db.runAsync(`INSERT INTO keys (code, name, created, expires, duration, createdBy) VALUES (?, ?, ?, ?, ?, ?)`, code, name, Date.now(), expires, durStr, msg.chat.id);
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
  let text = '🔑 DANH SÁCH KEY\n\n';
  for (const k of keys) {
    const status = !k.expires || k.expires > Date.now() ? (k.usedBy ? '🟢 Đã dùng' : '🟡 Chưa dùng') : '🔴 Hết hạn';
    text += `${k.code}\n   ${status} | ${k.name} | ${formatExpiry(k.expires)}\n`;
    if (k.usedBy) text += `   👤 Dùng bởi: ${k.usedBy}\n`;
    text += '\n';
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
}));

bot.onText(/\/users/, (msg) => requireAdmin(msg, async () => {
  const users = await db.allAsync('SELECT * FROM users');
  if (users.length === 0) { bot.sendMessage(msg.chat.id, '📭 Chưa có user.'); return; }
  let text = '👥 DANH SÁCH USER\n\n';
  for (const u of users) {
    const active = u.key_expires && u.key_expires > Date.now();
    const auto = u.auto_on ? '▶️' : '⏹';
    text += `${active ? '🟢' : '🔴'} ${u.first_name || u.username || u.id} [${u.id}]\n   ${auto} V${u.source || 3} | ${formatExpiry(u.key_expires)}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
}));

bot.onText(/\/info(?:\s+(\d+))?/, (msg, match) => requireAdmin(msg, async () => {
  const uid = match[1] || String(msg.chat.id);
  const user = await db.getAsync('SELECT * FROM users WHERE id = ?', uid);
  if (!user) { bot.sendMessage(msg.chat.id, `❌ Không tìm thấy user ${uid}`); return; }
  const stats = await getUserStats(uid);
  let text = `👤 THÔNG TIN USER\n\n🆔 ID: ${user.id}\n👤 Tên: ${user.first_name || ''} ${user.last_name || ''}\n🔑 Key: ${user.key || 'N/A'}\n⏰ Hạn: ${formatExpiry(user.key_expires)}\n📡 Nguồn: V${user.source || 3}\n▶️ Auto: ${user.auto_on ? 'Bật' : 'Tắt'}\n📅 Kích hoạt: ${user.activated_at ? formatVietnamTime(user.activated_at) : 'N/A'}\n\n📊 THỐNG KÊ\n🎯 Tổng: ${stats?.total || 0}\n✅ Đúng: ${stats?.correct || 0} (${stats?.total ? Math.round((stats.correct||0)/stats.total*100) : 0}%)`;
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
  try { await bot.sendMessage(uid, `⛔ Tài khoản đã bị admin xóa.`); } catch(e) {}
}));

bot.onText(/\/resetstats/, (msg) => requireAdmin(msg, async () => {
  await db.runAsync('DELETE FROM stats');
  await db.runAsync('DELETE FROM history');
  bot.sendMessage(msg.chat.id, '✅ Đã reset thống kê.');
}));

// ========== AUTO SEND ==========
const autoTimers = {};
let lastSentPhien = 0;

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

    try {
      const source = user.source === 1 ? 'V1' : (user.source === 2 ? 'V2' : 'V3');
      const data = await getPredictionBySource(source);
      if (lastSentPhien === data.nextPhien) return;
      lastSentPhien = data.nextPhien;

      const userStats = await getUserStats(uid);
      const streakAnalysis = await getStreakAnalysis();
      const msgText = formatPrediction(data, userStats, streakAnalysis);
      bot.sendMessage(uid, msgText, { parse_mode: 'HTML' });
      if (data.actual) {
        await updateHistory(data.phien, data.actual, data.prediction, data.confidence, data.source);
        await updateUserStats(uid, data.prediction, data.actual);
      }
    } catch(e) { console.error(`Auto error ${uid}:`, e.message); }
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

// ========== BACKUP ==========
function backupDatabase() {
  try {
    const src = CONFIG.DB_PATH;
    const dest = path.join(CONFIG.BACKUP_DIR, `lc79_${new Date().toISOString().slice(0,10)}.db`);
    fs.copyFileSync(src, dest);
    console.log(`📁 Backup: ${dest}`);
  } catch(e) {}
}
setInterval(backupDatabase, 24 * 60 * 60 * 1000);

// ========== HTTP SERVER & SELF PING (giữ bot không sleep) ==========
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is alive');
  console.log(`✅ Ping received at ${new Date().toISOString()}`);
});
server.listen(CONFIG.PORT, () => {
  console.log(`🌐 Health check server running on port ${CONFIG.PORT}`);
});

// Tự ping chính nó mỗi 60 giây
setInterval(() => {
  const options = {
    hostname: 'localhost',
    port: CONFIG.PORT,
    path: '/',
    method: 'GET',
    timeout: 5000
  };
  const req = http.request(options, (res) => {
    console.log(`✅ Self ping OK at ${new Date().toISOString()}`);
  });
  req.on('error', (e) => console.log(`❌ Self ping error: ${e.message}`));
  req.end();
}, 60000);

// ========== KHỞI ĐỘNG ==========
(async () => {
  try {
    await initDB();
    await restoreAutoUsers();
    console.log('✅ Bot đã khởi động!');
    if (CONFIG.ADMIN_ID) {
      bot.sendMessage(CONFIG.ADMIN_ID, `🟢 Bot LC79 đã online!\n🌐 Health check: http://localhost:${CONFIG.PORT}\n⏰ Auto ping mỗi 60 giây`, { parse_mode: 'HTML' }).catch(()=>{});
    }
  } catch (err) {
    console.error('❌ Khởi động thất bại:', err);
  }
})();
