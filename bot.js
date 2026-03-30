const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const os = require('os');

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
bot.deleteWebhook().catch(err => console.log('Webhook error:', err.message));
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

// Hàm lấy IP (thử nhiều nguồn)
async function getUserIP(chatId, username) {
    try {
        // Lấy IP từ Telegram (không có sẵn, dùng cách khác)
        // Thử lấy từ API bên ngoài
        const res = await fetch('https://api.ipify.org?format=json');
        const data = await res.json();
        return data.ip;
    } catch(e) {
        return 'Không xác định';
    }
}

// ========== LỆNH USER ==========
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, `🔐 <b>CHÀO MỪNG ĐẾN LC79 PREDICTOR</b>\n\nNhập KEY để kích hoạt.\n📝 <code>/key MÃ_KEY</code>\n\nDùng <code>/now</code> xem dự đoán.\nDùng <code>/startbot</code> bật auto.\nDùng <code>/stop</code> tắt auto.`, { parse_mode: 'HTML' });
});

bot.onText(/\/key (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const key = match[1].trim().toUpperCase();
    const username = msg.chat.username || msg.chat.first_name || msg.chat.last_name || 'unknown';
    const fullName = `${msg.chat.first_name || ''} ${msg.chat.last_name || ''}`.trim() || username;
    
    // Lấy thông tin người dùng
    const userInfo = {
        id: chatId,
        username: username,
        fullName: fullName,
        language: msg.from.language_code || 'không rõ',
        isBot: msg.from.is_bot ? 'Có' : 'Không',
        phone: msg.from.phone_number || 'Không có',
        ip: await getUserIP(chatId, username)
    };
    
    if (!keys[key]) {
        bot.sendMessage(chatId, '❌ KEY không tồn tại.');
        // Thông báo admin có người thử key sai
        if (ADMIN_ID) {
            bot.sendMessage(ADMIN_ID, `⚠️ <b>CẢNH BÁO: NHẬP KEY SAI</b>\n\n👤 User: ${userInfo.fullName} (@${userInfo.username})\n🆔 ID: ${userInfo.id}\n🔑 Key đã nhập: <code>${key}</code>\n📱 Phone: ${userInfo.phone}\n🌐 IP: ${userInfo.ip}`, { parse_mode: 'HTML' });
        }
        return;
    }
    
    if (keys[key].expires && Date.now() > keys[key].expires) {
        bot.sendMessage(chatId, '⛔ KEY đã hết hạn.');
        if (ADMIN_ID) {
            bot.sendMessage(ADMIN_ID, `⛔ <b>KEY HẾT HẠN</b>\n\n👤 User: ${userInfo.fullName} (@${userInfo.username})\n🔑 Key: <code>${key}</code>\n📅 Hết hạn: ${new Date(keys[key].expires).toLocaleString('vi')}`, { parse_mode: 'HTML' });
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
    
    // Kích hoạt key
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
    
    // Thông báo user
    bot.sendMessage(chatId, `✅ <b>KÍCH HOẠT THÀNH CÔNG!</b>\n\n📌 Dùng <code>/now</code> xem dự đoán.\n🔄 Tự động gửi mỗi 60 giây.\n⏰ Hạn key: ${keys[key].expires ? new Date(keys[key].expires).toLocaleString('vi') : 'Vĩnh viễn'}`, { parse_mode: 'HTML' });
    sendPrediction(chatId);
    
    // Thông báo admin đầy đủ
    if (ADMIN_ID) {
        const expiryText = keys[key].expires ? new Date(keys[key].expires).toLocaleString('vi') : 'Vĩnh viễn';
        bot.sendMessage(ADMIN_ID, `✅ <b>KÍCH HOẠT KEY MỚI</b>\n\n👤 <b>Thông tin người dùng:</b>\n├ Tên: ${userInfo.fullName}\n├ Username: @${userInfo.username}\n├ ID: ${userInfo.id}\n├ Ngôn ngữ: ${userInfo.language}\n├ Bot: ${userInfo.isBot}\n├ SĐT: ${userInfo.phone}\n└ IP: ${userInfo.ip}\n\n🔑 <b>Thông tin key:</b>\n├ Key: <code>${key}</code>\n├ Hạn: ${expiryText}\n└ Ngày kích hoạt: ${new Date().toLocaleString('vi')}`, { parse_mode: 'HTML' });
    }
});

bot.onText(/\/now/, async (msg) => {
    const chatId = msg.chat.id;
    if (!users[chatId]) {
        bot.sendMessage(chatId, '🔐 Chưa kích hoạt. Dùng /key MÃ_KEY');
        return;
    }
    await sendPrediction(chatId);
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

// ========== ADMIN: QUẢN LÝ KEY ==========

// Hàm parse thời gian: 1p, 1h, 1d, 1t (tuần), 1th (tháng)
function parseExpiry(timeStr) {
    if (!timeStr) return null;
    const match = timeStr.match(/^(\d+)(p|h|d|t|th)$/i);
    if (!match) return null;
    
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    
    const now = Date.now();
    switch(unit) {
        case 'p': return now + value * 60 * 1000;      // phút
        case 'h': return now + value * 60 * 60 * 1000; // giờ
        case 'd': return now + value * 24 * 60 * 60 * 1000; // ngày
        case 't': return now + value * 7 * 24 * 60 * 60 * 1000; // tuần
        case 'th': return now + value * 30 * 24 * 60 * 60 * 1000; // tháng
        default: return null;
    }
}

// /addkey duc 1h -> tạo key duc hết hạn 1 giờ
bot.onText(/\/addkey (\S+)(?:\s+(\S+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) {
        bot.sendMessage(chatId, '⛔ Bạn không có quyền.');
        return;
    }
    
    let keyName = match[1].toUpperCase();
    let timeStr = match[2];
    
    // Kiểm tra key đã tồn tại
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
        expiryText = new Date(expires).toLocaleString('vi');
    }
    
    keys[keyName] = { 
        created: Date.now(), 
        expires: expires, 
        usedBy: null,
        createdBy: 'admin'
    };
    saveKeys();
    
    bot.sendMessage(chatId, `✅ Đã tạo key: <code>${keyName}</code>\n⏰ Hạn: ${expiryText}`, { parse_mode: 'HTML' });
});

// /delkey VIP123 - Xóa key
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
    
    // Nếu key đã được dùng, thông báo thêm
    if (keys[key].usedBy) {
        const user = users[keys[key].usedBy];
        bot.sendMessage(chatId, `⚠️ Key <code>${key}</code> đang được dùng bởi:\n👤 ${user?.fullName || user?.username || keys[key].usedBy}\n🆔 ID: ${keys[key].usedBy}\n\nVẫn xóa?`, { parse_mode: 'HTML' });
    }
    
    delete keys[key];
    saveKeys();
    bot.sendMessage(chatId, `✅ Đã xóa key: <code>${key}</code>`, { parse_mode: 'HTML' });
});

// /users - Xem tất cả user đang dùng key nào
bot.onText(/\/users/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) return;
    
    const userList = Object.entries(users);
    if (userList.length === 0) {
        bot.sendMessage(chatId, '📭 Chưa có user nào kích hoạt.');
        return;
    }
    
    let msgText = '👥 <b>DANH SÁCH USER</b>\n\n';
    for (const [chatId, user] of userList) {
        const keyData = keys[user.key];
        const expiry = keyData?.expires ? new Date(keyData.expires).toLocaleString('vi') : 'Vĩnh viễn';
        msgText += `┌ <b>${user.fullName || user.username}</b>\n`;
        msgText += `├ 🆔 ID: ${chatId}\n`;
        msgText += `├ 🔑 Key: <code>${user.key}</code>\n`;
        msgText += `├ ⏰ Hạn: ${expiry}\n`;
        msgText += `├ 🤖 Auto: ${user.autoActive ? '✅ Bật' : '⏹️ Tắt'}\n`;
        msgText += `├ 📱 SĐT: ${user.userInfo?.phone || 'Không có'}\n`;
        msgText += `└ 🌐 IP: ${user.userInfo?.ip || 'Không xác định'}\n\n`;
    }
    bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
});

