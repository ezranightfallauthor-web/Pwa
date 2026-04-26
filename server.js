import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('.'));

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const WHMCS_API_KEY = process.env.WHMCS_API_KEY || '';
const validRoles = new Set(['admin', 'venue_host', 'user']);

const plans = {
  starter: { id: 'starter', maxLanguages: 2, includedSeconds: 3600, overagePerMinuteUsd: 0.1 },
  pro: { id: 'pro', maxLanguages: 6, includedSeconds: 21600, overagePerMinuteUsd: 0.07 },
  enterprise: { id: 'enterprise', maxLanguages: 20, includedSeconds: 0, overagePerMinuteUsd: 0.04 },
};
const venueCatalog = [
  { id: 'bluebird', name: 'Bluebird Café', room: 'Coffee Fans' },
  { id: 'arcade', name: 'Retro Arcade', room: 'Game Night' },
  { id: 'skyline', name: 'Skyline Rooftop', room: 'Sunset Lounge' },
];

const scaleThresholds = {
  maxConcurrentUsersPerNode: Number(process.env.SCALE_MAX_USERS_PER_NODE || 150),
  maxChunksPerMinutePerNode: Number(process.env.SCALE_MAX_CHUNKS_PER_MINUTE || 1200),
  maxActiveVenuesPerNode: Number(process.env.SCALE_MAX_ACTIVE_VENUES || 40),
};


const languagePackCatalog = {
  en: { packName: 'english-core', version: '1.0', includes: ['en', 'es', 'fr'] },
  es: { packName: 'spanish-core', version: '1.0', includes: ['es', 'en', 'pt'] },
  fr: { packName: 'french-core', version: '1.0', includes: ['fr', 'en', 'de'] },
  de: { packName: 'german-core', version: '1.0', includes: ['de', 'en', 'fr'] },
  default: { packName: 'global-core', version: '1.0', includes: ['en'] },
};

const resolveLanguagePack = (primaryLanguage) => languagePackCatalog[primaryLanguage] || languagePackCatalog.default;
const countryFromRequest = (req) => String(
  req.headers['cf-ipcountry']
  || req.headers['x-vercel-ip-country']
  || req.headers['x-country-code']
  || 'unknown',
).toLowerCase();
const languageFromRequest = (req, fallback = 'en') => {
  const accept = String(req.headers['accept-language'] || '').split(',')[0]?.trim().toLowerCase();
  if (!accept) return fallback;
  return accept.split('-')[0] || fallback;
};

const roomParticipants = new Map();
const recentChunkTimestamps = [];
const addParticipantToRoom = (room, userId) => {
  if (!roomParticipants.has(room)) roomParticipants.set(room, new Set());
  roomParticipants.get(room).add(userId);
};
const removeParticipantEverywhere = (userId) => roomParticipants.forEach((members) => members.delete(userId));
const markChunkProcessed = () => {
  const now = Date.now();
  recentChunkTimestamps.push(now);
  const cutoff = now - (5 * 60 * 1000);
  while (recentChunkTimestamps.length && recentChunkTimestamps[0] < cutoff) recentChunkTimestamps.shift();
};
const chunksPerMinute = () => {
  const now = Date.now();
  const cutoff = now - (60 * 1000);
  let count = 0;
  for (let index = recentChunkTimestamps.length - 1; index >= 0; index -= 1) {
    if (recentChunkTimestamps[index] < cutoff) break;
    count += 1;
  }
  return count;
};

const ensureUserPlan = (userId) => prisma.userPlan.upsert({ where: { id: userId }, create: { id: userId, planId: 'starter' }, update: {} });
const ensureVenuePlan = (venueId) => prisma.venuePlan.upsert({ where: { id: venueId }, create: { id: venueId, planId: 'starter' }, update: {} });
const ensureUsageUser = (userId) => prisma.usageUser.upsert({ where: { id: userId }, create: { id: userId }, update: {} });
const ensureUsageVenue = (venueId) => prisma.usageVenue.upsert({ where: { id: venueId }, create: { id: venueId }, update: {} });
const ensureUserAuth = (email, role = 'user') => prisma.userAuth.upsert({
  where: { email },
  create: { id: crypto.randomUUID(), email, role: validRoles.has(role) ? role : 'user' },
  update: validRoles.has(role) ? { role } : {},
});

