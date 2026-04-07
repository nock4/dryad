/**
 * Dryad AutoResearch — Shared Experiment Runner
 *
 * Inspired by karpathy/autoresearch: an autonomous loop that
 * modifies parameters → runs experiments → measures a metric →
 * keeps improvements → discards regressions → repeats.
 *
 * This is the shared infrastructure for all three Dryad research loops:
 *   1. Vision verification tuning
 *   2. Ecological strategy optimization
 *   3. Treasury yield optimization
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@elizaos/core';
import { audit } from '../services/auditLog.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExperimentConfig {
  /** Human-readable name for this experiment */
  name: string;
  /** One-line description of what changed */
  description: string;
  /** The parameter set being tested (arbitrary JSON-serializable object) */
  params: Record<string, any>;
  /** Which research domain this belongs to */
  domain: 'vision' | 'ecology' | 'treasury';
}

export interface ExperimentResult {
  /** Unique experiment ID (timestamp-based) */
  id: string;
  /** Config that produced this result */
  config: ExperimentConfig;
  /** The primary metric value (lower is better for vision error, higher is better for yield) */
  metric: number;
  /** Name of the metric (e.g. 'accuracy', 'species_count', 'apy') */
  metricName: string;
  /** Whether higher metric = better (true for accuracy/yield) or lower = better (false for error) */
  higherIsBetter: boolean;
  /** Seconds the experiment took to run */
  durationSeconds: number;
  /** Whether this beat the current baseline */
  improved: boolean;
  /** 'keep' | 'discard' | 'crash' */
  status: 'keep' | 'discard' | 'crash';
  /** ISO timestamp */
  timestamp: string;
  /** Optional error message if experiment crashed */
  error?: string;
  /** Optional extra data from the experiment */
  metadata?: Record<string, any>;
}

export interface ResearchState {
  /** Domain identifier */
  domain: string;
  /** Current best metric value */
  bestMetric: number;
  /** Current best parameter set */
  bestParams: Record<string, any>;
  /** Total experiments run */
  totalExperiments: number;
  /** Experiments that improved the metric */
  improvements: number;
  /** Experiments that crashed */
  crashes: number;
  /** All experiment results (append-only log) */
  history: ExperimentResult[];
}

// ---------------------------------------------------------------------------
// Results file management (TSV like autoresearch)
// ---------------------------------------------------------------------------

const RESULTS_DIR = path.join(process.cwd(), 'data', 'autoresearch');

function ensureResultsDir(): void {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
}

function getResultsPath(domain: string): string {
  return path.join(RESULTS_DIR, `${domain}-results.tsv`);
}

function getStatePath(domain: string): string {
  return path.join(RESULTS_DIR, `${domain}-state.json`);
}

/**
 * Load or initialize the research state for a domain.
 */
export function loadState(domain: string, metricName: string, higherIsBetter: boolean): ResearchState {
  ensureResultsDir();
  const statePath = getStatePath(domain);

  if (fs.existsSync(statePath)) {
    try {
      return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    } catch {
      logger.warn(`[AutoResearch] Corrupted state file for ${domain}, starting fresh`);
    }
  }

  return {
    domain,
    bestMetric: higherIsBetter ? -Infinity : Infinity,
    bestParams: {},
    totalExperiments: 0,
    improvements: 0,
    crashes: 0,
    history: [],
  };
}

/**
 * Save the research state for a domain.
 */
function saveState(state: ResearchState): void {
  ensureResultsDir();
  fs.writeFileSync(getStatePath(state.domain), JSON.stringify(state, null, 2));
}

/**
 * Append a result to the TSV log (human-readable, like autoresearch's results.tsv).
 */
function appendToTSV(result: ExperimentResult): void {
  ensureResultsDir();
  const tsvPath = getResultsPath(result.config.domain);
  const header = 'id\tmetric\tduration_s\tstatus\tdescription\ttimestamp\n';

  if (!fs.existsSync(tsvPath)) {
    fs.writeFileSync(tsvPath, header);
  }

  const line = [
    result.id,
    result.metric.toFixed(6),
    result.durationSeconds.toFixed(1),
    result.status,
    result.config.description,
    result.timestamp,
  ].join('\t') + '\n';

  fs.appendFileSync(tsvPath, line);
}

// ---------------------------------------------------------------------------
// Core experiment runner
// ---------------------------------------------------------------------------

export type ExperimentFn = (params: Record<string, any>) => Promise<{
  metric: number;
  metadata?: Record<string, any>;
}>;

/**
 * Run a single experiment and record the result.
 *
 * Pattern: modify params → run → measure → keep/discard
 *
 * @param config - What we're testing
 * @param runExperiment - The function that runs the actual experiment
 * @param state - Current research state (mutated in place)
 * @param metricName - Name of the metric being optimized
 * @param higherIsBetter - Direction of optimization
 * @returns The experiment result
 */
