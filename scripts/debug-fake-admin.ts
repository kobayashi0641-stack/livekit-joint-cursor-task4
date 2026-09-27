#!/usr/bin/env tsx
/**
 * Debug-only "fake admin" — connects as admin (so it doesn't publish a cursor)
 * and acknowledges recording start/stop to /agent/recording-status, plus posts
 * the running avg cursor to /agent/avg-cursor while the agent expects it.
 * Lets headless multi-trial tests advance without a real browser admin.
 */

import { Room, RoomEvent } from '@livekit/rtc-node';

const SERVER = process.env.SERVER ?? 'http://localhost:3001';
const ROOM = process.env.ROOM ?? 'joint-cursor-task2';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) throw new Error('Missing required environment variable: ADMIN_PASSWORD');

const VERSION = 1;
const CURSOR_RANGE_MIN = -4.0;
const CURSOR_RANGE_MAX = 5.0;
const CURSOR_RANGE_SIZE = CURSOR_RANGE_MAX - CURSOR_RANGE_MIN;

function decodeCursor(buf: Uint8Array) {
  if (buf.length < 11) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint8(0) !== VERSION) return null;
  const xRaw = view.getUint16(3, false);
  const yRaw = view.getUint16(5, false);
  const x = (xRaw / 65535) * CURSOR_RANGE_SIZE + CURSOR_RANGE_MIN;
  const y = (yRaw / 65535) * CURSOR_RANGE_SIZE + CURSOR_RANGE_MIN;
  return { x, y };
}

async function fetchToken() {
  const url = `${SERVER}/token?room=${encodeURIComponent(ROOM)}&adminPassword=${encodeURIComponent(ADMIN_PASSWORD)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
  return (await res.json()) as { token: string; url: string };
}

async function postStatus(status: string, experimentName: string, trialNumber: number) {
  await fetch(`${SERVER}/agent/recording-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, experimentName, trialNumber }),
  }).catch(() => {});
}

async function postAvg(x: number, y: number) {
  await fetch(`${SERVER}/agent/avg-cursor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x, y }),
  }).catch(() => {});
}

async function main() {
  const { token, url } = await fetchToken();
  const room = new Room();
  const cursors = new Map<string, { x: number; y: number; t: number }>();

  room.on(RoomEvent.DataReceived, async (payload, participant, _kind, topic) => {
    if (topic === 'cursor') {
      const dec = decodeCursor(payload);
      if (dec) {
        const id = participant?.identity ?? `unknown`;
        cursors.set(id, { x: dec.x, y: dec.y, t: Date.now() });
      }
      return;
    }
    if (topic === 'control') {
      try {
        const text = new TextDecoder().decode(payload);
        const msg = JSON.parse(text);
        if (msg.type === 'agentStartRecording') {
          console.log('[fake-admin] recording started → status=recording');
          await postStatus('recording', msg.experimentName, msg.trialNumber);
        } else if (msg.type === 'agentStopRecording') {
          // Pretend upload took ~500ms then completed.
          console.log('[fake-admin] stop → uploading');
          await postStatus('uploading', msg.experimentName, msg.trialNumber);
          await new Promise((r) => setTimeout(r, 500));
          console.log('[fake-admin] uploaded ✓');
          await postStatus('uploaded', msg.experimentName, msg.trialNumber);
        }
      } catch { /* ignore */ }
    }
  });

  await room.connect(url, token);
  console.log('[fake-admin] Connected. Forwarding avg cursor at 10Hz…');

  const tick = setInterval(() => {
    const now = Date.now();
    let sx = 0, sy = 0, n = 0;
    for (const [, c] of cursors) {
      if (now - c.t > 2000) continue;
      sx += c.x; sy += c.y; n++;
    }
    if (n > 0) postAvg(sx / n, sy / n);
  }, 100);

  process.on('SIGINT', () => { clearInterval(tick); room.disconnect(); process.exit(0); });
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
