import cors from 'cors';
import express from 'express';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { env } from './config.js';
import { ExperimentAgent } from './agent.js';
import type { AgentRule, ExperimentConfig } from './agent-rules.js';
import { ProlificClient } from './prolific-recovery.js';
import { isValidSharedContribution } from './shared-contribution-policy.js';

// Initialize RoomServiceClient for participant management
const roomService = new RoomServiceClient(env.wsUrl, env.apiKey, env.apiSecret);

// Initialize Experiment Agent
const prolificClient = env.prolificApiToken
  ? new ProlificClient(env.prolificApiToken, env.prolificApiBaseUrl)
  : null;
const agent = new ExperimentAgent(roomService, 'joint-cursor-task2', prolificClient);

const app = express();
app.use(cors());
app.use(express.json());

function clientLiveKitUrl(req: express.Request): string {
  try {
    const configured = new URL(env.wsUrl);
    const isLocalLiveKit = ['localhost', '127.0.0.1', '::1'].includes(configured.hostname);
    if (!isLocalLiveKit) {
      return env.wsUrl;
    }
    const requestedPublicHost = typeof req.query.publicHost === 'string'
      ? req.query.publicHost.trim()
      : '';
    const origin = typeof req.get('origin') === 'string' ? req.get('origin') : '';
    const hostSource = origin && origin.length > 0
      ? new URL(origin).hostname
      : requestedPublicHost.length > 0
        ? requestedPublicHost
      : req.hostname;
    const publicHostname = ['localhost', '127.0.0.1', '::1'].includes(hostSource)
      ? configured.hostname
      : hostSource;
    configured.hostname = publicHostname;
    return configured.toString();
  } catch {
    return env.wsUrl;
  }
}

app.get('/healthz', (_, res) => {
  res.json({ status: 'ok' });
});

/** Public: current participant latency-check threshold (median RTT in ms). */
app.get('/latency-threshold', (_, res) => {
  const cfg = agent.getConfig();
  const t = cfg.latencyThresholdMs;
  const thresholdMs = typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : 100;
  res.json({ thresholdMs });
});

app.get('/token', async (req, res) => {
  const room = typeof req.query.room === 'string' && req.query.room.length > 0
    ? req.query.room
    : 'joint-cursor-task2';
  
  const adminPassword = typeof req.query.adminPassword === 'string' ? req.query.adminPassword : '';
  const isAdmin = adminPassword.length > 0 && adminPassword === env.adminPassword;
  const requestedRole = typeof req.query.role === 'string' ? req.query.role : '';
  const isExperimentParticipant = !isAdmin && requestedRole === 'experiment-participant';
  
  const hasExplicitParticipantIdentity = typeof req.query.identity === 'string' && req.query.identity.length > 0;
  let identity: string;
  if (isAdmin) {
    identity = `admin:${randomUUID()}`;
  } else {
    const userIdentity = hasExplicitParticipantIdentity
      ? req.query.identity as string
      : randomUUID();
    identity = userIdentity.startsWith('admin:') ? userIdentity.slice(6) : userIdentity;
  }
  const metadata = JSON.stringify({
    role: isAdmin
      ? 'admin'
      : isExperimentParticipant
        ? 'experiment-participant'
        : 'anonymous',
  });

  try {
    const token = new AccessToken(env.apiKey, env.apiSecret, {
      identity,
      ttl: env.tokenTtlSeconds,
      metadata,
    });
    token.addGrant({ roomJoin: true, room });

    res.json({
      token: await token.toJwt(),
      url: clientLiveKitUrl(req),
      identity,
      room,
      isAdmin,
      expiresIn: env.tokenTtlSeconds,
    });
  } catch (error) {
    console.error('Failed to issue LiveKit token', error);
    res.status(500).json({ message: 'Failed to issue token' });
  }
});

app.post('/kick', async (req, res) => {
  const { room, identity, adminPassword } = req.body;

  if (!room || typeof room !== 'string') {
    res.status(400).json({ message: 'Missing or invalid room parameter' });
    return;
  }

  if (!identity || typeof identity !== 'string') {
    res.status(400).json({ message: 'Missing or invalid identity parameter' });
    return;
  }

  if (!adminPassword || adminPassword !== env.adminPassword) {
    res.status(403).json({ message: 'Unauthorized: Invalid admin password' });
    return;
  }

  try {
    await roomService.removeParticipant(room, identity);
    console.log(`Kicked participant ${identity} from room ${room}`);
    res.json({ success: true, message: `Participant ${identity} has been removed from room ${room}` });
  } catch (error) {
    console.error('Failed to kick participant', error);
    res.status(500).json({ message: 'Failed to kick participant' });
  }
});

