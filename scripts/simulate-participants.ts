#!/usr/bin/env tsx
/**
 * Headless simulated participants for local testing.
 *
 * Each bot:
 *   1. Fetches a LiveKit token from the local token server.
 *   2. Connects to the LiveKit room via @livekit/rtc-node.
 *   3. Publishes cursor-position data packets on the "cursor" topic,
 *      following the same binary protocol the web client uses.
 *
 * Usage:
 *   npx tsx scripts/simulate-participants.ts          # 5 bots (default)
 *   npx tsx scripts/simulate-participants.ts --count 10
 *   npx tsx scripts/simulate-participants.ts --count 3 --server http://localhost:3001 --room joint-cursor-task2
 */

import { Room, RoomEvent, DataPacketKind } from '@livekit/rtc-node';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  let count = 5;
  let server = 'http://localhost:3001';
  let room = 'joint-cursor-task2';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--count' && args[i + 1]) {
      count = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--server' && args[i + 1]) {
      server = args[i + 1];
      i++;
    } else if (args[i] === '--room' && args[i + 1]) {
      room = args[i + 1];
      i++;
    }
  }
  return { count, server, room };
}

// ---------------------------------------------------------------------------
// Binary cursor protocol (matches packages/web/src/App.tsx)
// ---------------------------------------------------------------------------
const VERSION = 1;
const CURSOR_RANGE_MIN = -4.0;
const CURSOR_RANGE_MAX = 5.0;
const CURSOR_RANGE_SIZE = CURSOR_RANGE_MAX - CURSOR_RANGE_MIN; // 9.0

