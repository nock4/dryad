/**
 * AutoResearch Loop 2: Ecological Strategy Optimization
 *
 * Optimizes land management strategies by iterating on:
 *   - Planting configurations (species mix, density, placement)
 *   - Invasive removal priorities (which species first, timing)
 *   - Maintenance schedules (mowing frequency, seasonal timing)
 *   - Monitoring strategies (survey frequency, indicator species)
 *
 * Metric: composite biodiversity score derived from iNaturalist observations
 * (species richness, native/invasive ratio, pollinator presence).
 *
 * Unlike vision tuning (which runs in minutes), ecology experiments
 * run over weeks/months. This loop tracks strategy changes over time
 * and correlates them with observed biodiversity outcomes.
 *
 * Autoresearch pattern:
 *   modify strategy → execute over season → measure biodiversity → keep/discard
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@elizaos/core';
import {
  type ExperimentConfig,
  type ExperimentFn,
  type ResearchState,
  runExperiment,
  loadState,
} from './experimentRunner.ts';
import { PARCEL_BOUNDS } from '../parcels.ts';

// ---------------------------------------------------------------------------
// Ecology strategy parameters
// ---------------------------------------------------------------------------

export interface EcologyParams {
  /** Species mix ratios for new plantings */
  plantingMix: {
    grasses: number;      // 0.0-1.0 proportion
    wildflowers: number;
    shrubs: number;
    trees: number;
  };
  /** Invasive removal priority order */
  invasivePriority: ('tree_of_heaven' | 'buckthorn' | 'knapweed' | 'phragmites' | 'garlic_mustard')[];
  /** Mowing frequency during establishment (times per growing season) */
  mowingFrequency: number;
  /** Mowing height in inches */
  mowingHeight: number;
  /** Whether to apply prescribed burn in year 3+ */
  usePrescribedBurn: boolean;
  /** Monthly monitoring frequency */
  monitoringFrequency: number;
  /** Indicator species to track (subset focused on) */
  focusIndicators: string[];
  /** Soil amendment strategy */
  soilAmendment: 'none' | 'compost_light' | 'compost_heavy' | 'mycorrhizal';
  /** Planting season preference */
  plantingSeason: 'spring' | 'fall' | 'both';
  /** Native seed source region */
  seedRegion: 'local_ecotype' | 'regional_mix' | 'national_mix';
}

const BASELINE_ECOLOGY_PARAMS: EcologyParams = {
  plantingMix: { grasses: 0.4, wildflowers: 0.35, shrubs: 0.2, trees: 0.05 },
  invasivePriority: ['tree_of_heaven', 'buckthorn', 'knapweed'],
  mowingFrequency: 2,
  mowingHeight: 6,
  usePrescribedBurn: false,
  monitoringFrequency: 2, // bimonthly
  focusIndicators: ['Asclepias', 'Monarda', 'Rudbeckia', 'Schizachyrium', 'Echinacea'],
  soilAmendment: 'compost_light',
  plantingSeason: 'both',
  seedRegion: 'local_ecotype',
};

// ---------------------------------------------------------------------------
// Biodiversity scoring from iNaturalist data
// ---------------------------------------------------------------------------

export interface BiodiversitySnapshot {
  /** Total unique species observed */
  speciesRichness: number;
  /** Number of native species */
  nativeCount: number;
  /** Number of invasive species */
  invasiveCount: number;
  /** Native to invasive ratio (higher = better) */
  nativeInvasiveRatio: number;
  /** Pollinator-supporting species count */
  pollinatorSpecies: number;
  /** Shannon diversity index */
  shannonIndex: number;
  /** Observation count in period */
  totalObservations: number;
  /** Date range of observations */
  periodStart: string;
  periodEnd: string;
}