const upsertUserLanguagePack = (userId, primaryLanguage) => {
  const pack = resolveLanguagePack(primaryLanguage);
  return prisma.userLanguagePack.upsert({
    where: { userId },
    create: { userId, primaryLanguage, packName: pack.packName, packVersion: pack.version },
    update: { primaryLanguage, packName: pack.packName, packVersion: pack.version },
  });
};
const getVenueAccess = (venueId, userId) => prisma.venueAccess.findUnique({ where: { venueId_userId: { venueId, userId } } });
const upsertVenueAccess = (venueId, userId, status = 'pending', reviewedBy = null) => prisma.venueAccess.upsert({
  where: { venueId_userId: { venueId, userId } },
  create: {
    id: crypto.randomUUID(),
    venueId,
    userId,
    status,
    reviewedAt: status === 'approved' ? new Date() : null,
    reviewedBy: status === 'approved' ? reviewedBy : null,
  },
  update: {
    status,
    reviewedAt: status === 'approved' ? new Date() : null,
    reviewedBy: status === 'approved' ? reviewedBy : null,
  },
});

const monthWindow = (at = new Date()) => {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1, 0, 0, 0));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1, 0, 0, 0));
  return { start, end };
};
const ensureBillingPeriod = (accountType, accountId, now = new Date()) => {
  const { start, end } = monthWindow(now);
  return prisma.billingPeriod.upsert({
    where: { accountType_accountId_periodStart_periodEnd: { accountType, accountId, periodStart: start, periodEnd: end } },
    create: { id: crypto.randomUUID(), accountType, accountId, periodStart: start, periodEnd: end },
    update: {},
  });
};
const recordLedgerEvent = async ({ accountType, accountId, source, sourceId, seconds, amountUsd, idempotencyKey, metadata = null }) => {
  if (!idempotencyKey) return { duplicated: false };
  try {
    await prisma.billingLedgerEvent.create({
      data: { id: crypto.randomUUID(), accountType, accountId, source, sourceId, seconds, amountUsd, idempotencyKey, metadata },
    });
    return { duplicated: false };
  } catch {
    return { duplicated: true };
  }
};
const refreshPeriodProjection = async (accountType, accountId) => {
  const period = await ensureBillingPeriod(accountType, accountId);
  const secondsProcessed = accountType === 'user' ? (await ensureUsageUser(accountId)).secondsProcessed : (await ensureUsageVenue(accountId)).secondsProcessed;
  let projectedOverage = 0;
  if (accountType === 'user') {
    const plan = plans[(await ensureUserPlan(accountId)).planId] || plans.starter;
    const overageSeconds = Math.max(0, secondsProcessed - plan.includedSeconds);
    projectedOverage = Number(((overageSeconds / 60) * plan.overagePerMinuteUsd).toFixed(4));
  }
  await prisma.billingPeriod.update({ where: { id: period.id }, data: { secondsProcessed, projectedOverage } });
};

const billUser = async (userId, seconds, idempotencyKey = null, sourceId = null) => {
  const plan = plans[(await ensureUserPlan(userId)).planId] || plans.starter;
  const amountUsd = Number((((Math.max(0, seconds) / 60) * plan.overagePerMinuteUsd)).toFixed(6));
  const ledger = await recordLedgerEvent({
    accountType: 'user',
    accountId: userId,
    source: 'realtime_chunk',
    sourceId: sourceId || crypto.randomUUID(),
    seconds: Math.max(0, seconds),
    amountUsd,
    idempotencyKey,
  });
  if (ledger.duplicated) return;
  await ensureUsageUser(userId);
  await prisma.usageUser.update({ where: { id: userId }, data: { secondsProcessed: { increment: seconds }, chunks: { increment: 1 } } });
  await refreshPeriodProjection('user', userId);
};
const billVenue = async (venueId, seconds, idempotencyKey = null, sourceId = null) => {
  const ledger = await recordLedgerEvent({
    accountType: 'venue',
    accountId: venueId,
    source: 'realtime_chunk',
    sourceId: sourceId || crypto.randomUUID(),
    seconds: Math.max(0, seconds),
    amountUsd: 0,
    idempotencyKey,
  });
  if (ledger.duplicated) return;
  await ensureUsageVenue(venueId);
  await prisma.usageVenue.update({ where: { id: venueId }, data: { secondsProcessed: { increment: seconds }, chunks: { increment: 1 } } });
  await refreshPeriodProjection('venue', venueId);
};

