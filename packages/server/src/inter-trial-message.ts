export function formatInterTrialUploadMessage(trialNumber: number, totalTrials: number): string {
  return `Trial ${trialNumber} of ${totalTrials} is complete.\nData is now uploading...`;
}
