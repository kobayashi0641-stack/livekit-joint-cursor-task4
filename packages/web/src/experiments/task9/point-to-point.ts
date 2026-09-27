export type Task9Point = { x: number; y: number };

export type Task9DwellState = {
  enteredAt: number | null;
  scored: boolean;
};

export type Task9TargetPair = [number, number];

export type Task9TargetDwellState = Task9DwellState & {
  targetIndex: number | null;
};

export type Task9Clock = {
  phase: 'countdown' | 'running' | 'complete';
  countdown: number | null;
  remainingSeconds: number;
};

export type Task9RenderState = {
  showTask: boolean;
  showCursors: boolean;
  targetFill: '#dc2626' | '#16a34a';
};

export type Task9TrialState = {
  trialKey: string;
  seed: number;
  identityKey: string;
  sequence: number;
  score: number;
  previousTargetIndex: number;
  targetIndices: Task9TargetPair;
  targetPresentedAt: number;
  dwell: Task9TargetDwellState;
};

export type Task9Acquisition = {
  trialKey: string;
  identityKey: string;
  sequence: number;
  score: number;
  targetIndices: Task9TargetPair;
  targetIndex: number;
  unchosenTargetIndex: number;
  nextTargetIndices: Task9TargetPair;
  /** First next-pair index retained for existing recording consumers. */
  nextTargetIndex: number;
  targetPresentedAt: number;
  acquiredAt: number;
  movementTimeMs: number;
  dwellMs: number;
};

export function advanceTask9SharedTargetParams(
  params: Record<string, unknown>,
  acquisition: Task9Acquisition,
  now: number,
): Record<string, unknown> | null {
  if (
    params.task9PointToPoint !== true
    || params.phase !== 'shared'
    || params.trialKey !== acquisition.trialKey
  ) {
    return null;
  }
  const sequence = Number(params.sequence ?? 0);
  const score = Number(params.score ?? 0);
  // The server's initial payload carries the seed but not the derived pair.
  // The first acquisition supplies that pair; subsequent updates include it.
  const targetIndices = Array.isArray(params.targetIndices)
    && params.targetIndices.length === 2
    && params.targetIndices.every((value) => Number.isInteger(Number(value)))
    ? [Number(params.targetIndices[0]), Number(params.targetIndices[1])] as Task9TargetPair
    : acquisition.targetIndices;
  if (
    !Number.isFinite(sequence)
    || !Number.isFinite(score)
    || acquisition.sequence !== sequence
    || acquisition.targetIndices[0] !== targetIndices[0]
    || acquisition.targetIndices[1] !== targetIndices[1]
    || !targetIndices.includes(acquisition.targetIndex)
  ) {
    return null;
  }
  return {
    ...params,
    sequence: sequence + 1,
    score: score + 1,
    previousTargetIndex: acquisition.targetIndex,
    targetIndices: acquisition.nextTargetIndices,
    // Preserve the legacy scalar as the first member of the next pair.
    targetIndex: acquisition.nextTargetIndex,
    targetPresentedAt: now,
  };
}

export function shouldShowTask9SharedFeedback(
  selectedByAdmin: boolean,
  enabled: boolean,
  phase: string | undefined,
): boolean {
  return selectedByAdmin && enabled && phase === 'shared';
}

export function getTask9SharedCursorFill(showIndividualFeedback: boolean): '#2563eb' | '#111827' {
  return showIndividualFeedback ? '#111827' : '#2563eb';
}

export function isTask9CompletionMessage(text: string): boolean {
  return /^Trial \d+ of \d+ is complete\./.test(text.trim());
}

export function shouldShowTask9QuestionnaireScore(
  phase: string | undefined,
  scoreTrialNumber: number,
  questionnaireTrialNumber: number,
  questionnaireVisible: boolean,
): boolean {
  return phase === 'shared'
    && questionnaireVisible
    && scoreTrialNumber === questionnaireTrialNumber;
}

export function shouldShowTask9CompletionScore(
  phase: string | undefined,
  completionMessageVisible: boolean,
): boolean {
  return phase !== 'shared' && completionMessageVisible;
}

const INNER_RADIUS = 0.18;

/**
 * Nineteen vertices from a triangular lattice: the origin, its six nearest
 * neighbours, and the twelve vertices in the second lattice ring. Six of the
 * outer vertices are rotated 30 degrees at sqrt(3) spacings; the other six
 * form a regular hexagon two target spacings from the center.
 */
