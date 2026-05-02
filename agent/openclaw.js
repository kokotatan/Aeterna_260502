/**
 * Aeterna — OpenClaw Agent Mode
 *
 * This module enables OpenClaw (Claude Code) to drive the Aeterna agent
 * directly, without requiring a separate node-cron process.
 *
 * Usage (from Claude Code / OpenClaw):
 *   node agent/openclaw.js
 *
 * Or via API trigger (when agent/index.js is running):
 *   curl -X POST http://localhost:3001/api/trigger
 *
 * OpenClaw reads SKILL.md and orchestrates the full cycle:
 *   1. Load persona
 *   2. Fetch world news (via web_fetch tool)
 *   3. Judge based on persona values
 *   4. Execute XRPL transfer if triggered
 *   5. Log result
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { runJudgment } = require('./judge');
const { sendXRP, getOrCreateWallet } = require('../xrpl/send');

const LOG_PATH = path.join(__dirname, '../logs/log.json');
const PERSONA_PATH = path.join(__dirname, '../data/persona.json');

function readLog() {
  try { return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')); }
  catch { return []; }
}

function appendLog(entry) {
  const logs = readLog();
  logs.push(entry);
  fs.writeFileSync(LOG_PATH, JSON.stringify(logs, null, 2));
}

async function runOpenClawCycle() {
  const persona = JSON.parse(fs.readFileSync(PERSONA_PATH, 'utf8'));

  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║        AETERNA — OpenClaw Agent Mode         ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Persona: ${persona.name}`);
  console.log(`Values:  ${persona.values}`);
  console.log(`Watch:   ${persona.trigger_keywords.join(', ')}`);
  console.log('');

  const logEntry = {
    timestamp: new Date().toISOString(),
    mode: 'openclaw',
    triggered: false,
    transactions: [],
    reason: '',
    error: null,
  };

  try {
    console.log('[OpenClaw] Invoking Claude judgment engine...');
    const judgment = await runJudgment();

    console.log('');
    console.log(`Triggered:        ${judgment.triggered ? '✅ YES' : '❌ NO'}`);
    console.log(`Keywords found:   ${(judgment.keywords_found || []).join(', ') || 'none'}`);
    console.log(`Reason (persona): ${judgment.reason}`);
    console.log('');

    logEntry.triggered = judgment.triggered;
    logEntry.reason = judgment.reason;
    logEntry.keywords_found = judgment.keywords_found || [];

    if (judgment.triggered && judgment.recipients?.length > 0) {
      const wallet = await getOrCreateWallet();
      const transactions = [];

      console.log('[OpenClaw] Executing XRPL transfers...');

      for (const r of judgment.recipients) {
        try {
          const { txHash, explorerUrl } = await sendXRP({
            toAddress: r.wallet,
            amountXRP: r.amount_xrp,
            memo: judgment.reason,
            wallet,
          });

          console.log(`  → ${r.name}: ${r.amount_xrp} XRP`);
          console.log(`    TX:  ${txHash}`);
          console.log(`    URL: ${explorerUrl}`);

          transactions.push({ recipient: r.name, wallet: r.wallet, amount_xrp: r.amount_xrp, txHash, explorerUrl });
        } catch (err) {
          console.error(`  ✗ ${r.name}: ${err.message}`);
          transactions.push({ recipient: r.name, error: err.message });
        }
      }

      logEntry.transactions = transactions;

      // Update last_triggered
      persona.last_triggered = new Date().toISOString();
      fs.writeFileSync(PERSONA_PATH, JSON.stringify(persona, null, 2));

      console.log('');
      console.log('╔══════════════════════════════════════════════╗');
      console.log('║   意志の執行完了 — Will Executed              ║');
      console.log('╚══════════════════════════════════════════════╝');
    } else {
      console.log('[OpenClaw] No trigger condition met. Will continues to watch.');
    }
  } catch (err) {
    console.error('[OpenClaw] Error:', err.message);
    logEntry.error = err.message;
  }

  appendLog(logEntry);

  console.log('');
  console.log(`[OpenClaw] Log written to logs/log.json`);
  return logEntry;
}

// Run immediately when invoked
runOpenClawCycle().catch(console.error);

module.exports = { runOpenClawCycle };
