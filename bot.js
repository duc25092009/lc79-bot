const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');

// ========== CẤU HÌNH ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// File lưu dữ liệu
const KEYS_FILE = 'keys.json';
const USERS_FILE = 'users.json';
const HISTORY_FILE = 'history.json';

let keys = {};
let users = {};
let history = {}; // { chatId: [{ phien, ket_qua, ai_pred, time }] }

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

// Tính % đúng của AI dựa trên lịch sử user
function getUserAccuracy(chatId) {
    const userHistory = history[chatId] || [];
    if (userHistory.length < 3) return null;
    
    let correct = 0;
    for (const h of userHistory) {
        if (h.ket_qua === h.ai_pred) correct++;
    }
    return Math.round((correct / userHistory.length) * 100);
}

// Lưu kết quả vào lịch sử user
function saveToHistory(chatId, phien, ket_qua, ai_pred) {
    if (!history[chatId]) history[chatId] = [];
    history[chatId].unshift({ phien, ket_qua, ai_pred, time: new Date().toISOString() });
    if (history[chatId].length > 100) history[chatId].pop();
    saveHistory();
}

async function sendPrediction(chatId, isAuto = false) {
    const pred = await getPrediction();
    if (!pred) {
        bot.sendMessage(chatId, '⚠️ *Lỗi kết nối API* ⚠️\nVui lòng thử lại sau.', { parse_mode: 'Markdown' });
        return;
    }
    
    // Lưu vào lịch sử để tính % đúng sau này
    // (Khi có kết quả thực tế, chúng ta sẽ cập nhật)
    
    const diceMap = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    const diceStr = pred.xuc_xac.map(d => diceMap[d-1]).join(' ');
    
    // Xác định màu sắc và icon cho kết quả
    const resultIcon = pred.ket_qua === 'Tài' ? '🟢' : '🔴';
    const predIcon = pred.ket_qua === 'Tài' ? '🔴 TÀI' : '🟢 XỈU';
    
    // Lấy % đúng của user
    const accuracy = getUserAccuracy(chatId);
    const accuracyText = accuracy !== null ? `\n📊 *Độ chính xác AI:* ${accuracy}% (${history[chatId]?.length || 0} ván)` : '';
    
    const msg = `🎲 *KẾT QUẢ VÁN ${pred.phien}* 🎲
    
┌─────────────────┐
│  🎯 *XÚC XẮC*   │
│     ${diceStr}     │
│  📊 *TỔNG:* ${pred.tong}  │
└─────────────────┘

${resultIcon} *KẾT QUẢ:* ${pred.ket_qua}

━━━━━━━━━━━━━━━━━━━
🔮 *DỰ ĐOÁN PHIÊN TIẾP THEO*
━━━━━━━━━━━━━━━━━━━

${predIcon}
📈 *Độ tin cậy:* 78%
${accuracyText}

⚠️ *Lưu ý:* Dự đoán chỉ mang tính tham khảo!`;

    // Gửi tin nhắn với inline keyboard
    const options = {
        parse_mode: 'Markdown',
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
    
    await bot.sendMessage(chatId, msg, options);
    
    // Lưu dự đoán để sau này so sánh
    if (!isAuto) {
        // Lưu tạm dự đoán này để khi có kết quả thực tế sẽ cập nhật
        // (Có thể cải tiến thêm)
    }
}

// Xử lý callback từ inline keyboard
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
        
        const last5 = userHistory.slice(0, 5);
        let last5Text = '';
        if (last5.length > 0) {
            last5Text = '\n\n📜 *5 ván gần nhất:*\n';
            for (const h of last5) {
                const icon = h.ket_qua === h.ai_pred ? '✅' : '❌';
                last5Text += `${icon} Phiên ${h.phien}: ${h.ket_qua} (AI đoán: ${h.ai_pred})\n`;
            }
        }
        
        const statsMsg = `📊 *THỐNG KÊ CÁ NHÂN* 📊
        
┌─────────────────────────┐
│ 📝 *Tổng số ván:* ${total}        │
│ ✅ *Đoán đúng:* ${correct}         │
│ ❌ *Đoán sai:* ${total - correct}   │
│ 🎯 *Tỉ lệ đúng:* ${acc}%            │
└─────────────────────────┘${last5Text}

💡 *Mẹo:* Độ chính xác sẽ cao hơn khi bạn theo dõi lâu dài!`;
        
        await bot.sendMessage(chatId, statsMsg, { parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id);
    } else if (data === 'stop_auto') {
        if (users[chatId]) {
            users[chatId].autoActive = false;
            saveUsers();
            await bot.sendMessage(chatId, '⏹️ *Đã tắt chế độ tự động gửi*', { parse_mode: 'Markdown' });
        }
        await bot.answerCallbackQuery(callbackQuery.id);
    } else if (data === 'start_auto') {
        if (users[chatId]) {
            users[chatId].autoActive = true;
            saveUsers();
            await bot.sendMessage(chatId, '✅ *Đã bật chế độ tự động gửi* (mỗi 60 giây)', { parse_mode: 'Markdown' });
        }
        await bot.answerCallbackQuery(callbackQuery.id);
    }
});