export function createTask9TargetGrid(): Task9Point[] {
  const center = { x: 0.5, y: 0.5 };
  const ring = (radius: number, offsetDegrees: number) => Array.from({ length: 6 }, (_, index) => {
    const angle = ((offsetDegrees + index * 60) * Math.PI) / 180;
    return {
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    };
  });
  return [
    center,
    ...ring(INNER_RADIUS, 0),
    ...ring(INNER_RADIUS * Math.sqrt(3), 30),
    ...ring(INNER_RADIUS * 2, 0),
  ];
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function targetDistanceShells(anchorIndex: number): number[][] {
  const grid = createTask9TargetGrid();
  const anchor = grid[anchorIndex];
  if (!anchor) return [];

  const shells = new Map<number, number[]>();
  for (let targetIndex = 0; targetIndex < grid.length; targetIndex += 1) {
    if (targetIndex === anchorIndex) continue;
    const dx = grid[targetIndex].x - anchor.x;
    const dy = grid[targetIndex].y - anchor.y;
    const roundedSquaredDistance = Math.round((dx * dx + dy * dy) * 1e12) / 1e12;
    const shell = shells.get(roundedSquaredDistance) ?? [];
    shell.push(targetIndex);
    shells.set(roundedSquaredDistance, shell);
  }

  return [...shells.entries()]
    .filter(([, targetIndices]) => targetIndices.length >= 2)
    .sort(([distanceA], [distanceB]) => distanceA - distanceB)
    .map(([, targetIndices]) => targetIndices);
}

export function selectNextTargetPair(
  seed: number,
  sequence: number,
  previousIndex: number,
): [number, number] {
  const shells = targetDistanceShells(previousIndex);
  if (shells.length === 0) {
    throw new Error(`No equidistant target pair is available from grid index ${previousIndex}`);
  }

  let randomState = mix32(
    (Math.floor(seed) >>> 0)
      ^ Math.imul(Math.max(0, Math.floor(sequence)) + 1, 0x9e3779b1)
      ^ Math.imul(previousIndex + 1, 0x85ebca6b),
  );
  const shell = shells[randomState % shells.length];
  randomState = mix32((randomState + 0x6d2b79f5) >>> 0);
  const firstPosition = randomState % shell.length;
  randomState = mix32((randomState + 0x6d2b79f5) >>> 0);
  const secondPosition = randomState % (shell.length - 1);
  const adjustedSecondPosition = secondPosition >= firstPosition ? secondPosition + 1 : secondPosition;
  return [shell[firstPosition], shell[adjustedSecondPosition]];
}

function shuffledTask9TargetSet(seed: number, setIndex: number): number[] {
  const count = createTask9TargetGrid().length;
  let previousSet: number[] | null = null;

  for (let currentSetIndex = 0; currentSetIndex <= setIndex; currentSetIndex += 1) {
    const currentSet = Array.from({ length: count }, (_, index) => index);
    let randomState = mix32(
      (Math.floor(seed) >>> 0) ^ Math.imul(currentSetIndex + 1, 0x9e3779b1),
    );
    for (let index = currentSet.length - 1; index > 0; index -= 1) {
      randomState = mix32((randomState + 0x6d2b79f5) >>> 0);
      const swapIndex = randomState % (index + 1);
      [currentSet[index], currentSet[swapIndex]] = [currentSet[swapIndex], currentSet[index]];
    }

    if (previousSet) {
      const previousLast = previousSet[previousSet.length - 1];
      if (currentSet[0] === previousLast) {
        [currentSet[0], currentSet[1]] = [currentSet[1], currentSet[0]];
      }
      if (currentSet.every((targetIndex, index) => targetIndex === previousSet![index])) {
        [currentSet[1], currentSet[2]] = [currentSet[2], currentSet[1]];
      }
    }
    previousSet = currentSet;
  }

  return previousSet ?? [];
}

/**
 * Select a repeatable target from independently shuffled 19-target sets.
 * Every target appears exactly once per set, and adjacent sets cannot share
 * the same boundary target or repeat the exact same order.
 */
export function selectNextTargetIndex(
  seed: number,
  sequence: number,
  _previousIndex: number | null,
  _identity: string,
): number {
  const count = createTask9TargetGrid().length;
  const safeSequence = Math.max(0, Math.floor(sequence));
  const setIndex = Math.floor(safeSequence / count);
  const positionInSet = safeSequence % count;
  return shuffledTask9TargetSet(seed, setIndex)[positionInSet];
}

export function getTask9RenderState(
  phase: Task9Clock['phase'],
  cursorInsideTarget: boolean,
): Task9RenderState {
  const running = phase === 'running';
  return {
    showTask: running,
    showCursors: running,
    targetFill: cursorInsideTarget ? '#16a34a' : '#dc2626',
  };
}

export function updateDwellState(
  state: Task9DwellState,
  inside: boolean,
  now: number,
  requiredMs: number,
): Task9DwellState {
  if (state.scored) return state;
  if (!inside) return { enteredAt: null, scored: false };
  const enteredAt = state.enteredAt ?? now;
  return {
    enteredAt,
    scored: now - enteredAt >= Math.max(0, requiredMs),
  };
}

export function updateTargetDwellState(
  state: Task9TargetDwellState,
  insideTargetIndex: number | null,
  now: number,
  requiredMs: number,
): Task9TargetDwellState {
  if (state.scored) return state;
  if (insideTargetIndex === null) {
    return { targetIndex: null, enteredAt: null, scored: false };
  }
  const enteredAt = state.targetIndex === insideTargetIndex && state.enteredAt !== null
    ? state.enteredAt
    : now;
  return {
    targetIndex: insideTargetIndex,
    enteredAt,
    scored: now - enteredAt >= Math.max(0, requiredMs),
  };
}

export function getTask9Clock(
  elapsedMs: number,
  countdownMs: number,
  durationMs: number,
): Task9Clock {
  const elapsed = Math.max(0, elapsedMs);
  const countdownDuration = Math.max(0, countdownMs);
  const trialDuration = Math.max(0, durationMs);
  if (elapsed < countdownDuration) {
    return {
      phase: 'countdown',
      countdown: Math.max(1, Math.ceil((countdownDuration - elapsed) / 1000)),
      remainingSeconds: Math.ceil(trialDuration / 1000),
    };
  }
  const trialElapsed = elapsed - countdownDuration;
  if (trialElapsed >= trialDuration) {
    return { phase: 'complete', countdown: null, remainingSeconds: 0 };
  }
  return {
    phase: 'running',
    countdown: null,
    remainingSeconds: Math.max(0, Math.ceil((trialDuration - trialElapsed) / 1000)),
  };
}

export function createTask9TrialState(
  trialKey: string,
  seed: number,
  identityKey: string,
  now: number,
): Task9TrialState {
  const previousTargetIndex = 0;
  return {
    trialKey,
    seed,
    identityKey,
    sequence: 0,
    score: 0,
    previousTargetIndex,
    targetIndices: selectNextTargetPair(seed, 0, previousTargetIndex),
    targetPresentedAt: now,
    dwell: { targetIndex: null, enteredAt: null, scored: false },
  };
}

export function updateTask9TrialHit(
  state: Task9TrialState,
  insideTargetIndex: number | null,
  now: number,
  requiredDwellMs: number,
  mode: 'solo' | 'shared',
): { state: Task9TrialState; acquisition: Task9Acquisition | null } {
  const previousDwell = state.dwell;
  const validInsideTargetIndex = insideTargetIndex !== null && state.targetIndices.includes(insideTargetIndex)
    ? insideTargetIndex
    : null;
  const dwell = updateTargetDwellState(previousDwell, validInsideTargetIndex, now, requiredDwellMs);
  if (!dwell.scored || previousDwell.scored) {
    return { state: { ...state, dwell }, acquisition: null };
  }

  const targetIndex = dwell.targetIndex;
  if (targetIndex === null) {
    return { state: { ...state, dwell }, acquisition: null };
  }
  const nextSequence = state.sequence + 1;
  const nextTargetIndices = selectNextTargetPair(
    state.seed,
    nextSequence,
    targetIndex,
  );
  const unchosenTargetIndex = state.targetIndices[0] === targetIndex
    ? state.targetIndices[1]
    : state.targetIndices[0];
  const acquisition: Task9Acquisition = {
    trialKey: state.trialKey,
    identityKey: state.identityKey,
    sequence: state.sequence,
    score: state.score + 1,
    targetIndices: state.targetIndices,
    targetIndex,
    unchosenTargetIndex,
    nextTargetIndices,
    nextTargetIndex: nextTargetIndices[0],
    targetPresentedAt: state.targetPresentedAt,
    acquiredAt: now,
    movementTimeMs: Math.max(0, now - state.targetPresentedAt),
    dwellMs: Math.max(0, now - (dwell.enteredAt ?? now)),
  };
  if (mode === 'shared') {
    return { state: { ...state, dwell }, acquisition };
  }
  return {
    state: {
      ...state,
      sequence: nextSequence,
      score: state.score + 1,
      previousTargetIndex: targetIndex,
      targetIndices: nextTargetIndices,
      targetPresentedAt: now,
      dwell: { targetIndex: null, enteredAt: null, scored: false },
    },
    acquisition,
  };
}

export function syncTask9AuthoritativeState(
  state: Task9TrialState,
  authoritative: Pick<Task9TrialState, 'sequence' | 'score' | 'previousTargetIndex' | 'targetIndices' | 'targetPresentedAt'>,
): Task9TrialState {
  if (authoritative.sequence <= state.sequence) return state;
  return {
    ...state,
    ...authoritative,
    dwell: { targetIndex: null, enteredAt: null, scored: false },
  };
}
