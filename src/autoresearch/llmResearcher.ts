/**
 * LLM-in-the-Loop Researcher
 *
 * The real autoresearch pattern: an LLM reads the experiment history,
 * reasons about what to try next, proposes a specific change with
 * a hypothesis, runs the experiment, evaluates the result, and loops.
 *
 * This is NOT random parameter mutation. The LLM forms hypotheses
 * informed by the pattern of prior successes and failures, just like
 * a human researcher would.
 *
 * Each iteration:
 *   1. LLM reads results.tsv + current best params
 *   2. LLM reasons about what change might improve the metric
 *   3. LLM outputs a specific parameter change + hypothesis
 *   4. We run the experiment and measure the metric
 *   5. LLM sees the result, updates its mental model
 *   6. If improved → keep. If not → revert.
 *   7. Back to step 1
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@elizaos/core';
import { audit } from '../services/auditLog.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResearcherConfig {
  /** Domain name for file organization */
  domain: string;
  /** Description of what we're optimizing (fed to the LLM) */
  problemDescription: string;
  /** Name of the metric */
  metricName: string;
  /** Is higher better? */
  higherIsBetter: boolean;
  /** JSON schema describing the parameter space (fed to the LLM) */
  parameterSchema: string;
  /** Current best parameters as JSON */
  currentBestParams: Record<string, any>;
  /** Additional context the LLM should know (constraints, domain knowledge) */
  domainContext: string;
  /** Function that runs an experiment given params, returns metric + metadata */
  experimentFn: (params: Record<string, any>) => Promise<{ metric: number; metadata?: Record<string, any> }>;
  /** Max experiments per session */
  maxExperiments: number;
  /** LLM model to use for reasoning */
  model?: string;
}

interface ExperimentLogEntry {
  iteration: number;
  hypothesis: string;
  paramChange: string;
  params: Record<string, any>;
  metric: number;
  status: 'keep' | 'discard' | 'crash';
  reasoning: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

interface ResearchSession {
  domain: string;
  startedAt: string;
  bestMetric: number;
  bestParams: Record<string, any>;
  experiments: ExperimentLogEntry[];
}

// ---------------------------------------------------------------------------
// File paths
// ---------------------------------------------------------------------------

const RESULTS_DIR = path.join(process.cwd(), 'data', 'autoresearch');

function ensureDir(): void {
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

function getSessionPath(domain: string): string {
  return path.join(RESULTS_DIR, `${domain}-session.json`);
}

function getTSVPath(domain: string): string {
  return path.join(RESULTS_DIR, `${domain}-results.tsv`);
}

function loadSession(domain: string): ResearchSession | null {
  const p = getSessionPath(domain);
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
  }
  return null;
}

function saveSession(session: ResearchSession): void {
  ensureDir();
  fs.writeFileSync(getSessionPath(session.domain), JSON.stringify(session, null, 2));
}

function appendTSV(domain: string, entry: ExperimentLogEntry): void {
  ensureDir();
  const tsvPath = getTSVPath(domain);
  if (!fs.existsSync(tsvPath)) {
    fs.writeFileSync(tsvPath, 'iteration\tmetric\tstatus\thypothesis\tparam_change\ttimestamp\n');
  }
  const line = [
    entry.iteration,
    entry.metric.toFixed(6),
    entry.status,
    entry.hypothesis.replace(/\t/g, ' ').slice(0, 120),
    entry.paramChange.replace(/\t/g, ' ').slice(0, 80),
    entry.timestamp,
  ].join('\t') + '\n';
  fs.appendFileSync(tsvPath, line);
}

// ---------------------------------------------------------------------------
// LLM calls
// ---------------------------------------------------------------------------

async function callLLM(systemPrompt: string, userPrompt: string, model?: string): Promise<string> {
  const veniceKey = process.env.VENICE_API_KEY;
  const veniceBase = process.env.VENICE_BASE_URL || 'https://api.venice.ai/api/v1';
  const veniceModel = model || process.env.VENICE_LARGE_MODEL || 'llama-3.3-70b';

  const openaiKey = process.env.OPENAI_API_KEY;

  const apiKey = veniceKey || openaiKey;
  const baseUrl = veniceKey ? veniceBase : 'https://api.openai.com/v1';
  const useModel = veniceKey ? veniceModel : (model || 'gpt-4o-mini');

  if (!apiKey) throw new Error('No LLM API key configured (VENICE_API_KEY or OPENAI_API_KEY)');

  const body: any = {
    model: useModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 1500,
    temperature: 0.7, // Creative enough to explore, focused enough to converge
  };

  if (veniceKey) {
    body.venice_parameters = { disable_thinking: false, include_venice_system_prompt: false };
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000), // 60s for reasoning
  });

  if (!resp.ok) throw new Error(`LLM API error: ${resp.status} ${resp.statusText}`);

  const data = (await resp.json()) as any;
  return data?.choices?.[0]?.message?.content || '';
}

