#!/usr/bin/env bun
/**
 * Overnight Treasury Research Runner
 *
 * Launches the LLM-in-the-loop researcher to optimize Dryad's
 * DeFi yield allocation. Each iteration, the LLM:
 *   1. Reviews past experiment results
 *   2. Forms a hypothesis about what allocation change might help
 *   3. Proposes specific parameter changes
 *   4. We simulate the outcome
 *   5. LLM reflects on the result
 *   6. Keep or discard, then loop
 *
 * Usage:
 *   bun run src/autoresearch/runTreasuryResearch.ts
 *   bun run src/autoresearch/runTreasuryResearch.ts --experiments 50
 *   bun run src/autoresearch/runTreasuryResearch.ts --treasury 10000
 */

import { runLLMResearchLoop, getResearchSummary } from './llmResearcher.ts';

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(name: string, defaultVal: number): number {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return parseInt(args[idx + 1], 10);
  return defaultVal;
}

const MAX_EXPERIMENTS = getArg('experiments', 30);
const TREASURY_VALUE = getArg('treasury', 5000);

// ---------------------------------------------------------------------------
// Known yield protocols (same as treasuryOptimizer but inlined for runner)
// ---------------------------------------------------------------------------

interface YieldProtocol {
  name: string;
  chain: string;
  asset: string;
  currentApy: number;
  apyVolatility: number;
  riskScore: number;
  minDeposit: number;
  lockDays: number;
  gasCostPerTx: number;
}

const PROTOCOLS: YieldProtocol[] = [
  { name: 'Aave USDC (Base)', chain: 'base', asset: 'USDC', currentApy: 0.045, apyVolatility: 0.015, riskScore: 2, minDeposit: 10, lockDays: 0, gasCostPerTx: 0.10 },
  { name: 'Compound USDC (Base)', chain: 'base', asset: 'USDC', currentApy: 0.042, apyVolatility: 0.012, riskScore: 2, minDeposit: 10, lockDays: 0, gasCostPerTx: 0.10 },
  { name: 'Morpho USDC Vault (Base)', chain: 'base', asset: 'USDC', currentApy: 0.065, apyVolatility: 0.025, riskScore: 4, minDeposit: 100, lockDays: 0, gasCostPerTx: 0.15 },
  { name: 'Aerodrome USDC/DAI LP', chain: 'base', asset: 'USDC-DAI', currentApy: 0.08, apyVolatility: 0.04, riskScore: 5, minDeposit: 50, lockDays: 0, gasCostPerTx: 0.20 },
  { name: 'Lido stETH', chain: 'ethereum', asset: 'stETH', currentApy: 0.035, apyVolatility: 0.005, riskScore: 3, minDeposit: 100, lockDays: 0, gasCostPerTx: 5.00 },
  { name: 'Spark DAI Savings', chain: 'ethereum', asset: 'sDAI', currentApy: 0.05, apyVolatility: 0.01, riskScore: 3, minDeposit: 100, lockDays: 0, gasCostPerTx: 5.00 },
  { name: 'Yearn USDC Vault', chain: 'arbitrum', asset: 'USDC', currentApy: 0.055, apyVolatility: 0.02, riskScore: 4, minDeposit: 50, lockDays: 0, gasCostPerTx: 0.30 },
  { name: 'Pendle PT-sDAI', chain: 'arbitrum', asset: 'PT-sDAI', currentApy: 0.07, apyVolatility: 0.01, riskScore: 5, minDeposit: 200, lockDays: 90, gasCostPerTx: 0.50 },
];

// ---------------------------------------------------------------------------
// Fetch live APYs from DeFi Llama
// ---------------------------------------------------------------------------

