import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SESSION_COOKIE = 'binksalad_session';
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password, storedHash) {
  const [algorithm, saltValue, expectedValue] = String(storedHash).split('$');
  if (algorithm !== 'scrypt' || !saltValue || !expectedValue) return false;
  const expected = Buffer.from(expectedValue, 'base64url');
  const actual = scryptSync(password, Buffer.from(saltValue, 'base64url'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function credentialKey() {
  const configured = process.env.BINKSALAD_CREDENTIAL_KEY;
  if (configured) {
    if (!/^[\da-f]{64}$/i.test(configured)) {
      throw new Error('BINKSALAD_CREDENTIAL_KEY must be 64 hexadecimal characters.');
    }
    return Buffer.from(configured, 'hex');
  }

  const keyFile = path.resolve(process.env.BINKSALAD_CREDENTIAL_KEY_FILE || '.secrets/credentials.key');
  mkdirSync(path.dirname(keyFile), { recursive: true });
  if (!existsSync(keyFile)) {
    try {
      writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const key = readFileSync(keyFile);
  if (key.length !== 32) throw new Error(`Credential key file must contain 32 bytes: ${keyFile}`);
  return key;
}

export function encryptCredential(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', credentialKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    encryptedPassword: encrypted.toString('base64'),
    encryptionIv: iv.toString('base64'),
    encryptionTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptCredential(record) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    credentialKey(),
    Buffer.from(record.encryption_iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(record.encryption_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.encrypted_password, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_LIFETIME_MS);
  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(hashToken(token), userId, csrfToken, expiresAt.toISOString(), createdAt.toISOString());
  return { token, csrfToken, expiresAt };
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function readSessionCookie(request) {
  const cookies = String(request.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [name, ...parts] = cookie.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(parts.join('='));
  }
  return null;
}

export function setSessionCookie(response, token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: response.req.secure,
    path: '/',
    maxAge: maxAge * 1000,
  });
}

export function clearSessionCookie(response) {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: response.req.secure,
    path: '/',
  });
}
