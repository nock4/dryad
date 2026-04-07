/**
 * AutoResearch Loop 3: Treasury Yield Optimization
 *
 * Optimizes DeFi yield strategies for Dryad's autonomous treasury:
 *   - Stablecoin allocation across yield protocols
 *   - Risk/return tradeoffs
 *   - Rebalancing frequency
 *   - Gas cost optimization
 *
 * Metric: risk-adjusted annual yield (Sharpe-like ratio)
 * accounting for protocol risk, gas costs, and minimum operating budget.
 *
 * Autoresearch pattern:
 *   modify allocation → simulate/backtest → measure risk-adjusted yield → keep/discard
 *
 * This is the most hackathon-ready loop — maps directly to the
 * Lablab AI Trading Agents hackathon (ERC-8004 + autonomous treasury).
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@elizaos/core';
import {
  type ExperimentConfig,
  type ExperimentFn,
  type ResearchState,
  runBatch,
  loadState,
} from './experimentRunner.ts';

// ---------------------------------------------------------------------------
// Treasury strategy parameters
// ---------------------------------------------------------------------------

export interface YieldProtocol {
  name: string;
  chain: 'base' | 'ethereum' | 'arbitrum' | 'optimism' | 'solana';
  asset: string;
  /** Current advertised APY */
  currentApy: number;
  /** Historical APY volatility (std dev) */
  apyVolatility: number;
  /** Risk score 0-10 (10 = highest risk) */
  riskScore: number;
  /** Minimum deposit in USD */
  minDeposit: number;
  /** Lock period in days (0 = instant withdrawal) */
  lockDays: number;
  /** Gas cost per rebalance in USD */
  gasCostPerTx: number;
}

// Known yield opportunities (updated periodically by the agent)
const YIELD_PROTOCOLS: YieldProtocol[] = [
  {
    name: 'Aave USDC (Base)',
    chain: 'base',
    asset: 'USDC',
    currentApy: 0.045,
    apyVolatility: 0.015,
    riskScore: 2,
    minDeposit: 10,
    lockDays: 0,
    gasCostPerTx: 0.10,
  },
  {
    name: 'Compound USDC (Base)',
    chain: 'base',
    asset: 'USDC',
    currentApy: 0.042,
    apyVolatility: 0.012,
    riskScore: 2,
    minDeposit: 10,
    lockDays: 0,
    gasCostPerTx: 0.10,
  },
  {
    name: 'Morpho USDC Vault (Base)',
    chain: 'base',
    asset: 'USDC',
    currentApy: 0.065,
    apyVolatility: 0.025,
    riskScore: 4,
    minDeposit: 100,
    lockDays: 0,
    gasCostPerTx: 0.15,
  },
  {
    name: 'Aerodrome USDC/DAI LP',
    chain: 'base',
    asset: 'USDC-DAI',
    currentApy: 0.08,
    apyVolatility: 0.04,
    riskScore: 5,
    minDeposit: 50,
    lockDays: 0,
    gasCostPerTx: 0.20,
  },
  {
    name: 'Lido stETH',
    chain: 'ethereum',
    asset: 'stETH',
    currentApy: 0.035,
    apyVolatility: 0.005,
    riskScore: 3,
    minDeposit: 100,
    lockDays: 0,
    gasCostPerTx: 5.00,
  },
  {
    name: 'Spark DAI Savings',
    chain: 'ethereum',
    asset: 'sDAI',
    currentApy: 0.05,
    apyVolatility: 0.01,
    riskScore: 3,
    minDeposit: 100,
    lockDays: 0,
    gasCostPerTx: 5.00,
  },
  {
    name: 'Yearn USDC Vault',
    chain: 'arbitrum',
    asset: 'USDC',
    currentApy: 0.055,
    apyVolatility: 0.02,
    riskScore: 4,
    minDeposit: 50,
    lockDays: 0,
    gasCostPerTx: 0.30,
  },
  {
    name: 'Pendle PT-sDAI',
    chain: 'arbitrum',
    asset: 'PT-sDAI',
    currentApy: 0.07,
    apyVolatility: 0.01,
    riskScore: 5,
    minDeposit: 200,
    lockDays: 90,
    gasCostPerTx: 0.50,
  },
];

