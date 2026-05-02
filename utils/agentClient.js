const { createAgentkitClient } = require('@worldcoin/agentkit');
const { ethers } = require('ethers');

// Initialize the AgentKit Client
// Note: This requires AGENT_PRIVATE_KEY to be set in the environment variables
function initAgentClient() {
    const privateKey = process.env.AGENT_PRIVATE_KEY;
    if (!privateKey) {
        throw new Error("AGENT_PRIVATE_KEY is not set in environment variables.");
    }

    const wallet = new ethers.Wallet(privateKey);

    const agentkit = createAgentkitClient({
        signer: {
            address: wallet.address,
            chainId: 'eip155:8453', // Base network
            type: 'eip191',
            signMessage: (message) => wallet.signMessage(message),
        },
    });

    return agentkit;
}

module.exports = {
    initAgentClient
};
