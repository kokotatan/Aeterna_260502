const { transferUSDC, swapETHToUSDC, getWallet } = require('../agent/cryptoActions');

async function test() {
    try {
        const wallet = getWallet();
        console.log(`Testing with Agent Wallet: ${wallet.address}`);
        
        // Example logic:
        // const swapRes = await swapETHToUSDC("0.001");
        // console.log("Swap Result:", swapRes);
        // 
        // const transferRes = await transferUSDC("0xRecipientAddress", "10");
        // console.log("Transfer Result:", transferRes);
        
        console.log("Crypto Actions loaded successfully. Ensure wallet has Base ETH and USDC to execute actual transactions.");
    } catch (e) {
        console.error("Test setup failed:", e);
    }
}

test();