// ---------------------------------------------------------------------------
// Agent API endpoints
// ---------------------------------------------------------------------------

/** Get agent status and current state */
app.get('/agent/status', async (req, res) => {
  const adminPassword = typeof req.query.adminPassword === 'string' ? req.query.adminPassword : '';
  if (!adminPassword || adminPassword !== env.adminPassword) {
    res.status(403).json({ message: 'Unauthorized' });
    return;
  }
  await agent.refreshParticipantCount();
  res.json(agent.getState());
});

/** Get agent rules */
app.get('/agent/rules', (req, res) => {
  const adminPassword = typeof req.query.adminPassword === 'string' ? req.query.adminPassword : '';
  if (!adminPassword || adminPassword !== env.adminPassword) {
    res.status(403).json({ message: 'Unauthorized' });
    return;
  }
  const state = agent.getState();
  res.json({ rules: state.rules });
});

/** Update agent rules */
app.post('/agent/rules', (req, res) => {
  const { adminPassword, rules } = req.body;
  if (!adminPassword || adminPassword !== env.adminPassword) {
    res.status(403).json({ message: 'Unauthorized' });
    return;
  }
  if (!Array.isArray(rules)) {
    res.status(400).json({ message: 'rules must be an array' });
    return;
  }
  try {
    agent.setRules(rules as AgentRule[]);
    res.json({ success: true, rules: agent.getState().rules });
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : 'Failed to update rules' });
  }
});

/** Start agent execution */
app.post('/agent/start', async (req, res) => {
  const { adminPassword, roomName, controlOrigin } = req.body;
  if (!adminPassword || adminPassword !== env.adminPassword) {
    res.status(403).json({ message: 'Unauthorized' });
    return;
  }
  if (roomName && typeof roomName === 'string') {
    agent.setRoomName(roomName);
  }
  if (controlOrigin && typeof controlOrigin === 'string') {
    agent.setControlOrigin(controlOrigin);
  } else {
    const requestOrigin = req.get('origin');
    agent.setControlOrigin(requestOrigin ?? null);
  }
  try {
    // Start agent in background (don't await completion)
    agent.start().catch((err) => {
      console.error('[Agent] Execution error:', err);
    });
    res.json({ success: true, message: 'Agent started' });
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : 'Failed to start agent' });
  }
});

/** Stop agent execution */
app.post('/agent/stop', (req, res) => {
  const { adminPassword } = req.body;
  if (!adminPassword || adminPassword !== env.adminPassword) {
    res.status(403).json({ message: 'Unauthorized' });
    return;
  }
  agent.stop();
  res.json({ success: true, message: 'Agent stopped' });
});

/** Reset agent to idle */
app.post('/agent/reset', (req, res) => {
  const { adminPassword } = req.body;
  if (!adminPassword || adminPassword !== env.adminPassword) {
    res.status(403).json({ message: 'Unauthorized' });
    return;
  }
  agent.reset();
  res.json({ success: true, message: 'Agent reset' });
});

/** Release a manual wait gate after participants have joined. */
app.post('/agent/manual-start', (req, res) => {
  const { adminPassword } = req.body;
  if (!adminPassword || adminPassword !== env.adminPassword) {
    res.status(403).json({ message: 'Unauthorized' });
    return;
  }
  agent.requestManualStart();
  res.json({ success: true, message: 'Manual start requested' });
});

/** Receive cursor area reports from participants */
app.post('/agent/area-report', (req, res) => {
  const { identity, area } = req.body;
  if (!identity || typeof identity !== 'string') {
    res.status(400).json({ message: 'Missing identity' });
    return;
  }
  if (area !== 'yes' && area !== 'no' && area !== null) {
    res.status(400).json({ message: 'area must be "yes", "no", or null' });
    return;
  }
  agent.reportArea({ identity, area, timestamp: Date.now() });
  res.json({ success: true });
});

/** Receive virtual cursor / pointer lock reports from participants */
app.post('/agent/virtual-cursor-report', (req, res) => {
  const { identity, isPointerLocked } = req.body;
  if (!identity || typeof identity !== 'string') {
    res.status(400).json({ message: 'Missing identity' });
    return;
  }
  if (typeof isPointerLocked !== 'boolean') {
    res.status(400).json({ message: 'isPointerLocked must be a boolean' });
    return;
  }
  agent.reportVirtualCursor({ identity, isPointerLocked, timestamp: Date.now() });
  res.json({ success: true });
});

