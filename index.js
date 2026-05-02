require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const { createUserWallet, getXRPBalance, sendXRPFromWallet, GLOBAL_PARTNERS } = require('./xrpl/wallet');
const cryptoTools = require('./agent/skills/cryptoTools');
// ─── Clients ──────────────────────────────────────────────────────────
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = (lineConfig.channelAccessToken && lineConfig.channelSecret)
  ? new line.messagingApi.MessagingApiClient({ channelAccessToken: lineConfig.channelAccessToken })
  : null;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

app.post('/api/line-webhook', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(r => res.json(r))
    .catch(err => { console.error('[WEBHOOK]', err); res.status(500).end(); });
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
    id, name: u.persona?.name || u.name || '—', state: u.state,
    balance: u.xrplWallet?.balance ?? 0,
    totalDonated: (u.donationHistory || []).reduce((s, h) => s + (h.amount || 0), 0),
    donationCount: (u.donationHistory || []).length,
  })));
});

const PORT = process.env.WEB_PORT || process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[WEB] http://localhost:${PORT}`));

// ─── Main router ──────────────────────────────────────────────────────
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return null;
  const { replyToken, source: { userId }, message: { text: rawText } } = event;
  const text = rawText.trim();
  const user = getUser(userId);

  if (/^(リセット|reset)$/i.test(text)) {
    updateUser(userId, { state: 'none' });
    return reply(replyToken, 'リセットしました。「始める」と送ってください。', ['始める']);
  }

  // Global: World ID verification — available in any state
  if (/^(認証|本人確認|world\s?id|worldid)/i.test(text)) {
    return showVerifyUrl(replyToken, userId, user);
  }

  switch (user.state) {
    case 'none':            return onStart(replyToken, userId, text);
    case 'discovering':     return onDiscovering(replyToken, userId, text, user);
    case 'wallet_pending':  return onWalletPending(replyToken, userId, text, user);
    case 'persona_review':  return onPersonaReview(replyToken, userId, text, user);
    case 'registered':      return onRegistered(replyToken, userId, text, user);
    default:                return reply(replyToken, '「始める」と送ってください。', ['始める']);
  }
}

// ─── State: none ─────────────────────────────────────────────────────
async function onStart(replyToken, userId, text) {
  if (!/^(始める|スタート|start|登録|はじめる)$/i.test(text)) {
    return reply(replyToken,
      'Aeterna（エターナ）へようこそ。\n\n' +
      'あなたの想いを、永遠に動き続ける\nAI分身に託しませんか？\n\n' +
      '✨ Aeterna とは:\n' +
      'あなたが生前に残した人格・価値観をもとに、AIが世界を24時間監視。来るべきときに、あなたに代わって寄付を実行し続けます。\n\n' +
      '寄付先はAIが世界から探します。\nあなたの「分身」が、ときめいたものを選びます。\n\n' +
      '「始める」をタップしてください。',
      ['始める']
    );
  }
  // Get Claude's opening message, then store the full exchange so history always starts with 'user'
  const opening = await claudeDiscover([], 0);
  updateUser(userId, {
    state: 'discovering',
    discoveryHistory: [
      { role: 'user', content: '始めます' },
      { role: 'assistant', content: opening.text },
    ],
    discoveryTurns: 0,
  });
  return reply(replyToken, opening.text);
}

// ─── State: discovering ───────────────────────────────────────────────
async function onDiscovering(replyToken, userId, text, user) {
  const history = [...(user.discoveryHistory || [])];
  const turns = user.discoveryTurns || 0;

  history.push({ role: 'user', content: text });
  const result = await claudeDiscover(history, turns + 1);

  if (result.ready && result.persona) {
    // Persona synthesized — move to wallet setup
    updateUser(userId, {
      discoveryHistory: history,
      discoveryTurns: turns + 1,
      persona: { ...result.persona, values: result.persona.values || [], memorable_phrases: result.persona.memorable_phrases || [], interests: result.persona.interests || [], trigger_keywords: result.persona.trigger_keywords || [] },
      state: 'wallet_pending',
    });

    await reply(replyToken,
      `${result.persona.name}さんのことが、\nだいぶわかってきました。\n\n` +
      `あなたの「分身」を作る準備をしています。\nXRPウォレットを生成中...`
    );

    // Create XRPL wallet in background and push result
    const walletInfo = await createUserWallet();
    updateUser(userId, { xrplWallet: walletInfo });

    const balLabel = walletInfo.real ? 'XRP (テストネット)' : 'XRP (デモ)';
    await push(userId,
      `✅ ウォレット準備完了\n\n` +
      `📬 受取アドレス:\n${walletInfo.address}\n\n` +
      `残高: ${walletInfo.balance} ${balLabel}\n\n` +
      `実際のサービスでは、このアドレスへXRPを送金すると残高が自動反映されます。\n\n` +
      `デモのため送金不要です。\n「入金完了」をタップしてください。`,
      ['入金完了']
    );
    return;
  }

  // Continue conversation (or retry synthesis if parsing failed)
  const responseText = result.text || 'ありがとうございます。もう少し教えていただけますか？';
  history.push({ role: 'assistant', content: responseText });
  updateUser(userId, { discoveryHistory: history, discoveryTurns: turns + 1 });
  return reply(replyToken, responseText);
}

