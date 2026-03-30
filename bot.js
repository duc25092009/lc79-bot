const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // ID của admin (bạn)

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
console.log('✅ Bot started!');

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
        bot.sendMessage(chatId, '⚠️ API error, try later');
        return;
    }
    const diceMap = ['⚀','⚁','⚂','⚃','⚄','⚅'];
    const diceStr = pred.xuc_xac.map(d => diceMap[d-1]).join(' ');
    const msg = `🎲 <b>LC79 PREDICTION</b>\n\n📌 Round: <b>${pred.phien}</b>\n🎲 Dice: ${diceStr}\n📊 Total: <b>${pred.tong}</b>\n${pred.ket_qua === 'Tài' ? '🟢' : '🔴'} Result: <b>${pred.ket_qua}</b>\n\n🤖 Next prediction: <b>${pred.ket_qua === 'Tài' ? '🔴 TÀI' : '🟢 XỈU'}</b>\n\n⚠️ For reference only.`;
    bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
}

// ============== LỆNH USER ==============
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, `🔐 <b>WELCOME TO LC79 PREDICTOR</b>\n\nEnter KEY to activate.\n📝 <code>/key YOUR_KEY</code>\n\nContact admin to get key.`, { parse_mode: 'HTML' });
});

bot.onText(/\/key (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const key = match[1].trim().toUpperCase();
    const username = msg.chat.username || msg.chat.first_name || 'unknown';
    
    // Lấy IP của user (cách đơn giản là dùng API)
    let userIP = 'Unknown';
    try {
        const res = await fetch('https://api.ipify.org?format=json');
        const data = await res.json();
        userIP = data.ip;
    } catch(e) { userIP = 'Unable to fetch'; }
    
    if (!keys[key]) {
        bot.sendMessage(chatId, '❌ KEY không tồn tại.');
        return;
    }
    if (keys[key].expires && Date.now() > keys[key].expires) {
        bot.sendMessage(chatId, '⛔ KEY đã hết hạn.');
        return;
    }
    if (keys[key].usedBy && keys[key].usedBy !== chatId.toString()) {
        bot.sendMessage(chatId, '⚠️ KEY đã được sử dụng trên thiết bị khác.');
        return;
    }
    
    // Lưu thông tin user
    const isNew = !keys[key].usedBy;
    keys[key].usedBy = chatId.toString();
    keys[key].usedAt = Date.now();
    keys[key].username = username;
    keys[key].ip = userIP;
    
    users[chatId] = { 
        username, 
        key, 
        usedAt: Date.now(),
        ip: userIP,
        autoActive: true 
    };
    saveKeys(); saveUsers();
    
    // Tính thời gian còn lại
    let timeLeft = 'Vĩnh viễn';
    if (keys[key].expires) {
        const remaining = keys[key].expires - Date.now();
        const days = Math.floor(remaining / (1000 * 60 * 60 * 24));
        const hours = Math.floor((remaining % (86400000)) / (3600000));
        if (days > 0) timeLeft = `${days} ngày ${hours} giờ`;
        else timeLeft = `${hours} giờ`;
    }
    
    // Gửi thông báo cho user
    bot.sendMessage(chatId, `✅ <b>KÍCH HOẠT THÀNH CÔNG!</b>\n\n🔑 Key: <code>${key}</code>\n⏰ Hạn: ${timeLeft}\n\n📌 Dùng <code>/now</code> xem dự đoán.\n🔄 Tự động gửi mỗi 60 giây.\n🔔 <code>/stop</code> tắt, <code>/startbot</code> bật.`, { parse_mode: 'HTML' });
    
    // Gửi dự đoán đầu tiên
    await sendPrediction(chatId);
    
    // Gửi thông báo cho admin
    if (ADMIN_CHAT_ID) {
        const action = isNew ? '🔑 KÍCH HOẠT MỚI' : '🔄 ĐĂNG NHẬP LẠI';
        bot.sendMessage(ADMIN_CHAT_ID, `${action}\n\n👤 User: ${username}\n🆔 ID: ${chatId}\n🔑 Key: ${key}\n🌐 IP: ${userIP}\n⏰ Hạn: ${timeLeft}`, { parse_mode: 'HTML' });
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

// ============== LỆNH ADMIN ==============
function isAdmin(chatId) {
    return chatId.toString() === ADMIN_CHAT_ID;
}

// /addkey <tên> <thời gian>
// Ví dụ: /addkey vip01 7d (7 ngày)
//        /addkey vip02 12h (12 giờ)
//        /addkey vip03 30d (30 ngày)
//        /addkey vip04 0 (vĩnh viễn)
bot.onText(/\/addkey (.+) (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) {
        bot.sendMessage(chatId, '⛔ Bạn không có quyền dùng lệnh này.');
        return;
    }
    
    let keyName = match[1].trim().toUpperCase();
    let duration = match[2].trim().toLowerCase();
    
    // Xử lý thời gian
    let expires = null;
    let durationText = '';
    
    if (duration === '0' || duration === 'forever' || duration === 'vinhvien') {
        expires = null;
        durationText = 'Vĩnh viễn';
    } else {
        let value = parseInt(duration);
        let unit = duration.replace(value, '');
        
        if (unit === 'd' || unit === 'ngay' || unit === 'day') {
            expires = Date.now() + value * 86400000;
            durationText = `${value} ngày`;
        } else if (unit === 'h' || unit === 'gio' || unit === 'hour') {
            expires = Date.now() + value * 3600000;
            durationText = `${value} giờ`;
        } else {
            bot.sendMessage(chatId, '❌ Sai định dạng. Dùng: /addkey TÊN 7d (ngày) hoặc 12h (giờ) hoặc 0 (vĩnh viễn)');
            return;
        }
    }
    
    // Kiểm tra key đã tồn tại
    if (keys[keyName]) {
        bot.sendMessage(chatId, `❌ Key ${keyName} đã tồn tại. Dùng tên khác.`);
        return;
    }
    
    keys[keyName] = {
        created: Date.now(),
        expires: expires,
        usedBy: null,
        usedAt: null,
        username: null,
        ip: null
    };
    saveKeys();
    
    bot.sendMessage(chatId, `✅ Đã tạo key: <code>${keyName}</code>\n⏰ Hạn: ${durationText}`, { parse_mode: 'HTML' });
});

// /listkey - hiển thị tất cả key
bot.onText(/\/listkey/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) {
        bot.sendMessage(chatId, '⛔ Bạn không có quyền dùng lệnh này.');
        return;
    }
    
    if (Object.keys(keys).length === 0) {
        bot.sendMessage(chatId, '📭 Chưa có key nào.');
        return;
    }
    
    let message = '📋 <b>DANH SÁCH KEY</b>\n\n';
    for (const [key, data] of Object.entries(keys)) {
        let status = '';
        let usedInfo = '';
        
        if (data.usedBy) {
            const usedDate = new Date(data.usedAt).toLocaleString('vi-VN');
            const user = users[data.usedBy];
            const username = user?.username || data.username || 'Unknown';
            const ip = user?.ip || data.ip || 'Unknown';
            usedInfo = `\n   👤 Dùng bởi: ${username}\n   🆔 ID: ${data.usedBy}\n   🌐 IP: ${ip}\n   📅 Lúc: ${usedDate}`;
            status = '✅ ĐÃ DÙNG';
        } else {
            status = '🟢 CHƯA DÙNG';
        }
        
        let expiryText = 'Vĩnh viễn';
        let expiryStatus = '';
        if (data.expires) {
            const remaining = data.expires - Date.now();
            if (remaining < 0) {
                expiryText = 'HẾT HẠN';
                expiryStatus = '❌';
            } else {
                const days = Math.floor(remaining / 86400000);
                const hours = Math.floor((remaining % 86400000) / 3600000);
                if (days > 0) expiryText = `${days} ngày ${hours} giờ`;
                else expiryText = `${hours} giờ`;
            }
        }
        
        message += `<code>${key}</code> - ${status}\n`;
        message += `   ⏰ Hạn: ${expiryText} ${expiryStatus}\n`;
        message += usedInfo;
        message += `\n\n`;
    }
    
    // Gửi tin nhắn, nếu quá dài thì chia nhỏ
    if (message.length > 4000) {
        bot.sendMessage(chatId, '📋 Quá nhiều key, vui lòng kiểm tra file keys.json');
    } else {
        bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    }
});

