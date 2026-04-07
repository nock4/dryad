/**
 * AutoResearch Loop 1: Vision Verification Tuning
 *
 * Optimizes the vision verification pipeline by iterating on:
 *   - Prompt templates (wording, structure, instruction clarity)
 *   - Scoring thresholds (approval cutoff)
 *   - Checklist weightings (which indicators matter most)
 *   - Temperature / model parameters
 *
 * Metric: accuracy against a labeled ground-truth dataset of
 * contractor photos (correct approve/reject decisions).
 *
 * Autoresearch pattern:
 *   modify prompt/params → run against eval set → measure accuracy → keep/discard
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
import { WORK_TYPE_CHECKLISTS, type VisualChecklist } from '../services/visionVerify.ts';

// ---------------------------------------------------------------------------
// Ground truth dataset
// ---------------------------------------------------------------------------

export interface LabeledPhoto {
  /** Path to the image file */
  photoPath: string;
  /** Work type claimed by the contractor */
  workType: string;
  /** Description of the work order */
  workDescription: string;
  /** Parcel address */
  parcelAddress: string;
  /** Ground truth: should this be approved? */
  shouldApprove: boolean;
  /** Optional ground truth score (0.0-1.0) */
  expectedScore?: number;
  /** Optional notes about why this label was assigned */
  notes?: string;
}

const EVAL_DATASET_PATH = path.join(process.cwd(), 'data', 'autoresearch', 'vision-eval-set.json');

/**
 * Load the labeled evaluation dataset.
 * If none exists, creates a template with instructions.
 */
