require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const lineClient = (lineConfig.channelAccessToken && lineConfig.channelSecret)
  ? new line.messagingApi.MessagingApiClient({ channelAccessToken: lineConfig.channelAccessToken })
  : null;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PERSONA_PATH = path.join(__dirname, 'data', 'persona.json');
const AGENT_URL = process.env.AGENT_URL || 'http://localhost:3001';

function loadPersona() {
  try {
    return JSON.parse(fs.readFileSync(PERSONA_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// ユーザーごとの会話履歴 (userId -> {role, content}[])
const conversationHistory = new Map();

// ────────────────────────────────────────────────────────────
// Express App
// ────────────────────────────────────────────────────────────
const app = express();

// LINE Webhook は express.json() より前に登録する
app.post('/api/line-webhook', line.middleware(lineConfig), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('[LINE WEBHOOK ERROR]', err);
      res.status(500).end();
    });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// フロントエンド向け World ID 設定 (シークレット除外)
app.get('/api/world-id-config', (req, res) => {
  res.json({
    app_id: process.env.WORLD_ID_APP_ID || '',
    action: process.env.WORLD_ID_ACTION || 'register-intent',
  });
});

// World ID 証明の検証
app.post('/api/verify', async (req, res) => {
  const proof = req.body;
  const rp_id = process.env.WORLD_ID_RP_ID;
  const action = process.env.WORLD_ID_ACTION || 'register-intent';

  if (!rp_id) {
    return res.status(500).json({ success: false, detail: 'Server misconfiguration: missing WORLD_ID_RP_ID' });
  }

  try {
    const verifyRes = await fetch(`https://developer.world.org/api/v4/verify/${rp_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...proof, action }),
    });
    const verifyResJson = await verifyRes.json();

    if (verifyRes.ok) {
      res.json({ success: true, detail: 'Proof successfully verified.', nullifier_hash: proof.nullifier_hash });
    } else {
      res.status(400).json({ success: false, detail: verifyResJson.detail || 'Verification failed.' });
    }
  } catch (error) {
    console.error('[WORLD ID VERIFY ERROR]', error);
    res.status(500).json({ success: false, detail: 'Server error during verification.' });
  }
});

const PORT = process.env.WEB_PORT || process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[WEB] Aeterna web server running on http://localhost:${PORT}`);
});

// ────────────────────────────────────────────────────────────
// LINE メッセージハンドラー (OpenClaw AI 対話ロジック)
// ────────────────────────────────────────────────────────────
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const userId = event.source.userId;
  const userText = event.message.text.trim();

  // ── 特殊コマンド: World ID 認証リンク送付 ──────────────────
  if (/認証|本人確認|World\s*ID/i.test(userText)) {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    return reply(event.replyToken,
      `本人確認を行います。\n以下のリンクを開いて World ID で認証を完了してください。\n\n${baseUrl}`
    );
  }

  // ── 特殊コマンド: エージェント手動実行 ─────────────────────
  if (/^(実行|トリガー|trigger|execute|送金)$/i.test(userText)) {
    return handleManualTrigger(event.replyToken);
  }

  // ── 特殊コマンド: ステータス確認 ────────────────────────────
  if (/ステータス|状態|status/i.test(userText)) {
    return handleStatusCheck(event.replyToken);
  }

  // ── 通常の AI 対話 (Claude マルチターン) ─────────────────────
  return handleAIDialogue(event.replyToken, userId, userText);
}

// エージェントを手動トリガーしてLINEに結果返信
async function handleManualTrigger(replyToken) {
  // LINE は replyToken を1度しか使えないため、トリガー前に「受付」を返す
  // → 実際には push_message で完了通知するが、ここではトリガー結果を直接返す
  try {
    const res = await axios.post(`${AGENT_URL}/api/trigger`, {}, { timeout: 60000 });
    const data = res.data;

    if (data.triggered) {
      const txLines = (data.transactions || [])
        .map(tx => tx.txHash
          ? `・${tx.recipient}: ${tx.amount_xrp} XRP\n  TX: ${tx.txHash.slice(0, 16)}...`
          : `・${tx.recipient}: 送金失敗 (${tx.error})`
        ).join('\n');

      return reply(replyToken,
        `意志を実行しました。\n\n判断理由:\n${data.reason}\n\n送金結果:\n${txLines || '（なし）'}`
      );
    } else {
      return reply(replyToken,
        `今回はトリガーされませんでした。\n\n理由: ${data.reason}`
      );
    }
  } catch (err) {
    console.error('[LINE BOT] Agent trigger error:', err.message);
    return reply(replyToken,
      'エージェントサーバーに接続できませんでした。\n`node agent/index.js` が起動しているか確認してください。'
    );
  }
}

// エージェントサーバーのステータスを取得してLINEに返信
async function handleStatusCheck(replyToken) {
  try {
    const [statusRes, logsRes] = await Promise.all([
      axios.get(`${AGENT_URL}/api/status`, { timeout: 5000 }),
      axios.get(`${AGENT_URL}/api/logs`, { timeout: 5000 }),
    ]);

    const s = statusRes.data;
    const logs = logsRes.data || [];
    const lastLog = logs[logs.length - 1];
    const lastTriggered = lastLog?.timestamp
      ? new Date(lastLog.timestamp).toLocaleString('ja-JP')
      : 'なし';
    const lastResult = lastLog?.triggered ? 'トリガー済み' : '監視中（未発動）';

    return reply(replyToken,
      `エージェント状態\n\n` +
      `状態: ${s.isRunning ? '実行中' : '待機中'}\n` +
      `最終サイクル: ${lastTriggered}\n` +
      `最終結果: ${lastResult}\n` +
      `累計サイクル: ${logs.length}回`
    );
  } catch {
    return reply(replyToken,
      'エージェントサーバーに接続できません。\n`node agent/index.js` を起動してください。'
    );
  }
}

// Claude API を使ったマルチターン AI 対話
async function handleAIDialogue(replyToken, userId, userText) {
  const persona = loadPersona();
  if (!persona) {
    return reply(replyToken, 'ペルソナデータが見つかりません。管理者に連絡してください。');
  }

  // ユーザーごとの会話履歴を取得・初期化
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  const history = conversationHistory.get(userId);

  // 直近 10 メッセージのみ保持（トークン節約）
  if (history.length >= 10) {
    history.splice(0, history.length - 8);
  }

  const systemPrompt = `あなたは「Aeterna」という死後遺志実行AIエージェントです。
故人「${persona.name}」の意志を代弁し、LINEを通じてユーザーと対話します。

【故人の価値観】
${persona.values}

【遺産分配の設定】
総額: ${persona.total_xrp} XRP
分配先:
${persona.recipients.map(r => `・${r.name}: ${Math.round(r.ratio * 100)}% — ${r.cause}`).join('\n')}

【エージェント設定】
ステータス: ${persona.status}
トリガーキーワード: ${persona.trigger_keywords.join('、')}
クールダウン: ${persona.cooldown_minutes}分

【あなたの役割】
- 故人の意志と価値観を誠実かつ温かく説明する
- Aeterna の仕組み（AIがニュースを監視し、条件成立時にXRPを自動送金する）をわかりやすく案内する
- 遺志の登録・確認・変更を検討しているユーザーをサポートする
- 「実行」と送ればエージェントを手動起動できること、「ステータス」で状態確認できることを必要に応じて案内する
- 故人への敬意を込めつつ、親しみやすく誠実な口調で話す
- 返答は200文字以内に収める（LINEメッセージとして読みやすい長さ）
- 常に日本語で返答する`;

  history.push({ role: 'user', content: userText });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      system: systemPrompt,
      messages: history,
    });

    const replyText = response.content.find(b => b.type === 'text')?.text
      ?? '応答を生成できませんでした。';

    history.push({ role: 'assistant', content: replyText });

    return reply(replyToken, replyText);
  } catch (err) {
    console.error('[LINE BOT] Claude API error:', err.message);
    return reply(replyToken, '申し訳ありません。現在応答できません。しばらくしてからお試しください。');
  }
}

// LINE メッセージ送信ヘルパー
async function reply(replyToken, text) {
  if (lineClient) {
    return lineClient.replyMessage({
      replyToken,
      messages: [{ type: 'text', text }],
    });
  } else {
    console.log('[LINE BOT] (credentials not set) Reply:', text);
    return null;
  }
}