// Claude drives the discovery conversation. Returns {text, ready, persona}.
async function claudeDiscover(history, turn) {
  const partnerList = GLOBAL_PARTNERS.map(p => `・${p.name}（${p.category}）: ${p.mission}`).join('\n');

  const system =
    `あなたはAeterna（エターナ）の「記憶の守り手」です。\n` +
    `温かく自然な会話を通じて、ユーザーの人格・価値観・想いを引き出してください。\n\n` +
    `【引き出すべき情報】\n` +
    `1. お名前\n` +
    `2. 人生で誇りに思うこと・大切な記憶\n` +
    `3. よく使う言葉・口癖・人生哲学\n` +
    `4. 世の中で心配なこと・気になる問題\n` +
    `5. 将来の世代に残したい想い\n` +
    `6. 遺産として残したいXRP金額（自然に聞く）\n` +
    `7. どんな出来事のときに実行してほしいか\n\n` +
    `【寄付先について】\n` +
    `寄付先は固定ではありません。AIが世界を調査して、\n` +
    `あなたの人格がときめくものを自律的に選びます。\n` +
    `以下はその候補の一部です:\n${partnerList}\n\n` +
    `【ターン ${turn} / 最低7ターン後に合成可能】\n` +
    (turn >= 7
      ? `情報が揃っています。次のJSON形式のみを返してください（説明文なし）:\n[SYNTHESIZE]{"name":"...","personality_summary":"50文字で人格を","voice_style":"話し方の特徴","values":["価値観1","価値観2","価値観3"],"memorable_phrases":["口癖や言葉"],"interests":["関心事1","関心事2"],"trigger_condition":"寄付トリガー条件（日本語）","trigger_keywords":["英語kw1","英語kw2","日本語kw1","日本語kw2"],"total_xrp":数値}`
      : `まだ会話を続けてください。絶対に[SYNTHESIZE]を返さないでください。`
    ) + `\n\nルール:\n- 一度に一つの質問のみ\n- 共感してから次の質問へ\n- 返答は200文字以内\n- 常に日本語で`;

  const messages = history.length === 0
    ? [{ role: 'user', content: '始めます' }]
    : history;

  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 700,
    system,
    messages,
  });

  const text = res.content.find(b => b.type === 'text')?.text || '';

  if (turn >= 7 && text.includes('[SYNTHESIZE]')) {
    const m = text.match(/\[SYNTHESIZE\]\s*(\{[\s\S]*\})/);
    if (m) {
      try {
        const persona = JSON.parse(m[0].replace('[SYNTHESIZE]', '').trim());
        return { text: '', ready: true, persona };
      } catch { /* fall through to normal reply */ }
    }
  }

  return { text, ready: false, persona: null };
}

