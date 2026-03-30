const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');

// ========== CẤU HÌNH ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_CHAT_ID;

const KEYS_FILE = 'keys.json';
const USERS_FILE = 'users.json';
const PREDICT_HISTORY_FILE = 'predict_history.json';

// ========== DỮ LIỆU ==========
let keys = {};        // { KEY: { created, expires, usedBy, usedAt, userInfo } }
let users = {};       // { chatId: { username, fullName, key, autoActive, gameType, apiVersion, userInfo, activatedAt } }
let predictHistory = []; // mỗi phần tử: { userId, gameType, apiVersion, phien, prediction, actual, correct, timestamp }

// ========== HÀM LƯU/ĐỌC ==========
function loadData() {
    try { keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch(e) { keys = {}; }
    try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch(e) { users = {}; }
    try { predictHistory = JSON.parse(fs.readFileSync(PREDICT_HISTORY_FILE, 'utf8')); } catch(e) { predictHistory = []; }
    console.log(`Loaded ${Object.keys(keys).length} keys, ${Object.keys(users).length} users, ${predictHistory.length} predictions`);
}
function saveKeys() { fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2)); }
function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
function savePredictHistory() { fs.writeFileSync(PREDICT_HISTORY_FILE, JSON.stringify(predictHistory, null, 2)); }

loadData();

// ========== KHỞI TẠO BOT ==========
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log('✅ Bot đã khởi động!');

// ========== API URLs ==========
const API_URL_MD5_V1 = 'https://lc79-betvip-api-production.up.railway.app/api/lc79_md5?key=apihdx';
const API_URL_MD5_V2 = 'http://160.250.137.196:5000/lc79-md5';
const API_URL_HU = 'http://160.250.137.196:5000/lc79-hu';

// ========== HÀM TIỆN ÍCH ==========
function formatVietnamTime(timestamp) {
    if (!timestamp) return 'Vĩnh viễn';
    const date = new Date(timestamp);
    return date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
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

function isKeyValid(key) {
    const keyData = keys[key];
    if (!keyData) return false;
    if (keyData.expires && Date.now() > keyData.expires) return false;
    return true;
}

// ========== LẤY DỰ ĐOÁN TỪ API ==========
async function getPrediction(gameType, apiVersion) {
    let url;
    if (gameType === 'hu') url = API_URL_HU;
    else if (apiVersion === 'v1') url = API_URL_MD5_V1;
    else url = API_URL_MD5_V2;

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        let phien, ket_qua, tong, xuc_xac = [], ai_pred, ai_conf;
        if (gameType === 'hu') {
            phien = data.phien ?? data.id ?? 0;
            ket_qua = data.ket_qua;
            tong = data.tong ?? 0;
            ai_pred = data.du_doan;
            ai_conf = data.do_tin_cay ? parseInt(String(data.do_tin_cay).match(/\d+/)?.[0] || 50) : 50;
        } else {
            phien = data.phien ?? data.phen ?? 0;
            ket_qua = data.ket_qua;
            tong = data.tong ?? 0;
            if (data.xuc_xac) xuc_xac = data.xuc_xac;
            else if (data.xuc_xac_1) xuc_xac = [data.xuc_xac_1, data.xuc_xac_2, data.xuc_xac_3];
            ai_pred = data.du_doan;
            ai_conf = data.do_tin_cay ? parseInt(String(data.do_tin_cay).match(/\d+/)?.[0] || 50) : 50;
        }

        return { phien, ket_qua, tong, xuc_xac, ai_pred, ai_conf, gameType, apiVersion };
    } catch(e) {
        console.error('API error:', e.message);
        return null;
    }
}

