require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const line = require('@line/bot-sdk');
const { runLineOpenClaw } = require('./agent/line-openclaw');
// ─── LINE client ──────────────────────────────────────────────────────
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = (lineConfig.channelAccessToken && lineConfig.channelSecret)
  ? new line.messagingApi.MessagingApiClient({ channelAccessToken: lineConfig.channelAccessToken })
  : null;

// ─── User persistence ─────────────────────────────────────────────────
const USERS_PATH = path.join(__dirname, 'data', 'users.json');

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')); }
  catch { return {}; }
}
function saveUsers(u) {
  fs.mkdirSync(path.dirname(USERS_PATH), { recursive: true });
  fs.writeFileSync(USERS_PATH, JSON.stringify(u, null, 2), 'utf8');
}
function getUser(id)         { return loadUsers()[id] || { state: 'none' }; }
function updateUser(id, data) {
  const users = loadUsers();
  users[id] = { ...(users[id] || {}), ...data };
  saveUsers(users);
}

// ─── Express ──────────────────────────────────────────────────────────
const app = express();

// Respond to LINE immediately, process asynchronously (avoids webhook timeout)
app.post('/api/line-webhook', line.middleware(lineConfig), (req, res) => {
  res.status(200).end();
  req.body.events.forEach(event => {
    processLineEvent(event).catch(err => console.error('[EVENT ERROR]', err));
  });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/world-id-config', (req, res) => {
  res.json({ app_id: process.env.WORLD_ID_APP_ID || '', action: process.env.WORLD_ID_ACTION || 'register-intent' });
});

app.post('/api/verify', async (req, res) => {
  const rp_id = process.env.WORLD_ID_RP_ID;
  if (!rp_id) return res.status(500).json({ success: false, detail: 'Server misconfiguration' });
  try {
    const r = await fetch(`https://developer.world.org/api/v4/verify/${rp_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, action: process.env.WORLD_ID_ACTION || 'register-intent' }),
    });
    const json = await r.json();
    res.status(r.ok ? 200 : 400).json(r.ok ? { success: true } : { success: false, detail: json.detail });
  } catch { res.status(500).json({ success: false, detail: 'Server error' }); }
});

// World ID verification for LINE users — called from line-verify.html
app.post('/api/verify-line', async (req, res) => {
  const { line_user_id, ...proof } = req.body;
  const rp_id = process.env.WORLD_ID_RP_ID;
  if (!rp_id)          return res.status(500).json({ success: false, detail: 'Server misconfiguration' });
  if (!line_user_id)   return res.status(400).json({ success: false, detail: 'Missing line_user_id' });

  // Nullifier 重複チェック: 同じ World ID を2度登録させない
  const allUsers = loadUsers();
  const duplicate = Object.entries(allUsers).find(
    ([uid, u]) => u.world_id_nullifier === proof.nullifier_hash && uid !== line_user_id
  );
  if (duplicate) {
    return res.status(400).json({ success: false, detail: 'この World ID はすでに別のアカウントで登録済みです。' });
  }

  try {
    const r = await fetch(`https://developer.world.org/api/v4/verify/${rp_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...proof, action: process.env.WORLD_ID_ACTION || 'register-intent' }),
    });
    const json = await r.json();
    if (!r.ok) return res.status(400).json({ success: false, detail: json.detail || 'Verification failed' });

    updateUser(line_user_id, {
      world_id_verified: true,
      world_id_nullifier: proof.nullifier_hash,
      world_id_verified_at: new Date().toISOString(),
    });

    // Push confirmation to LINE
    await push(line_user_id,
      `✅ World ID 本人確認が完了しました！\n\n` +
      `🔐 認証済みエージェントとして登録されました。\n\n` +
      `これで以下のコマンドが使えます:\n` +
      `💸「送金 [XRPLアドレス] [金額]」\n` +
      `💰「残高」\n` +
      `📊「ステータス」`
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[VERIFY-LINE]', err.message);
    res.status(500).json({ success: false, detail: 'Server error' });
  }
});

// Admin overview for demo presenter
app.get('/api/users', (req, res) => {
  const users = loadUsers();
  res.json(Object.entries(users).map(([id, u]) => ({
    id,
    name:         u.persona?.name || u.name || '—',
    state:        u.state || 'none',
    values:       (u.persona?.values || []).join('・') || u.persona?.personality_summary || '—',
    balance:      u.xrplWallet?.balance ?? 0,
    totalDonated: (u.donationHistory || []).reduce((s, h) => s + (h.amount || 0), 0),
    donationCount: (u.donationHistory || []).length,
    history:      (u.donationHistory || []).slice(-3).map(h => ({
      at:        h.at,
      amount:    h.amount,
      recipient: h.recipient,
      reason:    h.reason,
    })),
    worldIdVerified: !!u.world_id_verified,
  })));
});

const PORT = process.env.WEB_PORT || process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[WEB] http://localhost:${PORT}`));

// ─── OpenClaw event processor ─────────────────────────────────────────
async function processLineEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const { replyToken, source: { userId }, message: { text } } = event;
  const user = getUser(userId);

  console.log(`[LINE] ${userId.slice(0, 8)}... state=${user.state} msg="${text.slice(0, 40)}"`);

  try {
    const result = await runLineOpenClaw(userId, text.trim(), user, {
      updateUserFn: updateUser,
      pushFn: push,
      baseUrl: process.env.BASE_URL || `http://localhost:${PORT}`,
      loadUsersFn: loadUsers,
    });
    if (result.replyText) await reply(replyToken, result.replyText);
  } catch (err) {
    console.error('[OPENCLAW ERROR]', err.message);
    await reply(replyToken, '申し訳ありません。エラーが発生しました。しばらくしてから再試行してください。');
  }
}


// ─── Messaging helpers ─────────────────────────────────────────────────
async function reply(replyToken, text, quickReplies = null) {
  const message = { type: 'text', text };
  if (quickReplies?.length) {
    message.quickReply = {
      items: quickReplies.map(label => ({
        type: 'action',
        action: { type: 'message', label: label.slice(0, 20), text: label },
      })),
    };
  }
  if (lineClient) return lineClient.replyMessage({ replyToken, messages: [message] });
  console.log('[LINE] Reply:', text);
  return null;
}

async function push(userId, text, quickReplies = null) {
  const message = { type: 'text', text };
  if (quickReplies?.length) {
    message.quickReply = {
      items: quickReplies.map(label => ({
        type: 'action',
        action: { type: 'message', label: label.slice(0, 20), text: label },
      })),
    };
  }
  if (lineClient) return lineClient.pushMessage({ to: userId, messages: [message] });
  console.log('[LINE] Push:', text);
  return null;
}
