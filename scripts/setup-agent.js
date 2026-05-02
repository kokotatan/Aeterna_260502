const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

function main() {
    console.log("Generating Agent Wallet...");
    const wallet = ethers.Wallet.createRandom();
    
    console.log("==========================================");
    console.log("Agent Address:     ", wallet.address);
    console.log("Agent Private Key: ", wallet.privateKey);
    console.log("==========================================");
    
    // Append to .env automatically
    const envPath = path.join(__dirname, '..', '.env');
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    
    if (!envContent.includes('AGENT_ADDRESS')) {
        envContent += `\n# AgentKit Configuration\nAGENT_ADDRESS=${wallet.address}\nAGENT_PRIVATE_KEY=${wallet.privateKey}\n`;
        fs.writeFileSync(envPath, envContent);
        console.log("Added AGENT_ADDRESS and AGENT_PRIVATE_KEY to .env file automatically.");
    } else {
        console.log("AGENT_ADDRESS already exists in .env. Skipping automatic update.");
    }

    console.log("\nNext step: Register the agent using:");
    console.log(`npx @worldcoin/agentkit-cli register ${wallet.address}`);
}

main();