// ========== XỬ LÝ DỰ ĐOÁN & TỈ LỆ ĐÚNG ==========
async function sendPrediction(chatId, pred) {
    const diceMap = ['⚀','⚁','⚂','⚃','⚄','⚅'];
    const diceStr = pred.xuc_xac && pred.xuc_xac.length ? pred.xuc_xac.map(d => diceMap[d-1]).join(' ') : '? ? ?';
    const gameName = pred.gameType === 'hu' ? 'HŨ' : `MD5 ${pred.apiVersion.toUpperCase()}`;
    const msg = `🎲 <b>LC79 DỰ ĐOÁN (${gameName})</b>\n\n📌 Phiên: <b>${pred.phien}</b>\n🎲 Xúc xắc: ${diceStr}\n📊 Tổng: <b>${pred.tong}</b>\n${pred.ket_qua === 'Tài' ? '🟢' : '🔴'} Kết quả: <b>${pred.ket_qua}</b>\n\n🤖 Dự đoán phiên tiếp: <b>${pred.ai_pred === 'Tài' ? '🔴 TÀI' : '🟢 XỈU'}</b>\n📈 Độ tin cậy: <b>${pred.ai_conf}%</b>\n\n⚠️ Chỉ tham khảo.`;
    await bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });

    // Lưu dự đoán để sau kiểm tra đúng/sai
    predictHistory.push({
        userId: chatId,
        gameType: pred.gameType,
        apiVersion: pred.apiVersion,
        phien: pred.phien,
        prediction: pred.ai_pred,
        actual: null,
        correct: null,
        timestamp: Date.now()
    });
    savePredictHistory();
}

// Cập nhật kết quả thực tế cho các dự đoán trước đó (gọi khi có phiên mới)
function updatePredictionAccuracy(actualPred) {
    // Tìm dự đoán cho cùng game và phiên (vì phiên hiện tại là kết quả của phiên trước)
    const prevPred = predictHistory.find(p => 
        p.userId === actualPred.userId &&
        p.gameType === actualPred.gameType &&
        p.apiVersion === actualPred.apiVersion &&
        p.phien === actualPred.phien - 1 &&
        p.actual === null
    );
    if (prevPred) {
        prevPred.actual = actualPred.ket_qua;
        prevPred.correct = (prevPred.prediction === actualPred.ket_qua);
        savePredictHistory();
        const status = prevPred.correct ? '✅ ĐÚNG' : '❌ SAI';
        const gameName = actualPred.gameType === 'hu' ? 'HŨ' : `MD5 ${actualPred.apiVersion.toUpperCase()}`;
        bot.sendMessage(actualPred.userId, `📢 Kết quả dự đoán (${gameName}): ${status}\nPhiên ${actualPred.phien} ra <b>${actualPred.ket_qua}</b>`, { parse_mode: 'HTML' }).catch(e => console.log(e));
    }
}

// Tính tỉ lệ đúng của user cho một game cụ thể
function getUserAccuracy(userId, gameType, apiVersion) {
    const userPreds = predictHistory.filter(p => 
        p.userId === userId && 
        p.gameType === gameType && 
        p.apiVersion === apiVersion && 
        p.correct !== null
    );
    const total = userPreds.length;
    const correct = userPreds.filter(p => p.correct === true).length;
    return total ? Math.round(correct / total * 100) : 0;
}

// Gợi ý bẻ cầu khi thua liên tiếp
async function checkAndSuggest(chatId, gameType, apiVersion) {
    const recentPreds = predictHistory
        .filter(p => p.userId === chatId && p.gameType === gameType && p.apiVersion === apiVersion && p.correct !== null)
        .slice(0, 5);
    const consecutiveLoss = recentPreds.filter(p => p.correct === false).length;
    if (consecutiveLoss >= 2) {
        const lastPred = recentPreds[0];
        const opposite = lastPred.prediction === 'Tài' ? 'Xỉu' : 'Tài';
        await bot.sendMessage(chatId, `💡 <b>Gợi ý:</b> Bạn đã thua ${consecutiveLoss} ván liên tiếp. Có thể cân nhắc đánh ${opposite} để bẻ cầu.`, { parse_mode: 'HTML' });
    }
}

// ========== LỆNH USER ==========
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, `🔐 <b>CHÀO MỪNG ĐẾN LC79 PREDICTOR</b>\n\nNhập KEY để kích hoạt.\n📝 <code>/key MÃ_KEY</code>\n\nDùng <code>/now</code> xem dự đoán.\nDùng <code>/startbot</code> bật auto.\nDùng <code>/stop</code> tắt auto.\n\n💡 Chưa có key? Liên hệ admin @mdlvepa`, { parse_mode: 'HTML' });
});