const projectBilling = async (userId) => {
  const user = await ensureUserPlan(userId);
  const usage = await ensureUsageUser(userId);
  const plan = plans[user.planId] ?? plans.starter;
  const overageSeconds = Math.max(0, usage.secondsProcessed - plan.includedSeconds);
  return { userId, planId: plan.id, maxLanguages: plan.maxLanguages, secondsProcessed: usage.secondsProcessed, chunks: usage.chunks, pollCount: usage.pollCount, overageSeconds, projectedOverageUsd: Number(((overageSeconds / 60) * plan.overagePerMinuteUsd).toFixed(4)) };
};

const projectVenueBilling = async (venueId) => {
  const usage = await ensureUsageVenue(venueId);
  return { venueId, secondsProcessed: usage.secondsProcessed, chunks: usage.chunks, pollCount: usage.pollCount };
};


const getOrCreateActiveVenueSession = async (venueId) => {
  const active = await prisma.venueSession.findFirst({ where: { venueId, stoppedAt: null }, orderBy: { startedAt: 'desc' } });
  if (active) return active;
  const now = new Date();
  return prisma.venueSession.create({ data: { id: crypto.randomUUID(), venueId, startedAt: now, lastChunkAt: now, chunkCount: 0 } });
};

const touchVenueSessionChunk = async (venueId) => {
  const session = await getOrCreateActiveVenueSession(venueId);
  return prisma.venueSession.update({
    where: { id: session.id },
    data: { lastChunkAt: new Date(), chunkCount: { increment: 1 } },
  });
};

const stopVenueSession = async (venueId, reason = 'host_stop') => {
  const active = await prisma.venueSession.findFirst({ where: { venueId, stoppedAt: null }, orderBy: { startedAt: 'desc' } });
  if (!active) return null;
  return prisma.venueSession.update({ where: { id: active.id }, data: { stoppedAt: new Date(), reason } });
};


const buildVenueStats = async (venueId, ioServer) => {
  const room = `room:${venueId}`;
  const connectedPeople = ioServer.sockets.adapter.rooms.get(room)?.size ?? 0;
  const sockets = [...(ioServer.sockets.adapter.rooms.get(room) ?? new Set())]
    .map((id) => ioServer.sockets.sockets.get(id))
    .filter(Boolean);

  const languageCounts = {};
  const translated = new Set();
  sockets.forEach((socket) => {
    const preferred = socket.data.session?.preferredLanguage;
    if (preferred) languageCounts[preferred] = (languageCounts[preferred] || 0) + 1;
    (socket.data.targetLanguages || []).forEach((lang) => translated.add(lang));
  });

  const venuePlan = await ensureVenuePlan(venueId);
  const maxLanguages = plans[venuePlan.planId]?.maxLanguages ?? plans.starter.maxLanguages;
  const translatedLanguageCount = translated.size;

  return {
    venueId,
    connectedPeople,
    connectedLanguages: languageCounts,
    translatedLanguages: [...translated],
    translatedLanguageCount,
    planId: venuePlan.planId,
    maxLanguages,
    shouldUpsell: translatedLanguageCount > maxLanguages,
    suggestion: translatedLanguageCount > maxLanguages ? `You are translating ${translatedLanguageCount} languages on ${venuePlan.planId}. Consider upgrading.` : null,
  };
};

const buildScaleRecommendation = (ioServer) => {
  const activeRoomNames = [...ioServer.sockets.adapter.rooms.keys()].filter((room) => room.startsWith('room:') && room.split(':').length === 2);
  const connectedUsers = ioServer.engine.clientsCount;
  const activeVenues = new Set(activeRoomNames.map((room) => room.replace('room:', ''))).size;
  const currentChunksPerMinute = chunksPerMinute();

  const usersRatio = connectedUsers / scaleThresholds.maxConcurrentUsersPerNode;
  const chunksRatio = currentChunksPerMinute / scaleThresholds.maxChunksPerMinutePerNode;
  const venuesRatio = activeVenues / scaleThresholds.maxActiveVenuesPerNode;
  const maxRatio = Math.max(usersRatio, chunksRatio, venuesRatio);
  const recommendedTotalNodes = Math.max(1, Math.ceil(maxRatio));
  const recommendNewNode = recommendedTotalNodes > 1;

  const reasons = [];
  if (usersRatio > 1) reasons.push(`Connected users ${connectedUsers} exceed per-node threshold ${scaleThresholds.maxConcurrentUsersPerNode}.`);
  if (chunksRatio > 1) reasons.push(`Audio chunks/min ${currentChunksPerMinute} exceed per-node threshold ${scaleThresholds.maxChunksPerMinutePerNode}.`);
  if (venuesRatio > 1) reasons.push(`Active venues ${activeVenues} exceed per-node threshold ${scaleThresholds.maxActiveVenuesPerNode}.`);

  return {
    recommendNewNode,
    recommendedTotalNodes,
    recommendedAdditionalNodes: Math.max(0, recommendedTotalNodes - 1),
    reasons: reasons.length ? reasons : ['Current load is within configured per-node thresholds.'],
    metrics: { connectedUsers, activeVenues, chunksPerMinute: currentChunksPerMinute },
    thresholds: scaleThresholds,
  };
};