// ─── State: wallet_pending ────────────────────────────────────────────
async function onWalletPending(replyToken, userId, text, user) {
  if (!/入金完了|完了|確認|ok|はい|done/i.test(text)) {
    return reply(replyToken,
      `「入金完了」をタップすると次に進みます。\n\nアドレス:\n${user.xrplWallet?.address || '—'}`,
      ['入金完了']
    );
  }

  const persona = user.persona;
  updateUser(userId, { state: 'persona_review' });

  await reply(replyToken,
    `✨ ${persona.name}さんの分身を合成しています...\n\nひとこと確認させてください。`
  );

  // Generate a sample message from the twin persona
  let sample = '';
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: buildTwinSystem(persona),
      messages: [{ role: 'user', content: 'はじめまして。あなたはどんな人ですか？一言で教えてください。' }],
    });
    sample = r.content.find(b => b.type === 'text')?.text || '';
  } catch { /* ignore */ }

  const balance = user.xrplWallet?.balance ?? 0;
  const profileMsg =
    `📋 あなたの分身\n\n` +
    `👤 ${persona.name}\n` +
    `💫 ${persona.personality_summary}\n` +
    `🗣 ${persona.voice_style}\n` +
    `💛 価値観: ${(persona.values || []).join('・')}\n` +
    `✍️ 「${(persona.memorable_phrases || [])[0] || '—'}」\n` +
    `🌍 関心: ${(persona.interests || []).join('・')}\n` +
    `⚡ トリガー: ${persona.trigger_condition}\n` +
    `💰 残高: ${balance} XRP\n\n` +
    (sample ? `💬 分身からひとこと:\n「${sample}」\n\n` : '') +
    `この分身はあなたらしいですか？`;

  await push(userId, profileMsg, ['登録する ✅', '最初から 🔄']);
}