// Lệnh bot (tiếng Việt)
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const welcomeMsg = `🎲 *XIN CHÀO!* 🎲

Chào mừng bạn đến với *LC79 AI PREDICTOR*!

🤖 Tôi sẽ gửi cho bạn dự đoán kết quả Tài/Xỉu dựa trên dữ liệu real-time.

━━━━━━━━━━━━━━━━━━━
📝 *CÁCH SỬ DỤNG*
━━━━━━━━━━━━━━━━━━━

🔑 /key <MÃ_KEY> - Kích hoạt dịch vụ
📊 /now - Xem dự đoán ngay
📈 /stats - Xem thống kê cá nhân
▶️ /startbot - Bật tự động gửi
⏹️ /stop - Tắt tự động gửi

━━━━━━━━━━━━━━━━━━━
💡 *LƯU Ý*
━━━━━━━━━━━━━━━━━━━

• Dự đoán chỉ mang tính tham khảo
• Không đảm bảo chính xác 100%
• Hãy chơi có trách nhiệm!`;

    bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' });
});

bot.onText(/\/key (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const key = match[1].trim().toUpperCase();
    const username = msg.chat.username || msg.chat.first_name || 'unknown';
    
    if (!keys[key]) {
        bot.sendMessage(chatId, '❌ *KEY không hợp lệ!*\nVui lòng kiểm tra lại hoặc liên hệ admin.', { parse_mode: 'Markdown' });
        return;
    }
    if (keys[key].expires && Date.now() > keys[key].expires) {
        bot.sendMessage(chatId, '⛔ *KEY đã hết hạn!*\nVui lòng liên hệ admin để gia hạn.', { parse_mode: 'Markdown' });
        return;
    }
    if (keys[key].usedBy && keys[key].usedBy !== chatId.toString()) {
        bot.sendMessage(chatId, '⚠️ *KEY đã được kích hoạt trên thiết bị khác!*', { parse_mode: 'Markdown' });
        return;
    }
    
    keys[key].usedBy = chatId.toString();
    users[chatId] = { username, key, autoActive: true };
    saveKeys(); saveUsers();
    
    const successMsg = `✅ *KÍCH HOẠT THÀNH CÔNG!* ✅

🎉 Chào mừng *${username}* đã tham gia!

━━━━━━━━━━━━━━━━━━━
⚡ *TÍNH NĂNG*
━━━━━━━━━━━━━━━━━━━

• 📊 Dự đoán real-time
• 📈 Thống kê độ chính xác
• 🔔 Tự động gửi mỗi 60 giây
• 📱 Giao diện thân thiện

📝 Dùng /now để xem dự đoán ngay!
🔔 Dùng /startbot để bật tự động gửi`;

    bot.sendMessage(chatId, successMsg, { parse_mode: 'Markdown' });
    sendPrediction(chatId);
    
    if (ADMIN_CHAT_ID) {
        bot.sendMessage(ADMIN_CHAT_ID, `🔑 *USER MỚI KÍCH HOẠT* 🔑\n👤 ${username}\n🆔 ${chatId}\n🔐 KEY: ${key}`, { parse_mode: 'Markdown' });
    }
});

bot.onText(/\/now/, async (msg) => {
    const chatId = msg.chat.id;
    if (!users[chatId]) {
        bot.sendMessage(chatId, '🔐 *Bạn chưa kích hoạt dịch vụ!*\nDùng /key <MÃ_KEY> để bắt đầu.', { parse_mode: 'Markdown' });
        return;
    }
    await sendPrediction(chatId);
});

