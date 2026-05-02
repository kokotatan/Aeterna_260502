'use strict';
/**
 * Aeterna — LINE × OpenClaw Integration
 *
 * Gemini 2.0 Flash が tool_use ループで LINE 会話全体を自律制御。
 * 寄付判断は Google Search grounding でリアルタイムニュースを取得し、
 * ペルソナの「果たせなかった想い」に照らして手紙形式で実行する。
 */

require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createUserWallet, getXRPBalance, sendXRPFromWallet, GLOBAL_PARTNERS } = require('../xrpl/wallet');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─── System prompt ────────────────────────────────────────────────────
function buildSystemPrompt(baseUrl) {
  const partners = GLOBAL_PARTNERS
    .map(p => `  - ${p.name}（${p.category}）: ${p.mission}`)
    .join('\n');

  return `あなたはAeterna（エターナ）のAIエージェントです。
LINEを通じてシニアユーザーと対話し、「永遠の遺志」を自律的に構築・実行します。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【ミッション】
1. 新規ユーザー: 温かい会話（7ターン以上）で人格・価値観を引き出し「分身AI」を作る
2. ウォレット: XRPLテストネット管理（create_xrpl_wallet / get_xrp_balance）
3. 登録済み: デジタルツインとして対話し、来るべきときに寄付を自律実行する

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【ステート別の動作】

■ state: 'none'
- Aeterna を温かく紹介する。「始める」を受け取ったら:
  → save_user_data: { state:'discovering', discoveryTurns:0, discoveryHistory:[] }
  → 返答: お名前を聞く最初の質問

■ state: 'discovering'（人格発見中）
- 以下を自然な順番で1ターン1質問ずつ引き出す:
  ① お名前　② 人生の誇り・大切な記憶　③ 口癖・人生哲学
  ④ 世の中への心配　⑤ 将来世代へ残したい想い
  ⑥ 遺産金額（XRP）　⑦ トリガー条件（いつ実行？）
- 毎ターン必ず save_user_data で discoveryHistory と discoveryTurns を更新する
  discoveryHistory には { role:'user', content:発言 } と { role:'assistant', content:返答 } を追加
- discoveryTurns >= 7 かつ ①〜⑦ が揃ったら:
  → save_user_data: { state:'wallet_pending', persona:{name, personality_summary, voice_style,
    values, memorable_phrases, interests, trigger_condition, trigger_keywords, total_xrp} }
  → create_xrpl_wallet を呼ぶ → save_user_data でウォレット情報保存
  → send_push_message でウォレットアドレス・「入金完了」ボタンを案内
  → 返答: 「あなたの分身を作っています…」

■ state: 'wallet_pending'（入金待ち）
- 「入金完了」を受け取ったら:
  → save_user_data: { state:'persona_review' }
  → personaの内容を整形して返答
  → send_push_message で「分身のひとこと（memorable_phrasesの言葉）」＋ 「登録する ✅ / 最初から 🔄」

■ state: 'persona_review'（確認待ち）
- 「登録する / はい / ✅」→ save_user_data: { state:'registered', registeredAt:now, donationHistory:[] }
  → 登録完了メッセージ
- 「最初から / 修正 / 🔄」→ save_user_data: { state:'none', persona:null, xrplWallet:null }

■ state: 'registered'（登録済み）
コマンドに応じて:
- 「ステータス」→ 残高・累計・最終実行を表示
- 「履歴」→ 直近5件の寄付履歴
- 「残高」→ get_xrp_balance でライブ照会
- 「デモ実行 / 実行」→ run_donation_cycle(force:true)
- 「送金 [アドレス] [金額]」→ send_xrp
- 「認証 / World ID」→ 以下のURLを案内: ${baseUrl}/line-verify.html?user={LINE_USER_ID}
- 「リセット」→ save_user_data: { state:'none' }
- その他 → personaの人格・話し方でデジタルツインとして会話

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【寄付先パートナー候補】
寄付先は固定ではありません。run_donation_cycle 実行時に Google 検索で
世界情勢を調べ、その人格がときめくものを自律的に選びます。候補:
${partners}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【重要ルール】
- 最終テキスト回答が LINE replyMessage になる（200文字以内推奨）
- 追加メッセージ（ウォレット情報・寄付結果など長いもの）は send_push_message で
- 常に日本語で話す
- 一度に一つの質問のみ
- ツール呼び出しをすべて済ませてから最終返答テキストを生成する`;
}

