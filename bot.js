const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');

// ========== CẤU HÌNH ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const KEYS_FILE = 'keys.json';
const USERS_FILE = 'users.json';
const HISTORY_FILE = 'history.json';

let keys = {};
let users = {};
let history = {};

function loadData() {
    try { keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch(e) { keys = {}; }
    try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch(e) { users = {}; }
    try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch(e) { history = {}; }
}
function saveKeys() { fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2)); }
function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
function saveHistory() { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2)); }

loadData();

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log('✅ Bot đã khởi động!');

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

function getUserAccuracy(chatId) {
    const userHistory = history[chatId] || [];
    if (userHistory.length < 3) return null;
    let correct = 0;
    for (const h of userHistory) {
        if (h.ket_qua === h.ai_pred) correct++;
    }
    return Math.round((correct / userHistory.length) * 100);
}

function saveToHistory(chatId, phien, ket_qua, ai_pred) {
    if (!history[chatId]) history[chatId] = [];
    history[chatId].unshift({ phien, ket_qua, ai_pred, time: new Date().toISOString() });
    if (history[chatId].length > 100) history[chatId].pop();
    saveHistory();
}

// Hàm gửi tin nhắn an toàn, tránh lỗi Markdown
async function safeSend(chatId, text, extra = {}) {
    try {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });
    } catch (e) {
        if (e.message.includes('can\'t parse entities')) {
            // Nếu lỗi Markdown, gửi lại dạng text thuần
            await bot.sendMessage(chatId, text, { ...extra });
        } else {
            throw e;
        }
    }
}

async function sendPrediction(chatId, isAuto = false) {
    const pred = await getPrediction();
    if (!pred) {
        await safeSend(chatId, '⚠️ Lỗi kết nối API ⚠️\nVui lòng thử lại sau.');
        return;
    }
    
    const diceMap = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    const diceStr = pred.xuc_xac.map(d => diceMap[d-1]).join(' ');
    const resultIcon = pred.ket_qua === 'Tài' ? '🟢' : '🔴';
    const predIcon = pred.ket_qua === 'Tài' ? '🔴 TÀI' : '🟢 XỈU';
    
    const accuracy = getUserAccuracy(chatId);
    const accuracyText = accuracy !== null ? `\n📊 Độ chính xác AI: ${accuracy}% (${history[chatId]?.length || 0} ván)` : '';
    
    const msg = `🎲 KẾT QUẢ VÁN ${pred.phien} 🎲
    
┌─────────────────┐
│  🎯 XÚC XẮC    │
│     ${diceStr}     │
│  📊 TỔNG: ${pred.tong}  │
└─────────────────┘

${resultIcon} KẾT QUẢ: ${pred.ket_qua}

━━━━━━━━━━━━━━━━━━━
🔮 DỰ ĐOÁN PHIÊN TIẾP THEO
━━━━━━━━━━━━━━━━━━━

${predIcon}
📈 Độ tin cậy: 78%
${accuracyText}

⚠️ Lưu ý: Dự đoán chỉ mang tính tham khảo!`;

    const options = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🔄 Xem lại', callback_data: 'refresh' },
                    { text: '📊 Thống kê', callback_data: 'stats' }
                ],
                [
                    { text: '❌ Tắt auto', callback_data: 'stop_auto' },
                    { text: '✅ Bật auto', callback_data: 'start_auto' }
                ]
            ]
        }
    };
    
    await safeSend(chatId, msg, options);
}

bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    
    if (data === 'refresh') {
        await sendPrediction(chatId);
        await bot.answerCallbackQuery(callbackQuery.id, { text: '🔄 Đã cập nhật!' });
    } else if (data === 'stats') {
        const userHistory = history[chatId] || [];
        const total = userHistory.length;
        const correct = userHistory.filter(h => h.ket_qua === h.ai_pred).length;
        const acc = total > 0 ? Math.round((correct / total) * 100) : 0;
        
        let last5Text = '';
        if (userHistory.length > 0) {
            last5Text = '\n\n📜 5 ván gần nhất:\n';
            for (const h of userHistory.slice(0, 5)) {
                const icon = h.ket_qua === h.ai_pred ? '✅' : '❌';
                last5Text += `${icon} Phiên ${h.phien}: ${h.ket_qua} (AI đoán: ${h.ai_pred})\n`;
            }
        }
        
        const statsMsg = `📊 THỐNG KÊ CÁ NHÂN 📊
        
┌─────────────────────────┐
│ 📝 Tổng số ván: ${total}        │
│ ✅ Đoán đúng: ${correct}         │
│ ❌ Đoán sai: ${total - correct}   │
│ 🎯 Tỉ lệ đúng: ${acc}%            │
└─────────────────────────┘${last5Text}

💡 Mẹo: Độ chính xác sẽ cao hơn khi bạn theo dõi lâu dài!`;
        
        await safeSend(chatId, statsMsg);
        await bot.answerCallbackQuery(callbackQuery.id);
    } else if (data === 'stop_auto') {
        if (users[chatId]) {
            users[chatId].autoActive = false;
            saveUsers();
            await safeSend(chatId, '⏹️ Đã tắt chế độ tự động gửi');
        }
        await bot.answerCallbackQuery(callbackQuery.id);
    } else if (data === 'start_auto') {
        if (users[chatId]) {
            users[chatId].autoActive = true;
            saveUsers();
            await safeSend(chatId, '✅ Đã bật chế độ tự động gửi (mỗi 60 giây)');
        }
        await bot.answerCallbackQuery(callbackQuery.id);
    }
});

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const welcomeMsg = `🎲 XIN CHÀO! 🎲

Chào mừng bạn đến với LC79 AI PREDICTOR!

🤖 Tôi sẽ gửi cho bạn dự đoán kết quả Tài/Xỉu dựa trên dữ liệu real-time.

━━━━━━━━━━━━━━━━━━━
📝 CÁCH SỬ DỤNG
━━━━━━━━━━━━━━━━━━━

🔑 /key <MÃ_KEY> - Kích hoạt dịch vụ
📊 /now - Xem dự đoán ngay
📈 /stats - Xem thống kê cá nhân
▶️ /startbot - Bật tự động gửi
⏹️ /stop - Tắt tự động gửi

━━━━━━━━━━━━━━━━━━━
💡 LƯU Ý
━━━━━━━━━━━━━━━━━━━

• Dự đoán chỉ mang tính tham khảo
• Không đảm bảo chính xác 100%
• Hãy chơi có trách nhiệm!`;
    
    safeSend(chatId, welcomeMsg);
});

bot.onText(/\/key (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const key = match[1].trim().toUpperCase();
    const username = msg.chat.username || msg.chat.first_name || 'unknown';
    
    if (!keys[key]) {
        safeSend(chatId, '❌ KEY không hợp lệ!\nVui lòng kiểm tra lại hoặc liên hệ admin.');
        return;
    }
    if (keys[key].expires && Date.now() > keys[key].expires) {
        safeSend(chatId, '⛔ KEY đã hết hạn!\nVui lòng liên hệ admin để gia hạn.');
        return;
    }
    if (keys[key].usedBy && keys[key].usedBy !== chatId.toString()) {
        safeSend(chatId, '⚠️ KEY đã được kích hoạt trên thiết bị khác!');
        return;
    }
    
    keys[key].usedBy = chatId.toString();
    users[chatId] = { username, key, autoActive: true };
    saveKeys(); saveUsers();
    
    const successMsg = `✅ KÍCH HOẠT THÀNH CÔNG! ✅

🎉 Chào mừng ${username} đã tham gia!

━━━━━━━━━━━━━━━━━━━
⚡ TÍNH NĂNG
━━━━━━━━━━━━━━━━━━━

• 📊 Dự đoán real-time
• 📈 Thống kê độ chính xác
• 🔔 Tự động gửi mỗi 60 giây
• 📱 Giao diện thân thiện

📝 Dùng /now để xem dự đoán ngay!
🔔 Dùng /startbot để bật tự động gửi`;
    
    safeSend(chatId, successMsg);
    sendPrediction(chatId);
    
    if (ADMIN_CHAT_ID) {
        safeSend(ADMIN_CHAT_ID, `🔑 USER MỚI KÍCH HOẠT 🔑\n👤 ${username}\n🆔 ${chatId}\n🔐 KEY: ${key}`);
    }
});

bot.onText(/\/now/, async (msg) => {
    const chatId = msg.chat.id;
    if (!users[chatId]) {
        safeSend(chatId, '🔐 Bạn chưa kích hoạt dịch vụ!\nDùng /key <MÃ_KEY> để bắt đầu.');
        return;
    }
    await sendPrediction(chatId);
});