async function fetchAndUpdateApys(): Promise<void> {
  console.log('[Runner] Fetching live APYs from DeFi Llama...');
  try {
    const resp = await fetch('https://yields.llama.fi/pools', { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as any;
    const pools = data?.data || [];

    const mappings: Record<string, { project: string; chain: string; symbol: string }> = {
      'Aave USDC (Base)': { project: 'aave-v3', chain: 'Base', symbol: 'USDC' },
      'Compound USDC (Base)': { project: 'compound-v3', chain: 'Base', symbol: 'USDC' },
      'Lido stETH': { project: 'lido', chain: 'Ethereum', symbol: 'STETH' },
    };

    for (const [name, filter] of Object.entries(mappings)) {
      const pool = pools.find((p: any) =>
        p.project === filter.project && p.chain === filter.chain && p.symbol?.includes(filter.symbol),
      );
      if (pool) {
        const proto = PROTOCOLS.find(p => p.name === name);
        if (proto) {
          const oldApy = proto.currentApy;
          proto.currentApy = pool.apy / 100;
          console.log(`  ${name}: ${(oldApy * 100).toFixed(2)}% → ${(proto.currentApy * 100).toFixed(2)}%`);
        }
      }
    }
    console.log('[Runner] Live APYs updated.\n');
  } catch (err: any) {
    console.log(`[Runner] DeFi Llama fetch failed (${err?.message}), using defaults.\n`);
  }
}

// ---------------------------------------------------------------------------
// Treasury simulation (the experiment function)
// ---------------------------------------------------------------------------

const ANNUAL_OPERATING_COST = 945;
const NON_NEGOTIABLE_ANNUAL = 383;

function simulateTreasury(params: Record<string, any>): { metric: number; metadata: Record<string, any> } {
  const allocations = params.allocations as Record<string, number>;
  const rebalanceDays = params.rebalanceDays as number || 30;
  const maxExposure = params.maxExposure as number || 0.5;
  const cashReserve = params.cashReserve as number || 500;
  const maxRiskScore = params.maxRiskScore as number || 5;
  const maxLockDays = params.maxLockDays as number || 0;
  const preferredChain = params.preferredChain as string || 'base';

  const deployable = Math.max(0, TREASURY_VALUE - cashReserve);
  let totalYield = 0;
  let totalVolatility = 0;
  let weightedRisk = 0;
  let totalGas = 0;
  let activeProtocols = 0;
  const rebalancesPerYear = Math.ceil(365 / rebalanceDays);

  const eligible = PROTOCOLS.filter(p => {
    if (p.riskScore > maxRiskScore) return false;
    if (p.lockDays > maxLockDays) return false;
    if (preferredChain !== 'any' && p.chain !== preferredChain) return false;
    return true;
  });
  const eligibleNames = new Set(eligible.map(p => p.name));

  for (const [name, weight] of Object.entries(allocations)) {
    if (weight <= 0) continue;
    if (!eligibleNames.has(name)) continue;
    const protocol = eligible.find(p => p.name === name);
    if (!protocol) continue;

    const effectiveWeight = Math.min(weight, maxExposure);
    const allocated = deployable * effectiveWeight;
    if (allocated < protocol.minDeposit) continue;

    const conservativeApy = protocol.currentApy - protocol.apyVolatility * 0.5;
    totalYield += allocated * Math.max(0, conservativeApy);
    totalVolatility += (effectiveWeight * protocol.apyVolatility) ** 2;
    weightedRisk += effectiveWeight * protocol.riskScore;
    totalGas += protocol.gasCostPerTx * rebalancesPerYear;
    activeProtocols++;
  }

  const portfolioVolatility = Math.sqrt(totalVolatility);
  const netYield = totalYield - totalGas;
  const netApy = deployable > 0 ? netYield / deployable : 0;
  const riskFreeRate = 0.035;
  const sharpeRatio = portfolioVolatility > 0 ? (netApy - riskFreeRate) / portfolioVolatility : 0;
  const sustainable = netYield >= NON_NEGOTIABLE_ANNUAL;
  const annualDeficit = ANNUAL_OPERATING_COST - netYield;
  const runwayYears = annualDeficit > 0 ? TREASURY_VALUE / annualDeficit : 999;

  // Composite score
  let metric = sharpeRatio;
  if (sustainable) metric += 0.5;
  if (totalGas > netYield * 0.1) metric -= 0.2;
  if (weightedRisk > 5) metric -= (weightedRisk - 5) * 0.1;
  // Diversification bonus
  if (activeProtocols >= 3) metric += 0.1;

  return {
    metric,
    metadata: {
      netApy: `${(netApy * 100).toFixed(2)}%`,
      annualYield: `$${netYield.toFixed(2)}`,
      gasCosts: `$${totalGas.toFixed(2)}/yr`,
      weightedRisk: weightedRisk.toFixed(2),
      sharpeRatio: sharpeRatio.toFixed(3),
      sustainable,
      runway: runwayYears >= 999 ? '∞' : `${runwayYears.toFixed(1)} years`,
      activeProtocols,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Dryad AutoResearch — Treasury Yield Optimization           ║');
  console.log('║  LLM-in-the-Loop (inspired by karpathy/autoresearch)       ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Treasury: $${TREASURY_VALUE}                                          ║`);
  console.log(`║  Experiments: ${MAX_EXPERIMENTS}                                            ║`);
  console.log(`║  Started: ${new Date().toISOString()}                ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Fetch live data
  await fetchAndUpdateApys();

  // Build protocol descriptions for the LLM
  const protocolDescriptions = PROTOCOLS
    .map(p => `  - ${p.name}: APY ${(p.currentApy * 100).toFixed(2)}% ± ${(p.apyVolatility * 100).toFixed(1)}%, risk ${p.riskScore}/10, min $${p.minDeposit}, lock ${p.lockDays}d, gas $${p.gasCostPerTx}/tx (${p.chain})`)
    .join('\n');

  // Run the LLM research loop
  const session = await runLLMResearchLoop({
    domain: 'treasury-llm',
    problemDescription: `You are optimizing a DeFi yield allocation strategy for Dryad, an autonomous land management agent in Detroit. The agent has a $${TREASURY_VALUE} treasury that needs to generate yield to cover annual operating costs of $${ANNUAL_OPERATING_COST} (non-negotiable minimum: $${NON_NEGOTIABLE_ANNUAL}/yr for taxes, server, gas, LLC fees). The treasury is on Base L2 primarily, with optional cross-chain positions.`,

    metricName: 'risk_adjusted_score',
    higherIsBetter: true,

    parameterSchema: `The parameter object has these fields:
{
  "allocations": { "<protocol name>": <weight 0.0-1.0>, ... },  // Must sum to ~1.0
  "rebalanceDays": <number 7-90>,          // How often to rebalance
  "maxExposure": <number 0.2-0.8>,         // Max % in any single protocol
  "cashReserve": <number 200-2000>,        // USD kept liquid for expenses
  "maxRiskScore": <number 2-8>,            // Max acceptable protocol risk (2=safest, 8=aggressive)
  "maxLockDays": <number 0|30|60|90>,      // Max acceptable lock period
  "preferredChain": "base" | "any"         // Chain preference
}

Available protocols:
${protocolDescriptions}`,

    domainContext: `Key constraints:
- Gas costs on Ethereum mainnet are ~$5/tx vs $0.10-0.30 on Base/Arbitrum — frequent rebalancing on mainnet is wasteful
- The agent needs liquidity for contractor payments (invasive removal, mowing, planting) — avoid long lock periods unless the yield premium justifies it
- Sustainability means annual yield >= $${NON_NEGOTIABLE_ANNUAL} (non-negotiable costs). Ideal is yield >= $${ANNUAL_OPERATING_COST} (full operating cost)
- Higher Sharpe ratio (return per unit risk) is preferred over raw yield
- Diversification across 3+ protocols is preferred over concentration
- The composite metric rewards: Sharpe ratio + sustainability bonus + diversification bonus - gas penalty - excess risk penalty
- With only $${TREASURY_VALUE} in the treasury, percentage-based APY differences matter less than absolute dollar yield and cost efficiency`,

    currentBestParams: {
      allocations: {
        'Aave USDC (Base)': 0.4,
        'Morpho USDC Vault (Base)': 0.3,
        'Compound USDC (Base)': 0.2,
        'Aerodrome USDC/DAI LP': 0.1,
      },
      rebalanceDays: 30,
      maxExposure: 0.5,
      cashReserve: 500,
      maxRiskScore: 5,
      maxLockDays: 0,
      preferredChain: 'base',
    },

    experimentFn: async (params) => simulateTreasury(params),
    maxExperiments: MAX_EXPERIMENTS,
  });

  // Print final summary
  console.log('\n' + '='.repeat(60));
  console.log(getResearchSummary('treasury-llm'));
  console.log('='.repeat(60));
  console.log('\nResults saved to data/autoresearch/treasury-llm-results.tsv');
  console.log('Full session: data/autoresearch/treasury-llm-session.json');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
