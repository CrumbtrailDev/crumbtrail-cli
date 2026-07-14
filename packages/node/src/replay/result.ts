import fs from 'node:fs';

export const REPLAY_RESULT_SCHEMA_VERSION = 'replay-result.v1' as const;

export type StepResolution = 'exact' | 'role-label' | 'structural' | 'failed';

const RESOLUTIONS = new Set<StepResolution>(['exact', 'role-label', 'structural', 'failed']);

export interface ReplayStepResult {
  index: number;
  sig: string;
  action: string;
  resolution: StepResolution;
  durationMs: number;
}

export interface ReplayDivergence {
  index: number;
  sig: string;
  reason: string;
}

export interface ReplayResult {
  schemaVersion: typeof REPLAY_RESULT_SCHEMA_VERSION;
  sourceSessionId: string;
  actuatedSessionId: string;
  steps: ReplayStepResult[];
  divergences: ReplayDivergence[];
  completed: boolean;
}

export function buildReplayResult(input: {
  sourceSessionId: string;
  actuatedSessionId: string;
  steps: ReplayStepResult[];
  divergences: ReplayDivergence[];
  completed: boolean;
}): ReplayResult {
  return {
    schemaVersion: REPLAY_RESULT_SCHEMA_VERSION,
    sourceSessionId: input.sourceSessionId,
    actuatedSessionId: input.actuatedSessionId,
    steps: input.steps,
    divergences: input.divergences,
    completed: input.completed,
  };
}

export function parseReplayResult(raw: unknown): ReplayResult {
  if (!isRecord(raw)) {
    throw new Error('replay-result.v1: payload must be an object');
  }
  if (raw.schemaVersion !== REPLAY_RESULT_SCHEMA_VERSION) {
    throw new Error(`replay-result.v1: unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)}`);
  }
  if (!Array.isArray(raw.steps)) {
    throw new Error('replay-result.v1: steps must be an array');
  }
  if (!Array.isArray(raw.divergences)) {
    throw new Error('replay-result.v1: divergences must be an array');
  }
  if (typeof raw.completed !== 'boolean') {
    throw new Error('replay-result.v1: completed must be a boolean');
  }

  return {
    schemaVersion: REPLAY_RESULT_SCHEMA_VERSION,
    sourceSessionId: reqString(raw, 'sourceSessionId', 'result'),
    actuatedSessionId: reqString(raw, 'actuatedSessionId', 'result'),
    steps: raw.steps.map(parseStep),
    divergences: raw.divergences.map(parseDivergence),
    completed: raw.completed,
  };
}

export function writeReplayResult(filePath: string, result: ReplayResult): void {
  fs.writeFileSync(filePath, `${JSON.stringify(result, null, 2)}\n`);
}

function parseStep(step: unknown, index: number): ReplayStepResult {
  const context = `steps[${index}]`;
  if (!isRecord(step)) {
    throw new Error(`replay-result.v1: ${context} must be an object`);
  }
  const resolution = step.resolution;
  if (typeof resolution !== 'string' || !RESOLUTIONS.has(resolution as StepResolution)) {
    throw new Error(`replay-result.v1: ${context}.resolution must be one of exact|role-label|structural|failed`);
  }
  return {
    index: reqNumber(step, 'index', context),
    sig: reqString(step, 'sig', context),
    action: reqString(step, 'action', context),
    resolution: resolution as StepResolution,
    durationMs: reqNumber(step, 'durationMs', context),
  };
}

function parseDivergence(divergence: unknown, index: number): ReplayDivergence {
  const context = `divergences[${index}]`;
  if (!isRecord(divergence)) {
    throw new Error(`replay-result.v1: ${context} must be an object`);
  }
  return {
    index: reqNumber(divergence, 'index', context),
    sig: reqString(divergence, 'sig', context),
    reason: reqString(divergence, 'reason', context),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function reqString(obj: Record<string, unknown>, key: string, context: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`replay-result.v1: ${context}.${key} must be a non-empty string`);
  }
  return value;
}

function reqNumber(obj: Record<string, unknown>, key: string, context: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`replay-result.v1: ${context}.${key} must be a finite number`);
  }
  return value;
}
