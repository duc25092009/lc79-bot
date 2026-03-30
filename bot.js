const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_CHAT_ID;

const KEYS_FILE = 'keys.json';
const USERS_FILE = 'users.json';
const PREDICT_HISTORY_FILE = 'predict_history.json';

let keys = {};
let users = {};
let predictHistory = []; // mỗi item: { userId, gameType, apiVersion, phien, prediction, actual, timestamp, correct }

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

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log('✅ Bot đã khởi động!');

// ========== API URLs ==========
const API_URL_V1 = 'https://lc79-betvip-api-production.up.railway.app/api/lc79_md5?key=apihdx';
const API_URL_V2 = 'http://160.250.137.196:5000/lc79-md5';
const API_URL_HU = 'http://160.250.137.196:5000/lc79-hu';

// Lưu game mặc định của user (có thể thay bằng lệnh /game)
let userGame = {}; // { userId: { game: 'md5', version: 'v1' } }

async function getPrediction(gameType, apiVersion) {
    let url;
    if (gameType === 'hu') url = API_URL_HU;
    else if (apiVersion === 'v1') url = API_URL_V1;
    else url = API_URL_V2;

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        // Parse theo từng loại
        let phien, ket_qua, tong, xuc_xac = [], ai_pred = null, ai_conf = null;
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

async function sendPrediction(chatId, pred) {
    const diceMap = ['⚀','⚁','⚂','⚃','⚄','⚅'];
    const diceStr = pred.xuc_xac && pred.xuc_xac.length ? pred.xuc_xac.map(d => diceMap[d-1]).join(' ') : '? ? ?';
    const gameName = pred.gameType === 'hu' ? 'HŨ' : `MD5 ${pred.apiVersion.toUpperCase()}`;
    const msg = `🎲 <b>LC79 DỰ ĐOÁN (${gameName})</b>\n\n📌 Phiên: <b>${pred.phien}</b>\n🎲 Xúc xắc: ${diceStr}\n📊 Tổng: <b>${pred.tong}</b>\n${pred.ket_qua === 'Tài' ? '🟢' : '🔴'} Kết quả: <b>${pred.ket_qua}</b>\n\n🤖 Dự đoán phiên tiếp: <b>${pred.ai_pred === 'Tài' ? '🔴 TÀI' : '🟢 XỈU'}</b>\n📈 Độ tin cậy: <b>${pred.ai_conf}%</b>\n\n⚠️ Chỉ tham khảo.`;
    bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
    // Lưu dự đoán để sau này kiểm tra đúng/sai
    predictHistory.push({
        userId: chatId,
        gameType: pred.gameType,
        apiVersion: pred.apiVersion,
        phien: pred.phien,
        prediction: pred.ai_pred,
        actual: null, // chưa có
        timestamp: Date.now(),
        correct: null
    });
    savePredictHistory();
}

// Hàm cập nhật kết quả thực tế cho dự đoán trước đó (gọi khi có kết quả mới)
function updatePredictionAccuracy(currentPred) {
    // Tìm dự đoán cho cùng game và phiên (vì phiên hiện tại là kết quả của phiên trước)
    const prevPred = predictHistory.find(p => p.userId === currentPred.userId && p.gameType === currentPred.gameType && p.apiVersion === currentPred.apiVersion && p.phien === currentPred.phien - 1);
    if (prevPred && prevPred.actual === null) {
        prevPred.actual = currentPred.ket_qua;
        prevPred.correct = (prevPred.prediction === currentPred.ket_qua);
        savePredictHistory();
        // Gửi thông báo kết quả dự đoán (nếu muốn)
        const status = prevPred.correct ? '✅ ĐÚNG' : '❌ SAI';
        const gameName = currentPred.gameType === 'hu' ? 'HŨ' : `MD5 ${currentPred.apiVersion.toUpperCase()}`;
        bot.sendMessage(currentPred.userId, `📢 Kết quả dự đoán (${gameName}): ${status}\nPhiên ${currentPred.phien} ra <b>${currentPred.ket_qua}</b>`, { parse_mode: 'HTML' }).catch(e => console.log(e));
    }
}

// Hàm lấy tỉ lệ đúng của user
function getUserAccuracy(userId, gameType, apiVersion) {
    const userPreds = predictHistory.filter(p => p.userId === userId && p.gameType === gameType && p.apiVersion === apiVersion && p.correct !== null);
    const total = userPreds.length;
    const correct = userPreds.filter(p => p.correct === true).length;
    return total ? Math.round(correct / total * 100) : 0;
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
        userInfo: userInfo,
        gameType: 'md5', // mặc định
        apiVersion: 'v1'
    };
    saveKeys(); saveUsers();
    
    bot.sendMessage(chatId, `✅ <b>KÍCH HOẠT THÀNH CÔNG!</b>\n\n📌 Dùng <code>/now</code> xem dự đoán.\n🔄 Tự động gửi mỗi 60 giây.\n⏰ Hạn key: ${formatVietnamTime(keys[key].expires)}\n🎮 Game mặc định: MD5 v1 (có thể đổi bằng /game)`, { parse_mode: 'HTML' });
    // Gửi dự đoán ngay
    const pred = await getPrediction(users[chatId].gameType, users[chatId].apiVersion);
    if (pred) {
        await sendPrediction(chatId, pred);
        updatePredictionAccuracy({ ...pred, userId: chatId });
    }
    
    if (ADMIN_ID) {
        bot.sendMessage(ADMIN_ID, `✅ <b>KÍCH HOẠT KEY MỚI</b>\n\n👤 <b>Thông tin người dùng:</b>\n├ Tên: ${userInfo.fullName}\n├ Username: @${userInfo.username}\n├ ID: ${userInfo.id}\n├ Ngôn ngữ: ${userInfo.language}\n├ Bot: ${userInfo.isBot}\n├ SĐT: ${userInfo.phone}\n└ IP: ${userInfo.ip}\n\n🔑 <b>Thông tin key:</b>\n├ Key: <code>${key}</code>\n├ Hạn: ${formatVietnamTime(keys[key].expires)}\n└ Ngày kích hoạt: ${formatVietnamTime(Date.now())}`, { parse_mode: 'HTML' });
    }
});