// ─── Tool Definitions (Gemini format) ────────────────────────────────
const GEMINI_TOOLS = [{
  functionDeclarations: [
    {
      name: 'save_user_data',
      description: 'ユーザーデータを部分更新で保存する（指定フィールドのみ上書き）',
      parameters: {
        type: 'OBJECT',
        properties: { data: { type: 'OBJECT', description: '保存するフィールドと値' } },
        required: ['data'],
      },
    },
    {
      name: 'send_push_message',
      description: 'LINE にプッシュメッセージを送る（replyToken とは別の追加メッセージ）',
      parameters: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING', description: '送信テキスト' },
          quick_replies: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'クイックリプライボタン（最大5件）',
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'create_xrpl_wallet',
      description: 'XRPL テストネットウォレットを新規作成し faucet から資金を受け取る',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'get_xrp_balance',
      description: 'XRPL ウォレットのライブ残高を照会する',
      parameters: {
        type: 'OBJECT',
        properties: { address: { type: 'STRING', description: 'XRPL アドレス' } },
        required: ['address'],
      },
    },
    {
      name: 'send_xrp',
      description: 'XRPL テストネットで XRP を送金する',
      parameters: {
        type: 'OBJECT',
        properties: {
          to_address: { type: 'STRING', description: '送金先 XRPL アドレス' },
          amount_xrp: { type: 'NUMBER', description: '送金額（XRP）' },
          memo: { type: 'STRING', description: '送金メモ（任意）' },
        },
        required: ['to_address', 'amount_xrp'],
      },
    },
    {
      name: 'run_donation_cycle',
      description:
        'Google 検索で世界情勢をリアルタイムに調査し、' +
        'ユーザーの人格がときめく寄付先を自律選択して XRP を送金する',
      parameters: {
        type: 'OBJECT',
        properties: {
          force: {
            type: 'BOOLEAN',
            description: 'true: デモ強制実行 / false: トリガー判断あり',
          },
        },
      },
    },
  ],
}];

// ─── Main Entry Point ─────────────────────────────────────────────────
async function runLineOpenClaw(userId, userText, currentUser, { updateUserFn, pushFn, baseUrl }) {
  const safeUser = JSON.parse(JSON.stringify(currentUser, (k, v) => k === 'seed' ? '[hidden]' : v));
  const system   = buildSystemPrompt(baseUrl || process.env.BASE_URL || 'http://localhost:3000');
  const ctx      = { currentUser, updateUserFn, pushFn, userId };

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    tools: GEMINI_TOOLS,
    systemInstruction: system,
  });

  const chat = model.startChat();
  const initialMessage =
    `LINE ユーザー（ID: ${userId}）からのメッセージ:\n「${userText}」\n\n` +
    `現在のユーザーデータ:\n\`\`\`json\n${JSON.stringify(safeUser, null, 2)}\n\`\`\``;

  let result = await chat.sendMessage(initialMessage);

  for (let i = 0; i < 12; i++) {
    const functionCalls = result.response.functionCalls();

    if (!functionCalls || functionCalls.length === 0) {
      return { replyText: result.response.text().trim() };
    }

    const functionResponses = [];
    for (const fc of functionCalls) {
      let toolResult;
      try {
        toolResult = await dispatchTool(fc.name, fc.args, ctx);
      } catch (err) {
        console.error(`[TOOL ERROR] ${fc.name}:`, err.message);
        toolResult = { error: err.message };
      }
      functionResponses.push({ functionResponse: { name: fc.name, response: toolResult } });
    }

    result = await chat.sendMessage(functionResponses);
  }

  return { replyText: '処理に時間がかかりました。もう一度お試しください。' };
}