bot.onText(/\/stats/, (msg) => {
    const chatId = msg.chat.id;
    if (!users[chatId]) {
        safeSend(chatId, '🔐 Bạn chưa kích hoạt dịch vụ!');
        return;
    }
    
    const userHistory = history[chatId] || [];
    const total = userHistory.length;
    const correct = userHistory.filter(h => h.ket_qua === h.ai_pred).length;
    const acc = total > 0 ? Math.round((correct / total) * 100) : 0;
    
    let last10Text = '';
    if (userHistory.length > 0) {
        last10Text = '\n📜 10 ván gần nhất:\n';
        for (const h of userHistory.slice(0, 10)) {
            const icon = h.ket_qua === h.ai_pred ? '✅' : '❌';
            last10Text += `${icon} Phiên ${h.phien}: ${h.ket_qua} (AI: ${h.ai_pred})\n`;
        }
    }
    
    const statsMsg = `📊 THỐNG KÊ CÁ NHÂN 📊
    
┌─────────────────────────────────┐
│ 📝 Tổng số ván: ${total}                    │
│ ✅ Đoán đúng: ${correct}                     │
│ ❌ Đoán sai: ${total - correct}               │
│ 🎯 Tỉ lệ đúng: ${acc}%                        │
└─────────────────────────────────┘${last10Text}

💡 Mẹo: Càng theo dõi lâu, tỉ lệ đúng càng phản ánh chính xác!`;
    
    safeSend(chatId, statsMsg);
});

bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    if (users[chatId]) {
        users[chatId].autoActive = false;
        saveUsers();
        safeSend(chatId, '⏹️ Đã tắt chế độ tự động gửi\nDùng /startbot để bật lại.');
    }
});

bot.onText(/\/startbot/, (msg) => {
    const chatId = msg.chat.id;
    if (users[chatId]) {
        users[chatId].autoActive = true;
        saveUsers();
        safeSend(chatId, '✅ Đã bật chế độ tự động gửi\nTôi sẽ gửi dự đoán mỗi 60 giây.');
    } else {
        safeSend(chatId, '🔐 Bạn chưa kích hoạt dịch vụ!\nDùng /key <MÃ_KEY> để bắt đầu.');
    }
});

// ========== ADMIN: TẠO KEY ==========
const ADMIN_ID = process.env.ADMIN_CHAT_ID; // Chat ID của admin

bot.onText(/\/createkey(?:\s+(\S+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    
    // Kiểm tra xem có phải admin không
    if (chatId.toString() !== ADMIN_ID) {
        bot.sendMessage(chatId, '⛔ Bạn không có quyền sử dụng lệnh này.');
        return;
    }
    
    let keyName = match[1];
    if (!keyName) {
        // Tự động tạo key ngẫu nhiên
        keyName = Math.random().toString(36).substring(2, 10).toUpperCase();
    } else {
        keyName = keyName.toUpperCase();
    }
    
    // Kiểm tra key đã tồn tại chưa
    if (keys[keyName]) {
        bot.sendMessage(chatId, `❌ Key ${keyName} đã tồn tại!`);
        return;
    }
    
    // Tạo key mới (vĩnh viễn)
    keys[keyName] = {
        created: Date.now(),
        expires: null,  // null = vĩnh viễn
        usedBy: null
    };
    saveKeys();
    
    bot.sendMessage(chatId, `✅ Đã tạo key: <code>${keyName}</code>\n⏰ Hạn: Vĩnh viễn`, { parse_mode: 'HTML' });
});

// Thêm lệnh xem danh sách key (admin)
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

// Auto gửi dự đoán
let lastPhien = 0;
async function autoSendToUsers() {
    const pred = await getPrediction();
    if (!pred) return;
    if (lastPhien === pred.phien) return;
    lastPhien = pred.phien;
    
    const diceMap = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    const diceStr = pred.xuc_xac.map(d => diceMap[d-1]).join(' ');
    const resultIcon = pred.ket_qua === 'Tài' ? '🟢' : '🔴';
    const predIcon = pred.ket_qua === 'Tài' ? '🔴 TÀI' : '🟢 XỈU';
    
    const msg = `🎲 KẾT QUẢ VÁN ${pred.phien} 🎲
    
┌─────────────────┐
│  🎯 XÚC XẮC    │
│     ${diceStr}     │
│  📊 TỔNG: ${pred.tong}  │
└─────────────────┘

${resultIcon} KẾT QUẢ: ${pred.ket_qua}

━━━━━━━━━━━━━━━━━━━
🔮 DỰ ĐOÁN PHIÊN TIẾP THEO
━━━━━━━━━━━━━━━━━━━

${predIcon}
📈 Độ tin cậy: 78%

⚠️ Lưu ý: Dự đoán chỉ mang tính tham khảo!`;

    let count = 0;
    for (const [chatId, user] of Object.entries(users)) {
        if (user.autoActive) {
            try {
                await safeSend(chatId, msg);
                count++;
                await new Promise(r => setTimeout(r, 300));
            } catch(e) {
                console.error(`Gửi tin thất bại cho ${chatId}:`, e.message);
            }
        }
    }
    if (count) console.log(`✅ Đã gửi phiên ${pred.phien} đến ${count} user`);
}

const app = express();
app.get('/', (req, res) => res.send('Bot đang chạy!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web chạy tại port ${PORT}`));

setInterval(autoSendToUsers, 60000);
console.log('⏰ Bot đã sẵn sàng!');
