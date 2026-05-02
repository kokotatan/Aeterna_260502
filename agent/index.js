const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { runJudgment } = require('./judge');
const { sendXRP, getOrCreateWallet } = require('../xrpl/send');
const { executeDonationCycle } = require('./line-openclaw');

const LOG_PATH   = path.join(__dirname, '../logs/log.json');
const PERSONA_PATH = path.join(__dirname, '../data/persona.json');
const USERS_PATH = path.join(__dirname, '../data/users.json');

// ─── LINE push helper (for autonomous notifications) ──────────────────
const line = require('@line/bot-sdk');
const lineClient = process.env.LINE_CHANNEL_ACCESS_TOKEN
  ? new line.messagingApi.MessagingApiClient({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN })
  : null;

function pushToLINE(userId, text, quickReplies = []) {
  const message = { type: 'text', text };
  if (quickReplies.length) {
    message.quickReply = {
      items: quickReplies.map(l => ({
        type: 'action',
        action: { type: 'message', label: l.slice(0, 20), text: l },
      })),
    };
  }
  if (lineClient) return lineClient.pushMessage({ to: userId, messages: [message] });
  console.log(`[LINE PUSH] ${userId.slice(0, 8)}: ${text.slice(0, 80)}`);
  return Promise.resolve();
}

// ─── users.json helpers ───────────────────────────────────────────────
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')); }
  catch { return {}; }
}

function patchUser(userId, data) {
  const users = loadUsers();
  users[userId] = { ...(users[userId] || {}), ...data };
  fs.mkdirSync(path.dirname(USERS_PATH), { recursive: true });
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
}

// ─── Per-user autonomous donation cycles ─────────────────────────────
const USER_COOLDOWN_MINUTES = 60;
let isUserCycleRunning = false;

async function runAllUserDonationCycles() {
  if (isUserCycleRunning) return;
  isUserCycleRunning = true;
  try {
    const users = loadUsers();
    const registered = Object.entries(users).filter(([, u]) => u.state === 'registered');
    if (registered.length === 0) return;

    console.log(`\n[USER CYCLE] Checking ${registered.length} registered souls...`);

    for (const [userId, user] of registered) {
      // Cooldown guard
      const lastEntry = (user.donationHistory || []).at(-1);
      if (lastEntry) {
        const elapsed = (Date.now() - new Date(lastEntry.at).getTime()) / 60000;
        if (elapsed < USER_COOLDOWN_MINUTES) {
          console.log(`[USER CYCLE] ${user.persona?.name || userId.slice(0, 8)}: cooldown (${Math.round(elapsed)}min)`);
          continue;
        }
      }

      const balance = user.xrplWallet?.balance ?? 0;
      if (balance <= 0) {
        console.log(`[USER CYCLE] ${user.persona?.name}: no balance, skipping`);
        continue;
      }

      console.log(`[USER CYCLE] Running cycle for ${user.persona?.name}...`);
      try {
        // Snapshot user so executeDonationCycle can mutate the local copy
        const userSnapshot = JSON.parse(JSON.stringify(user, (k, v) => k === 'seed' ? '[hidden]' : v));
        userSnapshot.xrplWallet = user.xrplWallet; // restore seed for actual transfer

        const result = await executeDonationCycle(userId, userSnapshot, false, {
          updateUserFn: (id, data) => {
            patchUser(id, data);
            Object.assign(user, data);
          },
          pushFn: pushToLINE,
        });

        const label = user.persona?.name || userId.slice(0, 8);
        if (result.triggered) {
          console.log(`[USER CYCLE] ✓ ${label}: donated ${result.donated} XRP`);
          appendLog({
            timestamp: new Date().toISOString(),
            userId: userId.slice(0, 8),
            persona: label,
            triggered: true,
            donated: result.donated,
          });
        } else {
          console.log(`[USER CYCLE] ${label}: not triggered`);
        }
      } catch (err) {
        console.error(`[USER CYCLE] Error for ${userId.slice(0, 8)}:`, err.message);
      }
    }
  } finally {
    isUserCycleRunning = false;
  }
}

let isRunning = false;
let agentStatus = 'idle';
let lastResult = null;

