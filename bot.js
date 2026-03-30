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

// ========== CÁC API ==========
const API1_URL = 'https://living-telecommunications-start-consoles.trycloudflare.com/api/txmd5';
const API2_URL = 'https://lc79-betvip-api-production.up.railway.app/api/lc79_md5?key=apihdx';

// Hàm gọi API với fallback proxy
async function fetchAPI(url) {
    const proxies = ['https://api.allorigins.win/raw?url=', 'https://corsproxy.io/?', ''];
    for (const proxy of proxies) {
        try {
            const fetchUrl = proxy ? proxy + encodeURIComponent(url) : url;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 6000);
            const res = await fetch(fetchUrl, { signal: controller.signal });
            clearTimeout(timeout);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch(e) { console.log(`Proxy ${proxy || 'direct'} failed:`, e.message); }
    }
    return null;
}

// API1: dữ liệu đặt cược → dự đoán dựa trên tỷ lệ tiền/người
async function getPredictionV1() {
    const raw = await fetchAPI(API1_URL);
    if (!raw) return null;
    const betting = raw.betting_info || {};
    const taiPeople = betting.nguoi_cuoc?.tai || 0;
    const xiuPeople = betting.nguoi_cuoc?.xiu || 0;
    const taiMoney = parseFloat((betting.tien_cuoc?.tai || '0').replace(/\./g, ''));
    const xiuMoney = parseFloat((betting.tien_cuoc?.xiu || '0').replace(/\./g, ''));
    const totalPeople = taiPeople + xiuPeople;
    const totalMoney = taiMoney + xiuMoney;

    // Tính điểm: 50% số người + 50% số tiền
    let score = 0.5;
    if (totalPeople > 0) score += (taiPeople - xiuPeople) / totalPeople * 0.25;
    if (totalMoney > 0) score += (taiMoney - xiuMoney) / totalMoney * 0.25;
    const prediction = score >= 0.5 ? 'Tài' : 'Xỉu';
    const confidence = Math.min(95, Math.max(5, Math.round(Math.abs(score - 0.5) * 200)));
    return { prediction, confidence, raw };
}

// API2: dự đoán AI (du_doan + do_tin_cay)
async function getPredictionV2() {
    const raw = await fetchAPI(API2_URL);
    if (!raw) return null;
    let prediction = null;
    if (raw.du_doan) {
        prediction = raw.du_doan === 'Tài' ? 'Tài' : 'Xỉu';
    } else {
        // fallback: dùng kết quả ván trước (không dùng)
        prediction = raw.ket_qua === 'Tài' ? 'Tài' : 'Xỉu';
    }
    let confidence = 50;
    if (raw.do_tin_cay) {
        const match = raw.do_tin_cay.match(/\d+/);
        if (match) confidence = parseInt(match[0]);
    }
    return { prediction, confidence, raw };
}

// API3: mix (ưu tiên API2 nếu tin cậy cao, ngược lại dùng API1)
async function getPredictionV3() {
    const [v1, v2] = await Promise.all([getPredictionV1(), getPredictionV2()]);
    if (!v1 && !v2) return null;
    if (!v1) return v2;
    if (!v2) return v1;

    // Nếu API2 có độ tin cậy >= 60% và không phải 50-50 quá, ưu tiên API2
    if (v2.confidence >= 60) {
        return { prediction: v2.prediction, confidence: v2.confidence, raw: v2.raw };
    } else {
        // Nếu API2 tin cậy thấp, dùng API1
        return { prediction: v1.prediction, confidence: v1.confidence, raw: v1.raw };
    }
}

// ========== CÁC HÀM HỖ TRỢ ==========
async function getUserIP() {
    try {
        const res = await fetch('https://api.ipify.org?format=json');
        const data = await res.json();
        return data.ip;
    } catch(e) { return 'Không xác định'; }
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
            bot.sendMessage(chatId, `⛔ KEY <code>${user.key}</code> của bạn đã hết hạn hoặc bị xóa.`, { parse_mode: 'HTML' }).catch(e => console.log(e));
        }
    }
    if (changed) saveUsers();
}

