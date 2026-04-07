/**
 * Demo Event Collector
 *
 * Captures every meaningful event during a demo run into a structured timeline.
 * The report generator consumes this to build the proof report HTML.
 *
 * Events are grouped by scenario. Each event has a type, timestamp, and
 * scenario-specific payload that the report template knows how to render.
 */

export type EventType =
  | 'demo_start'
  | 'scenario_start'
  | 'scenario_end'
  | 'loop_cycle_start'
  | 'loop_cycle_end'
  | 'loop_step'
  | 'invasive_detected'
  | 'contractor_email_sent'
  | 'vision_verify'
  | 'payment_sent'
  | 'payment_blocked'
  | 'security_test'
  | 'treasury_check'
  | 'treasury_mode_change'
  | 'diem_check'
  | 'biodiversity_check'
  | 'milestone_recorded'
  | 'self_assessment'
  | 'weekly_report'
  | 'config_summary'
  | 'demo_end';

export interface DemoEvent {
  type: EventType;
  timestamp: number;
  scenario?: number;       // 1-8
  scenarioTitle?: string;
  data: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Singleton collector
// ---------------------------------------------------------------------------

const events: DemoEvent[] = [];
let currentScenario = 0;
let currentScenarioTitle = '';

export function startScenario(num: number, title: string): void {
  currentScenario = num;
  currentScenarioTitle = title;
  record('scenario_start', { number: num, title });
}

export function endScenario(num: number, passed: boolean, summary: string): void {
  record('scenario_end', { number: num, passed, summary });
}

export function record(type: EventType, data: Record<string, any> = {}): void {
  events.push({
    type,
    timestamp: Date.now(),
    scenario: currentScenario,
    scenarioTitle: currentScenarioTitle,
    data,
  });
}

export function getAllEvents(): DemoEvent[] {
  return [...events];
}

export function getEventsByScenario(scenario: number): DemoEvent[] {
  return events.filter(e => e.scenario === scenario);
}

export function getScenarioResults(): Array<{
  number: number;
  title: string;
  passed: boolean;
  summary: string;
  events: DemoEvent[];
}> {
  const scenarios = new Map<number, { title: string; passed: boolean; summary: string }>();

  for (const e of events) {
    if (e.type === 'scenario_start') {
      scenarios.set(e.data.number, { title: e.data.title, passed: false, summary: '' });
    }
    if (e.type === 'scenario_end') {
      const s = scenarios.get(e.data.number);
      if (s) {
        s.passed = e.data.passed;
        s.summary = e.data.summary;
      }
    }
  }

  return Array.from(scenarios.entries()).map(([num, info]) => ({
    number: num,
    ...info,
    events: events.filter(e => e.scenario === num),
  }));
}

export function clearEvents(): void {
  events.length = 0;
  currentScenario = 0;
  currentScenarioTitle = '';
}