const authMiddleware = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token.' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const session = await prisma.session.findUnique({ where: { id: decoded.sid } });
    if (!session || session.revokedAt) return res.status(401).json({ error: 'Session is not active.' });
    req.auth = decoded;
    const user = await prisma.userAuth.findUnique({ where: { id: decoded.sub } });
    req.authRole = user?.role || decoded.role || 'user';
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token.' });
  }
};
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.authRole)) return res.status(403).json({ error: 'Insufficient role for this endpoint.' });
  next();
};
const whmcsMiddleware = (req, res, next) => {
  if (!WHMCS_API_KEY) return res.status(503).json({ error: 'WHMCS integration key is not configured.' });
  const providedKey = req.headers['x-whmcs-key'];
  if (providedKey !== WHMCS_API_KEY) return res.status(401).json({ error: 'Invalid WHMCS key.' });
  next();
};

const loginHandler = async (req, res) => {
  const { email, deviceName = 'Unknown device', role = 'user' } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  const user = await ensureUserAuth(email.trim().toLowerCase(), role);
  await ensureUserPlan(user.id);
  const session = await prisma.session.create({ data: { id: crypto.randomUUID(), userId: user.id, deviceName } });

  const token = jwt.sign({ sub: user.id, email: user.email, sid: session.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, sessionId: session.id, user: { id: user.id, email: user.email, role: user.role } });
};

const listSessionsHandler = async (req, res) => {
  const sessions = await prisma.session.findMany({ where: { userId: req.auth.sub }, orderBy: { issuedAt: 'desc' } });
  res.json({ sessions, currentSessionId: req.auth.sid });
};

const logoutSessionHandler = async (req, res) => {
  const session = await prisma.session.findUnique({ where: { id: req.params.sessionId } });
  if (!session || session.userId !== req.auth.sub) return res.status(404).json({ error: 'Session not found.' });
  await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  res.json({ ok: true });
};

const setLanguagePackHandler = async (req, res) => {
  const { primaryLanguage } = req.body;
  if (!primaryLanguage) return res.status(400).json({ error: 'primaryLanguage required' });
  const record = await upsertUserLanguagePack(req.auth.sub, primaryLanguage);
  const pack = resolveLanguagePack(primaryLanguage);
  res.json({ ...record, includes: pack.includes });
};

const getLanguagePackHandler = async (req, res) => {
  const record = await prisma.userLanguagePack.findUnique({ where: { userId: req.auth.sub } });
  if (!record) return res.json({ packName: 'global-core', primaryLanguage: 'en', includes: ['en'] });
  const pack = resolveLanguagePack(record.primaryLanguage);
  res.json({ ...record, includes: pack.includes });
};

const recordInstallHandler = async (req, res) => {
  const { deviceInstallId, uiLanguage, primaryLanguage = null } = req.body || {};
  if (!deviceInstallId) return res.status(400).json({ error: 'deviceInstallId required' });
  const normalizedUiLanguage = String(uiLanguage || languageFromRequest(req, 'en')).toLowerCase().slice(0, 10);
  const normalizedPrimary = primaryLanguage ? String(primaryLanguage).toLowerCase().slice(0, 10) : null;
  const country = countryFromRequest(req);
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 200);

  const install = await prisma.pwaInstall.upsert({
    where: { deviceInstallId: String(deviceInstallId).slice(0, 80) },
    create: {
      id: crypto.randomUUID(),
      deviceInstallId: String(deviceInstallId).slice(0, 80),
      uiLanguage: normalizedUiLanguage,
      primaryLanguage: normalizedPrimary,
      country,
      userAgent,
    },
    update: {
      uiLanguage: normalizedUiLanguage,
      primaryLanguage: normalizedPrimary,
      country,
      userAgent,
    },
  });
  res.json({ ok: true, installId: install.id });
};

