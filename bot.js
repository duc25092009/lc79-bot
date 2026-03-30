const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_CHAT_ID;

const KEYS_FILE = 'keys.json';
const USERS_FILE = 'users.json';

let keys = {};
let users = {};

function loadData() {
    try { keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch(e) { keys = {}; }
    try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch(e) { users = {}; }
    console.log(`Loaded ${Object.keys(keys).length} keys, ${Object.keys(users).length} users`);
}
function saveKeys() { fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2)); }
function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }

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

async function sendPrediction(chatId) {
    const pred = await getPrediction();
    if (!pred) {
        bot.sendMessage(chatId, '⚠️ Lỗi API, thử lại sau');
        return;
    }
    const diceMap = ['⚀','⚁','⚂','⚃','⚄','⚅'];
    const diceStr = pred.xuc_xac.map(d => diceMap[d-1]).join(' ');
    const msg = `🎲 <b>LC79 DỰ ĐOÁN</b>\n\n📌 Phiên: <b>${pred.phien}</b>\n🎲 Xúc xắc: ${diceStr}\n📊 Tổng: <b>${pred.tong}</b>\n${pred.ket_qua === 'Tài' ? '🟢' : '🔴'} Kết quả: <b>${pred.ket_qua}</b>\n\n🤖 Dự đoán phiên tiếp: <b>${pred.ket_qua === 'Tài' ? '🔴 TÀI' : '🟢 XỈU'}</b>\n\n⚠️ Chỉ tham khảo.`;
    bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
}

// Hàm lấy IP
async function getUserIP() {
    try {
        const res = await fetch('https://api.ipify.org?format=json');
        const data = await res.json();
        return data.ip;
    } catch(e) {
        return 'Không xác định';
    }
}

// Hàm format thời gian theo giờ Việt Nam (GMT+7)
function formatVietnamTime(timestamp) {
    if (!timestamp) return 'Vĩnh viễn';
    const date = new Date(timestamp);
    return date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// Hàm kiểm tra key còn hiệu lực
function isKeyValid(key) {
    const keyData = keys[key];
    if (!keyData) return false;
    if (keyData.expires && Date.now() > keyData.expires) return false;
    return true;
}

// Hàm kiểm tra và xóa user nếu key không hợp lệ
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
        userInfo: userInfo
    };
    saveKeys(); saveUsers();
    
    bot.sendMessage(chatId, `✅ <b>KÍCH HOẠT THÀNH CÔNG!</b>\n\n📌 Dùng <code>/now</code> xem dự đoán.\n🔄 Tự động gửi mỗi 60 giây.\n⏰ Hạn key: ${formatVietnamTime(keys[key].expires)}`, { parse_mode: 'HTML' });
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
    
    keys[keyName] = { created: Date.now(), expires: expires, usedBy: null, createdBy: 'admin' };
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
    
    const diceMap = ['⚀','⚁','⚂','⚃','⚄','⚅'];
    const diceStr = pred.xuc_xac.map(d => diceMap[d-1]).join(' ');
    const msg = `🎲 <b>LC79 DỰ ĐOÁN MỚI</b>\n\n📌 Phiên: <b>${pred.phien}</b>\n🎲 Xúc xắc: ${diceStr}\n📊 Tổng: <b>${pred.tong}</b>\n${pred.ket_qua === 'Tài' ? '🟢' : '🔴'} Kết quả: <b>${pred.ket_qua}</b>\n\n🤖 Dự đoán: <b>${pred.ket_qua === 'Tài' ? '🔴 TÀI' : '🟢 XỈU'}</b>`;
    
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
