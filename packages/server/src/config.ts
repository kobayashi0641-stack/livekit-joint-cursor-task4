import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Always load the server package's .env regardless of process.cwd()
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../.env'), override: true });

const requiredEnv = ['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'ADMIN_PASSWORD'] as const;

type RequiredEnv = typeof requiredEnv[number];

function getEnv(name: RequiredEnv): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  port: parseNumber(process.env.PORT, 3001),
  tokenTtlSeconds: parseNumber(process.env.TOKEN_TTL_SECONDS, 600),
  apiKey: getEnv('LIVEKIT_API_KEY'),
  apiSecret: getEnv('LIVEKIT_API_SECRET'),
  wsUrl: (() => {
    const url = process.env.LIVEKIT_WS_URL ?? process.env.LIVEKIT_URL;
    if (!url) {
      throw new Error('Missing required environment variable: LIVEKIT_WS_URL (or fallback LIVEKIT_URL)');
    }
    return url;
  })(),
  adminPassword: getEnv('ADMIN_PASSWORD'),
  prolificApiToken: process.env.PROLIFIC_API_TOKEN?.trim() || null,
  prolificApiBaseUrl: process.env.PROLIFIC_API_BASE_URL?.trim() || 'https://api.prolific.com/api/v1',
};