const installSummaryHandler = async (_req, res) => {
  const [totalInstalls, byLanguage, byCountry] = await Promise.all([
    prisma.pwaInstall.count(),
    prisma.pwaInstall.groupBy({ by: ['uiLanguage'], _count: { _all: true }, orderBy: { _count: { uiLanguage: 'desc' } }, take: 12 }),
    prisma.pwaInstall.groupBy({ by: ['country'], _count: { _all: true }, orderBy: { _count: { country: 'desc' } }, take: 12 }),
  ]);

  res.json({
    totalInstalls,
    byLanguage: byLanguage.map((entry) => ({ language: entry.uiLanguage, installs: entry._count._all })),
    byCountry: byCountry.map((entry) => ({ country: entry.country, installs: entry._count._all })),
  });
};

const setUserPlanHandler = async (req, res) => {
  const { userId } = req.params;
  const { planId } = req.body;
  if (!plans[planId]) return res.status(400).json({ error: 'Unknown planId.' });
  const user = await prisma.userPlan.upsert({ where: { id: userId }, create: { id: userId, planId }, update: { planId } });
  res.json({ ok: true, user });
};

const translateChunkHandler = async (req, res) => {
  const { userId, sourceLanguage, targetLanguages = [], durationMs = 0, chunkId } = req.body;
  if (!userId || !sourceLanguage || !Array.isArray(targetLanguages) || !chunkId) return res.status(400).json({ error: 'userId, sourceLanguage, chunkId and targetLanguages are required.' });
  const billing = await projectBilling(userId);
  if (targetLanguages.length > billing.maxLanguages) return res.status(402).json({ error: 'Language count exceeds plan limit.', maxLanguages: billing.maxLanguages, requestedLanguages: targetLanguages.length });
  markChunkProcessed();
  const idemKey = req.headers['x-idempotency-key'] || `rest:${userId}:${chunkId}`;
  await billUser(userId, Math.max(0, Number(durationMs) / 1000), String(idemKey), String(chunkId));
  res.json({ ok: true, chunkId, sourceLanguage, targetLanguages, billing: await projectBilling(userId) });
};

const getUserUsageHandler = async (req, res) => {
  await ensureUsageUser(req.params.userId);
  await prisma.usageUser.update({ where: { id: req.params.userId }, data: { pollCount: { increment: 1 } } });
  res.json(await projectBilling(req.params.userId));
};

const getVenueUsageHandler = async (req, res) => {
  await ensureUsageVenue(req.params.venueId);
  await prisma.usageVenue.update({ where: { id: req.params.venueId }, data: { pollCount: { increment: 1 } } });
  res.json(await projectVenueBilling(req.params.venueId));
};

const venueStatsHandler = async (req, res) => {
  res.json(await buildVenueStats(req.params.venueId, io));
};