// ========== THỐNG KÊ ==========
function analyzeStreak() {
    const predictions = stats.predictions;
    if (predictions.length < 5) {
        return { breakRate: 0, confidence: 0, streak: 0, currentResult: 'chưa có', totalPredictions: predictions.length };
    }
    const recent = predictions.slice(-10).map(p => p.result);
    const currentResult = recent[recent.length - 1];
    let streak = 1;
    for (let i = recent.length - 2; i >= 0; i--) {
        if (recent[i] === currentResult) streak++;
        else break;
    }
    let breaks = 0, totalChanges = 0;
    for (let i = 1; i < predictions.length; i++) {
        if (predictions[i].result !== predictions[i-1].result) breaks++;
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
    stats.predictions.push({ time: Date.now(), result: actual, predicted: prediction });
    if (stats.predictions.length > 1000) stats.predictions.shift();
    let correctCount = stats.predictions.filter(p => p.result === p.predicted).length;
    stats.total = stats.predictions.length;
    stats.correct = correctCount;
    const analysis = analyzeStreak();
    stats.breakRate = analysis.breakRate;
    stats.lastResult = actual;
    saveStats();
}

function formatPredictionMessage(predResult, confidence, rawData) {
    const analysis = analyzeStreak();
    const accuracy = stats.total > 0 ? ((stats.correct / stats.total) * 100).toFixed(1) : 'Chưa có';
    const breakEmoji = analysis.breakRate > 60 ? '⚠️ CAO' : (analysis.breakRate < 40 ? '✅ THẤP' : '⚖️ TRUNG BÌNH');
    const diceMap = ['⚀','⚁','⚂','⚃','⚄','⚅'];
    let diceStr = '';
    let tong = '';
    let ketQua = '';
    if (rawData && rawData.xuc_xac) {
        diceStr = rawData.xuc_xac.map(d => diceMap[d-1]).join(' ');
        tong = rawData.tong;
        ketQua = rawData.ket_qua;
    } else if (rawData && rawData.xuc_xac_1) {
        diceStr = [rawData.xuc_xac_1, rawData.xuc_xac_2, rawData.xuc_xac_3].map(d => diceMap[d-1]).join(' ');
        tong = rawData.tong;
        ketQua = rawData.ket_qua;
    } else {
        diceStr = '⚀ ⚁ ⚂';
        tong = '?';
        ketQua = '?';
    }
    const msg = `🎲 <b>LC79 DỰ ĐOÁN</b>\n\n` +
                `📌 Phiên: <b>${rawData?.phien || '?'}</b>\n` +
                `🎲 Xúc xắc: ${diceStr}\n` +
                `📊 Tổng: <b>${tong}</b>\n` +
                `${ketQua === 'Tài' ? '🟢' : '🔴'} Kết quả: <b>${ketQua}</b>\n\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `🤖 <b>DỰ ĐOÁN PHIÊN TIẾP:</b> <b>${predResult === 'Tài' ? '🔴 TÀI' : '🟢 XỈU'}</b>\n\n` +
                `📊 <b>THỐNG KÊ</b>\n` +
                `├ Độ chính xác: <b>${accuracy}%</b> (${stats.correct}/${stats.total})\n` +
                `├ Tỉ lệ bẻ cầu: <b>${analysis.breakRate}%</b> (${breakEmoji})\n` +
                `└ Chuỗi hiện tại: <b>${analysis.streak} ${analysis.currentResult}</b>\n\n` +
                `⚠️ Chỉ tham khảo, không đảm bảo chính xác.`;
    return msg;
}

// ========== GỬI DỰ ĐOÁN THEO MODE CỦA USER ==========
async function sendPredictionToUser(chatId) {
    const user = users[chatId];
    if (!user) {
        bot.sendMessage(chatId, '🔐 Chưa kích hoạt. Dùng /key MÃ_KEY');
        return false;
    }
    if (!isKeyValid(user.key)) {
        bot.sendMessage(chatId, `⛔ KEY <code>${user.key}</code> đã hết hạn.`, { parse_mode: 'HTML' });
        delete users[chatId];
        saveUsers();
        return false;
    }

    let mode = user.mode || 'v1'; // mặc định v1
    let predResult = null, confidence = null, rawData = null;

    if (mode === 'v1') {
        const res = await getPredictionV1();
        if (res) { predResult = res.prediction; confidence = res.confidence; rawData = res.raw; }
    } else if (mode === 'v2') {
        const res = await getPredictionV2();
        if (res) { predResult = res.prediction; confidence = res.confidence; rawData = res.raw; }
    } else if (mode === 'v3') {
        const res = await getPredictionV3();
        if (res) { predResult = res.prediction; confidence = res.confidence; rawData = res.raw; }
    }

    if (!predResult) {
        bot.sendMessage(chatId, '⚠️ Lỗi API, thử lại sau');
        return false;
    }

    const msg = formatPredictionMessage(predResult, confidence, rawData);
    bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });

    // Cập nhật thống kê (so sánh dự đoán trước với kết quả thực tế)
    if (stats.lastPhien && stats.lastPhien !== (rawData?.phien || 0) && stats.lastPrediction) {
        updateStats(stats.lastPrediction, rawData?.ket_qua || '');
    }
    stats.lastPhien = rawData?.phien || 0;
    stats.lastPrediction = predResult;
    saveStats();
    return true;
}

// ========== LỆNH USER ==========
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (users[chatId] && isKeyValid(users[chatId].key)) {
        const mode = users[chatId].mode || 'v1';
        bot.sendMessage(chatId, `🔐 <b>BẠN ĐÃ KÍCH HOẠT</b>\n\n📌 Dùng <code>/now</code> xem dự đoán.\n🔄 Dùng <code>/startbot</code> bật auto.\n⏹️ Dùng <code>/stop</code> tắt auto.\n📊 Dùng <code>/stats</code> xem thống kê.\n\n⚙️ Chọn nguồn dự đoán:\n<code>/V1</code> - Đám đông\n<code>/V2</code> - AI (LC79)\n<code>/V3</code> - Kết hợp\n\n💡 Hỗ trợ: @mdlvepa`, { parse_mode: 'HTML' });
    } else {
        bot.sendMessage(chatId, `🔐 <b>CHÀO MỪNG ĐẾN LC79 PREDICTOR</b>\n\nNhập KEY để kích hoạt.\n📝 <code>/key MÃ_KEY</code>\n\n💡 Chưa có key? Liên hệ admin @mdlvepa`, { parse_mode: 'HTML' });
    }
});

// Lệnh chọn mode
bot.onText(/\/V1/, (msg) => {
    const chatId = msg.chat.id;
    if (!users[chatId]) {
        bot.sendMessage(chatId, '🔐 Chưa kích hoạt. Dùng /key MÃ_KEY');
        return;
    }
    users[chatId].mode = 'v1';
    saveUsers();
    bot.sendMessage(chatId, '✅ Đã chuyển sang nguồn dự đoán: <b>V1 (Đám đông)</b>', { parse_mode: 'HTML' });
});
bot.onText(/\/V2/, (msg) => {
    const chatId = msg.chat.id;
    if (!users[chatId]) {
        bot.sendMessage(chatId, '🔐 Chưa kích hoạt. Dùng /key MÃ_KEY');
        return;
    }
    users[chatId].mode = 'v2';
    saveUsers();
    bot.sendMessage(chatId, '✅ Đã chuyển sang nguồn dự đoán: <b>V2 (AI LC79)</b>', { parse_mode: 'HTML' });
});
bot.onText(/\/V3/, (msg) => {
    const chatId = msg.chat.id;
    if (!users[chatId]) {
        bot.sendMessage(chatId, '🔐 Chưa kích hoạt. Dùng /key MÃ_KEY');
        return;
    }
    users[chatId].mode = 'v3';
    saveUsers();
    bot.sendMessage(chatId, '✅ Đã chuyển sang nguồn dự đoán: <b>V3 (Kết hợp)</b>', { parse_mode: 'HTML' });
});

// Các lệnh cũ giữ nguyên
bot.onText(/\/key (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const rawKey = match[1].trim();
    const key = rawKey.toUpperCase();
    const username = msg.chat.username || msg.chat.first_name || msg.chat.last_name || 'unknown';
    const fullName = `${msg.chat.first_name || ''} ${msg.chat.last_name || ''}`.trim() || username;

    console.log(`[KEY] User ${chatId} (${fullName}) nhập key: "${rawKey}" -> chuẩn hóa: "${key}"`);

    const userInfo = {
        id: chatId, username, fullName,
        language: msg.from.language_code || 'không rõ',
        isBot: msg.from.is_bot ? 'Có' : 'Không',
        phone: msg.from.phone_number || 'Không có',
        ip: await getUserIP()
    };

    if (!keys[key]) {
        bot.sendMessage(chatId, '❌ KEY không tồn tại.');
        if (ADMIN_ID) bot.sendMessage(ADMIN_ID, `⚠️ <b>NHẬP KEY SAI</b>\n\n👤 ${fullName} (@${username})\n🔑 Key: <code>${rawKey}</code>\n📱 ${userInfo.phone}\n🌐 ${userInfo.ip}`, { parse_mode: 'HTML' });
        return;
    }
    if (keys[key].expires && Date.now() > keys[key].expires) {
        bot.sendMessage(chatId, '⛔ KEY đã hết hạn.');
        return;
    }
    if (keys[key].usedBy && keys[key].usedBy !== chatId.toString()) {
        bot.sendMessage(chatId, '⚠️ KEY đã được dùng trên thiết bị khác.');
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
        username, fullName, key,
        autoActive: true,
        activatedAt: Date.now(),
        mode: 'v1', // mặc định V1
        userInfo
    };
    saveKeys(); saveUsers();

    bot.sendMessage(chatId, `✅ <b>KÍCH HOẠT THÀNH CÔNG!</b>\n\n📌 Dùng <code>/now</code> xem dự đoán.\n🔄 Tự động gửi mỗi 60 giây.\n⚙️ Chọn nguồn: /V1, /V2, /V3\n⏰ Hạn key: ${formatVietnamTime(keys[key].expires)}`, { parse_mode: 'HTML' });
    sendPredictionToUser(chatId);

    if (ADMIN_ID) {
        bot.sendMessage(ADMIN_ID, `✅ <b>KÍCH HOẠT KEY MỚI</b>\n\n👤 ${fullName} (@${username})\n🔑 <code>${key}</code>\n📅 Hạn: ${formatVietnamTime(keys[key].expires)}\n📱 ${userInfo.phone}\n🌐 ${userInfo.ip}`, { parse_mode: 'HTML' });
    }
});

bot.onText(/\/now/, async (msg) => {
    const chatId = msg.chat.id;
    if (!users[chatId]) {
        bot.sendMessage(chatId, '🔐 Chưa kích hoạt. Dùng /key MÃ_KEY');
        return;
    }
    await sendPredictionToUser(chatId);
});

bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    if (!users[chatId]) {
        bot.sendMessage(chatId, '🔐 Chưa kích hoạt.');
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
    users[chatId].autoActive = true;
    saveUsers();
    bot.sendMessage(chatId, '✅ Đã bật auto.');
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
    const msg = `📊 <b>THỐNG KÊ DỰ ĐOÁN</b>\n\n🎯 Độ chính xác: <b>${accuracy}%</b> (${stats.correct}/${stats.total})\n🔄 Tỉ lệ bẻ cầu: <b>${analysis.breakRate}%</b> (${breakEmoji})\n📈 Chuỗi hiện tại: <b>${analysis.streak} ${analysis.currentResult}</b>\n├ Độ tin cậy bẻ cầu: <b>${analysis.confidence}%</b>\n\nℹ️ Cập nhật sau mỗi phiên mới.`;
    bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
});

// ========== LỆNH ADMIN (giữ nguyên) ==========
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
    const cmds = `📋 <b>LỆNH ADMIN</b>\n\n🔑 Quản lý key:\n/addkey <tên> [thời gian]\n/keys\n/delkey <tên>\n\n👥 Quản lý user:\n/users\n/info [ID]\n/deluser <ID>\n\n📊 Thống kê:\n/stats\n/resetstats\n\n⏰ Định dạng: 1p, 1h, 1d, 1t, 1th\n📌 Giờ Việt Nam (GMT+7)`;
    bot.sendMessage(chatId, cmds, { parse_mode: 'HTML' });
});

bot.onText(/\/resetstats/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) return;
    stats = { predictions: [], total: 0, correct: 0, breakRate: 0, lastPhien: 0, lastResult: null, lastPrediction: null };
    saveStats();
    bot.sendMessage(chatId, '✅ Đã reset thống kê.');
});

bot.onText(/\/addkey (\S+)(?:\s+(\S+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) return;
    let keyName = match[1].toUpperCase();
    let timeStr = match[2];
    if (keys[keyName]) { bot.sendMessage(chatId, `❌ Key ${keyName} đã tồn tại!`); return; }
    let expires = null, expiryText = 'Vĩnh viễn';
    if (timeStr) {
        expires = parseExpiry(timeStr);
        if (!expires) { bot.sendMessage(chatId, `❌ Sai định dạng. Dùng: 1p, 1h, 1d, 1t, 1th`); return; }
        expiryText = formatVietnamTime(expires);
    }
    keys[keyName] = { created: Date.now(), expires, usedBy: null };
    saveKeys();
    bot.sendMessage(chatId, `✅ Đã tạo key: <code>${keyName}</code>\n⏰ Hạn: ${expiryText}`, { parse_mode: 'HTML' });
});

bot.onText(/\/delkey (\S+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) return;
    const key = match[1].toUpperCase();
    if (!keys[key]) { bot.sendMessage(chatId, `❌ Key ${key} không tồn tại.`); return; }
    let userIdToRemove = null;
    for (const [uid, user] of Object.entries(users)) if (user.key === key) userIdToRemove = uid;
    if (userIdToRemove) {
        delete users[userIdToRemove];
        saveUsers();
        bot.sendMessage(chatId, `✅ Đã xóa key <code>${key}</code> và user ${userIdToRemove}`, { parse_mode: 'HTML' });
        bot.sendMessage(userIdToRemove, `⛔ Key <code>${key}</code> đã bị xóa.`).catch(e => console.log(e));
    } else {
        bot.sendMessage(chatId, `✅ Đã xóa key <code>${key}</code>`, { parse_mode: 'HTML' });
    }
    delete keys[key];
    saveKeys();
});

bot.onText(/\/users/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) return;
    const userList = Object.entries(users);
    if (userList.length === 0) { bot.sendMessage(chatId, '📭 Chưa có user.'); return; }
    let msgText = '👥 <b>DANH SÁCH USER</b>\n\n';
    for (const [uid, user] of userList) {
        const keyData = keys[user.key];
        const expiry = formatVietnamTime(keyData?.expires);
        msgText += `┌ <b>${user.fullName || user.username}</b>\n├ 🆔 ID: ${uid}\n├ 🔑 Key: <code>${user.key}</code>\n├ ⏰ Hạn: ${expiry}\n├ 🤖 Auto: ${user.autoActive ? '✅' : '⏹️'}\n├ 🧠 Mode: ${(user.mode || 'v1').toUpperCase()}\n├ 📱 SĐT: ${user.userInfo?.phone || 'Không có'}\n└ 🌐 IP: ${user.userInfo?.ip || 'Không xác định'}\n\n`;
    }
    bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
});

bot.onText(/\/keys/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) return;
    const keyList = Object.keys(keys);
    if (keyList.length === 0) { bot.sendMessage(chatId, '📭 Chưa có key.'); return; }
    let msgText = '📋 <b>DANH SÁCH KEY</b>\n\n';
    for (const k of keyList) {
        const data = keys[k];
        const isExpired = data.expires && Date.now() > data.expires;
        const status = isExpired ? '🔴 Hết hạn' : (data.usedBy ? `✅ Đã dùng (${data.usedBy})` : '🟢 Chưa dùng');
        const expiryText = formatVietnamTime(data.expires);
        msgText += `🔑 <code>${k}</code>\n   ├ 📅 Hạn: ${expiryText}\n   └ ${status}\n\n`;
    }
    bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
});

bot.onText(/\/deluser (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) return;
    const userId = match[1];
    if (!users[userId]) { bot.sendMessage(chatId, `❌ Không tìm thấy user ID: ${userId}`); return; }
    const user = users[userId];
    const key = user.key;
    if (keys[key] && keys[key].usedBy === userId) { keys[key].usedBy = null; saveKeys(); }
    delete users[userId];
    saveUsers();
    bot.sendMessage(userId, `⛔ Tài khoản của bạn đã bị admin vô hiệu hóa.`).catch(e => console.log(e));
    bot.sendMessage(chatId, `✅ Đã xóa user: ${user.fullName || user.username} (ID: ${userId})`);
});

bot.onText(/\/info(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) return;
    let userId = match[1];
    if (!userId) {
        const userList = Object.entries(users);
        if (userList.length === 0) { bot.sendMessage(chatId, '📭 Chưa có user.'); return; }
        let msgText = '👥 <b>DANH SÁCH USER</b>\n\n';
        for (const [id, user] of userList) msgText += `🆔 <code>${id}</code> — ${user.fullName || user.username}\n`;
        msgText += `\n📝 Dùng <code>/info ID</code> để xem chi tiết.`;
        bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
        return;
    }
    if (!users[userId]) { bot.sendMessage(chatId, `❌ Không tìm thấy user ID: ${userId}`); return; }
    const user = users[userId];
    const keyData = keys[user.key];
    const msgText = `📋 <b>THÔNG TIN USER</b>\n\n👤 <b>Thông tin cá nhân:</b>\n├ Tên: ${user.fullName || 'Không có'}\n├ Username: @${user.username || 'Không có'}\n├ ID: ${userId}\n├ SĐT: ${user.userInfo?.phone || 'Không có'}\n└ IP: ${user.userInfo?.ip || 'Không xác định'}\n\n🔑 <b>Thông tin key:</b>\n├ Key: <code>${user.key}</code>\n├ Hạn: ${formatVietnamTime(keyData?.expires)}\n├ Ngày kích hoạt: ${user.activatedAt ? formatVietnamTime(user.activatedAt) : 'Không rõ'}\n└ Auto: ${user.autoActive ? '✅ Bật' : '⏹️ Tắt'}\n🧠 Mode: ${(user.mode || 'v1').toUpperCase()}`;
    bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
});

// ========== AUTO GỬI ==========
let lastPhien = 0;
async function autoSend() {
    // Gọi API1 chỉ để lấy phiên hiện tại (dùng chung cho việc cập nhật thống kê)
    const v1 = await getPredictionV1();
    if (!v1) return;
    const phien = v1.raw?.phien || 0;
    if (lastPhien === phien) return;
    lastPhien = phien;

    // Cập nhật thống kê nếu có dự đoán trước đó
    if (stats.lastPhien && stats.lastPhien !== phien && stats.lastPrediction) {
        updateStats(stats.lastPrediction, v1.raw?.ket_qua || '');
    }
    stats.lastPhien = phien;
    stats.lastPrediction = null; // sẽ được gán khi gửi từng user

    let count = 0;
    for (const [chatId, user] of Object.entries(users)) {
        if (!isKeyValid(user.key)) {
            delete users[chatId];
            saveUsers();
            continue;
        }
        if (!user.autoActive) continue;

        const mode = user.mode || 'v1';
        let predResult = null, rawData = null;
        if (mode === 'v1') {
            const res = await getPredictionV1();
            if (res) { predResult = res.prediction; rawData = res.raw; }
        } else if (mode === 'v2') {
            const res = await getPredictionV2();
            if (res) { predResult = res.prediction; rawData = res.raw; }
        } else if (mode === 'v3') {
            const res = await getPredictionV3();
            if (res) { predResult = res.prediction; rawData = res.raw; }
        }

        if (!predResult) continue;

        // Cập nhật lastPrediction cho user? Không, chỉ cần thống kê toàn cục
        // Nhưng để thống kê chính xác, ta sẽ dùng kết quả từ API1 làm chuẩn
        if (stats.lastPrediction === null) {
            // Lấy dự đoán của lần đầu tiên (có thể từ bất kỳ user nào) - không lý tưởng
            // Thực tế, thống kê chỉ dùng cho v1 vì v1 có kết quả thực tế
            stats.lastPrediction = predResult;
        }

        const msg = formatPredictionMessage(predResult, 0, rawData);
        bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
        count++;
        await new Promise(r => setTimeout(r, 300));
    }
    if (count) console.log(`✅ Gửi phiên ${phien} đến ${count} user`);
    cleanInvalidUsers();
}

// Web server
const app = express();
app.get('/', (req, res) => res.send('Bot đang chạy!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web chạy tại port ${PORT}`));

setInterval(autoSend, 60000);
console.log('⏰ Bot sẵn sàng!');