bot.onText(/\/key (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const key = match[1].trim().toUpperCase();
    const username = msg.chat.username || msg.chat.first_name || msg.chat.last_name || 'unknown';
    const fullName = `${msg.chat.first_name || ''} ${msg.chat.last_name || ''}`.trim() || username;

    const userInfo = {
        id: chatId,
        username,
        fullName,
        language: msg.from.language_code || 'không rõ',
        isBot: msg.from.is_bot ? 'Có' : 'Không',
        phone: msg.from.phone_number || 'Không có',
        ip: await getUserIP()
    };

    if (!keys[key]) {
        bot.sendMessage(chatId, '❌ KEY không tồn tại.');
        if (ADMIN_ID) {
            bot.sendMessage(ADMIN_ID, `⚠️ <b>CẢNH BÁO: NHẬP KEY SAI</b>\n\n👤 User: ${userInfo.fullName} (@${userInfo.username})\n🆔 ID: ${userInfo.id}\n🔑 Key đã nhập: <code>${key}</code>\n📱 Phone: ${userInfo.phone}\n🌐 IP: ${userInfo.ip}`, { parse_mode: 'HTML' });
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

    // Giải phóng key cũ nếu user đã có key
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
        userInfo,
        gameType: 'md5',
        apiVersion: 'v1'
    };
    saveKeys(); saveUsers();

    bot.sendMessage(chatId, `✅ <b>KÍCH HOẠT THÀNH CÔNG!</b>\n\n📌 Dùng <code>/now</code> xem dự đoán.\n🔄 Tự động gửi mỗi 60 giây.\n⏰ Hạn key: ${formatVietnamTime(keys[key].expires)}\n🎮 Game mặc định: MD5 v1 (có thể đổi bằng /game)`, { parse_mode: 'HTML' });

    // Gửi dự đoán ngay lập tức
    const pred = await getPrediction('md5', 'v1');
    if (pred) {
        await sendPrediction(chatId, pred);
        updatePredictionAccuracy({ ...pred, userId: chatId });
        const acc = getUserAccuracy(chatId, 'md5', 'v1');
        bot.sendMessage(chatId, `📊 Tỉ lệ đúng hiện tại: ${acc}% (MD5 V1)`);
        await checkAndSuggest(chatId, 'md5', 'v1');
    }

    if (ADMIN_ID) {
        bot.sendMessage(ADMIN_ID, `✅ <b>KÍCH HOẠT KEY MỚI</b>\n\n👤 <b>Thông tin người dùng:</b>\n├ Tên: ${userInfo.fullName}\n├ Username: @${userInfo.username}\n├ ID: ${userInfo.id}\n├ Ngôn ngữ: ${userInfo.language}\n├ Bot: ${userInfo.isBot}\n├ SĐT: ${userInfo.phone}\n└ IP: ${userInfo.ip}\n\n🔑 <b>Thông tin key:</b>\n├ Key: <code>${key}</code>\n├ Hạn: ${formatVietnamTime(keys[key].expires)}\n└ Ngày kích hoạt: ${formatVietnamTime(Date.now())}`, { parse_mode: 'HTML' });
    }
});

bot.onText(/\/game (\w+)(?:\s+(\w+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!users[chatId]) {
        bot.sendMessage(chatId, '🔐 Chưa kích hoạt. Dùng /key MÃ_KEY');
        return;
    }
    let game = match[1].toLowerCase();
    let version = match[2] ? match[2].toLowerCase() : 'v1';
    if (game !== 'md5' && game !== 'hu') {
        bot.sendMessage(chatId, '❌ Game không hợp lệ. Chọn: md5 hoặc hu');
        return;
    }
    if (game === 'hu') version = '';
    if (game === 'md5' && version !== 'v1' && version !== 'v2') {
        bot.sendMessage(chatId, '❌ Phiên bản không hợp lệ. Chọn: v1 hoặc v2');
        return;
    }
    users[chatId].gameType = game;
    users[chatId].apiVersion = version;
    saveUsers();
    bot.sendMessage(chatId, `✅ Đã chuyển sang game: ${game.toUpperCase()} ${version ? version.toUpperCase() : ''}`);
});

bot.onText(/\/now/, async (msg) => {
    const chatId = msg.chat.id;
    if (!users[chatId]) {
        bot.sendMessage(chatId, '🔐 Chưa kích hoạt. Dùng /key MÃ_KEY');
        return;
    }
    const user = users[chatId];
    const pred = await getPrediction(user.gameType, user.apiVersion);
    if (pred) {
        await sendPrediction(chatId, pred);
        updatePredictionAccuracy({ ...pred, userId: chatId });
        const acc = getUserAccuracy(chatId, user.gameType, user.apiVersion);
        bot.sendMessage(chatId, `📊 Tỉ lệ đúng hiện tại: ${acc}% (${user.gameType.toUpperCase()} ${user.apiVersion ? user.apiVersion.toUpperCase() : ''})`);
        await checkAndSuggest(chatId, user.gameType, user.apiVersion);
    } else {
        bot.sendMessage(chatId, '⚠️ Lỗi API, thử lại sau');
    }
});

bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    if (users[chatId]) {
        users[chatId].autoActive = false;
        saveUsers();
        bot.sendMessage(chatId, '⏹️ Đã tắt auto.');
    }
});