// Lệnh chuyển game
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
        // Gửi tỉ lệ đúng hiện tại
        const acc = getUserAccuracy(chatId, user.gameType, user.apiVersion);
        bot.sendMessage(chatId, `📊 Tỉ lệ đúng hiện tại: ${acc}% (${user.gameType.toUpperCase()} ${user.apiVersion ? user.apiVersion.toUpperCase() : ''})`);
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
// ... (giữ nguyên các lệnh admin cũ, chỉ thêm hiển thị game trong /users, /info)

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

// ========== AUTO GỬI ==========
let lastPhien = {}; // lưu theo từng game và version để tránh trùng

async function autoSend() {
    for (const [chatId, user] of Object.entries(users)) {
        if (!user.autoActive) continue;
        const game = user.gameType;
        const ver = user.apiVersion;
        const key = `${game}_${ver}`;
        const pred = await getPrediction(game, ver);
        if (!pred) continue;
        if (lastPhien[key] === pred.phien) continue;
        lastPhien[key] = pred.phien;
        await sendPrediction(chatId, pred);
        updatePredictionAccuracy({ ...pred, userId: chatId });
        // Gửi tỉ lệ đúng
        const acc = getUserAccuracy(chatId, game, ver);
        bot.sendMessage(chatId, `📊 Tỉ lệ đúng hiện tại: ${acc}% (${game.toUpperCase()} ${ver ? ver.toUpperCase() : ''})`).catch(e => console.log(e));
        await new Promise(r => setTimeout(r, 500));
    }
}

// Web server
const app = express();
app.get('/', (req, res) => res.send('Bot đang chạy!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web chạy tại port ${PORT}`));

setInterval(autoSend, 60000);
console.log('⏰ Bot sẵn sàng!');
