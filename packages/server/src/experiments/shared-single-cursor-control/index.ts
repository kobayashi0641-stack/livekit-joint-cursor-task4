import type { AgentRule, ExperimentConfig } from '../../agent-rules.js';
import { buildExecuteTrialRule } from '../common-flow.js';
import type { ExperimentTask } from '../types.js';
import { runTrialBody } from './experiment.js';
import { generateInstructions } from './instructions.js';

export const sharedSingleCursorControlTask: ExperimentTask = {
  type: 'shared-single-cursor-control',
  label: 'Shared/Single Cursor Control',
  liveKitTaskMode: 'shared-single-cursor',
  generateInstructions,
  runTrialBody,
  generateTrialSequence(config: ExperimentConfig, experimentName: string): AgentRule[] {
    const baseline = Math.max(0, Math.floor(config.sharedPracticeTrials));
    const shared = Math.max(0, Math.floor(config.sharedMainTrials));
    const solo = Math.max(0, Math.floor(config.sharedSoloTrials));
    const total = baseline + shared + solo;
    const rules: AgentRule[] = [];

    for (let i = 0; i < baseline; i++) {
      rules.push({
        ...buildExecuteTrialRule(config, experimentName, i + 1, total),
        displayMode: 'self',
        sharedPhase: 'baseline',
        recordingUploadTimeoutSeconds: 1,
      });
    }

    if (shared + solo > 0) {
      rules.push({
        type: 'showInstruction',
        text: 'The baseline trials are now complete.',
        durationMs: 2000,
        waitForDuration: true,
        displayMode: 'self',
        position: 'bottom',
      });
      rules.push({
        type: 'showInstruction',
        text: 'From the next trial, you will control a shared cursor with another participant.',
        durationMs: 3000,
        waitForDuration: true,
        displayMode: 'self',
        position: 'bottom',
      });
    }

    for (let i = 0; i < shared; i++) {
      rules.push({
        ...buildExecuteTrialRule(config, experimentName, baseline + i + 1, total),
        displayMode: 'avgOnly',
        sharedPhase: 'shared',
        recordingUploadTimeoutSeconds: 1,
      });
    }

    for (let i = 0; i < solo; i++) {
      rules.push({
        ...buildExecuteTrialRule(config, experimentName, baseline + shared + i + 1, total),
        displayMode: 'avgOnly',
        sharedPhase: 'solo',
        recordingUploadTimeoutSeconds: 1,
      });
    }

    return rules;
  },
};