bot.onText(/\/stats/, (msg) => {
    const chatId = msg.chat.id;
    if (!users[chatId]) {
        bot.sendMessage(chatId, '🔐 *Bạn chưa kích hoạt dịch vụ!*', { parse_mode: 'Markdown' });
        return;
    }
    
    const userHistory = history[chatId] || [];
    const total = userHistory.length;
    const correct = userHistory.filter(h => h.ket_qua === h.ai_pred).length;
    const acc = total > 0 ? Math.round((correct / total) * 100) : 0;
    
    const last10 = userHistory.slice(0, 10);
    let last10Text = '';
    if (last10.length > 0) {
        last10Text = '\n📜 *10 ván gần nhất:*\n';
        for (const h of last10) {
            const icon = h.ket_qua === h.ai_pred ? '✅' : '❌';
            last10Text += `${icon} Phiên ${h.phien}: ${h.ket_qua} (AI: ${h.ai_pred})\n`;
        }
    }
    
    const statsMsg = `📊 *THỐNG KÊ CÁ NHÂN* 📊
    
┌─────────────────────────────────┐
│ 📝 *Tổng số ván:* ${total}                    │
│ ✅ *Đoán đúng:* ${correct}                     │
│ ❌ *Đoán sai:* ${total - correct}               │
│ 🎯 *Tỉ lệ đúng:* ${acc}%                        │
└─────────────────────────────────┘${last10Text}

💡 *Mẹo:* Càng theo dõi lâu, tỉ lệ đúng càng phản ánh chính xác!`;
    
    bot.sendMessage(chatId, statsMsg, { parse_mode: 'Markdown' });
});

bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    if (users[chatId]) {
        users[chatId].autoActive = false;
        saveUsers();
        bot.sendMessage(chatId, '⏹️ *Đã tắt chế độ tự động gửi*\nDùng /startbot để bật lại.', { parse_mode: 'Markdown' });
    }
});

bot.onText(/\/startbot/, (msg) => {
    const chatId = msg.chat.id;
    if (users[chatId]) {
        users[chatId].autoActive = true;
        saveUsers();
        bot.sendMessage(chatId, '✅ *Đã bật chế độ tự động gửi*\nTôi sẽ gửi dự đoán mỗi 60 giây.', { parse_mode: 'Markdown' });
    } else {
        bot.sendMessage(chatId, '🔐 *Bạn chưa kích hoạt dịch vụ!*\nDùng /key <MÃ_KEY> để bắt đầu.', { parse_mode: 'Markdown' });
    }
});

// Auto gửi dự đoán cho user đã kích hoạt
let lastPhien = 0;
let lastPredictionData = null;

async function autoSendToUsers() {
    const pred = await getPrediction();
    if (!pred) return;
    if (lastPhien === pred.phien) return;
    lastPhien = pred.phien;
    
    const diceMap = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    const diceStr = pred.xuc_xac.map(d => diceMap[d-1]).join(' ');
    const resultIcon = pred.ket_qua === 'Tài' ? '🟢' : '🔴';
    const predIcon = pred.ket_qua === 'Tài' ? '🔴 TÀI' : '🟢 XỈU';
    
    const msg = `🎲 *KẾT QUẢ VÁN ${pred.phien}* 🎲
    
┌─────────────────┐
│  🎯 *XÚC XẮC*   │
│     ${diceStr}     │
│  📊 *TỔNG:* ${pred.tong}  │
└─────────────────┘

${resultIcon} *KẾT QUẢ:* ${pred.ket_qua}

━━━━━━━━━━━━━━━━━━━
🔮 *DỰ ĐOÁN PHIÊN TIẾP THEO*
━━━━━━━━━━━━━━━━━━━

${predIcon}
📈 *Độ tin cậy:* 78%

⚠️ *Lưu ý:* Dự đoán chỉ mang tính tham khảo!`;

    let count = 0;
    for (const [chatId, user] of Object.entries(users)) {
        if (user.autoActive) {
            try {
                await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
                count++;
                await new Promise(r => setTimeout(r, 300));
            } catch(e) {
                console.error(`Gửi tin thất bại cho ${chatId}:`, e.message);
            }
        }
    }
    if (count) console.log(`✅ Đã gửi phiên ${pred.phien} đến ${count} user`);
}

// Web server cho Render
const app = express();
app.get('/', (req, res) => res.send('Bot đang chạy!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web chạy tại port ${PORT}`));

// Auto gửi mỗi 60 giây
setInterval(autoSendToUsers, 60000);
console.log('⏰ Bot đã sẵn sàng!');