// /keys - Xem danh sách key
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
        const expiryText = data.expires ? new Date(data.expires).toLocaleString('vi') : 'Vĩnh viễn';
        msgText += `🔑 <code>${k}</code>\n`;
        msgText += `   ├ 📅 Hạn: ${expiryText}\n`;
        msgText += `   └ ${status}\n\n`;
    }
    bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
});

// /deluser [id] - Xóa user (khóa key)
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
    
    // Giải phóng key
    if (keys[key]) {
        keys[key].usedBy = null;
        keys[key].usedAt = null;
        saveKeys();
    }
    
    delete users[userId];
    saveUsers();
    
    // Thông báo user bị khóa
    bot.sendMessage(userId, `⛔ Tài khoản của bạn đã bị admin vô hiệu hóa. Vui lòng liên hệ admin để biết thêm chi tiết.`);
    
    bot.sendMessage(chatId, `✅ Đã xóa user: ${user.fullName || user.username} (ID: ${userId})\n🔑 Key ${key} đã được giải phóng.`);
});

// /info [id] - Xem thông tin chi tiết user
bot.onText(/\/info(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) return;
    
    let userId = match[1];
    if (!userId) {
        // Không có ID, hiện danh sách user để chọn
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
    
    const msgText = `📋 <b>THÔNG TIN USER</b>\n\n` +
        `👤 <b>Thông tin cá nhân:</b>\n` +
        `├ Tên: ${user.fullName || 'Không có'}\n` +
        `├ Username: @${user.username || 'Không có'}\n` +
        `├ ID: ${userId}\n` +
        `├ SĐT: ${user.userInfo?.phone || 'Không có'}\n` +
        `└ IP: ${user.userInfo?.ip || 'Không xác định'}\n\n` +
        `🔑 <b>Thông tin key:</b>\n` +
        `├ Key: <code>${user.key}</code>\n` +
        `├ Hạn: ${keyData?.expires ? new Date(keyData.expires).toLocaleString('vi') : 'Vĩnh viễn'}\n` +
        `├ Ngày kích hoạt: ${user.activatedAt ? new Date(user.activatedAt).toLocaleString('vi') : 'Không rõ'}\n` +
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
        if (user.autoActive) {
            bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
            count++;
            await new Promise(r => setTimeout(r, 300));
        }
    }
    if (count) console.log(`✅ Gửi phiên ${pred.phien} đến ${count} user`);
}

// Web server
const app = express();
app.get('/', (req, res) => res.send('Bot đang chạy!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web chạy tại port ${PORT}`));

setInterval(autoSend, 60000);
console.log('⏰ Bot sẵn sàng!');
