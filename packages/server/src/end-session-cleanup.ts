export const END_SESSION_FORCE_DISCONNECT_DELAY_MS = 2 * 60 * 1000;

type ParticipantConnection = {
  identity: string;
  metadata?: string;
};

type RoomService = {
  listParticipants(roomName: string): Promise<ParticipantConnection[]>;
  removeParticipant(roomName: string, identity: string): Promise<unknown>;
};

function isExperimentParticipant(participant: ParticipantConnection): boolean {
  if (participant.identity.startsWith('admin:')) return false;
  if (
    participant.identity.startsWith('sim-bot-')
    || participant.identity.startsWith('sim-participant-')
    || participant.identity.startsWith('debug-')
    || participant.identity.startsWith('werewolf:')
    || participant.identity.startsWith('latency-')
  ) {
    return false;
  }
  if (!participant.metadata) return true;
  try {
    const metadata = JSON.parse(participant.metadata) as { role?: unknown };
    return metadata.role === undefined || metadata.role === 'experiment-participant';
  } catch {
    return true;
  }
}

async function disconnectMatchingParticipants(options: {
  roomService: RoomService;
  roomName: string;
  participantIdentities: string[];
}): Promise<string[]> {
  const targetIdentities = new Set(options.participantIdentities);
  if (targetIdentities.size === 0) return [];
  const participants = await options.roomService.listParticipants(options.roomName);
  const remainingTargets = participants.filter((participant) => (
    targetIdentities.has(participant.identity) && isExperimentParticipant(participant)
  ));
  await Promise.all(remainingTargets.map((participant) => (
    options.roomService.removeParticipant(options.roomName, participant.identity)
  )));
  return remainingTargets.map((participant) => participant.identity);
}

export async function disconnectCompletedParticipant(options: {
  roomService: RoomService;
  roomName: string;
  identity: string;
  completedParticipantIdentities: string[];
}): Promise<boolean> {
  if (!options.completedParticipantIdentities.includes(options.identity)) return false;
  const removed = await disconnectMatchingParticipants({
    roomService: options.roomService,
    roomName: options.roomName,
    participantIdentities: [options.identity],
  });
  return removed.includes(options.identity);
}

export function scheduleEndSessionParticipantCleanup(options: {
  roomService: RoomService;
  roomName: string;
  participantIdentities: string[];
  schedule?: (task: () => Promise<void>, delay: number) => unknown;
}): void {
  const completedParticipantIdentities = [...new Set(options.participantIdentities)];
  const task = async (): Promise<void> => {
    try {
      const removed = await disconnectMatchingParticipants({
        roomService: options.roomService,
        roomName: options.roomName,
        participantIdentities: completedParticipantIdentities,
      });
      if (removed.length > 0) {
        console.log(`[Agent] End-session safety cleanup disconnected: ${removed.join(', ')}`);
      }
    } catch (error) {
      console.warn('[Agent] End-session safety cleanup failed:', error);
    }
  };
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const timer = schedule(task, END_SESSION_FORCE_DISCONNECT_DELAY_MS);
  if (timer && typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }
}
