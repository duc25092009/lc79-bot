const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_CHAT_ID;

const KEYS_FILE = 'keys.json';
const USERS_FILE = 'users.json';
const STATS_FILE = 'stats.json';

let keys = {};
let users = {};
let stats = { predictions: [], total: 0, correct: 0, breakRate: 0, lastPhien: 0, lastResult: null, lastPrediction: null };

function loadData() {
    try { keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch(e) { keys = {}; }
    try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch(e) { users = {}; }
    try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch(e) { stats = { predictions: [], total: 0, correct: 0, breakRate: 0, lastPhien: 0, lastResult: null, lastPrediction: null }; }
    console.log(`Loaded ${Object.keys(keys).length} keys, ${Object.keys(users).length} users, ${stats.total} predictions`);
}
function saveKeys() { fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2)); }
function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
function saveStats() { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)); }

loadData();

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log('✅ Bot đã khởi động!');

// API lấy dự đoán
const API_URL = 'https://living-telecommunications-start-consoles.trycloudflare.com/api/txmd5';

async function getPrediction() {
    try {
        const res = await fetch(API_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return {
            phien: data.phien,
            ket_qua: data.ket_qua,
            xuc_xac: [data.xuc_xac_1, data.xuc_xac_2, data.xuc_xac_3],
            tong: data.tong
        };
    } catch(e) {
        console.error('API error:', e.message);
        return null;
    }
}

async function getUserIP() {
    try {
        const res = await fetch('https://api.ipify.org?format=json');
        const data = await res.json();
        return data.ip;
    } catch(e) {
        return 'Không xác định';
    }
}

function formatVietnamTime(timestamp) {
    if (!timestamp) return 'Vĩnh viễn';
    const date = new Date(timestamp);
    return date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function isKeyValid(key) {
    const keyData = keys[key];
    if (!keyData) return false;
    if (keyData.expires && Date.now() > keyData.expires) return false;
    return true;
}

function cleanInvalidUsers() {
    let changed = false;
    for (const [chatId, user] of Object.entries(users)) {
        const keyData = keys[user.key];
        if (!keyData || (keyData.expires && Date.now() > keyData.expires)) {
            delete users[chatId];
            changed = true;
            console.log(`🗑 Đã xóa user ${chatId} do key ${user.key} không hợp lệ`);
            bot.sendMessage(chatId, `⛔ KEY <code>${user.key}</code> của bạn đã hết hạn hoặc bị xóa. Vui lòng liên hệ admin.`, { parse_mode: 'HTML' }).catch(e => console.log(e));
        }
    }
    if (changed) saveUsers();
}

// ========== PHÂN TÍCH CẦU ==========
function analyzeStreak() {
    const predictions = stats.predictions;
    if (predictions.length < 5) {
        return {
            breakRate: 0,
            confidence: 0,
            streak: 0,
            currentResult: 'chưa có',
            pattern: 'Chưa đủ dữ liệu',
            totalPredictions: predictions.length
        };
    }
    
    const recent = predictions.slice(-10).map(p => p.result);
    const currentResult = recent[recent.length - 1];
    
    let streak = 1;
    for (let i = recent.length - 2; i >= 0; i--) {
        if (recent[i] === currentResult) streak++;
        else break;
    }
    
    let breaks = 0;
    let totalChanges = 0;
    for (let i = 1; i < predictions.length; i++) {
        if (predictions[i].result !== predictions[i-1].result) {
            breaks++;
        }
        totalChanges++;
    }
    const breakRate = totalChanges > 0 ? (breaks / totalChanges) * 100 : 0;
    
    let confidence = 50;
    if (streak >= 4) confidence = 35;
    else if (streak === 3) confidence = 45;
    else if (streak === 2) confidence = 55;
    else if (streak === 1) confidence = 65;
    
    if (breakRate > 60) confidence -= 10;
    if (breakRate < 40) confidence += 10;
    
    confidence = Math.min(95, Math.max(5, confidence));
    
    return { breakRate: Math.round(breakRate), confidence, streak, currentResult, totalPredictions: predictions.length };
}

function updateStats(prediction, actual) {
    if (!prediction || !actual) return;
    
    stats.predictions.push({
        time: Date.now(),
        result: actual,
        predicted: prediction
    });
    
    if (stats.predictions.length > 1000) stats.predictions.shift();
    
    let correctCount = 0;
    for (const p of stats.predictions) {
        if (p.result === p.predicted) correctCount++;
    }
    stats.total = stats.predictions.length;
    stats.correct = correctCount;
    
    const analysis = analyzeStreak();
    stats.breakRate = analysis.breakRate;
    stats.lastResult = actual;
    
    saveStats();
}

function formatPredictionMessage(pred) {
    const analysis = analyzeStreak();
    const accuracy = stats.total > 0 ? ((stats.correct / stats.total) * 100).toFixed(1) : 'Chưa có';
    const breakEmoji = analysis.breakRate > 60 ? '⚠️ CAO' : (analysis.breakRate < 40 ? '✅ THẤP' : '⚖️ TRUNG BÌNH');
    
    const diceMap = ['⚀','⚁','⚂','⚃','⚄','⚅'];
    const diceStr = pred.xuc_xac.map(d => diceMap[d-1]).join(' ');
    
    let msg = `🎲 <b>LC79 DỰ ĐOÁN</b>\n\n` +
              `📌 Phiên: <b>${pred.phien}</b>\n` +
              `🎲 Xúc xắc: ${diceStr}\n` +
              `📊 Tổng: <b>${pred.tong}</b>\n` +
              `${pred.ket_qua === 'Tài' ? '🟢' : '🔴'} Kết quả: <b>${pred.ket_qua}</b>\n\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `🤖 <b>DỰ ĐOÁN PHIÊN TIẾP:</b> <b>${pred.ket_qua === 'Tài' ? '🔴 TÀI' : '🟢 XỈU'}</b>\n\n` +
              `📊 <b>THỐNG KÊ</b>\n` +
              `├ Độ chính xác: <b>${accuracy}%</b> (${stats.correct}/${stats.total})\n` +
              `├ Tỉ lệ bẻ cầu: <b>${analysis.breakRate}%</b> (${breakEmoji})\n` +
              `└ Chuỗi hiện tại: <b>${analysis.streak} ${analysis.currentResult}</b>\n\n` +
              `⚠️ Chỉ tham khảo, không đảm bảo chính xác.`;
    return msg;
}

async function sendPrediction(chatId) {
    const pred = await getPrediction();
    if (!pred) {
        bot.sendMessage(chatId, '⚠️ Lỗi API, thử lại sau');
        return;
    }
    const msg = formatPredictionMessage(pred);
    bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
    
    // Cập nhật thống kê (so sánh dự đoán trước đó với kết quả hiện tại)
    if (stats.lastPhien && stats.lastPhien !== pred.phien && stats.lastPrediction) {
        updateStats(stats.lastPrediction, pred.ket_qua);
    }
    stats.lastPhien = pred.phien;
    stats.lastPrediction = pred.ket_qua === 'Tài' ? 'Tài' : 'Xỉu';
    saveStats();
}

// ========== LỆNH USER ==========
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, `🔐 <b>CHÀO MỪNG ĐẾN LC79 PREDICTOR</b>\n\nNhập KEY để kích hoạt.\n📝 <code>/key MÃ_KEY</code>\n\nDùng <code>/now</code> xem dự đoán.\nDùng <code>/startbot</code> bật auto.\nDùng <code>/stop</code> tắt auto.\nDùng <code>/stats</code> xem thống kê chi tiết.\n\n💡 Chưa có key? Liên hệ admin @mdlvepa`, { parse_mode: 'HTML' });
});

bot.onText(/\/stats/, (msg) => {
    const chatId = msg.chat.id;
    if (!users[chatId]) {
        bot.sendMessage(chatId, '🔐 Chưa kích hoạt. Dùng /key MÃ_KEY');
        return;
    }
    
    const analysis = analyzeStreak();
    const accuracy = stats.total > 0 ? ((stats.correct / stats.total) * 100).toFixed(1) : 'Chưa có';
    const breakEmoji = analysis.breakRate > 60 ? '⚠️ CAO' : (analysis.breakRate < 40 ? '✅ THẤP' : '⚖️ TRUNG BÌNH');
    
    const msg = `📊 <b>THỐNG KÊ DỰ ĐOÁN</b>\n\n` +
                `🎯 Độ chính xác: <b>${accuracy}%</b>\n` +
                `├ Đúng: <b>${stats.correct}</b> / ${stats.total} ván\n\n` +
                `🔄 Tỉ lệ bẻ cầu: <b>${analysis.breakRate}%</b> (${breakEmoji})\n` +
                `├ Dựa trên ${analysis.totalPredictions} ván gần nhất\n\n` +
                `📈 Chuỗi hiện tại: <b>${analysis.streak} ${analysis.currentResult}</b>\n` +
                `├ Độ tin cậy bẻ cầu: <b>${analysis.confidence}%</b>\n\n` +
                `ℹ️ Cập nhật sau mỗi phiên mới.`;
    
    bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
});

bot.onText(/\/key (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const rawKey = match[1].trim();
    const key = rawKey.toUpperCase();
    const username = msg.chat.username || msg.chat.first_name || msg.chat.last_name || 'unknown';
    const fullName = `${msg.chat.first_name || ''} ${msg.chat.last_name || ''}`.trim() || username;

    console.log(`[KEY] User ${chatId} (${fullName}) nhập key: "${rawKey}" -> chuẩn hóa: "${key}"`);
    console.log(`[KEY] Danh sách key hiện tại:`, Object.keys(keys));

    const userInfo = {
        id: chatId,
        username: username,
        fullName: fullName,
        language: msg.from.language_code || 'không rõ',
        isBot: msg.from.is_bot ? 'Có' : 'Không',
        phone: msg.from.phone_number || 'Không có',
        ip: await getUserIP()
    };

    if (!keys[key]) {
        bot.sendMessage(chatId, '❌ KEY không tồn tại.');
        if (ADMIN_ID) {
            bot.sendMessage(ADMIN_ID, `⚠️ <b>CẢNH BÁO: NHẬP KEY SAI</b>\n\n👤 User: ${userInfo.fullName} (@${userInfo.username})\n🆔 ID: ${userInfo.id}\n🔑 Key đã nhập: <code>${rawKey}</code> (chuẩn hóa: <code>${key}</code>)\n📱 Phone: ${userInfo.phone}\n🌐 IP: ${userInfo.ip}`, { parse_mode: 'HTML' });
        }
        return;
    }

    if (keys[key].expires && Date.now() > keys[key].expires) {
        bot.sendMessage(chatId, '⛔ KEY đã hết hạn.');
        if (ADMIN_ID) {
            bot.sendMessage(ADMIN_ID, `⛔ <b>KEY HẾT HẠN</b>\n\n👤 User: ${userInfo.fullName} (@${userInfo.username})\n🔑 Key: <code>${key}</code>\n📅 Hết hạn: ${formatVietnamTime(keys[key].expires)}`, { parse_mode: 'HTML' });
        }
        return;
    }

    if (keys[key].usedBy && keys[key].usedBy !== chatId.toString()) {
        bot.sendMessage(chatId, '⚠️ KEY đã được dùng trên thiết bị khác.');
        if (ADMIN_ID) {
            bot.sendMessage(ADMIN_ID, `⚠️ <b>CỐ GẮNG DÙNG KEY ĐÃ ĐƯỢC KÍCH HOẠT</b>\n\n👤 User: ${userInfo.fullName} (@${userInfo.username})\n🔑 Key: <code>${key}</code>\n👤 Đã dùng bởi: ${keys[key].usedBy}`, { parse_mode: 'HTML' });
        }
        return;
    }

    if (users[chatId]) {
        const oldKey = users[chatId].key;
        if (keys[oldKey] && keys[oldKey].usedBy === chatId.toString()) {
            keys[oldKey].usedBy = null;
            keys[oldKey].usedAt = null;
        }
    }

    keys[key].usedBy = chatId.toString();
    keys[key].usedAt = Date.now();
    keys[key].userInfo = userInfo;
    users[chatId] = {
        username,
        fullName,
        key,
        autoActive: true,
        activatedAt: Date.now(),
        userInfo: userInfo
    };
    saveKeys(); saveUsers();

    bot.sendMessage(chatId, `✅ <b>KÍCH HOẠT THÀNH CÔNG!</b>\n\n📌 Dùng <code>/now</code> xem dự đoán.\n🔄 Tự động gửi mỗi 60 giây.\n📊 Dùng <code>/stats</code> xem thống kê.\n⏰ Hạn key: ${formatVietnamTime(keys[key].expires)}`, { parse_mode: 'HTML' });
    sendPrediction(chatId);

    if (ADMIN_ID) {
        bot.sendMessage(ADMIN_ID, `✅ <b>KÍCH HOẠT KEY MỚI</b>\n\n👤 <b>Thông tin người dùng:</b>\n├ Tên: ${userInfo.fullName}\n├ Username: @${userInfo.username}\n├ ID: ${userInfo.id}\n├ Ngôn ngữ: ${userInfo.language}\n├ Bot: ${userInfo.isBot}\n├ SĐT: ${userInfo.phone}\n└ IP: ${userInfo.ip}\n\n🔑 <b>Thông tin key:</b>\n├ Key: <code>${key}</code>\n├ Hạn: ${formatVietnamTime(keys[key].expires)}\n└ Ngày kích hoạt: ${formatVietnamTime(Date.now())}`, { parse_mode: 'HTML' });
    }
});

bot.onText(/\/now/, async (msg) => {
    const chatId = msg.chat.id;
    if (!users[chatId]) {
        bot.sendMessage(chatId, '🔐 Chưa kích hoạt. Dùng /key MÃ_KEY');
        return;
    }

    const userKey = users[chatId].key;
    if (!isKeyValid(userKey)) {
        bot.sendMessage(chatId, `⛔ KEY <code>${userKey}</code> của bạn đã hết hạn hoặc không tồn tại. Vui lòng liên hệ admin.`, { parse_mode: 'HTML' });
        delete users[chatId];
        saveUsers();
        return;
    }

    await sendPrediction(chatId);
});

bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    if (!users[chatId]) {
        bot.sendMessage(chatId, '🔐 Chưa kích hoạt.');
        return;
    }

    const userKey = users[chatId].key;
    if (!isKeyValid(userKey)) {
        bot.sendMessage(chatId, `⛔ KEY <code>${userKey}</code> của bạn đã hết hạn.`, { parse_mode: 'HTML' });
        delete users[chatId];
        saveUsers();
        return;
    }

    users[chatId].autoActive = false;
    saveUsers();
    bot.sendMessage(chatId, '⏹️ Đã tắt auto.');
});

bot.onText(/\/startbot/, (msg) => {
    const chatId = msg.chat.id;
    if (!users[chatId]) {
        bot.sendMessage(chatId, '🔐 Chưa kích hoạt. Dùng /key MÃ_KEY');
        return;
    }

    const userKey = users[chatId].key;
    if (!isKeyValid(userKey)) {
        bot.sendMessage(chatId, `⛔ KEY <code>${userKey}</code> của bạn đã hết hạn. Vui lòng liên hệ admin.`, { parse_mode: 'HTML' });
        delete users[chatId];
        saveUsers();
        return;
    }

    users[chatId].autoActive = true;
    saveUsers();
    bot.sendMessage(chatId, '✅ Đã bật auto.');
});

// ========== LỆNH ADMIN ==========
function parseExpiry(timeStr) {
    if (!timeStr) return null;
    const match = timeStr.match(/^(\d+)(p|h|d|t|th)$/i);
    if (!match) return null;
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    const now = Date.now();
    switch(unit) {
        case 'p': return now + value * 60 * 1000;
        case 'h': return now + value * 60 * 60 * 1000;
        case 'd': return now + value * 24 * 60 * 60 * 1000;
        case 't': return now + value * 7 * 24 * 60 * 60 * 1000;
        case 'th': return now + value * 30 * 24 * 60 * 60 * 1000;
        default: return null;
    }
}

bot.onText(/\/admincmds/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) return;
    const cmds =
`📋 <b>LỆNH ADMIN</b>

🔑 <b>Quản lý key:</b>
/addkey <tên> [thời gian]  - Tạo key (vd: /addkey VIP 1h)
/keys                     - Xem danh sách key
/delkey <tên>             - Xóa key (tự xóa user đang dùng)

👥 <b>Quản lý user:</b>
/users                    - Xem danh sách user
/info [ID]                - Xem thông tin user
/deluser <ID>             - Xóa user

📊 <b>Thống kê:</b>
/stats                    - Xem thống kê dự đoán (user cũng dùng được)
/resetstats               - Reset toàn bộ thống kê (admin)

⏰ <b>Định dạng thời gian:</b>
p = phút, h = giờ, d = ngày, t = tuần, th = tháng
Ví dụ: 1h, 2d, 1t, 3th

📌 <b>Lưu ý:</b> Thời gian hiển thị theo giờ Việt Nam (GMT+7)`;
    bot.sendMessage(chatId, cmds, { parse_mode: 'HTML' });
});

bot.onText(/\/resetstats/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) {
        bot.sendMessage(chatId, '⛔ Bạn không có quyền.');
        return;
    }
    stats = { predictions: [], total: 0, correct: 0, breakRate: 0, lastPhien: 0, lastResult: null, lastPrediction: null };
    saveStats();
    bot.sendMessage(chatId, '✅ Đã reset toàn bộ thống kê dự đoán.');
});

bot.onText(/\/addkey (\S+)(?:\s+(\S+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) {
        bot.sendMessage(chatId, '⛔ Bạn không có quyền.');
        return;
    }

    let keyName = match[1].toUpperCase();
    let timeStr = match[2];

    if (keys[keyName]) {
        bot.sendMessage(chatId, `❌ Key ${keyName} đã tồn tại!`);
        return;
    }

    let expires = null;
    let expiryText = 'Vĩnh viễn';

    if (timeStr) {
        expires = parseExpiry(timeStr);
        if (!expires) {
            bot.sendMessage(chatId, `❌ Sai định dạng thời gian. Dùng: 1p, 1h, 1d, 1t (tuần), 1th (tháng)`);
            return;
        }
        expiryText = formatVietnamTime(expires);
    }

    keys[keyName] = { created: Date.now(), expires: expires, usedBy: null, createdBy: 'admin' };
    saveKeys();
    console.log(`[ADMIN] Đã tạo key: ${keyName}, hạn: ${expiryText}`);
    bot.sendMessage(chatId, `✅ Đã tạo key: <code>${keyName}</code>\n⏰ Hạn: ${expiryText}`, { parse_mode: 'HTML' });
});

bot.onText(/\/delkey (\S+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) {
        bot.sendMessage(chatId, '⛔ Bạn không có quyền.');
        return;
    }
    const key = match[1].toUpperCase();
    if (!keys[key]) {
        bot.sendMessage(chatId, `❌ Key ${key} không tồn tại.`);
        return;
    }

    let userIdToRemove = null;
    for (const [uid, user] of Object.entries(users)) {
        if (user.key === key) {
            userIdToRemove = uid;
            break;
        }
    }

    if (userIdToRemove) {
        delete users[userIdToRemove];
        saveUsers();
        bot.sendMessage(chatId, `✅ Đã xóa key <code>${key}</code> và user ${userIdToRemove}`, { parse_mode: 'HTML' });
        bot.sendMessage(userIdToRemove, `⛔ Key <code>${key}</code> của bạn đã bị admin xóa. Vui lòng liên hệ admin.`, { parse_mode: 'HTML' }).catch(e => console.log(e));
    } else {
        bot.sendMessage(chatId, `✅ Đã xóa key <code>${key}</code> (không có user nào đang dùng)`, { parse_mode: 'HTML' });
    }

    delete keys[key];
    saveKeys();
});

bot.onText(/\/users/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) return;

    const userList = Object.entries(users);
    if (userList.length === 0) {
        bot.sendMessage(chatId, '📭 Chưa có user nào kích hoạt.');
        return;
    }

    let msgText = '👥 <b>DANH SÁCH USER</b>\n\n';
    for (const [uid, user] of userList) {
        const keyData = keys[user.key];
        const isExpired = keyData?.expires && Date.now() > keyData.expires;
        const status = isExpired ? '🔴 Hết hạn' : (keyData ? '🟢 Hiệu lực' : '❌ Key không tồn tại');
        const expiry = formatVietnamTime(keyData?.expires);
        msgText += `┌ <b>${user.fullName || user.username}</b>\n`;
        msgText += `├ 🆔 ID: ${uid}\n`;
        msgText += `├ 🔑 Key: <code>${user.key}</code>\n`;
        msgText += `├ ⏰ Hạn: ${expiry}\n`;
        msgText += `├ 📊 Trạng thái: ${status}\n`;
        msgText += `├ 🤖 Auto: ${user.autoActive ? '✅ Bật' : '⏹️ Tắt'}\n`;
        msgText += `├ 📱 SĐT: ${user.userInfo?.phone || 'Không có'}\n`;
        msgText += `└ 🌐 IP: ${user.userInfo?.ip || 'Không xác định'}\n\n`;
    }
    bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
});

bot.onText(/\/keys/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) return;

    const keyList = Object.keys(keys);
    if (keyList.length === 0) {
        bot.sendMessage(chatId, '📭 Chưa có key nào.');
        return;
    }

    let msgText = '📋 <b>DANH SÁCH KEY</b>\n\n';
    for (const k of keyList) {
        const data = keys[k];
        const isExpired = data.expires && Date.now() > data.expires;
        const status = isExpired ? '🔴 Hết hạn' : (data.usedBy ? `✅ Đã dùng (${data.usedBy})` : '🟢 Chưa dùng');
        const expiryText = formatVietnamTime(data.expires);
        msgText += `🔑 <code>${k}</code>\n`;
        msgText += `   ├ 📅 Hạn: ${expiryText}\n`;
        msgText += `   └ ${status}\n\n`;
    }
    bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
});

bot.onText(/\/deluser (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) {
        bot.sendMessage(chatId, '⛔ Bạn không có quyền.');
        return;
    }
    const userId = match[1];
    if (!users[userId]) {
        bot.sendMessage(chatId, `❌ Không tìm thấy user ID: ${userId}`);
        return;
    }
    const user = users[userId];
    const key = user.key;
    if (keys[key] && keys[key].usedBy === userId) {
        keys[key].usedBy = null;
        keys[key].usedAt = null;
        saveKeys();
    }
    delete users[userId];
    saveUsers();
    bot.sendMessage(userId, `⛔ Tài khoản của bạn đã bị admin vô hiệu hóa.`).catch(e => console.log(e));
    bot.sendMessage(chatId, `✅ Đã xóa user: ${user.fullName || user.username} (ID: ${userId})\n🔑 Key ${key} đã được giải phóng.`);
});

bot.onText(/\/info(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) return;

    let userId = match[1];
    if (!userId) {
        const userList = Object.entries(users);
        if (userList.length === 0) {
            bot.sendMessage(chatId, '📭 Chưa có user nào.');
            return;
        }
        let msgText = '👥 <b>DANH SÁCH USER</b>\n\n';
        for (const [id, user] of userList) {
            msgText += `🆔 <code>${id}</code> — ${user.fullName || user.username}\n`;
        }
        msgText += `\n📝 Dùng <code>/info ID</code> để xem chi tiết.`;
        bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
        return;
    }

    if (!users[userId]) {
        bot.sendMessage(chatId, `❌ Không tìm thấy user ID: ${userId}`);
        return;
    }

    const user = users[userId];
    const keyData = keys[user.key];
    const isExpired = keyData?.expires && Date.now() > keyData.expires;

    const msgText = `📋 <b>THÔNG TIN USER</b>\n\n` +
        `👤 <b>Thông tin cá nhân:</b>\n` +
        `├ Tên: ${user.fullName || 'Không có'}\n` +
        `├ Username: @${user.username || 'Không có'}\n` +
        `├ ID: ${userId}\n` +
        `├ SĐT: ${user.userInfo?.phone || 'Không có'}\n` +
        `└ IP: ${user.userInfo?.ip || 'Không xác định'}\n\n` +
        `🔑 <b>Thông tin key:</b>\n` +
        `├ Key: <code>${user.key}</code>\n` +
        `├ Hạn: ${formatVietnamTime(keyData?.expires)}\n` +
        `├ Trạng thái: ${isExpired ? '🔴 Hết hạn' : (keyData ? '🟢 Hiệu lực' : '❌ Key không tồn tại')}\n` +
        `├ Ngày kích hoạt: ${user.activatedAt ? formatVietnamTime(user.activatedAt) : 'Không rõ'}\n` +
        `└ Auto: ${user.autoActive ? '✅ Bật' : '⏹️ Tắt'}`;

    bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
});

// ========== AUTO GỬI ==========
let lastPhien = 0;
async function autoSend() {
    const pred = await getPrediction();
    if (!pred) return;
    if (lastPhien === pred.phien) return;
    lastPhien = pred.phien;

    // Cập nhật thống kê (so sánh dự đoán trước đó với kết quả hiện tại)
    if (stats.lastPhien && stats.lastPhien !== pred.phien && stats.lastPrediction) {
        updateStats(stats.lastPrediction, pred.ket_qua);
    }
    stats.lastPhien = pred.phien;
    stats.lastPrediction = pred.ket_qua === 'Tài' ? 'Tài' : 'Xỉu';
    saveStats();

    const msg = formatPredictionMessage(pred);

    let count = 0;
    for (const [chatId, user] of Object.entries(users)) {
        const userKey = user.key;
        const keyData = keys[userKey];

        if (!keyData) {
            delete users[chatId];
            saveUsers();
            console.log(`🗑 Đã xóa user ${chatId} do key không tồn tại`);
            bot.sendMessage(chatId, `⛔ KEY <code>${userKey}</code> không tồn tại. Vui lòng liên hệ admin.`, { parse_mode: 'HTML' }).catch(e => console.log(e));
            continue;
        }

        if (keyData.expires && Date.now() > keyData.expires) {
            delete users[chatId];
            saveUsers();
            bot.sendMessage(chatId, `⛔ KEY <code>${userKey}</code> đã hết hạn từ ${formatVietnamTime(keyData.expires)}. Vui lòng liên hệ admin.`, { parse_mode: 'HTML' }).catch(e => console.log(e));
            console.log(`⛔ User ${chatId} bị xóa do key ${userKey} hết hạn`);
            continue;
        }

        if (user.autoActive) {
            bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
            count++;
            await new Promise(r => setTimeout(r, 300));
        }
    }
    if (count) console.log(`✅ Gửi phiên ${pred.phien} đến ${count} user`);

    cleanInvalidUsers();
}

// Web server
const app = express();
app.get('/', (req, res) => res.send('Bot đang chạy!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web chạy tại port ${PORT}`));

setInterval(autoSend, 60000);
console.log('⏰ Bot sẵn sàng!');
