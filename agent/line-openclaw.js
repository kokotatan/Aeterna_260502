'use strict';

require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createUserWallet, getXRPBalance, sendXRPFromWallet, GLOBAL_PARTNERS } = require('../xrpl/wallet');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─── Discovery questions ──────────────────────────────────────────────
const QUESTIONS = [
  { key: 'name',             ask: 'はじめまして！まず、お名前を教えてください。' },
  { key: 'pride',            ask: '素敵なお名前ですね。\n\n人生で一番誇りに思う出来事や、大切な記憶を教えてください。' },
  { key: 'philosophy',       ask: 'ありがとうございます。\n\n大切にしている言葉や、人生の信念はありますか？' },
  { key: 'concern',          ask: 'その言葉、心に響きます。\n\n今の世の中で、一番心配していることは何ですか？', qr: ['戦争・紛争', '環境・気候変動', '貧困・格差', '子どもの未来'] },
  { key: 'legacy',           ask: 'なるほど。\n\n将来の世代に残したいもの、伝えたいことは何ですか？' },
  { key: 'amount',           ask: '素晴らしい想いですね。\n\nAeterna を通じて遺贈する金額（XRP）はどのくらいをお考えですか？', qr: ['10 XRP', '50 XRP', '100 XRP', '500 XRP'] },
  { key: 'trigger',          ask: 'ありがとうございます。\n\nどんな出来事が起きたときに、その想いを実行しますか？', qr: ['戦争が起きたら', '大規模な自然災害', 'AIが人間を超えたら', '貧困率が上がったら'] },
];

