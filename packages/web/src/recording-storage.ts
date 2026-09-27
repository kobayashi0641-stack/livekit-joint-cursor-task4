export type RecordingStorageDescription = {
  mode: 'local' | 'remote';
  label: string;
  url: string;
  detail: string;
};

export function describeRecordingStorage(
  useRemote: boolean,
  storageUrl: string,
): RecordingStorageDescription {
  const url = storageUrl.replace(/\/$/, '');
  return useRemote
    ? {
        mode: 'remote',
        label: 'Remote Supabase',
        url,
        detail: 'Stored in the configured remote Supabase project.',
      }
    : {
        mode: 'local',
        label: 'Local Supabase (Docker)',
        url,
        detail: 'Stored in the local Docker PostgreSQL volume on this PC.',
      };
}