export async function runExperiment(
  config: ExperimentConfig,
  runExperiment: ExperimentFn,
  state: ResearchState,
  metricName: string,
  higherIsBetter: boolean,
): Promise<ExperimentResult> {
  const id = `${config.domain}-${Date.now()}`;
  const startTime = Date.now();

  logger.info(`[AutoResearch] Starting experiment: ${config.name} — ${config.description}`);

  let result: ExperimentResult;

  try {
    const { metric, metadata } = await runExperiment(config.params);
    const durationSeconds = (Date.now() - startTime) / 1000;

    const improved = higherIsBetter
      ? metric > state.bestMetric
      : metric < state.bestMetric;

    result = {
      id,
      config,
      metric,
      metricName,
      higherIsBetter,
      durationSeconds,
      improved,
      status: improved ? 'keep' : 'discard',
      timestamp: new Date().toISOString(),
      metadata,
    };

    if (improved) {
      state.bestMetric = metric;
      state.bestParams = { ...config.params };
      state.improvements++;
      logger.info(
        `[AutoResearch] ✓ IMPROVED: ${metricName}=${metric.toFixed(4)} (prev best: ${state.bestMetric.toFixed(4)}) — keeping "${config.description}"`,
      );
    } else {
      logger.info(
        `[AutoResearch] ✗ No improvement: ${metricName}=${metric.toFixed(4)} (best: ${state.bestMetric.toFixed(4)}) — discarding "${config.description}"`,
      );
    }
  } catch (error: any) {
    const durationSeconds = (Date.now() - startTime) / 1000;
    result = {
      id,
      config,
      metric: 0,
      metricName,
      higherIsBetter,
      durationSeconds,
      improved: false,
      status: 'crash',
      timestamp: new Date().toISOString(),
      error: error?.message || String(error),
    };
    state.crashes++;
    logger.error(`[AutoResearch] ✗ CRASH: "${config.description}" — ${result.error}`);
  }

  // Update state
  state.totalExperiments++;
  state.history.push(result);
  saveState(state);
  appendToTSV(result);

  // Audit trail
  audit(
    'AUTORESEARCH',
    `${config.domain}/${config.name}: ${metricName}=${result.metric.toFixed(4)} status=${result.status}`,
    'autoresearch',
    result.status === 'crash' ? 'warn' : 'info',
  );

  return result;
}

// ---------------------------------------------------------------------------
// Batch runner (run N experiments in sequence, like sleeping overnight)
// ---------------------------------------------------------------------------

export interface BatchConfig {
  domain: 'vision' | 'ecology' | 'treasury';
  metricName: string;
  higherIsBetter: boolean;
  /** Maximum time budget in seconds (like autoresearch's 5-min runs) */
  timeBudgetPerExperiment: number;
  /** Maximum total experiments to run */
  maxExperiments: number;
  /** Generator that produces experiment configs to try */
  experimentGenerator: (state: ResearchState) => AsyncGenerator<ExperimentConfig>;
  /** The experiment function */
  experimentFn: ExperimentFn;
}

/**
 * Run a batch of experiments, tracking results and keeping the best.
 * This is the main "overnight research" loop.
 */
export async function runBatch(batchConfig: BatchConfig): Promise<{
  state: ResearchState;
  results: ExperimentResult[];
}> {
  const state = loadState(batchConfig.domain, batchConfig.metricName, batchConfig.higherIsBetter);
  const results: ExperimentResult[] = [];

  logger.info(
    `[AutoResearch] Starting batch for "${batchConfig.domain}" — max ${batchConfig.maxExperiments} experiments, ${batchConfig.timeBudgetPerExperiment}s each`,
  );
  logger.info(
    `[AutoResearch] Current best ${batchConfig.metricName}: ${state.bestMetric === Infinity || state.bestMetric === -Infinity ? 'none (first run)' : state.bestMetric.toFixed(4)}`,
  );

  const generator = batchConfig.experimentGenerator(state);
  let count = 0;

  for await (const config of generator) {
    if (count >= batchConfig.maxExperiments) break;

    const result = await runExperiment(
      config,
      batchConfig.experimentFn,
      state,
      batchConfig.metricName,
      batchConfig.higherIsBetter,
    );

    results.push(result);
    count++;

    // Log running summary
    const keepRate = results.filter(r => r.status === 'keep').length / results.length;
    logger.info(
      `[AutoResearch] Progress: ${count}/${batchConfig.maxExperiments} experiments, ` +
      `${results.filter(r => r.status === 'keep').length} improvements, ` +
      `keep rate: ${(keepRate * 100).toFixed(0)}%`,
    );
  }

  logger.info(
    `[AutoResearch] Batch complete for "${batchConfig.domain}": ` +
    `${results.length} experiments, ` +
    `${results.filter(r => r.status === 'keep').length} kept, ` +
    `${results.filter(r => r.status === 'crash').length} crashed. ` +
    `Best ${batchConfig.metricName}: ${state.bestMetric.toFixed(4)}`,
  );

  return { state, results };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Get a formatted summary of research state for a domain.
 */
export function getSummary(domain: string): string {
  const statePath = getStatePath(domain);
  if (!fs.existsSync(statePath)) return `No research data for domain "${domain}"`;

  const state: ResearchState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const recent = state.history.slice(-5);

  return [
    `=== AutoResearch: ${domain} ===`,
    `Total experiments: ${state.totalExperiments}`,
    `Improvements: ${state.improvements}`,
    `Crashes: ${state.crashes}`,
    `Best metric: ${state.bestMetric.toFixed(4)}`,
    `Best params: ${JSON.stringify(state.bestParams, null, 2)}`,
    ``,
    `Last 5 experiments:`,
    ...recent.map(r => `  ${r.status.padEnd(7)} ${r.metric.toFixed(4)} — ${r.config.description}`),
  ].join('\n');
}
