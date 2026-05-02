const cryptoActions = require('../cryptoActions');

const transferUSDCTool = {
    name: "transfer_usdc",
    description: "Transfer USDC to a specified blockchain address. Used when the user wants to send money or distribute inheritance.",
    input_schema: {
        type: "object",
        properties: {
            toAddress: {
                type: "string",
                description: "The recipient's EVM address (starts with 0x)"
            },
            amount: {
                type: "string",
                description: "The amount of USDC to send (e.g., '10.5')"
            }
        },
        required: ["toAddress", "amount"]
    },
    execute: async (args) => {
        const result = await cryptoActions.transferUSDC(args.toAddress, args.amount);
        if (result.success) {
            return `Successfully transferred ${args.amount} USDC to ${args.toAddress}. Transaction Hash: ${result.txHash}`;
        } else {
            return `Failed to transfer USDC: ${result.error}`;
        }
    }
};

const swapETHToUSDCTool = {
    name: "swap_eth_to_usdc",
    description: "Swaps native ETH for USDC using Uniswap V3. Used when the user wants to convert or exchange assets to stablecoins.",
    input_schema: {
        type: "object",
        properties: {
            amountEth: {
                type: "string",
                description: "The amount of ETH to swap (e.g., '0.01')"
            }
        },
        required: ["amountEth"]
    },
    execute: async (args) => {
        const result = await cryptoActions.swapETHToUSDC(args.amountEth);
        if (result.success) {
            return `Successfully swapped ${args.amountEth} ETH for USDC. Transaction Hash: ${result.txHash}`;
        } else {
            return `Failed to swap ETH to USDC: ${result.error}`;
        }
    }
};

module.exports = {
    tools: [transferUSDCTool, swapETHToUSDCTool]
};