bot.onText(/\/startbot/, (msg) => {
    const chatId = msg.chat.id;
    if (users[chatId]) {
        users[chatId].autoActive = true;
        saveUsers();
        bot.sendMessage(chatId, '✅ Đã bật auto.');
    }
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
/stats                    - Xem tổng quan dự đoán

⏰ <b>Định dạng thời gian:</b>
p = phút, h = giờ, d = ngày, t = tuần, th = tháng
Ví dụ: 1h, 2d, 1t, 3th

📌 <b>Lưu ý:</b> Thời gian hiển thị theo giờ Việt Nam (GMT+7)`;
    bot.sendMessage(chatId, cmds, { parse_mode: 'HTML' });
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
    keys[keyName] = { created: Date.now(), expires, usedBy: null, createdBy: 'admin' };
    saveKeys();
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
        msgText += `├ 🎮 Game: ${user.gameType?.toUpperCase() || 'MD5'} ${user.apiVersion?.toUpperCase() || 'V1'}\n`;
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
    const acc = getUserAccuracy(userId, user.gameType, user.apiVersion);
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
        `└ Auto: ${user.autoActive ? '✅ Bật' : '⏹️ Tắt'}\n\n` +
        `📊 <b>Thống kê dự đoán (${user.gameType.toUpperCase()} ${user.apiVersion ? user.apiVersion.toUpperCase() : ''}):</b>\n` +
        `└ Tỉ lệ đúng: ${acc}%`;
    bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
});

bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) return;
    const totalPredictions = predictHistory.length;
    const correctPredictions = predictHistory.filter(p => p.correct === true).length;
    const overallAccuracy = totalPredictions ? Math.round(correctPredictions / totalPredictions * 100) : 0;
    const msgText = `📊 <b>THỐNG KÊ TỔNG QUAN</b>\n\n` +
        `📝 Tổng số dự đoán: ${totalPredictions}\n` +
        `✅ Số dự đoán đúng: ${correctPredictions}\n` +
        `❌ Số dự đoán sai: ${totalPredictions - correctPredictions}\n` +
        `📈 Tỉ lệ đúng trung bình: ${overallAccuracy}%\n\n` +
        `👥 Số user đã kích hoạt: ${Object.keys(users).length}\n` +
        `🔑 Số key đã tạo: ${Object.keys(keys).length}`;
    bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
});

// ========== AUTO GỬI ==========
let lastPhien = {}; // lưu theo key "game_apiVersion"

async function autoSend() {
    for (const [chatId, user] of Object.entries(users)) {
        if (!user.autoActive) continue;
        const key = `${user.gameType}_${user.apiVersion}`;
        const pred = await getPrediction(user.gameType, user.apiVersion);
        if (!pred) continue;
        if (lastPhien[key] === pred.phien) continue;
        lastPhien[key] = pred.phien;
        await sendPrediction(chatId, pred);
        updatePredictionAccuracy({ ...pred, userId: chatId });
        const acc = getUserAccuracy(chatId, user.gameType, user.apiVersion);
        bot.sendMessage(chatId, `📊 Tỉ lệ đúng hiện tại: ${acc}% (${user.gameType.toUpperCase()} ${user.apiVersion ? user.apiVersion.toUpperCase() : ''})`).catch(e => console.log(e));
        await checkAndSuggest(chatId, user.gameType, user.apiVersion);
        await new Promise(r => setTimeout(r, 500));
    }
}

// ========== WEB SERVER (giữ Render không ngủ) ==========
const app = express();
app.get('/', (req, res) => res.send('Bot đang chạy!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web chạy tại port ${PORT}`));

// ========== KHỞI CHẠY AUTO ==========
setInterval(autoSend, 60000);
console.log('⏰ Bot sẵn sàng!');