// /delkey <tên> - xóa key
bot.onText(/\/delkey (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) {
        bot.sendMessage(chatId, '⛔ Bạn không có quyền dùng lệnh này.');
        return;
    }
    
    const key = match[1].trim().toUpperCase();
    if (!keys[key]) {
        bot.sendMessage(chatId, `❌ Key ${key} không tồn tại.`);
        return;
    }
    
    // Nếu key đã được dùng, xóa luôn user khỏi danh sách active
    if (keys[key].usedBy && users[keys[key].usedBy]) {
        delete users[keys[key].usedBy];
    }
    
    delete keys[key];
    saveKeys();
    saveUsers();
    
    bot.sendMessage(chatId, `✅ Đã xóa key <code>${key}</code>`, { parse_mode: 'HTML' });
});

// /info <user_id> - xem thông tin user (admin)
bot.onText(/\/info (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) {
        bot.sendMessage(chatId, '⛔ Bạn không có quyền dùng lệnh này.');
        return;
    }
    
    const target = match[1].trim();
    let userId = target;
    let user = users[target];
    
    if (!user) {
        // Thử tìm theo username
        for (const [id, u] of Object.entries(users)) {
            if (u.username && u.username.toLowerCase().includes(target.toLowerCase())) {
                userId = id;
                user = u;
                break;
            }
        }
    }
    
    if (!user) {
        bot.sendMessage(chatId, `❌ Không tìm thấy user: ${target}`);
        return;
    }
    
    const keyData = keys[user.key];
    let expiryText = 'Vĩnh viễn';
    if (keyData?.expires) {
        const remaining = keyData.expires - Date.now();
        if (remaining < 0) expiryText = 'Đã hết hạn';
        else {
            const days = Math.floor(remaining / 86400000);
            const hours = Math.floor((remaining % 86400000) / 3600000);
            expiryText = `${days} ngày ${hours} giờ`;
        }
    }
    
    const msgText = `📋 <b>THÔNG TIN USER</b>\n\n👤 Tên: ${user.username}\n🆔 ID: ${userId}\n🔑 Key: ${user.key}\n⏰ Hạn: ${expiryText}\n🌐 IP: ${user.ip || 'Unknown'}\n📅 Kích hoạt: ${new Date(user.usedAt).toLocaleString('vi-VN')}\n🔔 Auto: ${user.autoActive ? 'BẬT' : 'TẮT'}`;
    
    bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
});

