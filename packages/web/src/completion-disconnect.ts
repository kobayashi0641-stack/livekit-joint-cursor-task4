export async function finishAdminSession(options: {
  disconnect: () => Promise<void>;
}): Promise<void> {
  try {
    await options.disconnect();
  } catch (error) {
    console.warn('Failed to disconnect the admin from LiveKit after experiment completion:', error);
  }
}

export async function finishParticipantSession(options: {
  notifyServer: () => Promise<void>;
  disconnect: () => Promise<void>;
  navigate: (url: string) => void;
  completionUrl: string;
}): Promise<void> {
  try {
    await options.notifyServer();
  } catch (error) {
    console.warn('Failed to notify the server about participant completion:', error);
  }
  try {
    await options.disconnect();
  } catch (error) {
    console.warn('Failed to disconnect LiveKit before completion redirect:', error);
  } finally {
    options.navigate(options.completionUrl);
  }
}