// Well-known invasive species in SE Michigan
const KNOWN_INVASIVES = new Set([
  'Ailanthus altissima',     // Tree of Heaven
  'Rhamnus cathartica',      // Common Buckthorn
  'Centaurea stoebe',        // Spotted Knapweed
  'Phragmites australis',    // Common Reed
  'Alliaria petiolata',      // Garlic Mustard
  'Lonicera maackii',        // Amur Honeysuckle
  'Elaeagnus umbellata',     // Autumn Olive
  'Rosa multiflora',         // Multiflora Rose
  'Celastrus orbiculatus',   // Oriental Bittersweet
  'Dipsacus fullonum',       // Common Teasel
]);

// Pollinator-supporting genera
const POLLINATOR_GENERA = new Set([
  'Asclepias', 'Monarda', 'Echinacea', 'Rudbeckia', 'Liatris',
  'Solidago', 'Symphyotrichum', 'Helianthus', 'Zizia', 'Penstemon',
  'Agastache', 'Coreopsis', 'Vernonia', 'Eupatorium', 'Pycnanthemum',
]);

/**
 * Fetch biodiversity data from iNaturalist for the Dryad parcels.
 * Uses the bounding box of all 9 parcels.
 */
async function fetchBiodiversitySnapshot(
  startDate: string,
  endDate: string,
): Promise<BiodiversitySnapshot> {
  // Bounding box for 4475-4523 25th St parcels
  const bbox = {
    swlat: 42.3410,
    swlng: -83.1010,
    nelat: 42.3425,
    nelng: -83.0990,
  };

  const url = `https://api.inaturalist.org/v1/observations/species_counts?` +
    `lat=${(bbox.swlat + bbox.nelat) / 2}&lng=${(bbox.swlng + bbox.nelng) / 2}` +
    `&radius=0.5&d1=${startDate}&d2=${endDate}&quality_grade=research,needs_id`;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`iNaturalist API error: ${resp.status}`);

    const data = (await resp.json()) as any;
    const results = data?.results || [];

    let nativeCount = 0;
    let invasiveCount = 0;
    let pollinatorCount = 0;
    const speciesNames: string[] = [];
    const observationCounts: number[] = [];

    for (const entry of results) {
      const taxon = entry?.taxon;
      if (!taxon) continue;

      const name = taxon.name || '';
      const genus = name.split(' ')[0];
      speciesNames.push(name);
      observationCounts.push(entry.count || 1);

      if (KNOWN_INVASIVES.has(name)) {
        invasiveCount++;
      } else {
        nativeCount++; // Simplified: non-invasive = native (imperfect but functional)
      }

      if (POLLINATOR_GENERA.has(genus)) {
        pollinatorCount++;
      }
    }

    // Shannon diversity index: H = -Σ(pi * ln(pi))
    const totalObs = observationCounts.reduce((a, b) => a + b, 0) || 1;
    const shannonIndex = -observationCounts.reduce((sum, count) => {
      const p = count / totalObs;
      return p > 0 ? sum + p * Math.log(p) : sum;
    }, 0);

    const ratio = invasiveCount > 0 ? nativeCount / invasiveCount : nativeCount || 0;

    return {
      speciesRichness: results.length,
      nativeCount,
      invasiveCount,
      nativeInvasiveRatio: ratio,
      pollinatorSpecies: pollinatorCount,
      shannonIndex,
      totalObservations: totalObs,
      periodStart: startDate,
      periodEnd: endDate,
    };
  } catch (err: any) {
    logger.warn(`[EcologyOptimizer] iNaturalist fetch failed: ${err?.message}`);
    return {
      speciesRichness: 0,
      nativeCount: 0,
      invasiveCount: 0,
      nativeInvasiveRatio: 0,
      pollinatorSpecies: 0,
      shannonIndex: 0,
      totalObservations: 0,
      periodStart: startDate,
      periodEnd: endDate,
    };
  }
}

/**
 * Compute the composite biodiversity score (0.0-1.0).
 * This is the metric we're optimizing.
 *
 * Weighted combination of:
 *   - Species richness (30%)
 *   - Native/invasive ratio (25%)
 *   - Pollinator species count (25%)
 *   - Shannon diversity index (20%)
 */
