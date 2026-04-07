#!/usr/bin/env node
/**
 * Standalone overnight treasury research runner.
 * Pure ESM JavaScript — no TypeScript compilation needed.
 *
 * LLM-in-the-loop: the AI reasons about what to try next based
 * on experiment history, just like karpathy/autoresearch.
 *
 * Usage: node src/autoresearch/run-overnight.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// Load .env manually
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_EXPERIMENTS = parseInt(process.argv[2] || '30', 10);
const TREASURY_VALUE = parseInt(process.argv[3] || '5000', 10);
const RESULTS_DIR = path.join(PROJECT_ROOT, 'data', 'autoresearch');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

const PROTOCOLS = [
  { name: 'Aave USDC (Base)', chain: 'base', asset: 'USDC', currentApy: 0.045, apyVolatility: 0.015, riskScore: 2, minDeposit: 10, lockDays: 0, gasCostPerTx: 0.10 },
  { name: 'Compound USDC (Base)', chain: 'base', asset: 'USDC', currentApy: 0.042, apyVolatility: 0.012, riskScore: 2, minDeposit: 10, lockDays: 0, gasCostPerTx: 0.10 },
  { name: 'Morpho USDC Vault (Base)', chain: 'base', asset: 'USDC', currentApy: 0.065, apyVolatility: 0.025, riskScore: 4, minDeposit: 100, lockDays: 0, gasCostPerTx: 0.15 },
  { name: 'Aerodrome USDC/DAI LP', chain: 'base', asset: 'USDC-DAI', currentApy: 0.08, apyVolatility: 0.04, riskScore: 5, minDeposit: 50, lockDays: 0, gasCostPerTx: 0.20 },
  { name: 'Lido stETH', chain: 'ethereum', asset: 'stETH', currentApy: 0.035, apyVolatility: 0.005, riskScore: 3, minDeposit: 100, lockDays: 0, gasCostPerTx: 5.00 },
  { name: 'Spark DAI Savings', chain: 'ethereum', asset: 'sDAI', currentApy: 0.05, apyVolatility: 0.01, riskScore: 3, minDeposit: 100, lockDays: 0, gasCostPerTx: 5.00 },
  { name: 'Yearn USDC Vault', chain: 'arbitrum', asset: 'USDC', currentApy: 0.055, apyVolatility: 0.02, riskScore: 4, minDeposit: 50, lockDays: 0, gasCostPerTx: 0.30 },
  { name: 'Pendle PT-sDAI', chain: 'arbitrum', asset: 'PT-sDAI', currentApy: 0.07, apyVolatility: 0.01, riskScore: 5, minDeposit: 200, lockDays: 90, gasCostPerTx: 0.50 },
];

const ANNUAL_OPERATING_COST = 945;
const NON_NEGOTIABLE_ANNUAL = 383;

// ---------------------------------------------------------------------------
// Fetch live APYs
// ---------------------------------------------------------------------------

async function fetchLiveApys() {
  console.log('[Runner] Fetching live APYs from DeFi Llama...');
  try {
    const resp = await fetch('https://yields.llama.fi/pools', { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const pools = data?.data || [];

    const mappings = {
      'Aave USDC (Base)': { project: 'aave-v3', chain: 'Base', symbol: 'USDC' },
      'Compound USDC (Base)': { project: 'compound-v3', chain: 'Base', symbol: 'USDC' },
      'Lido stETH': { project: 'lido', chain: 'Ethereum', symbol: 'STETH' },
    };

    for (const [name, filter] of Object.entries(mappings)) {
      const pool = pools.find(p =>
        p.project === filter.project && p.chain === filter.chain && p.symbol?.includes(filter.symbol),
      );
      if (pool) {
        const proto = PROTOCOLS.find(p => p.name === name);
        if (proto) {
          const old = proto.currentApy;
          proto.currentApy = pool.apy / 100;
          console.log(`  ${name}: ${(old * 100).toFixed(2)}% → ${(proto.currentApy * 100).toFixed(2)}%`);
        }
      }
    }
    console.log('');
  } catch (err) {
    console.log(`[Runner] DeFi Llama unavailable (${err.message}), using defaults.\n`);
  }
}

// ---------------------------------------------------------------------------
// Treasury simulation
// ---------------------------------------------------------------------------

function simulateTreasury(params) {
  const { allocations = {}, rebalanceDays = 30, maxExposure = 0.5, cashReserve = 500, maxRiskScore = 5, maxLockDays = 0, preferredChain = 'base' } = params;

  const deployable = Math.max(0, TREASURY_VALUE - cashReserve);
  let totalYield = 0, totalVol = 0, weightedRisk = 0, totalGas = 0, active = 0;
  const rebalsPerYear = Math.ceil(365 / rebalanceDays);

  const eligible = PROTOCOLS.filter(p =>
    p.riskScore <= maxRiskScore && p.lockDays <= maxLockDays && (preferredChain === 'any' || p.chain === preferredChain)
  );
  const eligibleSet = new Set(eligible.map(p => p.name));

  for (const [name, weight] of Object.entries(allocations)) {
    if (weight <= 0 || !eligibleSet.has(name)) continue;
    const proto = eligible.find(p => p.name === name);
    if (!proto) continue;

    const w = Math.min(weight, maxExposure);
    const allocated = deployable * w;
    if (allocated < proto.minDeposit) continue;

    totalYield += allocated * Math.max(0, proto.currentApy - proto.apyVolatility * 0.5);
    totalVol += (w * proto.apyVolatility) ** 2;
    weightedRisk += w * proto.riskScore;
    totalGas += proto.gasCostPerTx * rebalsPerYear;
    active++;
  }

  const vol = Math.sqrt(totalVol);
  const net = totalYield - totalGas;
  const apy = deployable > 0 ? net / deployable : 0;
  const sharpe = vol > 0 ? (apy - 0.035) / vol : 0;
  const sustainable = net >= NON_NEGOTIABLE_ANNUAL;
  const deficit = ANNUAL_OPERATING_COST - net;
  const runway = deficit > 0 ? TREASURY_VALUE / deficit : 999;

  let metric = sharpe;
  if (sustainable) metric += 0.5;
  if (totalGas > net * 0.1) metric -= 0.2;
  if (weightedRisk > 5) metric -= (weightedRisk - 5) * 0.1;
  if (active >= 3) metric += 0.1;

  return {
    metric,
    metadata: {
      netApy: `${(apy * 100).toFixed(2)}%`,
      annualYield: `$${net.toFixed(2)}`,
      gasCosts: `$${totalGas.toFixed(2)}/yr`,
      risk: weightedRisk.toFixed(2),
      sharpe: sharpe.toFixed(3),
      sustainable,
      runway: runway >= 999 ? '∞' : `${runway.toFixed(1)}yr`,
      protocols: active,
    },
  };
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callLLM(system, user) {
  const key = process.env.VENICE_API_KEY || process.env.OPENAI_API_KEY;
  const base = process.env.VENICE_API_KEY
    ? (process.env.VENICE_BASE_URL || 'https://api.venice.ai/api/v1')
    : 'https://api.openai.com/v1';
  const model = process.env.VENICE_API_KEY
    ? (process.env.VENICE_LARGE_MODEL || 'llama-3.3-70b')
    : 'gpt-4o-mini';

  if (!key) throw new Error('No API key (VENICE_API_KEY or OPENAI_API_KEY)');

  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: 1500,
    temperature: 0.7,
  };
  if (process.env.VENICE_API_KEY) {
    body.venice_parameters = { disable_thinking: true, include_venice_system_prompt: false };
  }

  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!resp.ok) throw new Error(`LLM API ${resp.status}`);
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || '';
}

// ---------------------------------------------------------------------------
// Parse LLM JSON response
// ---------------------------------------------------------------------------

function parseLLMResponse(raw) {
  let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    if (obj.params && obj.hypothesis) return obj;
    return null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const protocolDesc = PROTOCOLS
  .map(p => `  - ${p.name}: APY ${(p.currentApy*100).toFixed(2)}% ±${(p.apyVolatility*100).toFixed(1)}%, risk ${p.riskScore}/10, min $${p.minDeposit}, lock ${p.lockDays}d, gas $${p.gasCostPerTx}/tx (${p.chain})`)
  .join('\n');

const SYSTEM = `You are an autonomous DeFi research agent optimizing yield allocation for Dryad, a land management DAO with a $${TREASURY_VALUE} treasury on Base L2.

Annual costs: $${ANNUAL_OPERATING_COST} (non-negotiable minimum: $${NON_NEGOTIABLE_ANNUAL})

Available protocols:
${protocolDesc}

Parameter space:
{
  "allocations": {"<protocol>": <0.0-1.0>, ...},  // sum to ~1.0
  "rebalanceDays": <7-90>,
  "maxExposure": <0.2-0.8>,
  "cashReserve": <200-2000>,
  "maxRiskScore": <2-8>,
  "maxLockDays": <0|30|60|90>,
  "preferredChain": "base" | "any"
}

Metric: risk-adjusted score = Sharpe ratio + sustainability bonus + diversification bonus - gas penalty - risk penalty. HIGHER is better.

Constraints:
- Ethereum gas is ~$5/tx vs $0.10-0.30 on L2s — frequent mainnet rebalancing wastes money
- Need liquidity for contractor payments — avoid locks unless yield premium justifies it
- $${TREASURY_VALUE} is small — absolute dollar yield matters more than APY percentages
- Diversification (3+ protocols) is rewarded

You MUST respond with ONLY valid JSON:
{"hypothesis": "why this change should help", "param_change_description": "what you changed", "params": {<complete params>}}

Change only 1-2 params per experiment. Base decisions on evidence from prior results.`;

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  Dryad AutoResearch — LLM-in-the-Loop Treasury Optimizer ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  Treasury: $${TREASURY_VALUE}  |  Experiments: ${MAX_EXPERIMENTS}  |  ${new Date().toISOString().slice(0,16)}  ║`);
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  await fetchLiveApys();

  // Session state
  const sessionPath = path.join(RESULTS_DIR, 'treasury-llm-session.json');
  const tsvPath = path.join(RESULTS_DIR, 'treasury-llm-results.tsv');
  let session = { bestMetric: -Infinity, bestParams: null, experiments: [] };

  if (fs.existsSync(sessionPath)) {
    try { session = JSON.parse(fs.readFileSync(sessionPath, 'utf-8')); } catch {}
  }

  if (!fs.existsSync(tsvPath)) {
    fs.writeFileSync(tsvPath, 'iter\tmetric\tstatus\thypothesis\tchange\tnet_apy\tyield\ttimestamp\n');
  }

  const defaultParams = {
    allocations: { 'Aave USDC (Base)': 0.4, 'Morpho USDC Vault (Base)': 0.3, 'Compound USDC (Base)': 0.2, 'Aerodrome USDC/DAI LP': 0.1 },
    rebalanceDays: 30, maxExposure: 0.5, cashReserve: 500, maxRiskScore: 5, maxLockDays: 0, preferredChain: 'base',
  };

  if (!session.bestParams) session.bestParams = defaultParams;
  const startIter = session.experiments.length;

  for (let i = startIter; i < startIter + MAX_EXPERIMENTS; i++) {
    const t0 = Date.now();
    console.log(`\n━━━ Iteration ${i + 1}/${startIter + MAX_EXPERIMENTS} ━━━`);

    // Build context from history
    const recent = session.experiments.slice(-12);
    let historyStr = 'No prior experiments. Propose a change from the baseline.';
    if (recent.length > 0) {
      historyStr = `Best metric so far: ${session.bestMetric.toFixed(4)}\n\nRecent experiments:\n` +
        recent.reverse().map(e =>
          `[${e.status}] metric=${e.metric.toFixed(4)} | "${e.change}" | hypothesis: "${e.hypothesis}" ${e.metadata ? `| ${e.metadata.netApy} yield, ${e.metadata.sustainable ? 'sustainable' : 'NOT sustainable'}` : ''}`
        ).join('\n') +
        `\n\nCurrent best params:\n${JSON.stringify(session.bestParams, null, 2)}`;
    }

    // Ask LLM
    console.log('  Asking LLM for next experiment...');
    let proposal = null;
    for (let attempt = 0; attempt < 3 && !proposal; attempt++) {
      try {
        const raw = await callLLM(SYSTEM, historyStr);
        proposal = parseLLMResponse(raw);
        if (!proposal) {
          console.log(`  Parse failed (attempt ${attempt+1}), retrying...`);
          console.log(`  Raw (first 300 chars): ${raw.slice(0, 300)}`);
        }
      } catch (err) {
        console.log(`  LLM error (attempt ${attempt+1}): ${err.message}`);
      }
    }

    if (!proposal) {
      console.log('  ✗ Could not get valid proposal, skipping');
      continue;
    }

    console.log(`  Hypothesis: "${proposal.hypothesis}"`);
    console.log(`  Change: "${proposal.param_change_description}"`);

    // Run simulation
    const { metric, metadata } = simulateTreasury(proposal.params);
    const improved = metric > session.bestMetric;
    const status = improved ? 'keep' : 'discard';

    if (improved) {
      session.bestMetric = metric;
      session.bestParams = { ...proposal.params };
      console.log(`  ✓ IMPROVED: ${metric.toFixed(4)} — ${metadata.netApy} yield, ${metadata.annualYield}/yr ${metadata.sustainable ? '(sustainable!)' : ''}`);
    } else {
      console.log(`  ✗ No improvement: ${metric.toFixed(4)} (best: ${session.bestMetric.toFixed(4)}) — ${metadata.netApy} yield`);
    }

    // Record
    const entry = {
      iteration: i, hypothesis: proposal.hypothesis, change: proposal.param_change_description,
      params: proposal.params, metric, status, metadata, timestamp: new Date().toISOString(),
    };
    session.experiments.push(entry);

    // Save after each experiment
    fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
    fs.appendFileSync(tsvPath, [
      i + 1, metric.toFixed(4), status,
      proposal.hypothesis.replace(/\t/g, ' ').slice(0, 100),
      (proposal.param_change_description || '').replace(/\t/g, ' ').slice(0, 60),
      metadata.netApy, metadata.annualYield,
      new Date().toISOString(),
    ].join('\t') + '\n');

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  (${elapsed}s)`);

    // Brief pause to avoid rate limits
    await new Promise(r => setTimeout(r, 3000));
  }

  // Final summary
  const kept = session.experiments.filter(e => e.status === 'keep').length;
  console.log('\n' + '═'.repeat(60));
  console.log('RESEARCH COMPLETE');
  console.log('═'.repeat(60));
  console.log(`Experiments: ${session.experiments.length}`);
  console.log(`Improvements: ${kept} (${(kept/session.experiments.length*100).toFixed(0)}% keep rate)`);
  console.log(`Best metric: ${session.bestMetric.toFixed(4)}`);
  console.log(`Best allocation:`);
  const allocs = session.bestParams.allocations;
  for (const [name, weight] of Object.entries(allocs).sort((a,b) => b[1] - a[1])) {
    if (weight > 0) console.log(`  ${(weight*100).toFixed(1)}% → ${name}`);
  }
  const finalSim = simulateTreasury(session.bestParams);
  console.log(`Net APY: ${finalSim.metadata.netApy}`);
  console.log(`Annual yield: ${finalSim.metadata.annualYield}`);
  console.log(`Sustainable: ${finalSim.metadata.sustainable}`);
  console.log(`Gas costs: ${finalSim.metadata.gasCosts}`);
  console.log('═'.repeat(60));
  console.log(`Results: data/autoresearch/treasury-llm-results.tsv`);
  console.log(`Session: data/autoresearch/treasury-llm-session.json`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
