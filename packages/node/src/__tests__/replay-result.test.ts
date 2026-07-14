import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REPLAY_RESULT_SCHEMA_VERSION,
  buildReplayResult,
  parseReplayResult,
  writeReplayResult,
  type ReplayResult,
} from '../replay/result';

export const REPLAY_RESULT_FIXTURE: ReplayResult = {
  schemaVersion: 'replay-result.v1',
  sourceSessionId: 'ses_rec_n_001',
  actuatedSessionId: 'ses_act_n1_002',
  steps: [
    { index: 0, sig: '1kq9zx4', action: 'input', resolution: 'exact', durationMs: 112 },
    { index: 1, sig: 'z8m2c1p', action: 'click', resolution: 'role-label', durationMs: 348 },
    { index: 2, sig: '7ab3def', action: 'click', resolution: 'failed', durationMs: 5003 },
  ],
  divergences: [
    {
      index: 2,
      sig: '7ab3def',
      reason: 'unresolvable: no exact, role-label, or structural match for button "Confirm order"',
    },
  ],
  completed: true,
};

describe('buildReplayResult', () => {
  it('stamps the schema version and preserves inputs verbatim', () => {
    const result = buildReplayResult({
      sourceSessionId: 'ses_rec_n_001',
      actuatedSessionId: 'ses_act_n1_002',
      steps: REPLAY_RESULT_FIXTURE.steps,
      divergences: REPLAY_RESULT_FIXTURE.divergences,
      completed: true,
    });

    expect(result).toEqual(REPLAY_RESULT_FIXTURE);
    expect(result.schemaVersion).toBe(REPLAY_RESULT_SCHEMA_VERSION);
  });
});

describe('parseReplayResult', () => {
  it('round-trips a valid result', () => {
    expect(parseReplayResult(JSON.parse(JSON.stringify(REPLAY_RESULT_FIXTURE)))).toEqual(
      REPLAY_RESULT_FIXTURE,
    );
  });

  it('rejects a wrong schemaVersion', () => {
    expect(() =>
      parseReplayResult({ ...REPLAY_RESULT_FIXTURE, schemaVersion: 'replay-result.v2' }),
    ).toThrow(/schemaVersion/);
  });

  it('rejects a step with an unknown resolution', () => {
    const bad = JSON.parse(JSON.stringify(REPLAY_RESULT_FIXTURE));
    bad.steps[0].resolution = 'fuzzy';

    expect(() => parseReplayResult(bad)).toThrow(/resolution/);
  });

  it('rejects a divergence missing a reason', () => {
    const bad = JSON.parse(JSON.stringify(REPLAY_RESULT_FIXTURE));
    delete bad.divergences[0].reason;

    expect(() => parseReplayResult(bad)).toThrow(/reason/);
  });

  it('rejects non-object input', () => {
    expect(() => parseReplayResult(null)).toThrow(/object/);
  });
});

describe('writeReplayResult', () => {
  it('writes pretty JSON with trailing newline that parses back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-replay-result-'));
    const file = path.join(dir, 'replay-result.json');

    writeReplayResult(file, REPLAY_RESULT_FIXTURE);

    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(parseReplayResult(JSON.parse(raw))).toEqual(REPLAY_RESULT_FIXTURE);
  });
});
