#!/usr/bin/env tsx
/**
 * Debug-only LiveKit listener.
 *
 * Connects to the room as a "participant" (non-admin identity) and logs
 * every control / target / broadcast message it receives, plus the positions
 * of cursors it sees on the cursor topic. Used to verify what the agent is
 * actually sending in the reaching task.
 */

import { Room, RoomEvent } from '@livekit/rtc-node';

const SERVER = process.env.SERVER ?? 'http://localhost:3001';
const ROOM = process.env.ROOM ?? 'joint-cursor-task2';
const IDENTITY = process.env.IDENTITY ?? `debug-listener-${Date.now()}`;

const VERSION = 1;
const CURSOR_RANGE_MIN = -4.0;
const CURSOR_RANGE_MAX = 5.0;
const CURSOR_RANGE_SIZE = CURSOR_RANGE_MAX - CURSOR_RANGE_MIN;

function decodeCursorPayload(buf: Uint8Array): { hash: number; x: number; y: number } | null {
  if (buf.length < 11) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint8(0) !== VERSION) return null;
  const hash = view.getUint16(1, false);
  const xRaw = view.getUint16(3, false);
  const yRaw = view.getUint16(5, false);
  const x = (xRaw / 65535) * CURSOR_RANGE_SIZE + CURSOR_RANGE_MIN;
  const y = (yRaw / 65535) * CURSOR_RANGE_SIZE + CURSOR_RANGE_MIN;
  return { hash, x, y };
}

async function fetchToken(server: string, room: string, identity: string) {
  const url = `${server}/token?room=${encodeURIComponent(room)}&identity=${encodeURIComponent(identity)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as { token: string; url: string };
}

async function main() {
  console.log(`[listener] Identity: ${IDENTITY}`);
  console.log(`[listener] Fetching token from ${SERVER}…`);
  const { token, url } = await fetchToken(SERVER, ROOM, IDENTITY);
  console.log(`[listener] Connecting to ${url}…`);

  const room = new Room();

  room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    const sender = participant?.identity ?? 'SERVER';
    const ts = new Date().toISOString().slice(11, 23);

    if (topic === 'cursor') {
      // Skip cursor topic to keep the log readable
      return;
    }

    if (topic === 'control' || topic === 'target' || topic === 'broadcast') {
      try {
        const text = new TextDecoder().decode(payload);
        const msg = JSON.parse(text);
        // Highlight reaching-related messages
        const isReachingRelevant =
          msg.type === 'setVirtualCursorPosition' ||
          msg.type === 'resetVirtualCursorPosition' ||
          msg.type === 'setCursorRotation' ||
          msg.type === 'taskControl' ||
          msg.type === 'setTargetVisibility' ||
          msg.type === 'target';
        const tag = isReachingRelevant ? '★' : ' ';
        const summary = JSON.stringify(msg);
        console.log(`[${ts}] ${tag} [${topic}] from=${sender} ${summary.slice(0, 200)}`);
      } catch {
        console.log(`[${ts}]   [${topic}] from=${sender} <binary, ${payload.length}B>`);
      }
      return;
    }
  });

  await room.connect(url, token);
  console.log(`[listener] Connected. Listening for messages…`);

  process.on('SIGINT', () => {
    console.log('\n[listener] Disconnecting…');
    room.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[listener] Fatal:', err);
  process.exit(1);
});