export function computeBiodiversityScore(snapshot: BiodiversitySnapshot): number {
  // Normalize each component to 0-1 range with reasonable targets
  const richnessScore = Math.min(1, snapshot.speciesRichness / 30); // 30+ species = perfect
  const ratioScore = Math.min(1, snapshot.nativeInvasiveRatio / 10); // 10:1 native:invasive = perfect
  const pollinatorScore = Math.min(1, snapshot.pollinatorSpecies / 8); // 8+ pollinator spp = perfect
  const diversityScore = Math.min(1, snapshot.shannonIndex / 3.0);    // Shannon > 3.0 = perfect

  return (
    0.30 * richnessScore +
    0.25 * ratioScore +
    0.25 * pollinatorScore +
    0.20 * diversityScore
  );
}

// ---------------------------------------------------------------------------
// Strategy simulation
// ---------------------------------------------------------------------------

/**
 * Simulate expected biodiversity outcomes for a given strategy.
 * Uses a model based on ecological literature for SE Michigan
 * urban prairie restoration.
 *
 * This is used for rapid iteration (minutes, not months).
 * Real-world validation happens via iNaturalist monitoring.
 */
function simulateStrategy(params: EcologyParams): {
  expectedRichness: number;
  expectedNativeRatio: number;
  expectedPollinators: number;
  expectedDiversity: number;
  estimatedCost: number;
} {
  let richness = 10; // base species from soil seed bank
  let nativeRatio = 1.5; // starting ratio
  let pollinators = 2;
  let diversity = 1.2;
  let cost = 0;

  // Planting mix effects
  const { grasses, wildflowers, shrubs, trees } = params.plantingMix;
  richness += wildflowers * 15 + grasses * 5 + shrubs * 8 + trees * 3;
  pollinators += wildflowers * 6 + shrubs * 2;
  diversity += wildflowers * 0.8 + grasses * 0.3 + shrubs * 0.5 + trees * 0.2;
  cost += (grasses + wildflowers) * 800 + shrubs * 1200 + trees * 600;

  // Invasive removal priority effects
  if (params.invasivePriority[0] === 'tree_of_heaven') {
    nativeRatio += 2.0; // Biggest impact first
    richness += 3;
  }
  if (params.invasivePriority.includes('buckthorn')) {
    nativeRatio += 1.5;
    richness += 2;
  }
  cost += params.invasivePriority.length * 400;

  // Mowing effects (too much hurts, too little lets invasives back)
  if (params.mowingFrequency >= 1 && params.mowingFrequency <= 3) {
    nativeRatio += 0.5;
  } else if (params.mowingFrequency > 3) {
    richness -= 2; // Over-mowing harms establishment
    pollinators -= 1;
  }
  if (params.mowingHeight >= 6) {
    pollinators += 1; // Higher mow preserves flower stems
  }
  cost += params.mowingFrequency * 150;

  // Soil amendment effects
  if (params.soilAmendment === 'mycorrhizal') {
    richness += 4;
    nativeRatio += 1.0;
    cost += 300;
  } else if (params.soilAmendment === 'compost_heavy') {
    richness += 2;
    cost += 200; // Can actually favor weeds if too much
    nativeRatio -= 0.3;
  } else if (params.soilAmendment === 'compost_light') {
    richness += 1;
    cost += 100;
  }

  // Seed region effects
  if (params.seedRegion === 'local_ecotype') {
    richness += 2;
    nativeRatio += 0.5;
    cost += 200; // Local ecotypes cost more
  }

  // Season effects
  if (params.plantingSeason === 'both') {
    richness += 2;
    diversity += 0.2;
    cost += 300; // Two planting sessions
  } else if (params.plantingSeason === 'fall') {
    richness += 1; // Cold stratification helps some natives
  }

  // Prescribed burn bonus (year 3+)
  if (params.usePrescribedBurn) {
    richness += 5;
    nativeRatio += 2.0;
    pollinators += 2;
    diversity += 0.4;
    cost += 500;
  }

  // Monitoring doesn't directly improve ecology but enables adaptive management
  if (params.monitoringFrequency >= 4) {
    richness += 1; // Early detection of issues
    nativeRatio += 0.3;
  }

  return {
    expectedRichness: Math.max(0, richness),
    expectedNativeRatio: Math.max(0, nativeRatio),
    expectedPollinators: Math.max(0, pollinators),
    expectedDiversity: Math.max(0, diversity),
    estimatedCost: cost,
  };
}

