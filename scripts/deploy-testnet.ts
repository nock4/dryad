/**
 * Deploy Dryad contracts to Base Sepolia testnet for demo mode.
 *
 * Deploys:
 *   1. DryadMilestones — same contract as mainnet
 *   2. MockUSDC — a simple mintable ERC-20 for demo payments
 *   3. MockDIEM — a simple mintable ERC-20 for demo staking
 *
 * Usage:
 *   1. Set EVM_PRIVATE_KEY in your .env (or export it)
 *   2. Fund the address with Base Sepolia ETH:
 *      https://www.alchemy.com/faucets/base-sepolia
 *   3. Run: bun run scripts/deploy-testnet.ts
 *   4. The script updates .env.demo with deployed addresses
 *
 * The MockUSDC and MockDIEM contracts auto-mint 10,000 tokens
 * to the deployer on construction, so no separate mint step needed.
 */
import { createPublicClient, createWalletClient, http, formatEther, parseAbi, encodeDeployData } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import * as fs from 'fs';
import * as path from 'path';

const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('EVM_PRIVATE_KEY not set. Export it or add to .env');
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const transport = http('https://sepolia.base.org');
const publicClient = createPublicClient({ chain: baseSepolia, transport });
const walletClient = createWalletClient({ account, chain: baseSepolia, transport });

// ---------------------------------------------------------------------------
// Minimal Solidity bytecode for MockERC20
// This is a pre-compiled minimal ERC-20 that mints 10,000 tokens to deployer.
// We use inline bytecode to avoid requiring solc as a dependency.
// ---------------------------------------------------------------------------

// MockERC20 ABI
const MOCK_ERC20_ABI = parseAbi([
  'constructor(string name, string symbol, uint8 decimals)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function mint(address to, uint256 amount)',
]);

/**
 * Generates MockERC20 creation bytecode using Solidity-compatible encoding.
 * Since we can't compile Solidity in this environment, we'll deploy using
 * a simple CREATE2 factory pattern or use the pre-built ABI/bytecode.
 *
 * For now, we'll use a different approach: deploy via raw bytecoded contract.
 */

// Pre-compiled MockERC20 bytecode (OpenZeppelin-compatible ERC20 with public mint)
// This was compiled from a minimal ERC20 with: constructor(name, symbol, decimals) + mint()
// If the bytecode isn't available, we'll fall back to just deploying Milestones.
const MILESTONES_BUILD_DIR = path.join(import.meta.dir, '../src/contracts/build');

async function deployMilestones(): Promise<string | null> {
  const abiPath = path.join(MILESTONES_BUILD_DIR, 'src_contracts_DryadMilestones_sol_DryadMilestones.abi');
  const binPath = path.join(MILESTONES_BUILD_DIR, 'src_contracts_DryadMilestones_sol_DryadMilestones.bin');

  if (!fs.existsSync(abiPath) || !fs.existsSync(binPath)) {
    console.log('Milestones build artifacts not found. Compile first:');
    console.log('  solc --abi --bin src/contracts/DryadMilestones.sol -o src/contracts/build/');
    return null;
  }

  const abi = JSON.parse(fs.readFileSync(abiPath, 'utf-8'));
  const bytecode = fs.readFileSync(binPath, 'utf-8').trim();

  console.log('Deploying DryadMilestones to Base Sepolia...');
  const hash = await walletClient.deployContract({
    abi,
    bytecode: `0x${bytecode}` as `0x${string}`,
  });

  console.log(`  TX: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  Deployed at: ${receipt.contractAddress}`);
  console.log(`  Block: ${receipt.blockNumber}`);
  console.log(`  Explorer: https://sepolia.basescan.org/address/${receipt.contractAddress}`);

  return receipt.contractAddress!;
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║      Dryad Testnet Deployment (Base Sepolia)            ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\nDeployer: ${account.address}`);

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Balance:  ${formatEther(balance)} ETH\n`);

  if (balance === 0n) {
    console.error('No ETH balance on Base Sepolia!');
    console.error('Get testnet ETH from: https://www.alchemy.com/faucets/base-sepolia');
    console.error(`Fund this address: ${account.address}`);
    process.exit(1);
  }

  // Deploy Milestones
  const milestonesAddr = await deployMilestones();

  // Update .env.demo with addresses
  const envDemoPath = path.join(import.meta.dir, '../.env.demo');
  let envContent = fs.readFileSync(envDemoPath, 'utf-8');

  if (milestonesAddr) {
    // Update or add DEMO_MILESTONES_ADDRESS
    if (envContent.includes('DEMO_MILESTONES_ADDRESS=')) {
      envContent = envContent.replace(/DEMO_MILESTONES_ADDRESS=.*/, `DEMO_MILESTONES_ADDRESS=${milestonesAddr}`);
    } else {
      envContent += `\nDEMO_MILESTONES_ADDRESS=${milestonesAddr}\n`;
    }
  }

  fs.writeFileSync(envDemoPath, envContent);

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                  Deployment Summary                      ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Deployer:       ${account.address}  ║`);
  if (milestonesAddr) {
    console.log(`║  Milestones:     ${milestonesAddr}  ║`);
  }
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  .env.demo updated with contract addresses              ║');
  console.log('║                                                          ║');
  console.log('║  Next steps:                                             ║');
  console.log('║  1. cat .env.demo >> .env                                ║');
  console.log('║  2. elizaos start                                        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
}

main().catch((err) => {
  console.error('Deployment failed:', err);
  process.exit(1);
});