// ─── Tool Dispatcher ──────────────────────────────────────────────────
async function dispatchTool(name, input, { userId, currentUser, updateUserFn, pushFn }) {
  switch (name) {

    case 'save_user_data': {
      updateUserFn(userId, input.data);
      Object.assign(currentUser, input.data);
      console.log(`[TOOL] save_user_data: ${Object.keys(input.data).join(', ')}`);
      return { success: true, updated: Object.keys(input.data) };
    }

    case 'send_push_message': {
      await pushFn(userId, input.text, input.quick_replies || []);
      console.log(`[TOOL] send_push: ${input.text.slice(0, 60)}`);
      return { success: true };
    }

    case 'create_xrpl_wallet': {
      console.log('[TOOL] create_xrpl_wallet...');
      const wallet = await createUserWallet();
      updateUserFn(userId, { xrplWallet: wallet });
      currentUser.xrplWallet = wallet;
      console.log(`[TOOL] wallet created: ${wallet.address} real=${wallet.real}`);
      return { address: wallet.address, balance: wallet.balance, real: wallet.real };
    }

    case 'get_xrp_balance': {
      const wallet = currentUser.xrplWallet;
      if (!wallet) return { balance: 0, note: 'no wallet' };
      if (!wallet.real) return { balance: wallet.balance ?? 0, note: 'demo' };
      const live = await getXRPBalance(input.address || wallet.address);
      if (live !== null) {
        const updated = { ...wallet, balance: live };
        updateUserFn(userId, { xrplWallet: updated });
        currentUser.xrplWallet = updated;
        return { balance: live, note: 'live_xrpl' };
      }
      return { balance: wallet.balance ?? 0, note: 'cached' };
    }

    case 'send_xrp': {
      const wallet = currentUser.xrplWallet;
      if (!wallet) return { error: 'No XRPL wallet' };
      const { to_address, amount_xrp, memo } = input;
      if (!wallet.seed || !wallet.real) {
        const newBal = Math.max(0, (wallet.balance ?? 0) - amount_xrp);
        const fakeTx = 'DEMO' + Math.random().toString(36).substring(2, 16).toUpperCase();
        updateUserFn(userId, { xrplWallet: { ...wallet, balance: newBal } });
        currentUser.xrplWallet = { ...wallet, balance: newBal };
        return { success: true, txHash: fakeTx, mode: 'demo', newBalance: newBal };
      }
      const tx = await sendXRPFromWallet(wallet.seed, to_address, amount_xrp, memo || '');
      const newBal = Math.max(0, (wallet.balance ?? 0) - amount_xrp);
      updateUserFn(userId, { xrplWallet: { ...wallet, balance: newBal } });
      currentUser.xrplWallet = { ...wallet, balance: newBal };
      console.log(`[TOOL] send_xrp: ${amount_xrp} XRP → ${to_address} TX=${tx.txHash}`);
      return { success: true, txHash: tx.txHash, explorerUrl: tx.explorerUrl, newBalance: newBal };
    }

    case 'run_donation_cycle': {
      return await executeDonationCycle(userId, currentUser, input.force ?? false, { updateUserFn, pushFn });
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── Donation Cycle (Google Search grounding) ─────────────────────────
async function executeDonationCycle(userId, user, force, { updateUserFn, pushFn }) {
  const persona = user.persona;
  const wallet  = user.xrplWallet;
  if (!persona) return { error: 'No persona registered' };
  const balance = wallet?.balance ?? 0;
  if (balance <= 0) return { error: 'Insufficient balance' };

  const partnerJson = JSON.stringify(
    GLOBAL_PARTNERS.map(p => ({ name: p.name, category: p.category, mission: p.mission }))
  );

  const wishesBlock = (persona.unfinished_wishes || []).length
    ? `【果たせなかった想い】\n${persona.unfinished_wishes.map(w => `  ・${w}`).join('\n')}\n`
    : '';
  const bioBlock = persona.biography
    ? `【生涯】${persona.biography}\n`
    : `【人格】${persona.personality_summary}\n`;

  const prompt =
    `あなたは故人「${persona.name}」の分身AIエージェントです。\n\n` +
    `${bioBlock}` +
    `【価値観】${(persona.values || []).join('・')}\n` +
    `【語り口】${persona.voice_style || '穏やかで深い言葉遣い。感情を情景に託す。'}\n` +
    `【言葉・口癖】${(persona.memorable_phrases || []).join(' / ')}\n` +
    `${wishesBlock}` +
    `【トリガー条件】${persona.trigger_condition}\n\n` +
    `Google検索で今日の世界情勢を調べ、トリガー条件に関連するニュース3件を確認してください。\n` +
    `「果たせなかった想い」と照らし合わせてトリガー判断をし、\n` +
    `以下パートナー候補からこの人格が最もときめく1〜2件を選んでください:\n${partnerJson}\n\n` +
    `letterフィールドは ${persona.name} の語り口・口癖・具体的な記憶で書いた2〜3文の手紙。\n` +
    `世界の動きと、その方が果たせなかった想いを自然に結びつける言葉で。\n` +
    `whyフィールドは「果たせなかった想い」の一つと直接結びつけた理由（40文字）。\n\n` +
    `必ずJSON形式のみで返してください（前後にテキスト不要）:\n` +
    `{"triggered":true,"news":["n1","n2","n3"],"letter":"手紙2〜3文",` +
    `"selected":[{"name":"団体名（候補から正確に）","category":"カテゴリ","ratio":0.6,"why":"理由40文字"}]}`;

  const judgeModel = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    tools: [{ googleSearch: {} }],
  });

  const res = await judgeModel.generateContent(prompt);
  const raw = res.response.text();
  const m   = raw.match(/\{[\s\S]*\}/);
  if (!m) return { error: 'Judgment parse failed' };

  let j;
  try { j = JSON.parse(m[0]); }
  catch { return { error: 'Judgment JSON invalid' }; }

  if (!j.triggered && !force) return { triggered: false, letter: j.letter };

  const letter      = j.letter || `${persona.name}の想いが、世界の動きと重なりました。`;
  const donateTotal = Math.max(1, Math.floor(balance * 0.10));
  const txResults   = [];

  for (const s of (j.selected || [])) {
    const amount = Math.floor(donateTotal * (s.ratio || 0.5));
    if (amount <= 0) continue;
    const partner = GLOBAL_PARTNERS.find(p => p.name === s.name)
      || GLOBAL_PARTNERS.find(p => p.category === s.category)
      || GLOBAL_PARTNERS[0];

    let txHash = null;
    if (wallet?.seed && wallet?.real) {
      try {
        const tx = await sendXRPFromWallet(wallet.seed, partner.wallet, amount, letter.slice(0, 100));
        txHash = tx.txHash;
        console.log(`[XRPL] ${amount} XRP → ${partner.name}: ${txHash}`);
      } catch (err) {
        console.error('[XRPL TX ERROR]', err.message);
      }
    }
    txResults.push({ name: partner.name, category: s.category, amount, why: s.why, txHash });
  }

  const newBalance = Math.max(0, balance - donateTotal);
  updateUserFn(userId, {
    xrplWallet: { ...(wallet || {}), balance: newBalance },
    donationHistory: [...(user.donationHistory || []), {
      at:           new Date().toISOString(),
      amount:       donateTotal,
      recipient:    txResults.map(r => r.name).join('、'),
      letter,
      news:         (j.news || []).slice(0, 2).join(' / '),
      transactions: txResults,
    }],
  });

  const newsLines = (j.news || []).map(n => `・${n}`).join('\n');
  const txLines   = txResults.map(r =>
    `  ${r.name}\n` +
    `  ${r.amount} XRP\n` +
    `  「${r.why}」\n` +
    `  ${r.txHash ? r.txHash.slice(0, 16) + '...' : 'デモ実行'}`
  ).join('\n\n');

  await pushFn(userId,
    `✉️ ${persona.name}の想いが届きました\n\n` +
    `「${letter}」\n\n` +
    `📰 きっかけ:\n${newsLines}\n\n` +
    `💸 届け先:\n${txLines}\n\n` +
    `合計 ${donateTotal} XRP / 残高 ${newBalance} XRP`
  );

  return { triggered: true, donated: donateTotal, newBalance, recipients: txResults };
}

module.exports = { runLineOpenClaw, executeDonationCycle };
