const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

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

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, `🔐 <b>WELCOME</b>\n\nEnter KEY to activate.\n📝 <code>/key YOUR_KEY</code>`, { parse_mode: 'HTML' });
});

bot.onText(/\/key (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const key = match[1].trim().toUpperCase();
    const username = msg.chat.username || msg.chat.first_name || 'unknown';
    
    if (!keys[key]) {
        bot.sendMessage(chatId, '❌ KEY not found.');
        return;
    }
    if (keys[key].expires && Date.now() > keys[key].expires) {
        bot.sendMessage(chatId, '⛔ KEY expired.');
        return;
    }
    if (keys[key].usedBy && keys[key].usedBy !== chatId.toString()) {
        bot.sendMessage(chatId, '⚠️ KEY already used.');
        return;
    }
    
    keys[key].usedBy = chatId.toString();
    users[chatId] = { username, key, autoActive: true };
    saveKeys(); saveUsers();
    
    bot.sendMessage(chatId, `✅ <b>ACTIVATED!</b>\n\n📌 Use <code>/now</code> for prediction.\n🔄 Auto send every 60s.`, { parse_mode: 'HTML' });
    sendPrediction(chatId);
    
    if (ADMIN_CHAT_ID) {
        bot.sendMessage(ADMIN_CHAT_ID, `🔑 User ${username} (${chatId}) activated key: ${key}`);
    }
});

bot.onText(/\/now/, async (msg) => {
    const chatId = msg.chat.id;
    if (!users[chatId]) {
        bot.sendMessage(chatId, '🔐 Not activated. Use /key YOUR_KEY');
        return;
    }
    await sendPrediction(chatId);
});

bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    if (users[chatId]) {
        users[chatId].autoActive = false;
        saveUsers();
        bot.sendMessage(chatId, '⏹️ Auto send OFF.');
    }
});

bot.onText(/\/startbot/, (msg) => {
    const chatId = msg.chat.id;
    if (users[chatId]) {
        users[chatId].autoActive = true;
        saveUsers();
        bot.sendMessage(chatId, '✅ Auto send ON.');
    }
});

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
            bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
            count++;
            await new Promise(r => setTimeout(r, 300));
        }
    }
    if (count) console.log(`✅ Sent round ${pred.phien} to ${count} users`);
}

const app = express();
app.get('/', (req, res) => res.send('Bot is running!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web running on port ${PORT}`));

setInterval(autoSend, 60000);
console.log('⏰ Bot ready!');