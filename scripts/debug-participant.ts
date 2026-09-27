#!/usr/bin/env tsx
/**
 * Debug-only "real" participant simulator.
 *
 * Mimics what a browser participant tab does for the messages relevant to
 * reaching: when it receives setVirtualCursorPosition (or
 * resetVirtualCursorPosition), it publishes its own cursor at the new position
 * on the cursor topic — exactly what the React app's handleControlMessage does.
 *
 * Each instance also tracks all cursors it sees and prints the running
 * average, so we can verify whether reset → publish → avg propagates.
 */

import { Room, RoomEvent, DataPacketKind } from '@livekit/rtc-node';

const SERVER = process.env.SERVER ?? 'http://localhost:3001';
const ROOM = process.env.ROOM ?? 'joint-cursor-task2';
const IDENTITY = process.env.IDENTITY ?? `debug-participant-${Date.now()}`;

const VERSION = 1;
const CURSOR_RANGE_MIN = -4.0;
const CURSOR_RANGE_MAX = 5.0;
const CURSOR_RANGE_SIZE = CURSOR_RANGE_MAX - CURSOR_RANGE_MIN;

function hashIdentity(identity: string): number {
  let hash = 0;
  for (let i = 0; i < identity.length; i++) {
    hash = (hash * 31 + identity.charCodeAt(i)) & 0xffff;
  }
  return hash & 0xffff;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function encodeCursor(identity: string, x: number, y: number): Buffer {
  const buf = Buffer.alloc(11);
  buf.writeUInt8(VERSION, 0);
  buf.writeUInt16BE(hashIdentity(identity), 1);
  const cx = clamp(x, CURSOR_RANGE_MIN, CURSOR_RANGE_MAX);
  const cy = clamp(y, CURSOR_RANGE_MIN, CURSOR_RANGE_MAX);
  buf.writeUInt16BE(Math.round(((cx - CURSOR_RANGE_MIN) / CURSOR_RANGE_SIZE) * 65535), 3);
  buf.writeUInt16BE(Math.round(((cy - CURSOR_RANGE_MIN) / CURSOR_RANGE_SIZE) * 65535), 5);
  buf.writeUInt32BE(Date.now() >>> 0, 7);
  return buf;
}

function decodeCursor(buf: Uint8Array) {
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
  const { token, url } = await fetchToken(SERVER, ROOM, IDENTITY);
  console.log(`[${IDENTITY}] Connecting…`);

  const room = new Room();

  // x, y in stage units. Initial = wherever (matches "user hasn't moved yet")
  let myCursor = { x: 0.4 + Math.random() * 0.2, y: 0.4 + Math.random() * 0.2 };
  // Track all cursors we've seen by hash → for computing local avg
  const cursors = new Map<string, { x: number; y: number; t: number }>();

  function publishCursor(x: number, y: number) {
    myCursor = { x, y };
    cursors.set(`local:${IDENTITY}`, { x, y, t: Date.now() });
    const payload = encodeCursor(IDENTITY, x, y);
    room.localParticipant.publishData(payload, { reliable: false, topic: 'cursor' }).catch(() => {});
  }

  function logAvg(reason: string) {
    const now = Date.now();
    let sx = 0, sy = 0, n = 0;
    for (const [, c] of cursors) {
      if (now - c.t > 5000) continue; // ignore stale
      sx += c.x; sy += c.y; n++;
    }
    if (n === 0) return;
    const avg = { x: sx / n, y: sy / n };
    console.log(`[${IDENTITY}] avg=(${avg.x.toFixed(3)},${avg.y.toFixed(3)}) n=${n} my=(${myCursor.x.toFixed(3)},${myCursor.y.toFixed(3)}) ← ${reason}`);
  }

  room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    const sender = participant?.identity ?? 'SERVER';

    if (topic === 'cursor') {
      const dec = decodeCursor(payload);
      if (!dec) return;
      const id = participant?.identity ?? `hash-${dec.hash.toString(16)}`;
      cursors.set(id, { x: dec.x, y: dec.y, t: Date.now() });
      return;
    }

    if (topic === 'control') {
      try {
        const text = new TextDecoder().decode(payload);
        const msg = JSON.parse(text);

        if (msg.type === 'setVirtualCursorPosition') {
          console.log(`[${IDENTITY}] ★ Received setVirtualCursorPosition (${msg.x}, ${msg.y}) from ${sender}`);
          publishCursor(msg.x, msg.y);
          logAvg('after setVirtualCursorPosition publish');
        } else if (msg.type === 'resetVirtualCursorPosition') {
          console.log(`[${IDENTITY}] ★ Received resetVirtualCursorPosition from ${sender}`);
          publishCursor(0.5, 0.5);
          logAvg('after resetVirtualCursorPosition publish');
        } else if (msg.type === 'taskControl') {
          console.log(`[${IDENTITY}] taskControl → ${msg.taskMode}`);
        }
      } catch { /* ignore */ }
    }
  });

  await room.connect(url, token);
  console.log(`[${IDENTITY}] Connected. Initial position (${myCursor.x.toFixed(3)},${myCursor.y.toFixed(3)})`);

  // Publish initial cursor + keepalive at 5Hz (matches App.tsx)
  publishCursor(myCursor.x, myCursor.y);
  const keepAlive = setInterval(() => {
    publishCursor(myCursor.x, myCursor.y);
  }, 200);

  // Periodic avg log (every second) so we can see stability
  const avgTick = setInterval(() => logAvg('tick'), 1000);

  process.on('SIGINT', () => {
    clearInterval(keepAlive);
    clearInterval(avgTick);
    room.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