// ---------------------------------------------------------------------------
// The research system prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(config: ResearcherConfig): string {
  return `You are an autonomous research agent optimizing a real-world system. You follow the scientific method: observe results, form hypotheses, design experiments, analyze outcomes, and iterate.

## Your Domain
${config.problemDescription}

## What You're Optimizing
Metric: ${config.metricName} (${config.higherIsBetter ? 'HIGHER is better' : 'LOWER is better'})

## Parameter Space
${config.parameterSchema}

## Domain Knowledge & Constraints
${config.domainContext}

## Your Process
For each iteration:
1. Review all prior experiment results carefully
2. Identify patterns: what changes helped? what hurt? what had no effect?
3. Form a specific hypothesis about why a change might improve the metric
4. Propose ONE targeted parameter change to test that hypothesis
5. After seeing the result, update your understanding

## Response Format
You MUST respond with ONLY a valid JSON object (no markdown, no explanation outside the JSON):
{
  "hypothesis": "One sentence explaining WHY you think this change will improve the metric",
  "param_change_description": "Brief description of what you're changing",
  "params": { <complete parameter object with your proposed change> }
}

CRITICAL RULES:
- Change only 1-2 parameters at a time so you can attribute causation
- The "params" field must be a COMPLETE valid parameter object (not a partial diff)
- Base your decisions on the experimental evidence, not just intuition
- If you see a pattern where X correlates with improvement, test if more X helps
- If the last 3 experiments all failed, try a different direction entirely
- Consider interaction effects between parameters`;
}

function buildExperimentPrompt(
  config: ResearcherConfig,
  session: ResearchSession,
  iteration: number,
): string {
  const recentExperiments = session.experiments.slice(-15); // Last 15 for context window

  let experimentHistory = 'No experiments yet — this is the first iteration. Start by proposing a change from the baseline.';

  if (recentExperiments.length > 0) {
    const best = session.bestMetric;
    const kept = session.experiments.filter(e => e.status === 'keep').length;
    const total = session.experiments.length;

    experimentHistory = `## Experiment History (${total} total, ${kept} improvements)
Current best ${config.metricName}: ${best.toFixed(4)}

### Recent experiments (most recent first):
${recentExperiments
  .reverse()
  .map(e =>
    `- [${e.status.toUpperCase()}] ${config.metricName}=${e.metric.toFixed(4)} | "${e.paramChange}" | Hypothesis: "${e.hypothesis}"`,
  )
  .join('\n')}

### Current best parameters:
\`\`\`json
${JSON.stringify(session.bestParams, null, 2)}
\`\`\``;
  }

  return `## Iteration ${iteration + 1}

${experimentHistory}

Based on the experiment history above, propose your next experiment. Remember:
- Only change 1-2 parameters from the current best
- Form a clear hypothesis about why this change should help
- Output valid JSON only`;
}

function buildReflectionPrompt(
  config: ResearcherConfig,
  entry: ExperimentLogEntry,
  session: ResearchSession,
): string {
  return `## Experiment Result

Your hypothesis: "${entry.hypothesis}"
Change: "${entry.paramChange}"
Result: ${config.metricName} = ${entry.metric.toFixed(4)}
Status: ${entry.status.toUpperCase()}
${entry.status === 'keep' ? `This IMPROVED the metric from ${(session.bestMetric).toFixed(4)} → ${entry.metric.toFixed(4)}` : `This did NOT improve the metric. Best remains ${session.bestMetric.toFixed(4)}`}

${entry.metadata ? `Additional data: ${JSON.stringify(entry.metadata, null, 2)}` : ''}

Briefly reflect on this result in 1-2 sentences. What did you learn? How does this update your understanding?

Respond with ONLY a JSON object:
{"reflection": "Your 1-2 sentence reflection on what this result means"}`;
}