// ---------------------------------------------------------------------------
// Ecology experiment function
// ---------------------------------------------------------------------------

function createEcologyExperimentFn(): ExperimentFn {
  return async (params: Record<string, any>) => {
    const p = params as EcologyParams;
    const sim = simulateStrategy(p);

    // Build a biodiversity snapshot from simulation
    const simSnapshot: BiodiversitySnapshot = {
      speciesRichness: sim.expectedRichness,
      nativeCount: Math.round(sim.expectedRichness * (sim.expectedNativeRatio / (1 + sim.expectedNativeRatio))),
      invasiveCount: Math.round(sim.expectedRichness / (1 + sim.expectedNativeRatio)),
      nativeInvasiveRatio: sim.expectedNativeRatio,
      pollinatorSpecies: sim.expectedPollinators,
      shannonIndex: sim.expectedDiversity,
      totalObservations: sim.expectedRichness * 3,
      periodStart: new Date().toISOString().split('T')[0],
      periodEnd: new Date().toISOString().split('T')[0],
    };

    const score = computeBiodiversityScore(simSnapshot);

    return {
      metric: score,
      metadata: {
        simulation: sim,
        snapshot: simSnapshot,
        estimatedAnnualCost: sim.estimatedCost,
        costEfficiency: score / (sim.estimatedCost / 1000), // score per $1000
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Parameter mutation
// ---------------------------------------------------------------------------

function mutateEcologyParams(base: EcologyParams, rng: () => number): EcologyParams {
  const params: EcologyParams = JSON.parse(JSON.stringify(base));
  const dimension = Math.floor(rng() * 8);

  switch (dimension) {
    case 0: { // Planting mix
      const keys = ['grasses', 'wildflowers', 'shrubs', 'trees'] as const;
      const idx = Math.floor(rng() * 4);
      const key = keys[idx];
      params.plantingMix[key] = Math.max(0, Math.min(0.8, params.plantingMix[key] + (rng() - 0.5) * 0.2));
      // Normalize to sum to ~1
      const total = Object.values(params.plantingMix).reduce((a, b) => a + b, 0);
      for (const k of keys) params.plantingMix[k] /= total;
      break;
    }
    case 1: { // Invasive priority order (shuffle)
      const all: EcologyParams['invasivePriority'] = ['tree_of_heaven', 'buckthorn', 'knapweed', 'phragmites', 'garlic_mustard'];
      // Fisher-Yates shuffle
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
      }
      params.invasivePriority = all.slice(0, 3 + Math.floor(rng() * 3));
      break;
    }
    case 2: // Mowing frequency
      params.mowingFrequency = Math.max(0, Math.min(6, params.mowingFrequency + Math.floor((rng() - 0.5) * 3)));
      break;
    case 3: // Mowing height
      params.mowingHeight = Math.max(3, Math.min(12, params.mowingHeight + Math.floor((rng() - 0.5) * 4)));
      break;
    case 4: // Prescribed burn
      params.usePrescribedBurn = !params.usePrescribedBurn;
      break;
    case 5: // Soil amendment
      params.soilAmendment = (['none', 'compost_light', 'compost_heavy', 'mycorrhizal'] as const)[Math.floor(rng() * 4)];
      break;
    case 6: // Planting season
      params.plantingSeason = (['spring', 'fall', 'both'] as const)[Math.floor(rng() * 3)];
      break;
    case 7: // Seed region
      params.seedRegion = (['local_ecotype', 'regional_mix', 'national_mix'] as const)[Math.floor(rng() * 3)];
      break;
  }

  return params;
}

function describeEcologyChange(base: EcologyParams, mutated: EcologyParams): string {
  const changes: string[] = [];
  const b = base.plantingMix, m = mutated.plantingMix;
  if (Math.abs(b.grasses - m.grasses) > 0.05 || Math.abs(b.wildflowers - m.wildflowers) > 0.05)
    changes.push(`mix g:${m.grasses.toFixed(2)} w:${m.wildflowers.toFixed(2)} s:${m.shrubs.toFixed(2)} t:${m.trees.toFixed(2)}`);
  if (JSON.stringify(base.invasivePriority) !== JSON.stringify(mutated.invasivePriority))
    changes.push(`priority [${mutated.invasivePriority.join(',')}]`);
  if (base.mowingFrequency !== mutated.mowingFrequency)
    changes.push(`mow ${base.mowingFrequency}→${mutated.mowingFrequency}x`);
  if (base.mowingHeight !== mutated.mowingHeight)
    changes.push(`height ${base.mowingHeight}→${mutated.mowingHeight}in`);
  if (base.usePrescribedBurn !== mutated.usePrescribedBurn)
    changes.push(`burn=${mutated.usePrescribedBurn}`);
  if (base.soilAmendment !== mutated.soilAmendment)
    changes.push(`soil ${base.soilAmendment}→${mutated.soilAmendment}`);
  if (base.plantingSeason !== mutated.plantingSeason)
    changes.push(`season ${base.plantingSeason}→${mutated.plantingSeason}`);
  if (base.seedRegion !== mutated.seedRegion)
    changes.push(`seed ${base.seedRegion}→${mutated.seedRegion}`);
  return changes.join(', ') || 'no change';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the ecology strategy optimization loop (simulation mode).
 * Fast iteration using ecological models. Real-world validation
 * happens over growing seasons via iNaturalist monitoring.
 */
export async function runEcologyOptimization(maxExperiments: number = 50): Promise<void> {
  const experimentFn = createEcologyExperimentFn();

  let seed = Date.now();
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff;
  };

  const state = loadState('ecology', 'biodiversity_score', true);

  async function* experimentGenerator(st: ResearchState): AsyncGenerator<ExperimentConfig> {
    if (st.totalExperiments === 0) {
      yield {
        name: 'baseline',
        description: 'Baseline with current planting strategy',
        params: BASELINE_ECOLOGY_PARAMS,
        domain: 'ecology',
      };
    }

    let iteration = 0;
    while (true) {
      const baseParams = (st.bestParams as EcologyParams) || BASELINE_ECOLOGY_PARAMS;
      const mutated = mutateEcologyParams(baseParams, rng);
      const change = describeEcologyChange(baseParams, mutated);

      yield {
        name: `eco-${iteration++}`,
        description: change,
        params: mutated,
        domain: 'ecology',
      };
    }
  }

  const generator = experimentGenerator(state);
  let count = 0;

  for await (const config of generator) {
    if (count >= maxExperiments) break;

    await runExperiment(config, experimentFn, state, 'biodiversity_score', true);
    count++;
  }

  logger.info(`[EcologyOptimizer] Complete. Best strategy: biodiversity_score=${state.bestMetric.toFixed(4)}`);
  logger.info(`[EcologyOptimizer] Best params: ${JSON.stringify(state.bestParams, null, 2)}`);
}

/**
 * Take a real-world biodiversity snapshot and record it against
 * the current active strategy. This validates simulation predictions.
 */
export async function recordRealWorldObservation(
  periodDays: number = 30,
): Promise<{ snapshot: BiodiversitySnapshot; score: number }> {
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - periodDays * 86400000).toISOString().split('T')[0];

  const snapshot = await fetchBiodiversitySnapshot(startDate, endDate);
  const score = computeBiodiversityScore(snapshot);

  logger.info(
    `[EcologyOptimizer] Real-world snapshot: richness=${snapshot.speciesRichness} ` +
    `native/invasive=${snapshot.nativeInvasiveRatio.toFixed(1)} ` +
    `pollinators=${snapshot.pollinatorSpecies} score=${score.toFixed(4)}`,
  );

  return { snapshot, score };
}