const venueSessionHandler = async (req, res) => {
  const active = await prisma.venueSession.findFirst({ where: { venueId: req.params.venueId, stoppedAt: null }, orderBy: { startedAt: 'desc' } });
  const latest = active || await prisma.venueSession.findFirst({ where: { venueId: req.params.venueId }, orderBy: { startedAt: 'desc' } });
  res.json({ session: latest });
};
const requestVenueAccessHandler = async (req, res) => {
  const venueId = req.params.venueId;
  if (!venueId) return res.status(400).json({ error: 'venueId required' });
  if (['admin', 'venue_host'].includes(req.authRole)) {
    const approved = await upsertVenueAccess(venueId, req.auth.sub, 'approved', req.auth.sub);
    return res.json({ access: approved, autoApproved: true });
  }
  const existing = await getVenueAccess(venueId, req.auth.sub);
  if (existing) return res.json({ access: existing, autoApproved: false });
  const pending = await upsertVenueAccess(venueId, req.auth.sub, 'pending');
  return res.json({ access: pending, autoApproved: false });
};
const getMyVenueAccessHandler = async (req, res) => {
  const record = await getVenueAccess(req.params.venueId, req.auth.sub);
  if (!record) return res.json({ venueId: req.params.venueId, userId: req.auth.sub, status: 'none' });
  res.json(record);
};
const listPendingVenueAccessHandler = async (req, res) => {
  const pending = await prisma.venueAccess.findMany({ where: { venueId: req.params.venueId, status: 'pending' }, orderBy: { requestedAt: 'asc' }, take: 100 });
  res.json({ pending });
};
const approveVenueAccessHandler = async (req, res) => {
  const { venueId, userId } = req.params;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const access = await upsertVenueAccess(venueId, userId, 'approved', req.auth.sub);
  await prisma.venueMembership.upsert({
    where: { venueId_userId: { venueId, userId } },
    create: { id: crypto.randomUUID(), venueId, userId, role: 'member' },
    update: {},
  });
  res.json({ access });
};
const listUserVenuesHandler = async (req, res) => {
  const memberships = await prisma.venueMembership.findMany({ where: { userId: req.auth.sub } });
  const membershipMap = new Map(memberships.map((entry) => [entry.venueId, entry]));
  res.json({
    venues: venueCatalog.map((venue) => ({
      ...venue,
      membershipRole: membershipMap.get(venue.id)?.role || null,
      joined: membershipMap.has(venue.id),
    })),
  });
};
const joinVenueHandler = async (req, res) => {
  const { venueId } = req.params;
  const venue = venueCatalog.find((entry) => entry.id === venueId);
  if (!venue) return res.status(404).json({ error: 'Unknown venue.' });
  const membership = await prisma.venueMembership.upsert({
    where: { venueId_userId: { venueId, userId: req.auth.sub } },
    create: { id: crypto.randomUUID(), venueId, userId: req.auth.sub, role: 'member' },
    update: {},
  });
  await upsertVenueAccess(venueId, req.auth.sub, 'approved', req.auth.sub);
  res.json({ membership });
};
const leaveVenueHandler = async (req, res) => {
  const { venueId } = req.params;
  await prisma.venueMembership.deleteMany({ where: { venueId, userId: req.auth.sub } });
  res.json({ ok: true });
};
const whmcsProvisionUserHandler = async (req, res) => {
  const { email, planId = 'starter', role = 'user', venueIds = [] } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  if (!plans[planId]) return res.status(400).json({ error: 'Unknown planId.' });

  const user = await ensureUserAuth(String(email).trim().toLowerCase(), role);
  await prisma.userPlan.upsert({ where: { id: user.id }, create: { id: user.id, planId }, update: { planId } });

  const normalizedVenueIds = [...new Set(Array.isArray(venueIds) ? venueIds : [])];
  for (const venueId of normalizedVenueIds) {
    const venue = venueCatalog.find((entry) => entry.id === venueId);
    if (!venue) continue;
    await prisma.venueMembership.upsert({
      where: { venueId_userId: { venueId, userId: user.id } },
      create: { id: crypto.randomUUID(), venueId, userId: user.id, role: 'member' },
      update: {},
    });
    await upsertVenueAccess(venueId, user.id, 'approved', user.id);
  }

  res.json({ ok: true, user: { id: user.id, email: user.email, role: user.role }, planId, venueIds: normalizedVenueIds });
};
const whmcsOverageReportHandler = async (_req, res) => {
  const [userPlans, userUsages] = await Promise.all([
    prisma.userPlan.findMany(),
    prisma.usageUser.findMany(),
  ]);
  const planMap = new Map(userPlans.map((entry) => [entry.id, entry.planId]));
  const users = userUsages.map((usage) => {
    const planId = planMap.get(usage.id) || 'starter';
    const plan = plans[planId] || plans.starter;
    const overageSeconds = Math.max(0, usage.secondsProcessed - plan.includedSeconds);
    const overageUsd = Number(((overageSeconds / 60) * plan.overagePerMinuteUsd).toFixed(4));
    return { userId: usage.id, planId: plan.id, secondsProcessed: usage.secondsProcessed, overageSeconds, overageUsd };
  }).filter((entry) => entry.overageSeconds > 0);
  res.json({ generatedAt: new Date().toISOString(), users });
};
const listBillingPeriodsHandler = async (req, res) => {
  const { accountType, accountId, status } = req.query;
  const where = {
    ...(accountType ? { accountType: String(accountType) } : {}),
    ...(accountId ? { accountId: String(accountId) } : {}),
    ...(status ? { status: String(status) } : {}),
  };
  const periods = await prisma.billingPeriod.findMany({ where, orderBy: { periodStart: 'desc' }, take: 50 });
  res.json({ periods });
};
const reconcileBillingPeriodHandler = async (req, res) => {
  const { periodId } = req.params;
  const { externalRef = null, payload = null } = req.body || {};
  const period = await prisma.billingPeriod.findUnique({ where: { id: periodId } });
  if (!period) return res.status(404).json({ error: 'Period not found.' });
  const updated = await prisma.billingPeriod.update({
    where: { id: periodId },
    data: { status: 'reconciled', reconciledAt: new Date() },
  });
  await prisma.whmcsSyncRecord.create({
    data: {
      id: crypto.randomUUID(),
      periodId,
      direction: 'export',
      status: 'success',
      payload: payload ? JSON.stringify(payload).slice(0, 3000) : null,
      externalRef: externalRef ? String(externalRef).slice(0, 180) : null,
    },
  });
  res.json({ period: updated });
};