// ─── State: persona_review ────────────────────────────────────────────
async function onPersonaReview(replyToken, userId, text, user) {
  if (/最初|やり直|リセット|🔄/i.test(text)) {
    updateUser(userId, { state: 'none', discoveryHistory: [], persona: null });
    return reply(replyToken, 'もう一度始めましょう。「始める」をタップしてください。', ['始める']);
  }
  if (!/登録|はい|yes|ok|✅/i.test(text)) {
    return reply(replyToken, '「登録する ✅」または「最初から 🔄」をタップしてください。', ['登録する ✅', '最初から 🔄']);
  }

  updateUser(userId, { state: 'registered', registeredAt: new Date().toISOString(), donationHistory: [] });
  const persona = user.persona;

  return reply(replyToken,
    `🌟 ${persona.name}さんの分身が\n永遠に刻まれました。\n\n` +
    `AIエージェントが世界を監視し、\n` +
    `「${persona.trigger_condition}」を検知すると、\n` +
    `あなたの分身がときめく寄付先を\n世界中から探して実行します。\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `📊「ステータス」→ 現在の状況\n` +
    `📜「履歴」→ 寄付実績\n` +
    `💰「残高」→ XRP残高\n` +
    `🤖「デモ実行」→ 今すぐ試す\n` +
    `💬 その他 → 分身と会話`,
    ['ステータス', 'デモ実行']
  );
}

// ─── State: registered ────────────────────────────────────────────────
async function onRegistered(replyToken, userId, text, user) {
  if (/ステータス|状態|status/i.test(text))           return showStatus(replyToken, user);
  if (/履歴|実績|history/i.test(text))               return showHistory(replyToken, user);
  if (/残高|balance|XRP/i.test(text))                return showBalance(replyToken, userId, user);
  if (/デモ実行|demo|手動|実行|トリガー/i.test(text))   return runDemo(replyToken, userId, user);
  if (/^送金\s+\S+\s+[\d.]+/i.test(text))            return executeSend(replyToken, userId, text, user);
  return twinDialogue(replyToken, user, text);
}

async function showStatus(replyToken, user) {
  const history = user.donationHistory || [];
  const last = history[history.length - 1];
  const total = history.reduce((s, h) => s + (h.amount || 0), 0);
  const persona = user.persona;
  return reply(replyToken,
    `📊 ${persona.name}の分身\n\n` +
    `💰 残高: ${user.xrplWallet?.balance ?? 0} XRP\n` +
    `🤖 エージェント: 世界を監視中\n` +
    `⚡ トリガー: ${persona.trigger_condition}\n` +
    `📦 累計寄付: ${total} XRP（${history.length}回）\n` +
    `⏰ 最終実行: ${last ? new Date(last.at).toLocaleString('ja-JP') : 'まだなし'}`,
    ['履歴', '残高', 'デモ実行']
  );
}

async function showHistory(replyToken, user) {
  const history = user.donationHistory || [];
  if (!history.length) {
    return reply(replyToken, 'まだ寄付実績はありません。\n「デモ実行」で試せます。', ['デモ実行']);
  }
  const lines = history.slice(-5).reverse().map(h => {
    const d = new Date(h.at).toLocaleDateString('ja-JP');
    return `${d}\n💸 ${h.amount} XRP → ${h.recipient}\n💬「${h.reason}」`;
  });
  return reply(replyToken, `📜 寄付履歴（直近${Math.min(5, history.length)}件）\n\n${lines.join('\n\n')}`);
}

async function showBalance(replyToken, userId, user) {
  const wallet = user.xrplWallet;
  if (!wallet) return reply(replyToken, 'ウォレット情報がありません。');

  // Try to fetch live balance from XRPL
  const live = wallet.real ? await getXRPBalance(wallet.address) : null;
  const bal = live ?? wallet.balance ?? 0;
  if (live !== null && live !== wallet.balance) {
    updateUser(userId, { xrplWallet: { ...wallet, balance: live } });
  }

  const short = `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`;
  const label = wallet.real ? '(テストネット)' : '(デモ)';
  return reply(replyToken,
    `💰 残高情報\n\n` +
    `アドレス: ${short} ${label}\n` +
    `XRP残高: ${bal} XRP\n\n` +
    `トリガー条件が満たされると、\n分身がときめく寄付先を探して\n自動実行します。`,
    ['ステータス', 'デモ実行']
  );
}

// ─── Demo: autonomous world-research and donation ─────────────────────
async function runDemo(replyToken, userId, user) {
  const wallet = user.xrplWallet;
  const balance = wallet?.balance ?? 0;
  if (balance <= 0) return reply(replyToken, '残高がないため寄付を実行できません。');

  await reply(replyToken,
    `🌍 ${user.persona.name}の分身が世界を調査中...\n\n` +
    `世界のニュースを読み込み、\nあなたの価値観でときめくものを探しています。`
  );

  try {
    const persona = user.persona;
    const partnerJson = JSON.stringify(GLOBAL_PARTNERS.map(p => ({
      name: p.name, category: p.category, mission: p.mission, country: p.country
    })));

    // Claude autonomously researches and picks a recipient + executes judgment
    const researchPrompt =
      `あなたは故人「${persona.name}」の分身AIエージェントです。\n\n` +
      `【あなたの人格】\n${persona.personality_summary}\n` +
      `【価値観】${(persona.values || []).join('・')}\n` +
      `【関心事】${(persona.interests || []).join('・')}\n` +
      `【口癖】${(persona.memorable_phrases || []).join(' / ')}\n` +
      `【トリガー条件】${persona.trigger_condition}\n\n` +
      `今日の世界情勢（シミュレーション）を調査し、トリガー条件に合致する出来事を3件報告してください。\n` +
      `その上で、以下のパートナー候補から、あなたの人格がもっともときめく1〜2件を選んでください:\n\n` +
      `${partnerJson}\n\n` +
      `必ず以下のJSON形式のみで返してください:\n` +
      `{"triggered":true/false,"news":["ニュース1","ニュース2","ニュース3"],"reason":"${persona.name}の言葉で書いた判断理由（80文字）","selected":[{"name":"団体名","category":"カテゴリ","mission":"使命","reason":"なぜこの団体を選んだか（40文字）","ratio":0.6},{"name":"団体名2","ratio":0.4}]}`;

    const researchRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      messages: [{ role: 'user', content: researchPrompt }],
    });

    const raw = researchRes.content.find(b => b.type === 'text')?.text || '{}';
    const m = raw.match(/\{[\s\S]*\}/);
    const judgment = m ? JSON.parse(m[0]) : { triggered: false };

    if (!judgment.triggered) {
      await push(userId,
        `🔍 調査完了\n\n` +
        `今日の世界情勢では、${persona.name}の分身がときめくトリガーは\n見つかりませんでした。\n\n` +
        `引き続き監視を続けます。`
      );
      return;
    }

    const donateTotal = Math.max(1, Math.floor(balance * 0.10));
    const selected = judgment.selected || [];
    const transactions = [];

    // Execute XRPL transactions (or simulate if demo wallet)
    for (const s of selected) {
      const amount = Math.floor(donateTotal * (s.ratio || 0.5));
      if (amount <= 0) continue;

      // Find wallet address — fuzzy match by name then category
      const partner = GLOBAL_PARTNERS.find(p => p.name === s.name)
        || GLOBAL_PARTNERS.find(p => p.category === s.category)
        || GLOBAL_PARTNERS[0];
      let txHash = null;

      if (wallet.seed && wallet.real) {
        try {
          const txResult = await sendXRPFromWallet(wallet.seed, partner.wallet, amount, judgment.reason);
          txHash = txResult.txHash;
        } catch (err) {
          console.error('[XRPL TX ERROR]', err.message);
        }
      }

      transactions.push({
        name: s.name,
        category: s.category,
        amount,
        reason: s.reason,
        txHash,
        explorerUrl: txHash ? `https://testnet.xrpl.org/transactions/${txHash}` : null,
      });
    }

    const newBalance = Math.max(0, balance - donateTotal);
    const historyEntry = {
      at: new Date().toISOString(),
      amount: donateTotal,
      recipient: selected.map(s => s.name).join('、'),
      reason: judgment.reason,
      news: (judgment.news || []).slice(0, 2).join(' / '),
      transactions,
    };

    const users = loadUsers();
    users[userId] = {
      ...users[userId],
      xrplWallet: { ...wallet, balance: newBalance },
      donationHistory: [...(users[userId].donationHistory || []), historyEntry],
    };
    saveUsers(users);

    // Build result message
    const newsLines = (judgment.news || []).map(n => `・${n}`).join('\n');
    const txLines = transactions.map(t =>
      `🏛 ${t.name}（${t.category}）\n` +
      `   ${t.amount} XRP — ${t.reason}\n` +
      (t.txHash ? `   TX: ${t.txHash.slice(0, 16)}...` : `   TX: シミュレーション`)
    ).join('\n\n');

    await push(userId,
      `✅ ${persona.name}の分身が動きました\n\n` +
      `📰 世界の動き:\n${newsLines}\n\n` +
      `💬 ${persona.name}の判断:\n「${judgment.reason}」\n\n` +
      `💸 寄付を実行:\n${txLines}\n\n` +
      `合計: ${donateTotal} XRP\n` +
      `残高: ${newBalance} XRP`
    );
  } catch (err) {
    console.error('[DEMO EXEC ERROR]', err.message);
    await push(userId, 'エラーが発生しました。しばらくしてから再試行してください。');
  }
}

