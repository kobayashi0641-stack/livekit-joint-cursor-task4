import type { Task9Point, Task9TargetPair } from './point-to-point.js';

export type Task9RecordingPhase = 'baseline' | 'adaptation' | 'shared' | 'solo' | 'washout';

export type Task9ParticipantTargetPair = {
  trialKey: string;
  trialNumber: number;
  phase: Task9RecordingPhase;
  sequence: number;
  score: number;
  previousTargetIndex: number;
  targetIndices: Task9TargetPair;
  targetPositions: [Task9Point, Task9Point];
  targetPresentedAt: number;
};

export type Task9TargetStateReport = Task9ParticipantTargetPair & {
  type: 'task9TargetState';
  identity: string;
  timestamp: number;
};

export type Task9AcquisitionEvent = {
  type: 'task9ScoreAcquired';
  identity: string;
  trialKey: string;
  trialNumber: number;
  phase: Task9RecordingPhase;
  sequence: number;
  score: number;
  targetIndices: Task9TargetPair;
  targetPositions: [Task9Point, Task9Point];
  targetIndex: number;
  targetPosition: Task9Point;
  unchosenTargetIndex: number;
  unchosenTargetPosition: Task9Point;
  nextTargetIndices: Task9TargetPair;
  nextTargetPositions: [Task9Point, Task9Point];
  nextTargetIndex: number;
  targetPresentedAt: number;
  acquiredAt: number;
  movementTimeMs: number;
  dwellMs: number;
  participantTimestamp: number;
  timestamp: number;
};

const PHASES = new Set<Task9RecordingPhase>([
  'baseline',
  'adaptation',
  'shared',
  'solo',
  'washout',
]);

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integer(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function point(value: unknown): Task9Point | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const x = finiteNumber(candidate.x);
  const y = finiteNumber(candidate.y);
  return x !== null && y !== null ? { x, y } : null;
}

function pair<T>(value: unknown, parse: (item: unknown) => T | null): [T, T] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const first = parse(value[0]);
  const second = parse(value[1]);
  return first !== null && second !== null ? [first, second] : null;
}

function recordingPhase(value: unknown): Task9RecordingPhase | null {
  return typeof value === 'string' && PHASES.has(value as Task9RecordingPhase)
    ? value as Task9RecordingPhase
    : null;
}

export function buildTask9TargetStateReport(
  identity: string,
  detail: Record<string, unknown>,
  timestamp: number,
): Task9TargetStateReport | null {
  const trialKey = typeof detail.trialKey === 'string' ? detail.trialKey : '';
  const phase = recordingPhase(detail.phase);
  const trialNumber = integer(detail.trialNumber);
  const sequence = integer(detail.sequence);
  const score = integer(detail.score);
  const previousTargetIndex = integer(detail.previousTargetIndex);
  const targetIndices = pair(detail.targetIndices, integer);
  const targetPositions = pair(detail.targetPositions, point);
  const targetPresentedAt = finiteNumber(detail.targetPresentedAt);
  if (
    !identity || !trialKey || !phase || trialNumber === null || sequence === null
    || score === null || previousTargetIndex === null || !targetIndices
    || !targetPositions || targetPresentedAt === null
  ) {
    return null;
  }
  return {
    type: 'task9TargetState',
    identity,
    trialKey,
    trialNumber,
    phase,
    sequence,
    score,
    previousTargetIndex,
    targetIndices,
    targetPositions,
    targetPresentedAt,
    timestamp,
  };
}

export function snapshotTask9ParticipantTargetPairs(
  participantIdentities: string[],
  reports: ReadonlyMap<string, Task9TargetStateReport>,
): Record<string, Task9ParticipantTargetPair | null> {
  const shared = reports.get('shared');
  const result: Record<string, Task9ParticipantTargetPair | null> = {};
  for (const identity of participantIdentities) {
    const report = reports.get(identity) ?? (shared?.phase === 'shared' ? shared : undefined);
    if (!report) {
      result[identity] = null;
      continue;
    }
    const { type: _type, identity: _identity, timestamp: _timestamp, ...snapshot } = report;
    result[identity] = snapshot;
  }
  return result;
}

export function buildTask9AcquisitionEvent(
  identity: string,
  detail: Record<string, unknown>,
  timestamp: number,
): Task9AcquisitionEvent | null {
  const trialKey = typeof detail.trialKey === 'string' ? detail.trialKey : '';
  const phase = recordingPhase(detail.phase);
  const trialNumber = integer(detail.trialNumber);
  const sequence = integer(detail.sequence);
  const score = integer(detail.score);
  const targetIndices = pair(detail.targetIndices, integer);
  const targetPositions = pair(detail.targetPositions, point);
  const targetIndex = integer(detail.targetIndex);
  const targetPosition = point(detail.targetPosition);
  const unchosenTargetIndex = integer(detail.unchosenTargetIndex);
  const unchosenTargetPosition = point(detail.unchosenTargetPosition);
  const nextTargetIndices = pair(detail.nextTargetIndices, integer);
  const nextTargetPositions = pair(detail.nextTargetPositions, point);
  const nextTargetIndex = integer(detail.nextTargetIndex);
  const targetPresentedAt = finiteNumber(detail.targetPresentedAt);
  const acquiredAt = finiteNumber(detail.acquiredAt);
  const movementTimeMs = finiteNumber(detail.movementTimeMs);
  const dwellMs = finiteNumber(detail.dwellMs);
  if (
    !identity || !trialKey || !phase || trialNumber === null || sequence === null || score === null
    || !targetIndices || !targetPositions || targetIndex === null || !targetPosition
    || unchosenTargetIndex === null || !unchosenTargetPosition || !nextTargetIndices
    || !nextTargetPositions || nextTargetIndex === null || targetPresentedAt === null
    || acquiredAt === null || movementTimeMs === null || dwellMs === null
  ) {
    return null;
  }
  return {
    type: 'task9ScoreAcquired',
    identity,
    trialKey,
    trialNumber,
    phase,
    sequence,
    score,
    targetIndices,
    targetPositions,
    targetIndex,
    targetPosition,
    unchosenTargetIndex,
    unchosenTargetPosition,
    nextTargetIndices,
    nextTargetPositions,
    nextTargetIndex,
    targetPresentedAt,
    acquiredAt,
    movementTimeMs,
    dwellMs,
    participantTimestamp: acquiredAt,
    timestamp,
  };
}

