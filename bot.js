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

// SỬA DÒNG NÀY:
bot.deleteWebhook().catch(err => console.log('Webhook error:', err.message));

console.log('✅ Bot đã khởi động!');

// ... phần còn lại giữ nguyên

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

// ========== LỆNH USER ==========
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, `🔐 <b>CHÀO MỪNG ĐẾN LC79 PREDICTOR</b>\n\nNhập KEY để kích hoạt.\n📝 <code>/key MÃ_KEY</code>\n\nDùng <code>/now</code> xem dự đoán.\nDùng <code>/startbot</code> bật auto.\nDùng <code>/stop</code> tắt auto.`, { parse_mode: 'HTML' });
});

bot.onText(/\/key (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const key = match[1].trim().toUpperCase();
    const username = msg.chat.username || msg.chat.first_name || 'unknown';
    
    if (!keys[key]) {
        bot.sendMessage(chatId, '❌ KEY không tồn tại.');
        return;
    }
    if (keys[key].expires && Date.now() > keys[key].expires) {
        bot.sendMessage(chatId, '⛔ KEY đã hết hạn.');
        return;
    }
    if (keys[key].usedBy && keys[key].usedBy !== chatId.toString()) {
        bot.sendMessage(chatId, '⚠️ KEY đã được dùng.');
        return;
    }
    
    keys[key].usedBy = chatId.toString();
    users[chatId] = { username, key, autoActive: true };
    saveKeys(); saveUsers();
    
    bot.sendMessage(chatId, `✅ <b>KÍCH HOẠT THÀNH CÔNG!</b>\n\n📌 Dùng <code>/now</code> xem dự đoán.\n🔄 Tự động gửi mỗi 60 giây.`, { parse_mode: 'HTML' });
    sendPrediction(chatId);
    
    if (ADMIN_ID) {
        bot.sendMessage(ADMIN_ID, `🔑 User ${username} (${chatId}) kích hoạt key: ${key}`);
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

// ========== ADMIN: TẠO KEY ==========
bot.onText(/\/createkey(?:\s+(\S+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== ADMIN_ID) {
        bot.sendMessage(chatId, '⛔ Bạn không có quyền.');
        return;
    }
    
    let keyName = match[1];
    if (!keyName) {
        keyName = Math.random().toString(36).substring(2, 10).toUpperCase();
    } else {
        keyName = keyName.toUpperCase();
    }
    
    if (keys[keyName]) {
        bot.sendMessage(chatId, `❌ Key ${keyName} đã tồn tại!`);
        return;
    }
    
    keys[keyName] = { created: Date.now(), expires: null, usedBy: null };
    saveKeys();
    bot.sendMessage(chatId, `✅ Đã tạo key: <code>${keyName}</code>\n⏰ Hạn: Vĩnh viễn`, { parse_mode: 'HTML' });
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
        const used = data.usedBy ? `✅ Đã dùng (${data.usedBy})` : '🟢 Chưa dùng';
        msgText += `🔑 <code>${k}</code> — ${used}\n`;
    }
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