// ============== AUTO SEND ==============
let lastPhien = 0;
async function autoSend() {
    const pred = await getPrediction();
    if (!pred) return;
    if (lastPhien === pred.phien) return;
    lastPhien = pred.phien;
    
    const diceMap = ['⚀','⚁','⚂','⚃','⚄','⚅'];
    const diceStr = pred.xuc_xac.map(d => diceMap[d-1]).join(' ');
    const msg = `🎲 <b>NEW PREDICTION</b>\n\n📌 Round: <b>${pred.phien}</b>\n🎲 Dice: ${diceStr}\n📊 Total: <b>${pred.tong}</b>\n${pred.ket_qua === 'Tài' ? '🟢' : '🔴'} Result: <b>${pred.ket_qua}</b>\n\n🤖 Next: <b>${pred.ket_qua === 'Tài' ? '🔴 TÀI' : '🟢 XỈU'}</b>`;
    
    let count = 0;
    for (const [chatId, user] of Object.entries(users)) {
        if (user.autoActive) {
            // Kiểm tra key còn hạn không
            const keyData = keys[user.key];
            if (keyData && keyData.expires && Date.now() > keyData.expires) {
                // Key hết hạn, thông báo và tắt auto
                bot.sendMessage(chatId, '⛔ KEY của bạn đã hết hạn. Vui lòng liên hệ admin để gia hạn.');
                user.autoActive = false;
                saveUsers();
                continue;
            }
            bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
            count++;
            await new Promise(r => setTimeout(r, 300));
        }
    }
    if (count) console.log(`✅ Sent round ${pred.phien} to ${count} users`);
}

// ============== WEB SERVER ==============
const app = express();
app.get('/', (req, res) => res.send('Bot is running!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web running on port ${PORT}`));

setInterval(autoSend, 60000);
console.log('⏰ Bot ready!');