export function loadEvalDataset(): LabeledPhoto[] {
  if (fs.existsSync(EVAL_DATASET_PATH)) {
    return JSON.parse(fs.readFileSync(EVAL_DATASET_PATH, 'utf-8'));
  }

  // Create template dataset with instructions
  const template: LabeledPhoto[] = [
    {
      photoPath: 'data/eval-photos/good-invasive-removal-01.jpg',
      workType: 'invasive_removal',
      workDescription: 'Remove Tree of Heaven from lot at 4501 25th St',
      parcelAddress: '4501 25th St, Detroit, MI',
      shouldApprove: true,
      expectedScore: 0.85,
      notes: 'Clear photo of cut stumps with herbicide dye visible',
    },
    {
      photoPath: 'data/eval-photos/bad-wrong-location-01.jpg',
      workType: 'mowing',
      workDescription: 'Mow lot at 4487 25th St',
      parcelAddress: '4487 25th St, Detroit, MI',
      shouldApprove: false,
      expectedScore: 0.15,
      notes: 'Photo is clearly from a different neighborhood (building visible)',
    },
    {
      photoPath: 'data/eval-photos/ambiguous-planting-01.jpg',
      workType: 'native_planting',
      workDescription: 'Plant pollinator plugs at 4513 25th St',
      parcelAddress: '4513 25th St, Detroit, MI',
      shouldApprove: true,
      expectedScore: 0.65,
      notes: 'Some new plants visible but photo is low quality',
    },
  ];

  const dir = path.dirname(EVAL_DATASET_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(EVAL_DATASET_PATH, JSON.stringify(template, null, 2));

  logger.info(`[VisionTuner] Created template eval dataset at ${EVAL_DATASET_PATH}`);
  logger.info(`[VisionTuner] Add real labeled photos and update the file to start tuning.`);

  return template;
}

// ---------------------------------------------------------------------------
// Tunable parameters
// ---------------------------------------------------------------------------

export interface VisionTuningParams {
  /** Approval threshold (0.0-1.0) */
  approvalThreshold: number;
  /** LLM temperature for vision calls */
  temperature: number;
  /** Max tokens for vision response */
  maxTokens: number;
  /** Prompt style variant */
  promptStyle: 'structured' | 'conversational' | 'checklist_only' | 'strict_auditor';
  /** Whether to include red flags in prompt */
  includeRedFlags: boolean;
  /** Whether to include scoring guide in prompt */
  includeScoringGuide: boolean;
  /** Number of indicators to include per work type */
  maxIndicators: number;
  /** Prefix instruction emphasis */
  emphasisLevel: 'neutral' | 'strict' | 'lenient';
}

const BASELINE_PARAMS: VisionTuningParams = {
  approvalThreshold: 0.6,
  temperature: 0.1,
  maxTokens: 500,
  promptStyle: 'structured',
  includeRedFlags: true,
  includeScoringGuide: true,
  maxIndicators: 6,
  emphasisLevel: 'neutral',
};

// ---------------------------------------------------------------------------
// Prompt variants (the main thing we're tuning)
// ---------------------------------------------------------------------------

function buildTunedPrompt(
  params: VisionTuningParams,
  workType: string,
  workDescription: string,
  parcelAddress: string,
): string {
  const checklist = WORK_TYPE_CHECKLISTS[workType] || {
    description: 'General land management work',
    expectedIndicators: ['Evidence of physical work', 'Outdoor lot visible'],
    redFlags: ['Photo is indoors', 'No evidence of work'],
  };

  const indicators = checklist.expectedIndicators.slice(0, params.maxIndicators);

  // Emphasis prefix varies by tuning
  const emphasisMap: Record<string, string> = {
    neutral: 'Analyze this photo objectively.',
    strict: 'You are a strict auditor. Only approve photos with CLEAR, UNAMBIGUOUS evidence of work. When in doubt, reject.',
    lenient: 'You are evaluating a community volunteer project. Give reasonable benefit of the doubt for genuine effort, but still reject obvious fraud or irrelevant photos.',
  };

  if (params.promptStyle === 'checklist_only') {
    return `Verify this contractor photo. Work: ${workDescription} at ${parcelAddress}.
Type: ${checklist.description}

Check for: ${indicators.join('; ')}
${params.includeRedFlags ? `Watch for: ${checklist.redFlags.join('; ')}` : ''}

Respond JSON only: {"score": 0.0-1.0, "reasoning": "...", "matched_indicators": [...], "flags_triggered": [...]}`;
  }

  if (params.promptStyle === 'conversational') {
    return `I need you to look at this photo from a contractor who says they did "${workDescription}" at ${parcelAddress} (${checklist.description}).

${emphasisMap[params.emphasisLevel]}

Does the photo actually show this work was done? Look for things like: ${indicators.join(', ')}.
${params.includeRedFlags ? `Be suspicious if you see: ${checklist.redFlags.join(', ')}.` : ''}

Give me a JSON response: {"score": 0.0-1.0, "reasoning": "brief explanation", "matched_indicators": ["what you found"], "flags_triggered": ["concerns"]}`;
  }

  if (params.promptStyle === 'strict_auditor') {
    return `AUDIT VERIFICATION REQUEST

Subject: Contractor proof-of-work photo review
Work Order: ${workDescription}
Location: ${parcelAddress}
Category: ${checklist.description}

${emphasisMap.strict}

REQUIRED EVIDENCE (must find at least 2):
${indicators.map((i, idx) => `  ${idx + 1}. ${i}`).join('\n')}

DISQUALIFYING FACTORS:
${checklist.redFlags.map((f, idx) => `  ${idx + 1}. ${f}`).join('\n')}

OUTPUT FORMAT (JSON only, no other text):
{"score": <0.0-1.0>, "reasoning": "<2-3 sentences>", "matched_indicators": [<matched>], "flags_triggered": [<flags>]}

${params.includeScoringGuide ? `SCORING: 0.8+ clear evidence, 0.6-0.79 likely, 0.4-0.59 uncertain, <0.4 reject` : ''}`;
  }

  // Default: 'structured' (current production prompt style)
  return `You are a land management verification system for Dryad. ${emphasisMap[params.emphasisLevel]}

## Work Order Details
- **Work type:** ${checklist.description}
- **Specific task:** ${workDescription}
- **Parcel:** ${parcelAddress}

## Expected Visual Indicators
${indicators.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}

${params.includeRedFlags ? `## Red Flags\n${checklist.redFlags.map((f, idx) => `${idx + 1}. ${f}`).join('\n')}` : ''}

## Response Format
Respond with ONLY a valid JSON object:
{"score": <0.0-1.0>, "reasoning": "<2-3 sentences>", "matched_indicators": [...], "flags_triggered": [...]}

${params.includeScoringGuide ? `Scoring guide:
- 0.8–1.0: Clear evidence of the claimed work
- 0.6–0.79: Likely shows the claimed work
- 0.4–0.59: Uncertain — weak evidence
- 0.0–0.39: Does not show the claimed work` : ''}`;
}

// ---------------------------------------------------------------------------
// Vision experiment function
// ---------------------------------------------------------------------------

async function callVisionForEval(
  prompt: string,
  imageBuffer: Buffer,
  temperature: number,
  maxTokens: number,
): Promise<{ score: number; reasoning: string; matchedIndicators: string[]; flagsTriggered: string[] }> {
  const veniceKey = process.env.VENICE_API_KEY;
  const veniceBaseUrl = process.env.VENICE_BASE_URL || 'https://api.venice.ai/api/v1';
  const veniceVisionModel = process.env.VENICE_VISION_MODEL || process.env.VENICE_LARGE_MODEL || 'qwen/qwen-2.5-vl';

  const base64 = imageBuffer.toString('base64');
  const content = [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
  ];

  const apiKey = veniceKey || process.env.OPENAI_API_KEY;
  const baseUrl = veniceKey ? veniceBaseUrl : 'https://api.openai.com/v1';
  const model = veniceKey ? veniceVisionModel : 'gpt-4o-mini';

  if (!apiKey) throw new Error('No vision API key configured');

  const body: any = {
    model,
    messages: [{ role: 'user', content }],
    max_tokens: maxTokens,
    temperature,
  };
  if (veniceKey) {
    body.venice_parameters = { disable_thinking: true, include_venice_system_prompt: false };
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) throw new Error(`Vision API error: ${resp.status}`);

  const data = (await resp.json()) as any;
  const raw = data?.choices?.[0]?.message?.content || '';

  // Parse JSON response
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
  }

  try {
    const parsed = JSON.parse(cleaned);
    return {
      score: Math.max(0, Math.min(1, Number(parsed.score) || 0)),
      reasoning: String(parsed.reasoning || ''),
      matchedIndicators: Array.isArray(parsed.matched_indicators) ? parsed.matched_indicators : [],
      flagsTriggered: Array.isArray(parsed.flags_triggered) ? parsed.flags_triggered : [],
    };
  } catch {
    const scoreMatch = raw.match(/"score"\s*:\s*([\d.]+)/);
    return {
      score: scoreMatch ? parseFloat(scoreMatch[1]) : 0,
      reasoning: `Parse failed: ${raw.slice(0, 100)}`,
      matchedIndicators: [],
      flagsTriggered: ['response_parse_failure'],
    };
  }
}

/**
 * Create the experiment function that evaluates a parameter set
 * against the labeled dataset.
 */
function createVisionExperimentFn(evalSet: LabeledPhoto[]): ExperimentFn {
  return async (params: Record<string, any>) => {
    const p = params as VisionTuningParams;
    let correctDecisions = 0;
    let totalScoreError = 0;
    let totalEvaluated = 0;
    const perPhotoResults: Array<{
      photo: string;
      predicted: boolean;
      expected: boolean;
      score: number;
      correct: boolean;
    }> = [];

    for (const photo of evalSet) {
      // Skip if photo file doesn't exist
      if (!fs.existsSync(photo.photoPath)) {
        logger.warn(`[VisionTuner] Skipping missing photo: ${photo.photoPath}`);
        continue;
      }

      const imageBuffer = fs.readFileSync(photo.photoPath);
      const prompt = buildTunedPrompt(p, photo.workType, photo.workDescription, photo.parcelAddress);

      try {
        const result = await callVisionForEval(prompt, imageBuffer, p.temperature, p.maxTokens);
        const predicted = result.score >= p.approvalThreshold;
        const correct = predicted === photo.shouldApprove;

        if (correct) correctDecisions++;
        if (photo.expectedScore !== undefined) {
          totalScoreError += Math.abs(result.score - photo.expectedScore);
        }
        totalEvaluated++;

        perPhotoResults.push({
          photo: photo.photoPath,
          predicted,
          expected: photo.shouldApprove,
          score: result.score,
          correct,
        });
      } catch (err: any) {
        logger.warn(`[VisionTuner] Failed on ${photo.photoPath}: ${err?.message}`);
        totalEvaluated++;
        perPhotoResults.push({
          photo: photo.photoPath,
          predicted: false,
          expected: photo.shouldApprove,
          score: 0,
          correct: !photo.shouldApprove, // false negative = wrong for positives
        });
      }
    }

    if (totalEvaluated === 0) {
      throw new Error('No photos could be evaluated — check eval dataset paths');
    }

    const accuracy = correctDecisions / totalEvaluated;
    const avgScoreError = totalScoreError / totalEvaluated;

    return {
      metric: accuracy,
      metadata: {
        totalEvaluated,
        correctDecisions,
        avgScoreError,
        perPhotoResults,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Parameter mutation (generating experiment variants)
// ---------------------------------------------------------------------------

function mutateParams(base: VisionTuningParams, rng: () => number): VisionTuningParams {
  const params = { ...base };

  // Pick a random dimension to mutate
  const dimension = Math.floor(rng() * 7);

  switch (dimension) {
    case 0: // Threshold
      params.approvalThreshold = Math.max(0.3, Math.min(0.9, params.approvalThreshold + (rng() - 0.5) * 0.2));
      break;
    case 1: // Temperature
      params.temperature = Math.max(0.0, Math.min(0.5, params.temperature + (rng() - 0.5) * 0.15));
      break;
    case 2: // Prompt style
      params.promptStyle = (['structured', 'conversational', 'checklist_only', 'strict_auditor'] as const)[
        Math.floor(rng() * 4)
      ];
      break;
    case 3: // Red flags
      params.includeRedFlags = !params.includeRedFlags;
      break;
    case 4: // Scoring guide
      params.includeScoringGuide = !params.includeScoringGuide;
      break;
    case 5: // Max indicators
      params.maxIndicators = Math.max(2, Math.min(10, params.maxIndicators + Math.floor((rng() - 0.5) * 4)));
      break;
    case 6: // Emphasis
      params.emphasisLevel = (['neutral', 'strict', 'lenient'] as const)[Math.floor(rng() * 3)];
      break;
  }

  return params;
}

function describeChange(base: VisionTuningParams, mutated: VisionTuningParams): string {
  const changes: string[] = [];
  if (base.approvalThreshold !== mutated.approvalThreshold)
    changes.push(`threshold ${base.approvalThreshold.toFixed(2)}→${mutated.approvalThreshold.toFixed(2)}`);
  if (base.temperature !== mutated.temperature)
    changes.push(`temp ${base.temperature.toFixed(2)}→${mutated.temperature.toFixed(2)}`);
  if (base.promptStyle !== mutated.promptStyle)
    changes.push(`style ${base.promptStyle}→${mutated.promptStyle}`);
  if (base.includeRedFlags !== mutated.includeRedFlags)
    changes.push(`redFlags ${mutated.includeRedFlags}`);
  if (base.includeScoringGuide !== mutated.includeScoringGuide)
    changes.push(`scoringGuide ${mutated.includeScoringGuide}`);
  if (base.maxIndicators !== mutated.maxIndicators)
    changes.push(`indicators ${base.maxIndicators}→${mutated.maxIndicators}`);
  if (base.emphasisLevel !== mutated.emphasisLevel)
    changes.push(`emphasis ${base.emphasisLevel}→${mutated.emphasisLevel}`);
  return changes.join(', ') || 'no change';
}

// ---------------------------------------------------------------------------
// Public API: run the vision tuning loop
// ---------------------------------------------------------------------------

/**
 * Run the vision verification tuning loop.
 * @param maxExperiments - How many experiments to run (default 20)
 */
export async function runVisionTuning(maxExperiments: number = 20): Promise<void> {
  const evalSet = loadEvalDataset();
  const experimentFn = createVisionExperimentFn(evalSet);

  // Simple seeded RNG for reproducibility
  let seed = Date.now();
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff;
  };

  async function* experimentGenerator(state: ResearchState): AsyncGenerator<ExperimentConfig> {
    // First experiment: baseline with current params
    if (state.totalExperiments === 0) {
      yield {
        name: 'baseline',
        description: 'Baseline with current production params',
        params: BASELINE_PARAMS,
        domain: 'vision',
      };
    }

    // Subsequent experiments: mutate from best known params
    let iteration = 0;
    while (true) {
      const baseParams = (state.bestParams as VisionTuningParams) || BASELINE_PARAMS;
      const mutated = mutateParams(baseParams, rng);
      const change = describeChange(baseParams, mutated);

      yield {
        name: `mutation-${iteration++}`,
        description: change,
        params: mutated,
        domain: 'vision',
      };
    }
  }

  await runBatch({
    domain: 'vision',
    metricName: 'accuracy',
    higherIsBetter: true,
    timeBudgetPerExperiment: 120, // 2 minutes per eval run
    maxExperiments,
    experimentGenerator,
    experimentFn,
  });
}