export interface TreasuryParams {
  /** Allocation weights per protocol (must sum to 1.0) */
  allocations: Record<string, number>;
  /** Rebalancing frequency in days */
  rebalanceDays: number;
  /** Maximum single-protocol exposure (0.0-1.0) */
  maxExposure: number;
  /** Minimum cash reserve in USD (for operating expenses) */
  cashReserve: number;
  /** Maximum acceptable risk score (weighted average) */
  maxRiskScore: number;
  /** Whether to chase highest APY or optimize risk-adjusted */
  strategy: 'max_yield' | 'risk_adjusted' | 'conservative' | 'barbell';
  /** Maximum lock days acceptable */
  maxLockDays: number;
  /** Prefer protocols on which chain */
  preferredChain: 'base' | 'any';
}

const BASELINE_TREASURY_PARAMS: TreasuryParams = {
  allocations: {
    'Aave USDC (Base)': 0.4,
    'Morpho USDC Vault (Base)': 0.3,
    'Compound USDC (Base)': 0.2,
    'Aerodrome USDC/DAI LP': 0.1,
  },
  rebalanceDays: 30,
  maxExposure: 0.5,
  cashReserve: 500, // $500 operating buffer
  maxRiskScore: 5,
  strategy: 'risk_adjusted',
  maxLockDays: 0, // No locks (need liquidity for contractor payments)
  preferredChain: 'base',
};

// Dryad financial constants
const ANNUAL_OPERATING_COST = 945;   // Year 3+ established prairie
const NON_NEGOTIABLE_ANNUAL = 383;   // taxes + VPS + gas + LLC
const TOTAL_TREASURY = 5000;         // Example starting treasury

// ---------------------------------------------------------------------------
// Yield simulation / backtesting
// ---------------------------------------------------------------------------

interface SimulationResult {
  /** Net annual yield in USD after gas costs */
  netYieldUsd: number;
  /** Net APY after gas and risk adjustment */
  netApy: number;
  /** Weighted risk score of the portfolio */
  weightedRisk: number;
  /** Total gas costs for rebalancing over a year */
  annualGasCost: number;
  /** Sharpe-like ratio: (yield - risk_free) / volatility */
  sharpeRatio: number;
  /** Can the treasury sustain annual operating costs? */
  sustainable: boolean;
  /** Years of runway at current yield vs operating costs */
  runwayYears: number;
  /** Number of rebalances per year */
  rebalancesPerYear: number;
}

function simulateTreasury(
  params: TreasuryParams,
  treasury: number = TOTAL_TREASURY,
): SimulationResult {
  const deployable = Math.max(0, treasury - params.cashReserve);
  let totalYield = 0;
  let totalVolatility = 0;
  let weightedRisk = 0;
  let totalGas = 0;
  const rebalancesPerYear = Math.ceil(365 / params.rebalanceDays);

  // Filter protocols by constraints
  const eligible = YIELD_PROTOCOLS.filter(p => {
    if (p.riskScore > params.maxRiskScore) return false;
    if (p.lockDays > params.maxLockDays) return false;
    if (params.preferredChain !== 'any' && p.chain !== params.preferredChain) return false;
    return true;
  });

  const eligibleNames = new Set(eligible.map(p => p.name));

  for (const [protocolName, weight] of Object.entries(params.allocations)) {
    if (weight <= 0) continue;
    if (!eligibleNames.has(protocolName)) continue;

    const protocol = eligible.find(p => p.name === protocolName);
    if (!protocol) continue;

    // Enforce max exposure
    const effectiveWeight = Math.min(weight, params.maxExposure);
    const allocated = deployable * effectiveWeight;

    if (allocated < protocol.minDeposit) continue;

    // Yield calculation with APY volatility (Monte Carlo-lite)
    // Use expected APY minus half-volatility as conservative estimate
    const conservativeApy = protocol.currentApy - protocol.apyVolatility * 0.5;
    totalYield += allocated * Math.max(0, conservativeApy);
    totalVolatility += (effectiveWeight * protocol.apyVolatility) ** 2;
    weightedRisk += effectiveWeight * protocol.riskScore;

    // Gas costs for rebalancing
    totalGas += protocol.gasCostPerTx * rebalancesPerYear;
  }

  const portfolioVolatility = Math.sqrt(totalVolatility);
  const netYield = totalYield - totalGas;
  const netApy = deployable > 0 ? netYield / deployable : 0;
  const riskFreeRate = 0.035; // T-bill equivalent
  const sharpeRatio = portfolioVolatility > 0
    ? (netApy - riskFreeRate) / portfolioVolatility
    : 0;

  const annualDeficit = ANNUAL_OPERATING_COST - netYield;
  const sustainable = netYield >= NON_NEGOTIABLE_ANNUAL;
  const runwayYears = annualDeficit > 0
    ? treasury / annualDeficit
    : Infinity;

  return {
    netYieldUsd: netYield,
    netApy,
    weightedRisk,
    annualGasCost: totalGas,
    sharpeRatio,
    sustainable,
    runwayYears,
    rebalancesPerYear,
  };
}

