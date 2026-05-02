const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PERSONA_PATH = path.join(__dirname, '../data/persona.json');

function loadPersona() {
  return JSON.parse(fs.readFileSync(PERSONA_PATH, 'utf8'));
}

async function fetchRelevantNews(keywords) {
  const query = keywords.slice(0, 4).join(' OR ');

  // Gemini Google Search grounding（最優先）
  if (process.env.GEMINI_API_KEY) {
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.0-flash',
        tools: [{ googleSearch: {} }],
      });
      const searchPrompt =
        `以下のキーワードに関連する最新ニュースを5件、日本語で箇条書きにしてください。\n` +
        `キーワード: ${query}\n` +
        `形式: 「・[見出し]: [概要1〜2文]」`;
      const result = await model.generateContent(searchPrompt);
      const text = result.response.text().trim();
      if (text && text.length > 50) {
        console.log('[JUDGE] News fetched via Gemini Google Search grounding');
        return text;
      }
    } catch (err) {
      console.warn('[JUDGE] Gemini search unavailable:', err.message);
    }
  }

  // NewsAPI（フォールバック）
  if (process.env.NEWS_API_KEY && process.env.NEWS_API_KEY !== 'your_newsapi_key_here') {
    try {
      const res = await axios.get('https://newsapi.org/v2/everything', {
        params: {
          q: query,
          language: 'en',
          sortBy: 'publishedAt',
          pageSize: 5,
          apiKey: process.env.NEWS_API_KEY,
        },
        timeout: 5000,
      });
      const articles = res.data.articles || [];
      if (articles.length > 0) {
        console.log('[JUDGE] News fetched via NewsAPI');
        return articles.map(a => `・${a.title}: ${a.description || ''}`).join('\n');
      }
    } catch (err) {
      console.warn('[JUDGE] NewsAPI unavailable, using demo news.');
    }
  }

  // デモ用フォールバック
  console.log('[JUDGE] Using demo news (no search API configured)');
  return [
    '・Bangladesh floods: Sea levels rising 3mm per year accelerating coastal erosion',
    '・Climate Summit 2026: Scientists warn global warming on track for 2.8°C by century end',
    '・Pacific Islands face existential threat as ocean temperatures hit record high',
    '・海面上昇により沿岸都市が水没リスク増大、国連が緊急警告を発令',
    '・気候変動による農業被害、世界食料安保に深刻な影響と国際機関報告',
  ].join('\n');
}

async function runJudgment() {
  const persona = loadPersona();

  if (persona.status !== 'active') {
    return { triggered: false, reason: 'Persona is not active.', recipients: [] };
  }

  // クールダウンチェック
  if (persona.last_triggered) {
    const lastTime = new Date(persona.last_triggered);
    const minutesSince = (Date.now() - lastTime.getTime()) / 60000;
    if (minutesSince < (persona.cooldown_minutes || 60)) {
      return {
        triggered: false,
        reason: `Cooldown active (${Math.round(minutesSince)}min elapsed / ${persona.cooldown_minutes}min required).`,
        recipients: [],
      };
    }
  }

  const newsText = await fetchRelevantNews(persona.trigger_keywords);

  // 送金額を事前計算（Claudeに計算させない）
  const recipientsWithAmounts = persona.recipients.map(r => ({
    name: r.name,
    wallet: r.wallet,
    amount_xrp: parseFloat((r.ratio * persona.total_xrp).toFixed(2)),
    cause: r.cause,
  }));

  const wishesBlock = (persona.unfinished_wishes || []).length
    ? `果たせなかった想い:\n${persona.unfinished_wishes.map(w => `  ・${w}`).join('\n')}`
    : '';

  const systemPrompt = `あなたは「${persona.name}」という故人の遺志を実行するAIエージェントです。

【生涯】${persona.biography || ''}

【価値観】${(persona.values || []).join('・')}

【語り口】${persona.voice_style || '穏やかで深い言葉遣い。感情を情景に託す。'}

【言葉・口癖】${(persona.memorable_phrases || []).join(' / ')}

${wishesBlock}

【トリガー条件】${persona.trigger_condition}
【トリガーキーワード】${persona.trigger_keywords.join(', ')}

あなたのタスクは「トリガー判断」と「手紙の生成」です：
- ニュースにトリガーキーワードが含まれるか確認する
- その出来事が価値観・果たせなかった想いに照らして重大かどうか判断する
- triggered: true または false を返す
- letterフィールドに${persona.name}の語り口で書いた2〜3文の手紙を生成する
  （世界の動きと、その方が生涯果たせなかった想いを結びつける言葉で）
- 送金額の計算は不要（既に計算済み）

必ず有効なJSONのみを返す（説明文一切不要）。`;

  const userMessage = `本日のニュース:\n${newsText}

上記ニュースを分析し、以下のJSON形式のみで回答してください：
{
  "triggered": true または false,
  "letter": "${persona.name}の声で書いた手紙2〜3文（果たせなかった想いと世界の動きを結びつける）",
  "keywords_found": ["ニュース中で検出したキーワード"]
}`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    cache_control: { type: 'ephemeral' },
  });

  const text = response.content.find(b => b.type === 'text')?.text || '{}';

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Claude returned non-JSON: ${text}`);
  }

  const result = JSON.parse(jsonMatch[0]);

  result.recipients = result.triggered ? recipientsWithAmounts : [];
  result.usage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cache_read_input_tokens: response.usage.cache_read_input_tokens || 0,
  };

  return result;
}

module.exports = { runJudgment };

if (require.main === module) {
  (async () => {
    try {
      console.log('[TEST] Running judgment engine...');
      const result = await runJudgment();
      console.log('[TEST] Result:', JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('[TEST ERROR]', err.message);
    }
  })();
}
