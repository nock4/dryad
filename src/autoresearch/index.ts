/**
 * Dryad AutoResearch — Main Entry Point
 *
 * Three autonomous research loops inspired by karpathy/autoresearch:
 *
 *   1. Vision Tuner    — Optimizes contractor photo verification prompts/params
 *   2. Ecology Optimizer — Optimizes planting strategies via simulation
 *   3. Treasury Optimizer — Optimizes DeFi yield allocation
 *
 * Each loop follows the same pattern:
 *   modify params → run experiment → measure metric → keep/discard → repeat
 *
 * Usage:
 *   import { runAll, runVisionTuning, runEcologyOptimization, runTreasuryOptimization } from './autoresearch';
 *
 *   // Run all three loops
 *   await runAll();
 *
 *   // Or run individually
 *   await runVisionTuning(20);           // 20 prompt/threshold experiments
 *   await runEcologyOptimization(50);    // 50 planting strategy simulations
 *   await runTreasuryOptimization(30);   // 30 yield allocation experiments
 */

export { runVisionTuning } from './visionTuner.ts';
export { runEcologyOptimization, recordRealWorldObservation, computeBiodiversityScore } from './ecologyOptimizer.ts';
export { runTreasuryOptimization, getOptimalAllocation, fetchLiveYields } from './treasuryOptimizer.ts';
export { getSummary, loadState } from './experimentRunner.ts';

import { logger } from '@elizaos/core';
import { runVisionTuning } from './visionTuner.ts';
import { runEcologyOptimization } from './ecologyOptimizer.ts';
import { runTreasuryOptimization } from './treasuryOptimizer.ts';
import { getSummary } from './experimentRunner.ts';

/**
 * Run all three research loops in sequence.
 * Designed to be kicked off overnight — the agent wakes up
 * to optimized parameters across all three domains.
 */
export async function runAll(opts?: {
  visionExperiments?: number;
  ecologyExperiments?: number;
  treasuryExperiments?: number;
  treasuryValue?: number;
}): Promise<void> {
  const {
    visionExperiments = 20,
    ecologyExperiments = 50,
    treasuryExperiments = 30,
    treasuryValue = 5000,
  } = opts || {};

  logger.info('[AutoResearch] === Starting full research cycle ===');
  const startTime = Date.now();

  // 1. Treasury optimization (fastest — pure simulation)
  logger.info('[AutoResearch] Phase 1/3: Treasury yield optimization');
  try {
    await runTreasuryOptimization(treasuryExperiments, treasuryValue);
  } catch (err: any) {
    logger.error(`[AutoResearch] Treasury optimization failed: ${err?.message}`);
  }

  // 2. Ecology optimization (fast — simulation model)
  logger.info('[AutoResearch] Phase 2/3: Ecology strategy optimization');
  try {
    await runEcologyOptimization(ecologyExperiments);
  } catch (err: any) {
    logger.error(`[AutoResearch] Ecology optimization failed: ${err?.message}`);
  }

  // 3. Vision tuning (slowest — requires API calls per photo per experiment)
  logger.info('[AutoResearch] Phase 3/3: Vision verification tuning');
  try {
    await runVisionTuning(visionExperiments);
  } catch (err: any) {
    logger.error(`[AutoResearch] Vision tuning failed: ${err?.message}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  logger.info(`[AutoResearch] === Research cycle complete in ${elapsed} minutes ===`);

  // Print summaries
  for (const domain of ['treasury', 'ecology', 'vision']) {
    logger.info(`\n${getSummary(domain)}`);
  }
}