/** Receive per-participant shared tracking completion reports */
app.post('/agent/shared-tracking-complete', (req, res) => {
  const { identity, trialKey } = req.body;
  if (!identity || typeof identity !== 'string') {
    res.status(400).json({ message: 'Missing identity' });
    return;
  }
  if (!trialKey || typeof trialKey !== 'string') {
    res.status(400).json({ message: 'Missing trialKey' });
    return;
  }
  agent.reportSharedTrackingCompletion({ identity, trialKey, timestamp: Date.now() });
  res.json({ success: true });
});

/** Receive per-participant instruction Next clicks */
app.post('/agent/instruction-next', (req, res) => {
  const { identity, instructionId } = req.body;
  if (!identity || typeof identity !== 'string') {
    res.status(400).json({ message: 'Missing identity' });
    return;
  }
  if (!instructionId || typeof instructionId !== 'string') {
    res.status(400).json({ message: 'Missing instructionId' });
    return;
  }
  agent.reportInstructionNext({ identity, instructionId, timestamp: Date.now() });
  res.json({ success: true });
});

/** Receive participant browser refresh/close reports during a live paired task */
app.post('/agent/participant-withdraw', (req, res) => {
  const { identity, reason } = req.body;
  if (!identity || typeof identity !== 'string') {
    res.status(400).json({ message: 'Missing identity' });
    return;
  }
  const withdrawReason = typeof reason === 'string' ? reason : 'browser unload';
  void agent.reportParticipantWithdraw(identity, withdrawReason).catch((err) => {
    console.error('[Agent] Participant withdraw handling failed:', err);
  });
  res.json({ success: true });
});

/** Associate a LiveKit participant identity with its Prolific submission. */
app.post('/agent/prolific-session', async (req, res) => {
  const { identity, studyId, submissionId } = req.body;
  if (![identity, studyId, submissionId].every((value) => typeof value === 'string' && value.trim().length > 0)) {
    res.status(400).json({ message: 'Missing identity, studyId, or submissionId' });
    return;
  }
  try {
    await agent.registerProlificSession(identity.trim(), studyId.trim(), submissionId.trim());
    res.json({ success: true });
  } catch (error) {
    console.error('[Agent] Prolific session registration failed:', error);
    res.status(503).json({ message: error instanceof Error ? error.message : 'Prolific session registration failed' });
  }
});

/** Get experiment config */
app.get('/agent/config', (req, res) => {
  const adminPassword = typeof req.query.adminPassword === 'string' ? req.query.adminPassword : '';
  if (!adminPassword || adminPassword !== env.adminPassword) {
    res.status(403).json({ message: 'Unauthorized' });
    return;
  }
  res.json(agent.getConfig());
});

/** Update experiment config (regenerates rules) */
app.post('/agent/config', (req, res) => {
  const { adminPassword, config } = req.body;
  if (!adminPassword || adminPassword !== env.adminPassword) {
    res.status(403).json({ message: 'Unauthorized' });
    return;
  }
  if (!config || typeof config !== 'object') {
    res.status(400).json({ message: 'config must be an object' });
    return;
  }
  try {
    agent.setConfig(config as ExperimentConfig);
    res.json({ success: true, config: agent.getConfig(), rules: agent.getState().rules });
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : 'Failed to update config' });
  }
});

/** Receive avg cursor position from admin client (used by reaching task) */
app.post('/agent/avg-cursor', (req, res) => {
  const { x, y } = req.body;
  if (typeof x !== 'number' || typeof y !== 'number') {
    res.status(400).json({ message: 'x and y must be numbers' });
    return;
  }
  agent.reportAvgCursor({ x, y, timestamp: Date.now() });
  res.json({ success: true });
});

/**
 * Receive sketch events from admin clients.
 *
 * When the active sketch's `hit.detect(ctx)` predicate fires (or any other
 * sketch-side condition), the admin client POSTs to this endpoint with the
 * event name. The server agent's `waitForSketchEvent(name, ...)` helper
 * polls the inbox and resolves on match.
 *
 * No auth required (same as /agent/avg-cursor) — the endpoint is
 * write-only and the admin is the only client that should be calling it.
 */
app.post('/agent/sketch-event', (req, res) => {
  const { name, data } = req.body;
  if (!name || typeof name !== 'string') {
    res.status(400).json({ message: 'Missing or invalid name' });
    return;
  }
  agent.reportSketchEvent(name, data);
  res.json({ success: true });
});

