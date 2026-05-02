const xrpl = require('xrpl');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const NETWORK = process.env.XRPL_NETWORK || 'wss://s.altnet.rippletest.net:51233';
const WALLET_FILE = path.join(__dirname, '../data/wallet.json');

async function getOrCreateWallet() {
  if (fs.existsSync(WALLET_FILE)) {
    const saved = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
    return xrpl.Wallet.fromSeed(saved.seed);
  }

  const client = new xrpl.Client(NETWORK);
  await client.connect();
  const { wallet } = await client.fundWallet();
  await client.disconnect();

  fs.writeFileSync(WALLET_FILE, JSON.stringify({
    seed: wallet.seed,
    address: wallet.address,
  }, null, 2));

  console.log(`[XRPL] New wallet created: ${wallet.address}`);
  return wallet;
}

async function sendXRP({ toAddress, amountXRP, memo, wallet: providedWallet }) {
  const client = new xrpl.Client(NETWORK);
  await client.connect();

  const wallet = providedWallet || await getOrCreateWallet();

  const payment = {
    TransactionType: 'Payment',
    Account: wallet.address,
    Amount: xrpl.xrpToDrops(amountXRP.toString()),
    Destination: toAddress,
    Memos: memo ? [{
      Memo: {
        MemoData: Buffer.from(memo, 'utf8').toString('hex').toUpperCase(),
        MemoType: Buffer.from('Aeterna/Reason', 'utf8').toString('hex').toUpperCase(),
      }
    }] : undefined,
  };

  const prepared = await client.autofill(payment);
  const signed = wallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);

  await client.disconnect();

  const txHash = result.result.hash;
  const explorerUrl = `https://testnet.xrpl.org/transactions/${txHash}`;

  return { txHash, explorerUrl, result };
}

module.exports = { sendXRP, getOrCreateWallet };

// 単体テスト
if (require.main === module) {
  (async () => {
    try {
      console.log('[TEST] Getting/creating wallet...');
      const wallet = await getOrCreateWallet();
      console.log(`[TEST] Wallet address: ${wallet.address}`);

      const testRecipient = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
      console.log(`[TEST] Sending 1 XRP to ${testRecipient}...`);
      const { txHash, explorerUrl } = await sendXRP({
        toAddress: testRecipient,
        amountXRP: 1,
        memo: 'Aeterna test transaction - persona judgment engine',
        wallet,
      });

      console.log(`[TEST] TX Hash: ${txHash}`);
      console.log(`[TEST] Explorer: ${explorerUrl}`);
    } catch (err) {
      console.error('[TEST ERROR]', err.message);
    }
  })();
}