// Canonical API flow: /api/system -> /api/user -> /api/venue -> /api/audio
app.get('/api/system/health', (_req, res) => res.json({ ok: true, service: 'venuechat-api' }));
app.get('/api/system/plans', (_req, res) => res.json({ plans: Object.values(plans) }));
app.get('/api/system/scale/recommendation', authMiddleware, requireRole('admin', 'venue_host'), (_req, res) => res.json(buildScaleRecommendation(io)));
app.post('/api/system/install', recordInstallHandler);
app.get('/api/system/install-summary', authMiddleware, requireRole('admin', 'venue_host'), installSummaryHandler);
app.post('/api/system/whmcs/provision-user', whmcsMiddleware, whmcsProvisionUserHandler);
app.get('/api/system/whmcs/overage-report', whmcsMiddleware, whmcsOverageReportHandler);
app.get('/api/system/billing/periods', authMiddleware, requireRole('admin', 'venue_host'), listBillingPeriodsHandler);
app.post('/api/system/billing/periods/:periodId/reconcile', authMiddleware, requireRole('admin', 'venue_host'), reconcileBillingPeriodHandler);

app.post('/api/user/auth/login', loginHandler);
app.get('/api/user/auth/sessions', authMiddleware, listSessionsHandler);
app.post('/api/user/auth/sessions/:sessionId/logout', authMiddleware, logoutSessionHandler);
app.post('/api/user/language-pack', authMiddleware, setLanguagePackHandler);
app.get('/api/user/language-pack', authMiddleware, getLanguagePackHandler);
app.get('/api/user/venues', authMiddleware, listUserVenuesHandler);
app.post('/api/user/venues/:venueId/join', authMiddleware, joinVenueHandler);
app.post('/api/user/venues/:venueId/leave', authMiddleware, leaveVenueHandler);
app.post('/api/user/:userId/plan', setUserPlanHandler);
app.get('/api/user/:userId/usage', getUserUsageHandler);

app.get('/api/venue/:venueId/stats', venueStatsHandler);
app.get('/api/venue/:venueId/stats/session', venueSessionHandler);
app.get('/api/venue/:venueId/usage', getVenueUsageHandler);
app.get('/api/venue/:venueId/access/me', authMiddleware, getMyVenueAccessHandler);
app.post('/api/venue/:venueId/access/request', authMiddleware, requestVenueAccessHandler);
app.get('/api/venue/:venueId/access/pending', authMiddleware, requireRole('admin', 'venue_host'), listPendingVenueAccessHandler);
app.post('/api/venue/:venueId/access/:userId/approve', authMiddleware, requireRole('admin', 'venue_host'), approveVenueAccessHandler);

app.post('/api/audio/chunk', translateChunkHandler);

// Legacy compatibility routes
app.post('/api/auth/login', loginHandler);
app.get('/api/auth/sessions', authMiddleware, listSessionsHandler);
app.post('/api/auth/sessions/:sessionId/logout', authMiddleware, logoutSessionHandler);
app.post('/api/auth/language-pack', authMiddleware, setLanguagePackHandler);
app.get('/api/auth/language-pack', authMiddleware, getLanguagePackHandler);
app.post('/api/analytics/install', recordInstallHandler);
app.get('/api/analytics/install-summary', authMiddleware, requireRole('admin', 'venue_host'), installSummaryHandler);
app.get('/api/system/scale-check', authMiddleware, requireRole('admin', 'venue_host'), (_req, res) => res.json(buildScaleRecommendation(io)));
app.post('/api/users/:userId/plan', setUserPlanHandler);
app.post('/api/translate/chunk', translateChunkHandler);
app.get('/api/usage/:userId', getUserUsageHandler);
app.get('/api/usage/venue/:venueId', getVenueUsageHandler);
app.get('/api/venues/:venueId/stats', venueStatsHandler);
app.get('/api/venues/:venueId/stats/session', venueSessionHandler);
app.get('/api/venues/:venueId/access/me', authMiddleware, getMyVenueAccessHandler);
app.post('/api/venues/:venueId/access/request', authMiddleware, requestVenueAccessHandler);
app.get('/api/venues/:venueId/access/pending', authMiddleware, requireRole('admin', 'venue_host'), listPendingVenueAccessHandler);
app.post('/api/venues/:venueId/access/:userId/approve', authMiddleware, requireRole('admin', 'venue_host'), approveVenueAccessHandler);

app.get('/api/plans', (_, res) => res.json({ plans: Object.values(plans) }));

