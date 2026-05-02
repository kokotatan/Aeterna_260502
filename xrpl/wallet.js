require('dotenv').config();
const xrpl = require('xrpl');

const XRPL_NETWORK = process.env.XRPL_NETWORK || 'wss://s.altnet.rippletest.net:51233';

// Curated global partner pool — Claude autonomously picks from these based on persona values.
// In production, wallets would be real. Here they are XRPL testnet addresses.
const GLOBAL_PARTNERS = [
  { name: 'Climate Emergency Fund',    category: '気候変動',             wallet: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', country: 'USA',           mission: '気候危機への直接行動に資金を提供' },
  { name: 'Rainforest Alliance',       category: '森林・生態系',          wallet: 'rN7n3473SaZBCG4dFL83w7PB5jCDVN7ka6', country: 'International', mission: '熱帯雨林と生物多様性の保護' },
  { name: 'GiveDirectly',             category: '貧困・直接支援',        wallet: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', country: 'Kenya/USA',     mission: '極貧困層への現金直接給付' },
  { name: 'Doctors Without Borders',  category: '医療・紛争',            wallet: 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59', country: 'International', mission: '紛争・災害地域の緊急医療支援' },
  { name: 'Khan Academy',             category: '教育・無償学習',        wallet: 'rPVMhWBsfF9iMXYj3aAzJVkPDTFNSyWdKy', country: 'USA',           mission: '世界中に無償の質の高い教育を' },
  { name: 'Wikipedia Foundation',     category: '知識・文化保存',        wallet: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', country: 'USA',           mission: '人類の知識を無償で保ち続ける' },
  { name: 'Ocean Conservancy',        category: '海洋保護',              wallet: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', country: 'USA',           mission: '海洋生態系と海岸線の保護' },
  { name: 'IRC (難民支援)',           category: '難民・人道支援',        wallet: 'rN7n3473SaZBCG4dFL83w7PB5jCDVN7ka6', country: 'International', mission: '難民・避難民への人道支援' },
  { name: 'Malala Fund',              category: '女性・教育',            wallet: 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59', country: 'International', mission: '女の子の教育を受ける権利を守る' },
  { name: 'Rainforest Trust',         category: '野生動物保護',          wallet: 'rPVMhWBsfF9iMXYj3aAzJVkPDTFNSyWdKy', country: 'USA',           mission: '絶滅危惧種の生息地を永久保護' },
  { name: 'Oxfam',                    category: '不平等・貧困',          wallet: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', country: 'International', mission: '不平等をなくし貧困を根絶する' },
  { name: 'Teach For All',            category: '教育格差',              wallet: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', country: 'International', mission: '世界中の子供に優れた教育機会を' },
  { name: 'MIT OpenCourseWare',       category: 'STEM・科学教育',        wallet: 'rN7n3473SaZBCG4dFL83w7PB5jCDVN7ka6', country: 'USA',           mission: 'MITの全講義コンテンツを世界に無償公開' },
  { name: 'Open Science Fund',        category: '科学研究・オープン化',  wallet: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', country: 'International', mission: '科学研究の成果を誰もが使えるように開放する' },
  { name: 'Thiel Foundation',         category: '若手研究者支援',        wallet: 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59', country: 'USA',           mission: '大学の枠を超えた若手イノベーターへの直接支援' },
  { name: 'Engineers Without Borders', category: '工学・途上国支援',     wallet: 'rPVMhWBsfF9iMXYj3aAzJVkPDTFNSyWdKy', country: 'International', mission: '工学の力で途上国のインフラ問題を解決する' },
];

async function createUserWallet() {
  try {
    const client = new xrpl.Client(XRPL_NETWORK);
    await client.connect();
    const { wallet } = await client.fundWallet();
    await client.disconnect();
    return { address: wallet.address, seed: wallet.seed, real: true, balance: 10 };
  } catch (err) {
    console.warn('[XRPL] Wallet creation failed, using demo mode:', err.message);
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz0123456789';
    const address = 'r' + Array.from({ length: 33 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return { address, seed: null, real: false, balance: 1000 };
  }
}

async function getXRPBalance(address) {
  try {
    const client = new xrpl.Client(XRPL_NETWORK);
    await client.connect();
    const res = await client.request({ command: 'account_info', account: address, ledger_index: 'validated' });
    await client.disconnect();
    return parseFloat(xrpl.dropsToXrp(res.result.account_data.Balance));
  } catch {
    return null;
  }
}

async function sendXRPFromWallet(fromSeed, toAddress, amountXRP, memo = '') {
  const client = new xrpl.Client(XRPL_NETWORK);
  await client.connect();
  try {
    const wallet = xrpl.Wallet.fromSeed(fromSeed);
    const payment = {
      TransactionType: 'Payment',
      Account: wallet.address,
      Destination: toAddress,
      Amount: xrpl.xrpToDrops(amountXRP.toFixed(6)),
    };
    if (memo) {
      payment.Memos = [{
        Memo: {
          MemoData: Buffer.from(memo, 'utf8').toString('hex').toUpperCase(),
          MemoType: Buffer.from('Aeterna/Will', 'utf8').toString('hex').toUpperCase(),
        },
      }];
    }
    const prepared = await client.autofill(payment);
    const signed = wallet.sign(prepared);
    const result = await client.submitAndWait(signed.tx_blob);
    return { success: true, txHash: result.result.hash, explorerUrl: `https://testnet.xrpl.org/transactions/${result.result.hash}` };
  } finally {
    await client.disconnect();
  }
}

module.exports = { createUserWallet, getXRPBalance, sendXRPFromWallet, GLOBAL_PARTNERS };
