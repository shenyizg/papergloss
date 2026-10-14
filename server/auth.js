import crypto from 'node:crypto';
import { getConfig, setPassword, verifyPassword } from './config.js';
import { HttpError, cookieValues } from './util.js';

const COOKIE = 'pr_session';
// Sessions last 180 days; opening the app renews one that is more than a week old.
const MAX_AGE = 180 * 24 * 3600;
const RENEW_AFTER = 7 * 24 * 3600;

// ---- reverse proxies -------------------------------------------------------------------

// X-Forwarded-* headers are believed only from a reverse proxy on this machine, or from
// any peer with PAPERGLOSS_TRUST_PROXY=1. Anyone else could simply make them up.
const TRUST_ANY_PROXY = process.env.PAPERGLOSS_TRUST_PROXY === '1';

function fromTrustedProxy(req) {
  return TRUST_ANY_PROXY || /^(127\.|::ffff:127\.|::1$)/.test(req.socket.remoteAddress || '');
}

// The last entry is the one added by the proxy that talks to us.
export function forwardedHeader(req, name) {
  if (!fromTrustedProxy(req)) return '';
  const values = String(req.headers[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return values[values.length - 1] || '';
}

function isHttps(req) {
  return !!req.socket.encrypted || forwardedHeader(req, 'x-forwarded-proto') === 'https';
}

function clientIp(req) {
  return forwardedHeader(req, 'x-forwarded-for') || req.socket.remoteAddress || '?';
}

// ---- sessions --------------------------------------------------------------------------

// A token signs its issue time together with the password hash: it expires on its own,
// and changing the password signs every device out.
function sign(issued) {
  const { secret, passwordHash } = getConfig();
  return crypto.createHmac('sha256', secret).update(`session:${issued}:${passwordHash}`).digest('hex');
}

function newToken() {
  const issued = Math.floor(Date.now() / 1000).toString(36);
  return `${issued}.${sign(issued)}`;
}

// Seconds since the token was issued, or null if it isn't valid.
function tokenAge(token) {
  const m = /^([0-9a-z]{1,10})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return null;
  const age = Date.now() / 1000 - parseInt(m[1], 36);
  if (!(age > -300 && age < MAX_AGE)) return null;
  return crypto.timingSafeEqual(Buffer.from(m[2], 'hex'), Buffer.from(sign(m[1]), 'hex')) ? age : null;
}

function sessionAge(req) {
  let best = null;
  for (const token of cookieValues(req.headers.cookie, COOKIE)) {
    const age = tokenAge(token);
    if (age != null && (best == null || age < best)) best = age;
  }
  return best;
}

export function isAuthed(req) {
  return sessionAge(req) != null;
}

export function requireAuth(req) {
  if (!isAuthed(req)) throw new HttpError(401, 'auth.required', {}, 'unauthorized');
}

// For the app's start-up check: reports whether the visitor is signed in, and swaps an
// older session for a fresh one so active devices stay signed in.
export function checkSession(req, res) {
  const age = sessionAge(req);
  if (age != null && age > RENEW_AFTER) res.setHeader('Set-Cookie', cookieHeader(req, newToken(), MAX_AGE));
  return age != null;
}

function cookieHeader(req, value, maxAge) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

// ---- sign-in ---------------------------------------------------------------------------

// Small in-memory brute-force guard: 10 attempts per address per 10 minutes.
const WINDOW = 10 * 60_000;
const MAX_ATTEMPTS = 10;
const failures = new Map();

function attemptRecord(ip, now) {
  if (failures.size > 1000) {
    for (const [key, rec] of failures) if (now - rec.first >= WINDOW) failures.delete(key);
  }
  let rec = failures.get(ip);
  if (!rec || now - rec.first >= WINDOW) {
    rec = { first: now, count: 0 };
    failures.set(ip, rec);
  }
  return rec;
}

export async function login(req, res, password) {
  const ip = clientIp(req);
  const rec = attemptRecord(ip, Date.now());
  if (rec.count >= MAX_ATTEMPTS) throw new HttpError(429, 'auth.tooMany');
  // Counted before checking, so parallel guesses can't slip past the limit.
  rec.count += 1;
  if (typeof password !== 'string' || !(await verifyPassword(password))) {
    throw new HttpError(401, 'auth.wrong');
  }
  failures.delete(ip);
  res.setHeader('Set-Cookie', cookieHeader(req, newToken(), MAX_AGE));
}

export function logout(req, res) {
  res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
}

export async function changePassword(req, res, oldPassword, newPassword) {
  if (process.env.PAPERGLOSS_PASSWORD) {
    throw new HttpError(400, 'auth.envPassword');
  }
  if (typeof oldPassword !== 'string' || !(await verifyPassword(oldPassword))) {
    throw new HttpError(400, 'auth.oldWrong');
  }
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    throw new HttpError(400, 'auth.tooShort');
  }
  await setPassword(newPassword);
  res.setHeader('Set-Cookie', cookieHeader(req, newToken(), MAX_AGE));
}
