const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { runJudgment } = require('./judge');
const { sendXRP, getOrCreateWallet } = require('../xrpl/send');

const LOG_PATH = path.join(__dirname, '../logs/log.json');
const PERSONA_PATH = path.join(__dirname, '../data/persona.json');

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
    return;
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
    console.log(`[AGENT] Judgment: triggered=${judgment.triggered}`);
    console.log(`[AGENT] Reason: ${judgment.reason}`);

    if (judgment.keywords_found?.length) {
      console.log(`[AGENT] Keywords detected: ${judgment.keywords_found.join(', ')}`);
    }

    logEntry.triggered = judgment.triggered;
    logEntry.reason = judgment.reason;
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
            memo: judgment.reason,
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
      console.log(`║ 判断理由: ${judgment.reason.slice(0, 30)}...`);
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
  // 非同期で実行、即座にレスポンス
  runAgentCycle().catch(console.error);
  res.json({ message: 'Agent cycle triggered', status: 'running' });
});

app.get('/api/status', (req, res) => {
  res.json(getStatus());
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[API] Express server running on http://localhost:${PORT}`);
});

// 自律ループ: 30秒ごと
console.log('[AGENT] Aeterna autonomous agent starting...');
console.log('[AGENT] Will monitor world events every 30 seconds.');
console.log('[AGENT] API endpoints: http://localhost:' + PORT + '/api/status');

// 初回即時実行
runAgentCycle();

// 以後30秒ごと
cron.schedule('*/30 * * * * *', () => {
  runAgentCycle();
});

module.exports = { getStatus };