const server = createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Missing auth token'));
    const decoded = jwt.verify(String(token), JWT_SECRET);
    const session = await prisma.session.findUnique({ where: { id: decoded.sid } });
    if (!session || session.revokedAt) return next(new Error('Session inactive'));
    socket.data.auth = decoded;
    next();
  } catch {
    next(new Error('Invalid auth token'));
  }
});

io.on('connection', async (socket) => {
  const { sourceLanguage = 'en' } = socket.handshake.query;
  const targetLanguages = String(socket.handshake.query.targets ?? '').split(',').filter(Boolean);
  socket.data.targetLanguages = targetLanguages;
  const userId = String(socket.data.auth.sub);

  const billing = await projectBilling(userId);
  if (targetLanguages.length > billing.maxLanguages) {
    socket.emit('translation:error', { error: `Plan allows ${billing.maxLanguages} target languages.` });
    socket.disconnect();
    return;
  }

  socket.emit('translation:ready', { message: 'Connected to realtime translation node (Socket.IO).', roomExamples: ['room:<venueId>', 'room:<venueId>:en', 'room:<venueId>:fr'] });
  socket.data.session = { room: 'room:default-venue', mode: 'speaker', venueId: 'default-venue', preferredLanguage: 'en' };

  socket.on('session:configure', ({ venueId = 'default-venue', mode = 'speaker', preferredLanguage = 'en' } = {}) => {
    if (!['admin', 'venue_host'].includes(socket.data.auth.role || 'user')) {
      getVenueAccess(venueId, userId).then((access) => {
        if (!access || access.status !== 'approved') {
          socket.emit('translation:error', { error: 'Venue access is not approved yet.' });
          return;
        }
        const room = `room:${venueId}`;
        socket.data.session = { room, mode, venueId, preferredLanguage };
        socket.join(room);
        socket.join(`${room}:${preferredLanguage}`);
        addParticipantToRoom(room, userId);
        socket.emit('session:configured', socket.data.session);
      }).catch(() => socket.emit('translation:error', { error: 'Failed to verify venue access.' }));
      return;
    }
    const room = `room:${venueId}`;
    socket.data.session = { room, mode, venueId, preferredLanguage };
    socket.join(room);
    socket.join(`${room}:${preferredLanguage}`);
    addParticipantToRoom(room, userId);
    socket.emit('session:configured', socket.data.session);
  });

  socket.on('audio:chunk', async (payload = {}) => {
    if (!payload.chunkId) return socket.emit('translation:error', { error: 'chunkId is required for audio:chunk events.' });

    const seconds = Math.max(0, Number(payload.durationMs ?? 0) / 1000);
    markChunkProcessed();
    const session = socket.data.session;
    const participants = [...(roomParticipants.get(session.room) ?? new Set([userId]))];

    if (session.mode === 'conversation') {
      await Promise.all(participants.map((id) => billUser(id, seconds, `socket:${payload.chunkId}:user:${id}`, String(payload.chunkId))));
    } else {
      await billVenue(session.venueId, seconds, `socket:${payload.chunkId}:venue:${session.venueId}`, String(payload.chunkId));
    }

    await touchVenueSessionChunk(session.venueId);

    io.to(session.room).emit('translation:update', { chunkId: payload.chunkId, room: session.room, mode: session.mode, language: sourceLanguage, text: payload.transcriptHint || `[${sourceLanguage}] realtime transcript for ${payload.chunkId}` });

    for (const lang of targetLanguages) {
      const langRoom = `${session.room}:${lang}`;
      const activeSockets = io.sockets.adapter.rooms.get(langRoom)?.size ?? 0;
      if (!activeSockets) continue;
      io.to(langRoom).emit('translation:update', { chunkId: payload.chunkId, room: langRoom, mode: session.mode, language: lang, text: `[${sourceLanguage}->${lang}] realtime transcript for ${payload.chunkId}` });
    }
  });

  socket.on('session:stop', async ({ venueId } = {}) => {
    if (!venueId) return;
    await stopVenueSession(venueId, 'host_stop');
  });

  socket.on('disconnect', () => removeParticipantEverywhere(userId));
});

setInterval(async () => {
  const cutoff = new Date(Date.now() - 3 * 60 * 1000);
  await prisma.venueSession.updateMany({
    where: { stoppedAt: null, lastChunkAt: { lt: cutoff } },
    data: { stoppedAt: new Date(), reason: 'idle_timeout_3m' },
  });
}, 30_000);

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`VenueChat API listening on http://localhost:${port}`));
