require('dotenv').config();
const { ethers } = require('ethers');

// Base Mainnet RPC
const RPC_URL = 'https://mainnet.base.org';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const UNISWAP_V3_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';

const ERC20_ABI = [
    "function transfer(address to, uint256 amount) external returns (bool)",
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function balanceOf(address account) external view returns (uint256)",
    "function decimals() external view returns (uint8)"
];

const UNISWAP_V3_ABI = [
    "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
];

function getWallet() {
    if (!process.env.AGENT_PRIVATE_KEY) throw new Error("AGENT_PRIVATE_KEY not set");
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    return new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);
}

/**
 * Transfers USDC to a specified address
 * @param {string} toAddress - The recipient address
 * @param {string} amountStr - The amount in USDC (e.g. "10.5")
 */
async function transferUSDC(toAddress, amountStr) {
    try {
        const wallet = getWallet();
        const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
        
        // USDC has 6 decimals on Base
        const amount = ethers.parseUnits(amountStr, 6);
        
        const balance = await usdc.balanceOf(wallet.address);
        if (balance < amount) {
            return { success: false, error: "Insufficient USDC balance" };
        }

        console.log(`Transferring ${amountStr} USDC to ${toAddress}...`);
        const tx = await usdc.transfer(toAddress, amount);
        const receipt = await tx.wait();
        
        return { success: true, txHash: receipt.hash };
    } catch (error) {
        console.error("Transfer error:", error);
        return { success: false, error: error.message };
    }
}

/**
 * Swaps native ETH for USDC using Uniswap V3
 * @param {string} ethAmountStr - Amount of ETH to swap (e.g. "0.01")
 */
async function swapETHToUSDC(ethAmountStr) {
    try {
        const wallet = getWallet();
        const router = new ethers.Contract(UNISWAP_V3_ROUTER, UNISWAP_V3_ABI, wallet);
        
        const amountIn = ethers.parseEther(ethAmountStr);
        const deadline = Math.floor(Date.now() / 1000) + 60 * 10; // 10 minutes
        
        const params = {
            tokenIn: WETH_ADDRESS,
            tokenOut: USDC_ADDRESS,
            fee: 500, // 0.05% pool fee tier
            recipient: wallet.address,
            deadline: deadline,
            amountIn: amountIn,
            amountOutMinimum: 0, // In production, add slippage protection
            sqrtPriceLimitX96: 0
        };

        console.log(`Swapping ${ethAmountStr} ETH for USDC...`);
        // We pass the ETH amount as msg.value for exactInputSingle
        const tx = await router.exactInputSingle(params, { value: amountIn });
        const receipt = await tx.wait();
        
        return { success: true, txHash: receipt.hash };
    } catch (error) {
        console.error("Swap error:", error);
        return { success: false, error: error.message };
    }
}

module.exports = {
    transferUSDC,
    swapETHToUSDC,
    getWallet
};