// ---------------------------------------------------------------------------
// Treasury experiment function
// ---------------------------------------------------------------------------

function createTreasuryExperimentFn(treasury: number = TOTAL_TREASURY): ExperimentFn {
  return async (params: Record<string, any>) => {
    const p = params as TreasuryParams;
    const sim = simulateTreasury(p, treasury);

    // Combined metric: risk-adjusted yield that penalizes unsustainability
    let metric = sim.sharpeRatio;

    // Bonus for sustainability
    if (sim.sustainable) metric += 0.5;

    // Penalty for high gas costs relative to yield
    if (sim.annualGasCost > sim.netYieldUsd * 0.1) {
      metric -= 0.2; // Gas > 10% of yield is wasteful
    }

    // Penalty for excessive risk
    if (sim.weightedRisk > 5) {
      metric -= (sim.weightedRisk - 5) * 0.1;
    }

    return {
      metric,
      metadata: {
        simulation: sim,
        netApy: `${(sim.netApy * 100).toFixed(2)}%`,
        annualYield: `$${sim.netYieldUsd.toFixed(2)}`,
        gasCosts: `$${sim.annualGasCost.toFixed(2)}`,
        runway: sim.runwayYears === Infinity ? '∞' : `${sim.runwayYears.toFixed(1)} years`,
        sustainable: sim.sustainable,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Parameter mutation
// ---------------------------------------------------------------------------

function mutateTreasuryParams(base: TreasuryParams, rng: () => number): TreasuryParams {
  const params: TreasuryParams = JSON.parse(JSON.stringify(base));
  const dimension = Math.floor(rng() * 7);

  switch (dimension) {
    case 0: { // Shuffle allocations
      const protocols = YIELD_PROTOCOLS.map(p => p.name);
      const newAllocs: Record<string, number> = {};
      let remaining = 1.0;

      // Pick 2-4 protocols randomly
      const count = 2 + Math.floor(rng() * 3);
      const shuffled = [...protocols].sort(() => rng() - 0.5).slice(0, count);

      for (let i = 0; i < shuffled.length - 1; i++) {
        const alloc = rng() * remaining * 0.7; // Don't allocate everything to one
        newAllocs[shuffled[i]] = alloc;
        remaining -= alloc;
      }
      newAllocs[shuffled[shuffled.length - 1]] = remaining;
      params.allocations = newAllocs;
      break;
    }
    case 1: // Rebalance frequency
      params.rebalanceDays = Math.max(7, Math.min(90, params.rebalanceDays + Math.floor((rng() - 0.5) * 30)));
      break;
    case 2: // Max exposure
      params.maxExposure = Math.max(0.2, Math.min(0.8, params.maxExposure + (rng() - 0.5) * 0.2));
      break;
    case 3: // Cash reserve
      params.cashReserve = Math.max(200, Math.min(2000, params.cashReserve + (rng() - 0.5) * 500));
      break;
    case 4: // Max risk
      params.maxRiskScore = Math.max(2, Math.min(8, params.maxRiskScore + Math.floor((rng() - 0.5) * 3)));
      break;
    case 5: // Strategy
      params.strategy = (['max_yield', 'risk_adjusted', 'conservative', 'barbell'] as const)[Math.floor(rng() * 4)];
      break;
    case 6: // Lock tolerance
      params.maxLockDays = ([0, 30, 60, 90] as const)[Math.floor(rng() * 4)];
      break;
  }

  return params;
}

function describeTreasuryChange(base: TreasuryParams, mutated: TreasuryParams): string {
  const changes: string[] = [];
  if (JSON.stringify(base.allocations) !== JSON.stringify(mutated.allocations)) {
    const top = Object.entries(mutated.allocations)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([k, v]) => `${k.split(' ')[0]}:${(v * 100).toFixed(0)}%`)
      .join('+');
    changes.push(`alloc [${top}]`);
  }
  if (base.rebalanceDays !== mutated.rebalanceDays)
    changes.push(`rebal ${base.rebalanceDays}→${mutated.rebalanceDays}d`);
  if (base.maxExposure !== mutated.maxExposure)
    changes.push(`maxExp ${(base.maxExposure * 100).toFixed(0)}→${(mutated.maxExposure * 100).toFixed(0)}%`);
  if (base.cashReserve !== mutated.cashReserve)
    changes.push(`reserve $${base.cashReserve}→$${mutated.cashReserve}`);
  if (base.maxRiskScore !== mutated.maxRiskScore)
    changes.push(`risk ${base.maxRiskScore}→${mutated.maxRiskScore}`);
  if (base.strategy !== mutated.strategy)
    changes.push(`strategy ${base.strategy}→${mutated.strategy}`);
  if (base.maxLockDays !== mutated.maxLockDays)
    changes.push(`lock ${base.maxLockDays}→${mutated.maxLockDays}d`);
  return changes.join(', ') || 'no change';
}

// ---------------------------------------------------------------------------
// Live yield fetcher (for real-world validation)
// ---------------------------------------------------------------------------

/**
 * Fetch current live APYs from DeFi protocols.
 * Uses DeFi Llama API for protocol-level data.
 */
export async function fetchLiveYields(): Promise<Partial<Record<string, number>>> {
  const yields: Record<string, number> = {};

  try {
    const resp = await fetch('https://yields.llama.fi/pools', {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`DeFi Llama error: ${resp.status}`);

    const data = (await resp.json()) as any;
    const pools = data?.data || [];

    // Map known protocols to their DeFi Llama pool IDs
    const mappings: Record<string, { project: string; chain: string; symbol: string }> = {
      'Aave USDC (Base)': { project: 'aave-v3', chain: 'Base', symbol: 'USDC' },
      'Compound USDC (Base)': { project: 'compound-v3', chain: 'Base', symbol: 'USDC' },
      'Lido stETH': { project: 'lido', chain: 'Ethereum', symbol: 'STETH' },
    };

    for (const [name, filter] of Object.entries(mappings)) {
      const pool = pools.find(
        (p: any) =>
          p.project === filter.project &&
          p.chain === filter.chain &&
          p.symbol?.includes(filter.symbol),
      );
      if (pool) {
        yields[name] = pool.apy / 100; // Convert from percent to decimal
      }
    }
  } catch (err: any) {
    logger.warn(`[TreasuryOptimizer] DeFi Llama fetch failed: ${err?.message}`);
  }

  return yields;
}

/**
 * Update protocol APYs with live data before running optimization.
 */
export async function updateLiveApys(): Promise<void> {
  const liveYields = await fetchLiveYields();

  for (const protocol of YIELD_PROTOCOLS) {
    if (liveYields[protocol.name] !== undefined) {
      const oldApy = protocol.currentApy;
      protocol.currentApy = liveYields[protocol.name]!;
      logger.info(
        `[TreasuryOptimizer] Updated ${protocol.name}: APY ${(oldApy * 100).toFixed(2)}% → ${(protocol.currentApy * 100).toFixed(2)}%`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the treasury yield optimization loop.
 * @param maxExperiments - How many strategies to test (default 30)
 * @param treasury - Total treasury value in USD (default 5000)
 * @param fetchLive - Whether to fetch live APYs first (default true)
 */
export async function runTreasuryOptimization(
  maxExperiments: number = 30,
  treasury: number = TOTAL_TREASURY,
  fetchLive: boolean = true,
): Promise<void> {
  if (fetchLive) {
    await updateLiveApys();
  }

  const experimentFn = createTreasuryExperimentFn(treasury);

  let seed = Date.now();
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff;
  };

  async function* experimentGenerator(state: ResearchState): AsyncGenerator<ExperimentConfig> {
    if (state.totalExperiments === 0) {
      yield {
        name: 'baseline',
        description: 'Baseline: 40% Aave + 30% Morpho + 20% Compound + 10% Aerodrome on Base',
        params: BASELINE_TREASURY_PARAMS,
        domain: 'treasury',
      };
    }

    let iteration = 0;
    while (true) {
      const baseParams = (state.bestParams as TreasuryParams) || BASELINE_TREASURY_PARAMS;
      const mutated = mutateTreasuryParams(baseParams, rng);
      const change = describeTreasuryChange(baseParams, mutated);

      yield {
        name: `yield-${iteration++}`,
        description: change,
        params: mutated,
        domain: 'treasury',
      };
    }
  }

  await runBatch({
    domain: 'treasury',
    metricName: 'risk_adjusted_score',
    higherIsBetter: true,
    timeBudgetPerExperiment: 5, // Simulations are fast
    maxExperiments,
    experimentGenerator,
    experimentFn,
  });
}

/**
 * Get the current optimal treasury allocation.
 */
export function getOptimalAllocation(): { params: TreasuryParams; simulation: SimulationResult } | null {
  const state = loadState('treasury', 'risk_adjusted_score', true);
  if (state.totalExperiments === 0) return null;

  const params = state.bestParams as TreasuryParams;
  const simulation = simulateTreasury(params);

  return { params, simulation };
}