// ─── World ID verification URL ────────────────────────────────────────
async function showVerifyUrl(replyToken, userId, user) {
  const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const verifyUrl = `${baseUrl}/line-verify.html?user=${encodeURIComponent(userId)}`;

  if (user.world_id_verified) {
    return reply(replyToken,
      `✅ すでに World ID 認証済みです。\n\n` +
      `🔐 認証日時: ${new Date(user.world_id_verified_at).toLocaleString('ja-JP')}\n\n` +
      `💸「送金 [アドレス] [金額]」で送金できます。`,
      ['送金方法を確認', '残高']
    );
  }

  return reply(replyToken,
    `🔐 World ID 本人確認\n\n` +
    `以下のリンクを開いて、World AppでQRコードをスキャンしてください。\n\n` +
    `${verifyUrl}\n\n` +
    `📱 World App Simulator（テスト用）:\n` +
    `https://simulator.worldcoin.org\n\n` +
    `確認が完了すると、このLINEに通知が届きます。`
  );
}

// ─── XRPL send command ────────────────────────────────────────────────
async function executeSend(replyToken, userId, text, user) {
  const m = text.match(/^送金\s+(\S+)\s+([\d.]+)/i);
  if (!m) return reply(replyToken, '形式: 「送金 [XRPLアドレス] [金額]」\n例: 送金 rXXXXXXXX 5');

  const [, toAddress, amountStr] = m;
  const amount = parseFloat(amountStr);

  // World ID verification required
  if (!user.world_id_verified) {
    const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
    const verifyUrl = `${baseUrl}/line-verify.html?user=${encodeURIComponent(userId)}`;
    return reply(replyToken,
      `⚠️ 送金には World ID 本人確認が必要です。\n\n` +
      `以下のリンクで認証を完了させてください:\n${verifyUrl}`
    );
  }

  if (!toAddress.startsWith('r') || toAddress.length < 25) {
    return reply(replyToken, '有効な XRPL アドレス（r で始まる）を入力してください。');
  }
  if (isNaN(amount) || amount <= 0) {
    return reply(replyToken, '送金額は0より大きい数値を入力してください。');
  }

  const wallet = user.xrplWallet;
  if (!wallet) return reply(replyToken, 'ウォレットが設定されていません。');

  const currentBalance = wallet.balance || 0;
  if (currentBalance < amount + 1) {
    return reply(replyToken, `残高不足です。現在の残高: ${currentBalance} XRP\n（最低1 XRP の準備金が必要です）`);
  }

  await reply(replyToken, `💸 送金処理中...\n宛先: ${toAddress.slice(0,8)}...${toAddress.slice(-4)}\n金額: ${amount} XRP`);

  try {
    if (wallet.seed && wallet.real) {
      const result = await sendXRPFromWallet(wallet.seed, toAddress, amount, 'Aeterna LINE送金 (World ID verified)');
      const newBalance = Math.max(0, currentBalance - amount);
      updateUser(userId, { xrplWallet: { ...wallet, balance: newBalance } });
      await push(userId,
        `✅ 送金完了\n\n` +
        `宛先: ${toAddress.slice(0,8)}...${toAddress.slice(-4)}\n` +
        `金額: ${amount} XRP\n` +
        `残高: ${newBalance} XRP\n\n` +
        `🔗 TX確認:\nhttps://testnet.xrpl.org/transactions/${result.txHash}`
      );
    } else {
      // Demo mode
      const newBalance = Math.max(0, currentBalance - amount);
      const fakeTx = 'DEMO' + Math.random().toString(36).substring(2, 18).toUpperCase();
      updateUser(userId, { xrplWallet: { ...wallet, balance: newBalance } });
      await push(userId,
        `✅ 送金完了（デモモード）\n\n` +
        `宛先: ${toAddress.slice(0,8)}...${toAddress.slice(-4)}\n` +
        `金額: ${amount} XRP\n` +
        `TX: ${fakeTx}\n` +
        `残高: ${newBalance} XRP`
      );
    }
  } catch (err) {
    console.error('[SEND ERROR]', err.message);
    await push(userId, `❌ 送金エラー: ${err.message}`);
  }
}