// ---------------------------------------------------------------------------
// Parse LLM proposal
// ---------------------------------------------------------------------------

function parseLLMProposal(raw: string): {
  hypothesis: string;
  paramChangeDescription: string;
  params: Record<string, any>;
} | null {
  // Strip markdown code fences
  let cleaned = raw.trim();
  // Remove thinking tags if present
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
  }
  // Find the JSON object
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.params || !parsed.hypothesis) return null;
    return {
      hypothesis: String(parsed.hypothesis),
      paramChangeDescription: String(parsed.param_change_description || parsed.paramChange || 'unspecified'),
      params: parsed.params,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main research loop
// ---------------------------------------------------------------------------

/**
 * Run the LLM-in-the-loop research cycle.
 * This is the real autoresearch pattern.
 */
export async function runLLMResearchLoop(config: ResearcherConfig): Promise<ResearchSession> {
  ensureDir();

  // Load or initialize session
  let session = loadSession(config.domain) || {
    domain: config.domain,
    startedAt: new Date().toISOString(),
    bestMetric: config.higherIsBetter ? -Infinity : Infinity,
    bestParams: config.currentBestParams,
    experiments: [],
  };

  const systemPrompt = buildSystemPrompt(config);
  const startIteration = session.experiments.length;

  logger.info(`[LLMResearcher] Starting research loop for "${config.domain}"`);
  logger.info(`[LLMResearcher] ${config.maxExperiments} iterations, starting from experiment #${startIteration}`);
  if (session.bestMetric !== Infinity && session.bestMetric !== -Infinity) {
    logger.info(`[LLMResearcher] Resuming — current best ${config.metricName}: ${session.bestMetric.toFixed(4)}`);
  }

  for (let i = startIteration; i < startIteration + config.maxExperiments; i++) {
    const iterStart = Date.now();

    logger.info(`\n[LLMResearcher] === Iteration ${i + 1}/${startIteration + config.maxExperiments} ===`);

    // Step 1: Ask LLM to propose an experiment
    logger.info(`[LLMResearcher] Asking LLM to propose next experiment...`);
    const proposalPrompt = buildExperimentPrompt(config, session, i);

    let proposal: ReturnType<typeof parseLLMProposal> = null;
    let attempts = 0;
    while (!proposal && attempts < 3) {
      try {
        const raw = await callLLM(systemPrompt, proposalPrompt, config.model);
        proposal = parseLLMProposal(raw);
        if (!proposal) {
          logger.warn(`[LLMResearcher] Failed to parse LLM proposal (attempt ${attempts + 1}), retrying...`);
          logger.warn(`[LLMResearcher] Raw response: ${raw.slice(0, 200)}`);
        }
      } catch (err: any) {
        logger.warn(`[LLMResearcher] LLM call failed (attempt ${attempts + 1}): ${err?.message}`);
      }
      attempts++;
    }

    if (!proposal) {
      logger.error(`[LLMResearcher] Could not get valid proposal after 3 attempts, skipping iteration`);
      continue;
    }

    logger.info(`[LLMResearcher] Hypothesis: "${proposal.hypothesis}"`);
    logger.info(`[LLMResearcher] Change: "${proposal.paramChangeDescription}"`);

    // Step 2: Run the experiment
    logger.info(`[LLMResearcher] Running experiment...`);
    let entry: ExperimentLogEntry;

    try {
      const { metric, metadata } = await config.experimentFn(proposal.params);

      const improved = config.higherIsBetter
        ? metric > session.bestMetric
        : metric < session.bestMetric;

      entry = {
        iteration: i,
        hypothesis: proposal.hypothesis,
        paramChange: proposal.paramChangeDescription,
        params: proposal.params,
        metric,
        status: improved ? 'keep' : 'discard',
        reasoning: '',
        timestamp: new Date().toISOString(),
        metadata,
      };

      if (improved) {
        session.bestMetric = metric;
        session.bestParams = { ...proposal.params };
        logger.info(`[LLMResearcher] ✓ IMPROVED: ${config.metricName} = ${metric.toFixed(4)} — KEEPING`);
      } else {
        logger.info(`[LLMResearcher] ✗ No improvement: ${config.metricName} = ${metric.toFixed(4)} (best: ${session.bestMetric.toFixed(4)}) — DISCARDING`);
      }
    } catch (err: any) {
      entry = {
        iteration: i,
        hypothesis: proposal.hypothesis,
        paramChange: proposal.paramChangeDescription,
        params: proposal.params,
        metric: 0,
        status: 'crash',
        reasoning: `Crash: ${err?.message}`,
        timestamp: new Date().toISOString(),
      };
      logger.error(`[LLMResearcher] ✗ CRASH: ${err?.message}`);
    }

    // Step 3: Ask LLM to reflect on the result
    try {
      const reflectionRaw = await callLLM(systemPrompt, buildReflectionPrompt(config, entry, session), config.model);
      const reflectionClean = reflectionRaw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      const reflectionMatch = reflectionClean.match(/\{[\s\S]*\}/);
      if (reflectionMatch) {
        const reflection = JSON.parse(reflectionMatch[0]);
        entry.reasoning = reflection.reflection || '';
        logger.info(`[LLMResearcher] Reflection: "${entry.reasoning}"`);
      }
    } catch {
      // Reflection is nice-to-have, not critical
    }

    // Save results
    session.experiments.push(entry);
    saveSession(session);
    appendTSV(config.domain, entry);

    audit(
      'AUTORESEARCH',
      `${config.domain} #${i + 1}: ${config.metricName}=${entry.metric.toFixed(4)} [${entry.status}] "${entry.hypothesis.slice(0, 80)}"`,
      'autoresearch',
      entry.status === 'crash' ? 'warn' : 'info',
    );

    const elapsed = ((Date.now() - iterStart) / 1000).toFixed(1);
    logger.info(`[LLMResearcher] Iteration took ${elapsed}s`);

    // Brief pause between iterations to avoid rate limits
    await new Promise(r => setTimeout(r, 2000));
  }

  // Final summary
  const kept = session.experiments.filter(e => e.status === 'keep').length;
  const total = session.experiments.length;
  logger.info(`\n[LLMResearcher] === Research Complete ===`);
  logger.info(`[LLMResearcher] Domain: ${config.domain}`);
  logger.info(`[LLMResearcher] Total experiments: ${total}`);
  logger.info(`[LLMResearcher] Improvements: ${kept} (${(kept / total * 100).toFixed(0)}% keep rate)`);
  logger.info(`[LLMResearcher] Best ${config.metricName}: ${session.bestMetric.toFixed(4)}`);
  logger.info(`[LLMResearcher] Best params:\n${JSON.stringify(session.bestParams, null, 2)}`);

  return session;
}

/**
 * Get a human-readable summary of a research session.
 */
export function getResearchSummary(domain: string): string {
  const session = loadSession(domain);
  if (!session) return `No research session found for "${domain}"`;

  const kept = session.experiments.filter(e => e.status === 'keep').length;
  const crashed = session.experiments.filter(e => e.status === 'crash').length;
  const recent = session.experiments.slice(-10);

  return [
    `=== LLM Research: ${domain} ===`,
    `Started: ${session.startedAt}`,
    `Experiments: ${session.experiments.length} (${kept} kept, ${crashed} crashed)`,
    `Best metric: ${session.bestMetric.toFixed(4)}`,
    ``,
    `Recent experiments:`,
    ...recent.map(e =>
      `  [${e.status.padEnd(7)}] metric=${e.metric.toFixed(4)} | "${e.paramChange}"` +
      (e.reasoning ? `\n           → ${e.reasoning}` : ''),
    ),
    ``,
    `Best parameters:`,
    JSON.stringify(session.bestParams, null, 2),
  ].join('\n');
}
