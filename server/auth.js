import crypto from 'node:crypto';
import { getConfig, setPassword } from './config.js';
import { HttpError, parseCookies } from './util.js';

const COOKIE = 'pr_session';
const MAX_AGE = 365 * 24 * 3600;

function sessionToken() {
  const { secret, password } = getConfig();
  return crypto.createHmac('sha256', secret).update(`session:${password}`).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function isAuthed(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  return !!token && safeEqual(token, sessionToken());
}

export function requireAuth(req) {
  if (!isAuthed(req)) throw new HttpError(401, 'auth.required', {}, 'unauthorized');
}

function isHttps(req) {
  return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function cookieHeader(req, value, maxAge) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

// Small in-memory brute-force guard: 10 failures per IP per 10 minutes.
const failures = new Map();
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
}

export function login(req, res, password) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = failures.get(ip);
  if (rec && now - rec.first < 10 * 60_000 && rec.count >= 10) {
    throw new HttpError(429, 'auth.tooMany');
  }
  if (typeof password !== 'string' || !safeEqual(password, getConfig().password)) {
    if (!rec || now - rec.first >= 10 * 60_000) failures.set(ip, { first: now, count: 1 });
    else rec.count += 1;
    throw new HttpError(401, 'auth.wrong');
  }
  failures.delete(ip);
  res.setHeader('Set-Cookie', cookieHeader(req, sessionToken(), MAX_AGE));
}

export function logout(req, res) {
  res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
}

export async function changePassword(req, res, oldPassword, newPassword) {
  if (process.env.PAPERGLOSS_PASSWORD) {
    throw new HttpError(400, 'auth.envPassword');
  }
  if (typeof oldPassword !== 'string' || !safeEqual(oldPassword, getConfig().password)) {
    throw new HttpError(400, 'auth.oldWrong');
  }
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    throw new HttpError(400, 'auth.tooShort');
  }
  await setPassword(newPassword);
  res.setHeader('Set-Cookie', cookieHeader(req, sessionToken(), MAX_AGE));
}