/** Receive recent participant cursor positions for automatic Task1 readiness. */
app.post('/agent/cursor-readiness', (req, res) => {
  const reports = Array.isArray(req.body?.reports) ? req.body.reports : [];
  agent.reportCursorReadiness(reports.filter((report: unknown) => {
    if (!report || typeof report !== 'object') return false;
    const value = report as Record<string, unknown>;
    return typeof value.identity === 'string' && typeof value.x === 'number' && typeof value.y === 'number';
  }));
  res.json({ success: true });
});

/** Record a participant's explicit START confirmation for Task1. */
app.post('/agent/participant-start', async (req, res) => {
  const identity = typeof req.body?.identity === 'string' ? req.body.identity.trim() : '';
  if (!identity) {
    res.status(400).json({ message: 'Missing identity' });
    return;
  }
  try {
    agent.setControlOrigin(req.get('origin') ?? null);
    const accepted = await agent.confirmParticipantStart(identity);
    if (!accepted) {
      res.status(409).json({
        message: 'The experiment is not ready yet. Please wait and press START again.',
      });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[Agent] START confirmation failed:', error);
    res.status(503).json({ message: 'Could not confirm START. Please try again.' });
  }
});

/** Disconnect a participant immediately after the completed experiment redirects to Prolific. */
app.post('/agent/participant-complete', async (req, res) => {
  const identity = typeof req.body?.identity === 'string' ? req.body.identity.trim() : '';
  if (!identity) {
    res.status(400).json({ message: 'Missing identity' });
    return;
  }
  try {
    const disconnected = await agent.disconnectParticipantAfterCompletion(identity);
    if (!disconnected) {
      res.status(404).json({ message: 'Completed participant is not connected' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to disconnect completed participant:', error);
    res.status(500).json({ message: 'Failed to disconnect completed participant' });
  }
});

/** Receive Shared/Single Cursor Control questionnaire responses. */
app.post('/agent/shared-cursor-response', (req, res) => {
  const { identity, trialNumber, questionnaireKind, agency, partnership, contribution } = req.body;
  if (!identity || typeof identity !== 'string') {
    res.status(400).json({ message: 'Missing identity' });
    return;
  }
  if (!Number.isInteger(trialNumber) || trialNumber < 1) {
    res.status(400).json({ message: 'trialNumber must be a positive integer' });
    return;
  }
  if (questionnaireKind === 'contribution') {
    if (!isValidSharedContribution(contribution)) {
      res.status(400).json({ message: 'contribution must be an integer from 1 to 7' });
      return;
    }
  } else {
    if (!Number.isInteger(agency) || agency < 0 || agency > 3) {
      res.status(400).json({ message: 'agency must be an integer from 0 to 3' });
      return;
    }
    if (!Number.isInteger(partnership) || partnership < 0 || partnership > 3) {
      res.status(400).json({ message: 'partnership must be an integer from 0 to 3' });
      return;
    }
  }
  agent.reportSharedCursorResponse({
    identity,
    trialNumber,
    questionnaireKind: questionnaireKind === 'contribution' ? 'contribution' : 'legacy',
    ...(questionnaireKind === 'contribution' ? { contribution } : { agency, partnership }),
    timestamp: Date.now(),
  });
  res.json({ success: true });
});

/** Receive recording status updates from admin client */
app.post('/agent/recording-status', (req, res) => {
  const { status, experimentName, trialNumber } = req.body;
  const validStatuses = ['idle', 'recording', 'queued', 'uploading', 'uploaded', 'error'];
  if (!status || !validStatuses.includes(status)) {
    res.status(400).json({ message: 'status must be one of: ' + validStatuses.join(', ') });
    return;
  }
  if (typeof experimentName !== 'string' || !experimentName.trim() || !Number.isInteger(trialNumber)) {
    res.status(400).json({ message: 'experimentName and integer trialNumber are required' });
    return;
  }
  agent.reportRecordingStatus(status, experimentName, trialNumber);
  res.json({ success: true });
});

// Serve built web app if present (Render: single web service deploy)
try {
  const staticDir = resolve(new URL('.', import.meta.url).pathname, '../../web/dist');
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get('/', (_, res) => {
      res.sendFile(resolve(staticDir, 'index.html'));
    });
  }
} catch {
  // ignore if not available in dev
}

app.use((_, res) => {
  res.status(404).json({ message: 'Not Found' });
});

app.listen(env.port, () => {
  console.log(`LiveKit cursor server listening on http://localhost:${env.port}`);
});
