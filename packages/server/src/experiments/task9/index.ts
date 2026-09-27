import type { AgentRule, ExperimentConfig } from '../../agent-rules.js';
import { buildExecuteTrialRule } from '../common-flow.js';
import type { ExperimentTask } from '../types.js';
import { runTrialBody } from './experiment.js';
import { generateInstructions } from './instructions.js';

type DisturbanceParams = {
  gainA: number;
  gainB: number;
  rotationDeg: number;
};

function stepToward(initial: number, target: number, step: number, steps: number): number {
  if (!Number.isFinite(target)) return initial;
  const amount = Math.max(0, Math.abs(step));
  if (amount === 0 || steps <= 0 || target === initial) return initial;
  const delta = target - initial;
  const nextMagnitude = Math.min(Math.abs(delta), amount * steps);
  return initial + Math.sign(delta) * nextMagnitude;
}

function buildDisturbance(
  config: ExperimentConfig,
  phase: 'baseline' | 'adaptation' | 'shared' | 'washout',
  adaptationIndex: number,
): Record<string, unknown> {
  const gainStep = config.cursorControlGainStepPerTrial;
  const rotationStep = config.cursorControlRotationStepDegPerTrial;
  const participantTargets: [DisturbanceParams, DisturbanceParams] = [
    {
      gainA: config.cursorControlGainTargetA1,
      gainB: config.cursorControlGainTargetB1,
      rotationDeg: config.cursorControlRotationTargetDeg1,
    },
    {
      gainA: config.cursorControlGainTargetA2,
      gainB: config.cursorControlGainTargetB2,
      rotationDeg: config.cursorControlRotationTargetDeg2,
    },
  ];
  const identity: DisturbanceParams = { gainA: 1, gainB: 1, rotationDeg: 0 };
  const participantStart = participantTargets.map((target) => {
    if (phase === 'baseline' || phase === 'washout') return identity;
    if (phase === 'shared') return target;
    return {
      gainA: stepToward(1, target.gainA, gainStep, adaptationIndex),
      gainB: stepToward(1, target.gainB, gainStep, adaptationIndex),
      rotationDeg: stepToward(0, target.rotationDeg, rotationStep, adaptationIndex),
    };
  });
  const participantEnd = participantTargets.map((target) => {
    if (phase === 'baseline' || phase === 'washout') return identity;
    if (phase === 'shared') return target;
    return {
      gainA: stepToward(1, target.gainA, gainStep, adaptationIndex + 1),
      gainB: stepToward(1, target.gainB, gainStep, adaptationIndex + 1),
      rotationDeg: stepToward(0, target.rotationDeg, rotationStep, adaptationIndex + 1),
    };
  });
  return {
    enabled: phase === 'adaptation' || phase === 'shared',
    type: 'gain-plus-rotation',
    phase,
    rampStartSeconds: phase === 'adaptation' ? config.cursorControlRampStartSeconds : 0,
    rampDurationSeconds: phase === 'adaptation' ? config.cursorControlRampDurationSeconds : 0,
    rampShape: 'linear',
    participantStart,
    participantEnd,
    participantTargets,
  };
}

export const task9Task: ExperimentTask = {
  type: 'task9',
  label: 'Point-to-Point Task',
  liveKitTaskMode: 'shared-single-cursor',
  generateInstructions,
  runTrialBody,
  getInitialCursorPosition: () => ({ x: 0.5, y: 0.5 }),
  generateTrialSequence(config: ExperimentConfig, experimentName: string): AgentRule[] {
    const baseline = Math.max(0, Math.floor(config.cursorControlBaselineTrials));
    const shared = Math.max(0, Math.floor(config.cursorControlSharedTrials));
    const washout = Math.max(0, Math.floor(config.cursorControlWashoutTrials));
    const total = baseline + shared + washout;
    const rules: AgentRule[] = [];
    let trialNumber = 1;

    for (let i = 0; i < baseline; i++) {
      rules.push({
        ...buildExecuteTrialRule(config, experimentName, trialNumber++, total),
        displayMode: 'self',
        sharedPhase: 'baseline',
        sharedDisturbance: buildDisturbance(config, 'baseline', 0),
        recordingUploadTimeoutSeconds: 1,
      });
    }

    if (shared > 0) {
      rules.push({
        type: 'showInstruction',
        text: 'From the next trial, you will control <strong><em>a shared cursor with another participant</em></strong>.',
        durationMs: 3000,
        waitForDuration: true,
        displayMode: 'self',
        position: 'bottom',
      });
    }

    for (let i = 0; i < shared; i++) {
      rules.push({
        ...buildExecuteTrialRule(config, experimentName, trialNumber++, total),
        displayMode: 'avgOnly',
        sharedPhase: 'shared',
        sharedDisturbance: buildDisturbance(config, 'shared', 0),
        recordingUploadTimeoutSeconds: 1,
      });
    }

    if (washout > 0) {
      rules.push({
        type: 'showInstruction',
        text: 'From the next trial, you will control <strong><em>your own cursor</em></strong> again.',
        durationMs: 3000,
        waitForDuration: true,
        displayMode: 'self',
        position: 'bottom',
      });
    }

    for (let i = 0; i < washout; i++) {
      rules.push({
        ...buildExecuteTrialRule(config, experimentName, trialNumber++, total),
        displayMode: 'self',
        sharedPhase: 'washout',
        sharedDisturbance: buildDisturbance(config, 'washout', 0),
        recordingUploadTimeoutSeconds: 1,
      });
    }

    return rules;
  },
};