// ─── AI twin dialogue ──────────────────────────────────────────────────
async function twinDialogue(replyToken, user, text) {
  const persona = user.persona;
  try {
    let messages = [{ role: 'user', content: text }];
    const anthropicTools = cryptoTools.tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema
    }));

    const systemPrompt = buildTwinSystem(persona) + "\n\n【重要】ユーザーからの依頼で暗号資産（USDC）の送金や換金（ETHをUSDCにスワップ）が必要な場合は、ツールを使って実行してください。実行後、完了した旨（TXハッシュなど）を含めてユーザーに報告してください。※送金先アドレスは確実にユーザーに指定させてください。";

    let res = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      system: systemPrompt,
      messages: messages,
      tools: anthropicTools,
    });

    if (res.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: res.content });
      
      const toolUse = res.content.find(c => c.type === 'tool_use');
      let toolResultText = "Tool not found";
      
      const toolDef = cryptoTools.tools.find(t => t.name === toolUse.name);
      if (toolDef) {
         try {
           console.log(`[TOOL CALL] ${toolUse.name} invoked with args:`, toolUse.input);
           toolResultText = await toolDef.execute(toolUse.input);
           console.log(`[TOOL RESULT]`, toolResultText);
         } catch (e) {
           toolResultText = `Error executing tool: ${e.message}`;
         }
      }
      
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: toolResultText
        }]
      });

      res = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 400,
        system: systemPrompt,
        messages: messages,
        tools: anthropicTools,
      });
    }

    const txt = res.content.find(b => b.type === 'text')?.text ?? '応答を生成できませんでした。';
    return reply(replyToken, txt);
  } catch (err) {
    console.error("[twinDialogue Error]", err);
    return reply(replyToken, '申し訳ありません。現在応答できません。');
  }
}

function buildTwinSystem(persona) {
  return (
    `あなたは「${persona.name}」という人物の分身AIです。\n` +
    `この人物として自然に語りかけてください。\n\n` +
    `【人格】${persona.personality_summary}\n` +
    `【話し方】${persona.voice_style}\n` +
    `【価値観】${(persona.values || []).join('・')}\n` +
    `【口癖・言葉】${(persona.memorable_phrases || []).join(' / ')}\n` +
    `【関心事】${(persona.interests || []).join('・')}\n\n` +
    `${persona.name}本人として、温かく誠実に話してください。\n` +
    `返答は200文字以内。常に日本語で。`
  );
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