function readLog() {
  try {
    return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function appendLog(entry) {
  const logs = readLog();
  logs.push(entry);
  fs.writeFileSync(LOG_PATH, JSON.stringify(logs, null, 2));
}

function updatePersonaLastTriggered() {
  const persona = JSON.parse(fs.readFileSync(PERSONA_PATH, 'utf8'));
  persona.last_triggered = new Date().toISOString();
  fs.writeFileSync(PERSONA_PATH, JSON.stringify(persona, null, 2));
}

async function runAgentCycle() {
  if (isRunning) {
    console.log('[AGENT] Cycle skipped (previous still running)');
    return lastResult;
  }

  isRunning = true;
  agentStatus = 'running';
  const cycleStart = new Date().toISOString();
  console.log(`\n[AGENT] ====== Cycle started at ${cycleStart} ======`);

  const logEntry = {
    timestamp: cycleStart,
    triggered: false,
    transactions: [],
    reason: '',
    error: null,
  };

  try {
    // Step 1: Claude判断
    console.log('[AGENT] Running Claude judgment...');
    const judgment = await runJudgment();
    const letter = judgment.letter || judgment.reason || '';
    console.log(`[AGENT] Judgment: triggered=${judgment.triggered}`);
    console.log(`[AGENT] Letter: ${letter.slice(0, 80)}`);

    if (judgment.keywords_found?.length) {
      console.log(`[AGENT] Keywords detected: ${judgment.keywords_found.join(', ')}`);
    }

    logEntry.triggered = judgment.triggered;
    logEntry.letter = letter;
    logEntry.keywords_found = judgment.keywords_found || [];
    logEntry.claude_usage = judgment.usage;

    if (judgment.triggered && judgment.recipients?.length > 0) {
      console.log('\n[AGENT] *** TRIGGER ACTIVATED ***');
      console.log('[AGENT] Initiating XRPL transfers...');

      const wallet = await getOrCreateWallet();
      const transactions = [];

      for (const recipient of judgment.recipients) {
        try {
          console.log(`[AGENT] Sending ${recipient.amount_xrp} XRP to ${recipient.name}...`);
          const { txHash, explorerUrl } = await sendXRP({
            toAddress: recipient.wallet,
            amountXRP: recipient.amount_xrp,
            memo: letter.slice(0, 100),
            wallet,
          });

          console.log(`[AGENT] ✓ TX sent! Hash: ${txHash}`);
          console.log(`[AGENT] ✓ Explorer: ${explorerUrl}`);

          transactions.push({
            recipient: recipient.name,
            wallet: recipient.wallet,
            amount_xrp: recipient.amount_xrp,
            txHash,
            explorerUrl,
          });
        } catch (txErr) {
          console.error(`[AGENT] TX failed for ${recipient.name}: ${txErr.message}`);
          transactions.push({
            recipient: recipient.name,
            wallet: recipient.wallet,
            amount_xrp: recipient.amount_xrp,
            error: txErr.message,
          });
        }
      }

      logEntry.transactions = transactions;
      updatePersonaLastTriggered();

      // デモ出力
      console.log('\n╔══════════════════════════════════════╗');
      console.log('║   AETERNA — 意志の実行完了            ║');
      console.log('╠══════════════════════════════════════╣');
      console.log(`║ 「${letter.slice(0, 28)}...」`);
      for (const tx of transactions) {
        if (tx.txHash) {
          console.log(`║ → ${tx.recipient}: ${tx.amount_xrp} XRP`);
          console.log(`║   TX: ${tx.txHash.slice(0, 20)}...`);
        }
      }
      console.log('╚══════════════════════════════════════╝\n');
    } else {
      console.log('[AGENT] No trigger — monitoring continues.');
    }
  } catch (err) {
    console.error('[AGENT] Cycle error:', err.message);
    logEntry.error = err.message;
  } finally {
    appendLog(logEntry);
    lastResult = logEntry;
    isRunning = false;
    agentStatus = 'idle';
    console.log(`[AGENT] Cycle complete.`);
    return logEntry;
  }
}

function getStatus() {
  return { status: agentStatus, isRunning, lastResult };
}

// Express APIサーバー
const express = require('express');
const app = express();
app.use(express.json());

const cors = require('cors');
try {
  app.use(cors());
} catch {
  // cors not installed — skip
}

app.get('/api/persona', (req, res) => {
  try {
    const persona = JSON.parse(fs.readFileSync(PERSONA_PATH, 'utf8'));
    res.json(persona);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logs', (req, res) => {
  res.json(readLog());
});

app.post('/api/trigger', async (req, res) => {
  console.log('[API] Manual trigger requested');
  try {
    const result = await runAgentCycle();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json(getStatus());
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[API] Express server running on http://localhost:${PORT}`);
});

// 自律ループ
console.log('[AGENT] Aeterna autonomous agent starting...');
console.log('[AGENT] Global cycle: every 30s | User donation cycles: every 5min');
console.log('[AGENT] API: http://localhost:' + PORT + '/api/status');

// 初回即時実行
runAgentCycle();
setTimeout(runAllUserDonationCycles, 5000); // 5秒後に初回ユーザーサイクル

// グローバルペルソナ: 30秒ごと
cron.schedule('*/30 * * * * *', () => {
  runAgentCycle();
});

// 登録ユーザー全員: 5分ごと
cron.schedule('*/5 * * * *', () => {
  runAllUserDonationCycles();
});

module.exports = { getStatus };