// ─── Main Entry Point ─────────────────────────────────────────────────
async function runLineOpenClaw(userId, userText, currentUser, { updateUserFn, pushFn, baseUrl }) {
  const state  = currentUser.state  || 'none';
  const step   = currentUser.discoveryStep ?? 0;
  const answers = currentUser.discoveryAnswers || {};

  console.log(`[LINE] state=${state} step=${step} msg="${userText.slice(0, 30)}"`);

  // ── state: none ────────────────────────────────────────────────────
  if (state === 'none') {
    if (userText.includes('始める') || userText.includes('はじめる') || userText.includes('start')) {
      updateUserFn(userId, { state: 'discovering', discoveryStep: 0, discoveryAnswers: {} });
      return { replyText: QUESTIONS[0].ask };
    }
    return {
      replyText:
        'こんにちは。私はAeterna（エターナ）です。\n\n' +
        'あなたの価値観・想いを受け継ぎ、来るべき日に世界へ届けるAIエージェントです。\n\n' +
        '「始める」と送ると、あなたの分身AIを作り始めます。',
    };
  }

  // ── state: discovering ────────────────────────────────────────────
  if (state === 'discovering') {
    const newAnswers = { ...answers, [QUESTIONS[step].key]: userText };
    const nextStep   = step + 1;

    if (nextStep < QUESTIONS.length) {
      updateUserFn(userId, { discoveryStep: nextStep, discoveryAnswers: newAnswers });
      const q = QUESTIONS[nextStep];
      return { replyText: q.ask, quickReplies: q.qr || [] };
    }

    // All questions answered → build persona & create wallet
    const persona = buildPersona(newAnswers);
    updateUserFn(userId, {
      state: 'wallet_pending',
      discoveryStep: nextStep,
      discoveryAnswers: newAnswers,
      persona,
    });

    let walletInfo = '（デモ）';
    try {
      const wallet = await createUserWallet();
      updateUserFn(userId, { xrplWallet: wallet });
      walletInfo = wallet.address;
    } catch (e) {
      console.error('[WALLET]', e.message);
    }

    await pushFn(userId,
      `🌟 ${persona.name}さんの分身AIを作成しました。\n\n` +
      `📋 あなたの想い:\n` +
      `・価値観: ${persona.values.join('・')}\n` +
      `・遺産: ${persona.total_xrp} XRP\n` +
      `・トリガー: ${persona.trigger_condition}\n\n` +
      `💼 XRPLウォレットアドレス:\n${walletInfo}\n\n` +
      `上記アドレスに XRP を入金後、「入金完了」を送ってください。`,
      ['入金完了']
    );

    return { replyText: `${persona.name}さんの分身AIを作っています…\n\n少々お待ちください。` };
  }

  // ── state: wallet_pending ─────────────────────────────────────────
  if (state === 'wallet_pending') {
    if (/入金完了|完了|done/i.test(userText)) {
      updateUserFn(userId, { state: 'persona_review' });
      const p = currentUser.persona || {};
      await pushFn(userId,
        `「${p.memorable_phrases?.[0] || p.philosophy || '想いは続く'}」\n\n` +
        `— ${p.name}の分身より`,
        ['登録する ✅', '最初から 🔄']
      );
      return {
        replyText:
          `入金を確認しました。\n\n` +
          `あなたの分身AIの内容を確認してください。\n` +
          `よければ「登録する」で永遠の遺志が完成します。`,
      };
    }
    return {
      replyText:
        `XRPLウォレットへの入金後、「入金完了」と送ってください。\n\n` +
        `入金先: ${currentUser.xrplWallet?.address || '（ウォレット作成中）'}`,
      quickReplies: ['入金完了'],
    };
  }

  // ── state: persona_review ─────────────────────────────────────────
  if (state === 'persona_review') {
    if (/登録|はい|yes|✅/i.test(userText)) {
      updateUserFn(userId, { state: 'registered', registeredAt: new Date().toISOString(), donationHistory: [] });
      return {
        replyText:
          `✅ 登録完了しました！\n\n` +
          `あなたの遺志はAeterna が永遠に守ります。\n\n` +
          `使えるコマンド:\n` +
          `💰「残高」\n📊「ステータス」\n🚀「デモ実行」\n💸「送金 [アドレス] [金額]」`,
      };
    }
    if (/最初から|リセット|🔄/i.test(userText)) {
      updateUserFn(userId, { state: 'none', persona: null, xrplWallet: null, discoveryStep: 0, discoveryAnswers: {} });
      return { replyText: 'リセットしました。最初からやり直します。\n\n「始める」と送ってください。' };
    }
    return {
      replyText: '「登録する ✅」で完了、「最初から 🔄」でやり直せます。',
      quickReplies: ['登録する ✅', '最初から 🔄'],
    };
  }

  // ── state: registered ────────────────────────────────────────────
  if (state === 'registered') {
    const p = currentUser.persona || {};
    const w = currentUser.xrplWallet || {};

    if (/残高/.test(userText)) {
      let balance = w.balance ?? 0;
      if (w.address && w.real) {
        try { balance = (await getXRPBalance(w.address)) ?? balance; } catch {}
      }
      return { replyText: `💰 現在の残高: ${balance} XRP\n\nウォレット: ${w.address || '—'}` };
    }

    if (/ステータス/.test(userText)) {
      const history = currentUser.donationHistory || [];
      const total   = history.reduce((s, h) => s + (h.amount || 0), 0);
      return {
        replyText:
          `📊 ${p.name || 'あなた'}のステータス\n\n` +
          `残高: ${w.balance ?? 0} XRP\n` +
          `累計寄付: ${total} XRP（${history.length}回）\n` +
          `トリガー: ${p.trigger_condition || '—'}\n` +
          `登録日: ${currentUser.registeredAt?.slice(0, 10) || '—'}`,
      };
    }

    if (/履歴/.test(userText)) {
      const history = (currentUser.donationHistory || []).slice(-5);
      if (!history.length) return { replyText: '📋 まだ実行履歴はありません。' };
      const lines = history.map(h => `・${h.at?.slice(0, 10)} ${h.amount}XRP → ${h.recipient}`).join('\n');
      return { replyText: `📋 直近の寄付履歴:\n\n${lines}` };
    }

    if (/デモ実行|実行/.test(userText)) {
      const cycleResult = await executeDonationCycle(userId, currentUser, true, { updateUserFn, pushFn });
      if (cycleResult.error) return { replyText: `エラー: ${cycleResult.error}` };
      return { replyText: `🚀 実行完了！詳細は上のメッセージをご確認ください。` };
    }

    if (/認証|World\s?ID/i.test(userText)) {
      return {
        replyText:
          `🔐 World ID 本人確認\n\n` +
          `以下のリンクを開いて認証してください:\n` +
          `${baseUrl || process.env.BASE_URL}/line-verify.html?user=${userId}`,
      };
    }

    if (/リセット/.test(userText)) {
      updateUserFn(userId, { state: 'none', persona: null, xrplWallet: null, discoveryStep: 0, discoveryAnswers: {} });
      return { replyText: 'リセットしました。「始める」で再登録できます。' };
    }

    // 送金コマンド: 「送金 rXXX 10」
    const sendMatch = userText.match(/送金\s+([rR][A-Za-z0-9]{20,})\s+([\d.]+)/);
    if (sendMatch) {
      const [, toAddr, amtStr] = sendMatch;
      const amount = parseFloat(amtStr);
      if (!w) return { replyText: 'ウォレットが登録されていません。' };
      try {
        let txHash, mode;
        if (w.seed && w.real) {
          const tx = await sendXRPFromWallet(w.seed, toAddr, amount, 'LINE送金');
          txHash = tx.txHash; mode = 'live';
        } else {
          txHash = 'DEMO' + Math.random().toString(36).substring(2, 10).toUpperCase(); mode = 'demo';
        }
        const newBal = Math.max(0, (w.balance ?? 0) - amount);
        updateUserFn(userId, { xrplWallet: { ...w, balance: newBal } });
        return {
          replyText:
            `💸 送金完了（${mode}）\n\n` +
            `送金先: ${toAddr.slice(0, 12)}...\n` +
            `金額: ${amount} XRP\n` +
            `TX: ${txHash.slice(0, 16)}...\n` +
            `残高: ${newBal} XRP`,
        };
      } catch (e) {
        return { replyText: `送金エラー: ${e.message}` };
      }
    }

    // デジタルツイン返答
    return {
      replyText:
        `「${p.memorable_phrases?.[0] || p.philosophy || '大切なものを守り続けなさい'}」\n\n` +
        `— ${p.name || 'あなた'}の分身より\n\n` +
        `（コマンド: 残高 / ステータス / 履歴 / デモ実行）`,
      quickReplies: ['残高', 'ステータス', 'デモ実行'],
    };
  }

  return { replyText: 'こんにちは。「始める」と送ってください。' };
}

// ─── Persona builder ──────────────────────────────────────────────────
function buildPersona(answers) {
  return {
    name:                answers.name        || 'あなた',
    personality_summary: answers.pride       || '',
    philosophy:          answers.philosophy  || '',
    voice_style:         'warm',
    values:              [answers.concern, answers.legacy].filter(Boolean),
    memorable_phrases:   [answers.philosophy].filter(Boolean),
    interests:           [],
    trigger_condition:   answers.trigger     || '—',
    trigger_keywords:    [],
    total_xrp:           parseFloat(answers.amount) || 10,
  };
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

  const letter     = j.letter || `${persona.name}の想いが、世界の動きと重なりました。`;
  const donateTotal = Math.max(1, Math.floor(balance * 0.10));
  const txResults  = [];

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
