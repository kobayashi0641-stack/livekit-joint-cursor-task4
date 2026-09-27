#!/usr/bin/env tsx
/**
 * Debug-only avg cursor monitor.
 *
 * Connects to the room as a non-publishing identity (no cursor publish),
 * listens to the cursor topic for all participants, and prints the running
 * average cursor every 500ms — used to verify reaching trial resets.
 */

import { Room, RoomEvent } from '@livekit/rtc-node';

const SERVER = process.env.SERVER ?? 'http://localhost:3001';
const ROOM = process.env.ROOM ?? 'joint-cursor-task2';
const IDENTITY = process.env.IDENTITY ?? `monitor-${Date.now()}`;

const VERSION = 1;
const CURSOR_RANGE_MIN = -4.0;
const CURSOR_RANGE_MAX = 5.0;
const CURSOR_RANGE_SIZE = CURSOR_RANGE_MAX - CURSOR_RANGE_MIN;

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
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
  return (await res.json()) as { token: string; url: string };
}

async function main() {
  const { token, url } = await fetchToken(SERVER, ROOM, IDENTITY);
  const room = new Room();
  const cursors = new Map<string, { x: number; y: number; t: number }>();
  let lastTrialEvent = '';
  let avgOffset = { x: 0, y: 0 };

  room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    if (topic === 'cursor') {
      const dec = decodeCursor(payload);
      if (!dec) return;
      const id = participant?.identity ?? `hash-${dec.hash.toString(16)}`;
      cursors.set(id, { x: dec.x, y: dec.y, t: Date.now() });
    } else if (topic === 'control' || topic === 'broadcast') {
      try {
        const text = new TextDecoder().decode(payload);
        const msg = JSON.parse(text);
        if (msg.type === 'setAvgCursorOffset') {
          avgOffset = { x: msg.x ?? 0, y: msg.y ?? 0 };
        }
        if (msg.type === 'setVirtualCursorPosition' || msg.type === 'taskControl' || msg.type === 'setTargetVisibility' || msg.type === 'broadcast' || msg.type === 'setAvgCursorOffset') {
          lastTrialEvent = `${msg.type}${msg.taskMode ? ' '+msg.taskMode : ''}${msg.x !== undefined ? ` (${msg.x},${msg.y})` : ''}${msg.visible !== undefined ? ` v=${msg.visible}` : ''}${msg.text ? ` "${msg.text.slice(0,30)}"` : ''}`;
        }
      } catch { /* ignore */ }
    }
  });

  await room.connect(url, token);
  console.log(`[monitor] Connected. Watching cursors…`);

  const tick = setInterval(() => {
    const now = Date.now();
    let sx = 0, sy = 0, n = 0;
    const positions: string[] = [];
    for (const [id, c] of cursors) {
      if (now - c.t > 2000) continue;
      sx += c.x; sy += c.y; n++;
      if (id.startsWith('sim-bot-')) positions.push(`${id.slice(8)}=(${c.x.toFixed(2)},${c.y.toFixed(2)})`);
    }
    if (n === 0) return;
    const raw = { x: sx / n, y: sy / n };
    const disp = { x: raw.x - avgOffset.x, y: raw.y - avgOffset.y };
    const ts = new Date().toISOString().slice(11, 23);
    const offsetTag = (avgOffset.x !== 0 || avgOffset.y !== 0) ? ` off=(${avgOffset.x.toFixed(2)},${avgOffset.y.toFixed(2)})` : '';
    console.log(`[${ts}] raw=(${raw.x.toFixed(3)},${raw.y.toFixed(3)}) disp=(${disp.x.toFixed(3)},${disp.y.toFixed(3)})${offsetTag} n=${n} | last: ${lastTrialEvent}`);
  }, 500);

  process.on('SIGINT', () => { clearInterval(tick); room.disconnect(); process.exit(0); });
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