function hashIdentity(identity: string): number {
  let hash = 0;
  for (let i = 0; i < identity.length; i++) {
    hash = (hash * 31 + identity.charCodeAt(i)) & 0xffff;
  }
  return hash & 0xffff;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function encodeCursorPayload(identity: string, x: number, y: number): Buffer {
  const buf = Buffer.alloc(11);
  buf.writeUInt8(VERSION, 0);
  buf.writeUInt16BE(hashIdentity(identity), 1);
  const cx = clamp(x, CURSOR_RANGE_MIN, CURSOR_RANGE_MAX);
  const cy = clamp(y, CURSOR_RANGE_MIN, CURSOR_RANGE_MAX);
  buf.writeUInt16BE(Math.round(((cx - CURSOR_RANGE_MIN) / CURSOR_RANGE_SIZE) * 65535), 3);
  buf.writeUInt16BE(Math.round(((cy - CURSOR_RANGE_MIN) / CURSOR_RANGE_SIZE) * 65535), 5);
  // Take the low 32 bits as unsigned. `& 0xffffffff` returns a signed int in JS
  // (e.g. -261520157 for a current millisecond timestamp), which makes Node's
  // strict `writeUInt32BE` reject the value. `>>> 0` reinterprets as uint32.
  buf.writeUInt32BE(Date.now() >>> 0, 7);
  return buf;
}

// ---------------------------------------------------------------------------
// Token fetch
// ---------------------------------------------------------------------------
async function fetchToken(server: string, room: string, identity: string) {
  const url = `${server}/token?room=${encodeURIComponent(room)}&identity=${encodeURIComponent(identity)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as { token: string; url: string };
}

// ---------------------------------------------------------------------------
// Bot logic
// ---------------------------------------------------------------------------
async function runBot(index: number, server: string, roomName: string) {
  const identity = `sim-bot-${index}`;
  console.log(`[${identity}] Fetching token...`);
  const { token, url } = await fetchToken(server, roomName, identity);

  const room = new Room();

  room.on(RoomEvent.Disconnected, () => {
    console.log(`[${identity}] Disconnected`);
  });

  // Movement pattern: circular orbit with per-bot phase offset + noise
  const phase = (index / 5) * 2 * Math.PI;
  const speed = 0.1; // revolutions per second
  const radius = 0.25;
  const noise = 0.06;
  const noisePhaseX = Math.random() * Math.PI * 2;
  const noisePhaseY = Math.random() * Math.PI * 2;
  const startTime = Date.now();

  // Per-bot reaching state. In 'orbit' mode (default) bots use the existing
  // circular orbit pattern. When the agent switches taskMode to 'reaching'
  // and a target is published, bots drift toward `target + avgOffset` (the
  // *raw* target) so the displayed avg cursor (rawAvg − avgOffset) reaches
  // the displayed target naturally and trials can complete.
  let mode: 'orbit' | 'reach' = 'orbit';
  let position: { x: number; y: number } = { x: 0.5, y: 0.5 };
  let lastTarget: { x: number; y: number } | null = null;
  let targetVisible = false;
  let avgOffset = { x: 0, y: 0 };
  // Visuomotor rotation (radians). Mirrors the React app's behavior so the
  // bot's drift direction is rotated by this angle each frame — a "naive"
  // simulated human who moves their hand straight toward the target without
  // compensating for the rotation, so the cursor traces a curved path.
  let cursorRotationRad = 0;

  room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
    try {
      const text = new TextDecoder().decode(payload);
      const msg = JSON.parse(text) as Record<string, unknown>;
      if (topic === 'control') {
        if (msg.type === 'taskControl') {
          const tm = msg.taskMode as string;
          mode = tm === 'reaching' ? 'reach' : 'orbit';
          if (mode === 'orbit') {
            targetVisible = false;
            lastTarget = null;
            avgOffset = { x: 0, y: 0 };
          }
        } else if (msg.type === 'setTargetVisibility') {
          targetVisible = !!msg.visible;
        } else if (msg.type === 'setAvgCursorOffset') {
          const x = typeof msg.x === 'number' ? msg.x : 0;
          const y = typeof msg.y === 'number' ? msg.y : 0;
          avgOffset = { x, y };
        } else if (msg.type === 'resetVirtualCursorPosition') {
          // Mirror the React app: every participant resets to stage center.
          position = { x: 0.5, y: 0.5 };
        } else if (msg.type === 'setVirtualCursorPosition') {
          // Mirror the React app: jump to the requested position.
          const x = typeof msg.x === 'number' ? msg.x : 0.5;
          const y = typeof msg.y === 'number' ? msg.y : 0.5;
          position = { x, y };
        } else if (msg.type === 'setCursorRotation') {
          const deg = typeof msg.degrees === 'number' ? msg.degrees : 0;
          cursorRotationRad = (deg * Math.PI) / 180;
        }
      } else if (topic === 'target') {
        if (msg.type === 'target') {
          lastTarget = { x: msg.x as number, y: msg.y as number };
        }
      }
    } catch {
      // ignore non-JSON / unrelated payloads
    }
  });

  console.log(`[${identity}] Connecting to ${url} room=${roomName}...`);
  await room.connect(url, token);
  console.log(`[${identity}] Connected!`);

  const interval = setInterval(async () => {
    if (mode === 'orbit') {
      const elapsed = (Date.now() - startTime) / 1000;
      const angle = 2 * Math.PI * speed * elapsed + phase;
      const baseX = 0.5 + radius * Math.cos(angle);
      const baseY = 0.5 + radius * Math.sin(angle);

      const nx = noise * (
        0.6 * Math.sin(1.7 * elapsed + noisePhaseX) +
        0.4 * Math.sin(4.3 * elapsed + noisePhaseX * 1.5)
      );
      const ny = noise * (
        0.6 * Math.sin(2.1 * elapsed + noisePhaseY) +
        0.4 * Math.sin(3.7 * elapsed + noisePhaseY * 1.3)
      );

      position = {
        x: clamp(baseX + nx, 0.02, 0.98),
        y: clamp(baseY + ny, 0.02, 0.98),
      };
    } else {
      // reach mode — naive human simulation: aim straight toward the raw
      // target and rotate the input by `cursorRotationRad` (no compensation),
      // so the actual cursor path curves in the rotation direction. Without
      // the rotation, this still goes straight to the raw target and the
      // displayed avg reaches the displayed target normally.
      if (targetVisible && lastTarget) {
        const rawTargetX = lastTarget.x + avgOffset.x;
        const rawTargetY = lastTarget.y + avgOffset.y;
        const dx = rawTargetX - position.x;
        const dy = rawTargetY - position.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 0.001) {
          const stepPerFrame = 0.006 + (index % 5) * 0.0008; // ~0.18–0.30 stage units / s
          const step = Math.min(stepPerFrame, dist);
          const inDx = (dx / dist) * step;
          const inDy = (dy / dist) * step;
          const c = Math.cos(cursorRotationRad);
          const s = Math.sin(cursorRotationRad);
          position = {
            x: position.x + inDx * c - inDy * s,
            y: position.y + inDx * s + inDy * c,
          };
        }
      }
      // else: stay put until target+offset are known
    }

    const payload = encodeCursorPayload(identity, position.x, position.y);
    try {
      await room.localParticipant.publishData(payload, {
        reliable: false,
        topic: 'cursor',
      });
    } catch {
      // ignore transient publish errors
    }
  }, 33); // ~30 Hz, matching the web client's SEND_INTERVAL_MS

  // Return cleanup function
  return () => {
    clearInterval(interval);
    room.disconnect();
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const { count, server, room } = parseArgs();

  console.log(`Starting ${count} simulated participants...`);
  console.log(`  Token server: ${server}`);
  console.log(`  Room: ${room}`);
  console.log('');

  const cleanups: Array<() => void> = [];

  for (let i = 0; i < count; i++) {
    try {
      const cleanup = await runBot(i, server, room);
      cleanups.push(cleanup);
    } catch (err) {
      console.error(`[sim-bot-${i}] Failed to start:`, err);
    }
    // Stagger connections slightly
    if (i < count - 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log(`\n${cleanups.length}/${count} bots running. Press Ctrl+C to stop.\n`);

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down bots...');
    for (const cleanup of cleanups) {
      try { cleanup(); } catch { /* ignore */ }
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
