/**
 * Aeterna testnet setup script
 * - Creates/loads the main sender wallet (faucet funded)
 * - Creates two recipient wallets (faucet funded, so any amount works)
 * - Updates data/persona.json with real testnet addresses
 */

const xrpl = require('xrpl');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const NETWORK = process.env.XRPL_NETWORK || 'wss://s.altnet.rippletest.net:51233';
const WALLET_FILE = path.join(__dirname, '../data/wallet.json');
const RECIPIENTS_FILE = path.join(__dirname, '../data/recipients-testnet.json');
const PERSONA_PATH = path.join(__dirname, '../data/persona.json');

async function setup() {
  console.log('[SETUP] Connecting to XRPL testnet...');
  const client = new xrpl.Client(NETWORK);
  await client.connect();

  // 1. Main sender wallet
  let senderWallet;
  if (fs.existsSync(WALLET_FILE)) {
    const saved = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
    senderWallet = xrpl.Wallet.fromSeed(saved.seed);
    console.log(`[SETUP] Loaded existing sender wallet: ${senderWallet.address}`);
  } else {
    console.log('[SETUP] Creating new sender wallet via faucet...');
    const { wallet } = await client.fundWallet();
    senderWallet = wallet;
    fs.writeFileSync(WALLET_FILE, JSON.stringify({ seed: wallet.seed, address: wallet.address }, null, 2));
    console.log(`[SETUP] Sender wallet created: ${senderWallet.address}`);
  }

  const senderBalance = await client.getXrpBalance(senderWallet.address);
  console.log(`[SETUP] Sender balance: ${senderBalance} XRP`);

  // 2. Recipient wallets (fund via faucet so they're already active)
  let recipients;
  if (fs.existsSync(RECIPIENTS_FILE)) {
    recipients = JSON.parse(fs.readFileSync(RECIPIENTS_FILE, 'utf8'));
    console.log('[SETUP] Loaded existing recipient wallets.');
  } else {
    console.log('[SETUP] Creating recipient wallets via faucet...');

    console.log('[SETUP]   Creating WWF Japan wallet...');
    const { wallet: wwf } = await client.fundWallet();

    console.log('[SETUP]   Creating 奨学金財団 wallet...');
    const { wallet: scholarship } = await client.fundWallet();

    recipients = [
      { name: 'WWF Japan', address: wwf.address, seed: wwf.seed },
      { name: '奨学金財団', address: scholarship.address, seed: scholarship.seed },
    ];
    fs.writeFileSync(RECIPIENTS_FILE, JSON.stringify(recipients, null, 2));
    console.log('[SETUP] Recipient wallets created and saved.');
  }

  // 3. Update persona.json with real addresses
  const persona = JSON.parse(fs.readFileSync(PERSONA_PATH, 'utf8'));
  persona.recipients[0].wallet = recipients[0].address;
  persona.recipients[1].wallet = recipients[1].address;
  fs.writeFileSync(PERSONA_PATH, JSON.stringify(persona, null, 2));

  await client.disconnect();

  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║         SETUP COMPLETE                   ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║ Sender:  ${senderWallet.address.slice(0, 34)} ║`);
  console.log(`║ Balance: ${senderBalance} XRP`);
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║ WWF Japan:  ${recipients[0].address.slice(0, 28)} ║`);
  console.log(`║ 奨学金財団: ${recipients[1].address.slice(0, 28)} ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('persona.json updated with real testnet addresses.');
  console.log('Next: node agent/index.js');
}

setup().catch(err => {
  console.error('[SETUP ERROR]', err.message);
  process.exit(1);
});
