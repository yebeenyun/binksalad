import express from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardForMonth } from './analysis.js';
import { databasePath, dataDirectory, db, seedCategories } from './db.js';
import { createKakaoAuthorizationUrl, fetchKakaoProfile, getKakaoConfig } from './kakao.js';
import { getPrivateIPv4Networks, isLocalNetworkAddress } from './network.js';
import {
  clearSessionCookie,
  createSession,
  decryptCredential,
  encryptCredential,
  hashPassword,
  hashToken,
  verifyPassword,
} from './security.js';

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(serverDirectory, '..');
const uploadDirectory = path.join(dataDirectory, 'temporary-uploads');
const previews = new Map();
const loginAttempts = new Map();
const registrationAttempts = new Map();
const app = express();
app.set('trust proxy', 'loopback');
const COOKIE_NAME = 'binksalad_session';
const KAKAO_STATE_COOKIE = 'binksalad_kakao_state';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const KAKAO_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const HOUSEHOLD_INVITATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

mkdirSync(uploadDirectory, { recursive: true });

function commandArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const host = commandArgument('--host', process.env.BINKSALAD_HOST || '127.0.0.1');
const port = Number(commandArgument('--port', process.env.BINKSALAD_PORT || '4173'));
const networkOnly = process.env.BINKSALAD_NETWORK_ONLY === '1';
const privateIPv4Networks = networkOnly ? getPrivateIPv4Networks() : [];

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use((request, response, next) => {
  if (!networkOnly || isLocalNetworkAddress(request.socket.remoteAddress, privateIPv4Networks)) {
    return next();
  }
  response.status(403).json({ error: '이 서버는 같은 내부 네트워크에서만 접속할 수 있습니다.' });
});

function now() {
  return new Date().toISOString();
}

function isInitialized() {
  return db.prepare('SELECT 1 FROM users LIMIT 1').get() !== undefined;
}

function createPersonalAccount(username, password, requireEmptyDatabase = false) {
  return db.transaction(() => {
    if (requireEmptyDatabase && isInitialized()) {
      throw Object.assign(new Error('초기 설정은 이미 완료되었습니다.'), { statusCode: 409 });
    }
    const createdAt = now();
    const userId = Number(db.prepare(`
      INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)
    `).run(username, hashPassword(password), createdAt).lastInsertRowid);
    const householdId = randomUUID();
    db.prepare(`
      INSERT INTO households (id, name, household_type, owner_id, created_at)
      VALUES (?, ?, 'personal', ?, ?)
    `).run(householdId, '개인 가계부', userId, createdAt);
    db.prepare(`
      INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)
    `).run(householdId, userId, createdAt);
    seedCategories(householdId);
    return userId;
  })();
}

function isLoopback(address) {
  if (!address) return false;
  return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}

function setAuthCookie(response, token, expiresAt) {
  response.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: response.req.secure,
    path: '/',
    expires: expiresAt
  });
}

function clearAuthCookie(response) {
  response.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: response.req.secure,
    path: '/'
  });
}

function readAuthSession(request) {
  const cookie = String(request.headers.cookie || '').split(';')
    .map(value => value.trim()).find(value => value.startsWith(`${COOKIE_NAME}=`));
  if (!cookie) return null;
  let token;
  try {
    token = decodeURIComponent(cookie.slice(COOKIE_NAME.length + 1));
  } catch {
    return null;
  }
  const session = db.prepare(`
    SELECT s.user_id AS userId, s.csrf_token AS csrfToken, s.expires_at AS expiresAt,
      u.username AS username
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(hashToken(token));
  if (!session || session.expiresAt <= now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  return { ...session, token };
}

function readCookie(request, name) {
  const cookie = String(request.headers.cookie || '').split(';')
    .map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  if (!cookie) return null;
  try {
    return decodeURIComponent(cookie.slice(name.length + 1));
  } catch {
    return null;
  }
}

function setKakaoStateCookie(response, state) {
  response.cookie(KAKAO_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: response.req.secure,
    path: '/api/auth/kakao',
    maxAge: KAKAO_STATE_MAX_AGE_MS
  });
}

function clearKakaoStateCookie(response) {
  response.clearCookie(KAKAO_STATE_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: response.req.secure,
    path: '/api/auth/kakao'
  });
}

function createKakaoState(action, session = null) {
  const state = randomBytes(32).toString('base64url');
  const createdAt = now();
  const expiresAt = new Date(Date.now() + KAKAO_STATE_MAX_AGE_MS).toISOString();
  db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(createdAt);
  db.prepare(`
    INSERT INTO oauth_states (state_hash, action, user_id, session_token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    hashToken(state),
    action,
    session?.userId || null,
    session ? hashToken(session.token) : null,
    expiresAt,
    createdAt
  );
  return state;
}

function kakaoRedirect(response, result) {
  return response.redirect(303, `/?kakao=${encodeURIComponent(result)}`);
}

function requireAuth(request, response, next) {
  const session = readAuthSession(request);
  if (!session) return response.status(401).json({ error: '로그인이 필요합니다.' });
  request.session = session;
  next();
}

function requireCsrf(request, response, next) {
  if (!request.session || request.get('x-csrf-token') !== request.session.csrfToken) {
    return response.status(403).json({ error: '요청을 확인할 수 없습니다. 새로고침 후 다시 시도해 주세요.' });
  }
  next();
}

function requireHouseholdEdit(request, response, next) {
  const householdId = getHouseholdId(request.session.userId);
  const member = db.prepare(`
    SELECT permission FROM household_members WHERE household_id = ? AND user_id = ?
  `).get(householdId, request.session.userId);
  if (!member) return response.status(403).json({ error: '가계부에 접근할 권한이 없습니다.' });
  if (member.permission !== 'edit') {
    return response.status(403).json({ error: '이 가계부는 조회 전용 권한입니다.' });
  }
  request.householdId = householdId;
  next();
}

function requireHouseholdManager(request, response, next) {
  const householdId = getHouseholdId(request.session.userId);
  const member = db.prepare(`
    SELECT role FROM household_members WHERE household_id = ? AND user_id = ?
  `).get(householdId, request.session.userId);
  if (!member || !['owner', 'administrator'].includes(member.role)) {
    return response.status(403).json({ error: '가계부 소유자만 구성원을 관리할 수 있습니다.' });
  }
  request.householdId = householdId;
  next();
}

function requireHouseholdOwner(request, response, next) {
  const householdId = getHouseholdId(request.session.userId);
  const member = db.prepare(`
    SELECT role FROM household_members WHERE household_id = ? AND user_id = ?
  `).get(householdId, request.session.userId);
  if (!member || member.role !== 'owner') {
    return response.status(403).json({ error: '가계부 소유자만 이 작업을 할 수 있습니다.' });
  }
  request.householdId = householdId;
  next();
}

function createLoginLimiter() {
  return (request, response, next) => {
    const key = request.socket.remoteAddress || 'unknown';
    const record = loginAttempts.get(key);
    const currentTime = Date.now();
    if (record && record.blockedUntil > currentTime) {
      return response.status(429).json({ error: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
    }
    if (record && record.startedAt + 60_000 < currentTime) loginAttempts.delete(key);
    request.loginAttemptKey = key;
    next();
  };
}

function createRegistrationLimiter() {
  return (request, response, next) => {
    const key = request.socket.remoteAddress || 'unknown';
    const currentTime = Date.now();
    const record = registrationAttempts.get(key);
    if (record && record.startedAt + 60 * 60_000 > currentTime && record.count >= 5) {
      return response.status(429).json({ error: '회원가입 시도가 너무 많습니다. 한 시간 후 다시 시도해 주세요.' });
    }
    registrationAttempts.set(key, record && record.startedAt + 60 * 60_000 > currentTime
      ? { ...record, count: record.count + 1 }
      : { startedAt: currentTime, count: 1 });
    next();
  };
}

function recordLoginFailure(key) {
  const currentTime = Date.now();
  const record = loginAttempts.get(key);
  const next = !record || record.startedAt + 60_000 < currentTime
    ? { startedAt: currentTime, count: 1, blockedUntil: 0 }
    : { ...record, count: record.count + 1 };
  if (next.count >= 8) next.blockedUntil = currentTime + 60_000;
  loginAttempts.set(key, next);
}

function getHouseholdId(userId) {
  const household = db.prepare(`
    SELECT h.id
    FROM households h JOIN household_members m ON m.household_id = h.id
    WHERE m.user_id = ? ORDER BY h.created_at LIMIT 1
  `).get(userId);
  return household?.id || null;
}

function findInvitation(token) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(token || ''))) return null;
  return db.prepare(`
    SELECT i.id, i.household_id AS householdId, i.invited_by AS invitedBy,
      i.permission, i.status, i.expires_at AS expiresAt,
      h.name AS householdName, u.username AS inviterName
    FROM household_invitations i
    JOIN households h ON h.id = i.household_id
    JOIN users u ON u.id = i.invited_by
    WHERE i.token_hash = ?
  `).get(hashToken(token));
}

function activeInvitation(token) {
  const invitation = findInvitation(token);
  if (!invitation) return null;
  if (invitation.status !== 'pending') return null;
  if (invitation.expiresAt <= now()) {
    db.prepare("UPDATE household_invitations SET status = 'expired' WHERE id = ?").run(invitation.id);
    return null;
  }
  return invitation;
}

function inviteFailure(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function getCategoryId(householdId, name, type) {
  const normalizedName = String(name || '').trim().slice(0, 60) || '미분류';
  let category = db.prepare(`
    SELECT id FROM categories WHERE household_id = ? AND name = ? AND category_type = ?
  `).get(householdId, normalizedName, type);
  if (!category) {
    const result = db.prepare(`
      INSERT INTO categories (household_id, name, category_type, created_at) VALUES (?, ?, ?, ?)
    `).run(householdId, normalizedName, type, now());
    category = { id: Number(result.lastInsertRowid) };
  }
  return category.id;
}

function saveCategoryRule(householdId, description, categoryId, userId, timestamp) {
  db.prepare(`
    INSERT INTO category_rules (household_id, keyword, category_id, updated_by, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(household_id, keyword)
    DO UPDATE SET category_id = excluded.category_id, updated_by = excluded.updated_by, created_at = excluded.created_at
  `).run(householdId, description.trim().toLocaleLowerCase(), categoryId, userId, timestamp);
}

function externalKey(transaction, accountId) {
  return createHash('sha256')
    .update([
      accountId,
      transaction.transactionDate,
      transaction.description.trim(),
      transaction.amount,
      transaction.balance ?? ''
    ].join('|'))
    .digest('hex');
}

function expirePreviews() {
  const expiry = Date.now() - 10 * 60 * 1000;
  for (const [id, preview] of previews) {
    if (preview.createdAt < expiry) previews.delete(id);
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDirectory,
    filename: (request, file, callback) => callback(null, `${randomUUID()}.xlsx`)
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (request, file, callback) => {
    if (path.extname(file.originalname).toLowerCase() !== '.xlsx') {
      return callback(new Error('엑셀 .xlsx 파일만 업로드할 수 있습니다.'));
    }
    callback(null, true);
  }
});

function parseWorkbook(filePath, password) {
  return new Promise((resolve, reject) => {
    const python = process.env.BINKSALAD_PYTHON || 'python';
    const child = spawn(python, [path.join(serverDirectory, 'parse-kakaobank.py'), filePath], {
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1' },
      stdio: ['pipe', 'pipe', 'ignore']
    });
    let stdout = '';
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 10 * 1024 * 1024 && !settled) {
        settled = true;
        child.kill();
        reject(new Error('엑셀 처리 결과가 너무 큽니다.'));
      }
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      reject(new Error(error.code === 'ENOENT'
        ? 'Python을 찾지 못했습니다. Python을 설치하거나 BINKSALAD_PYTHON을 설정해 주세요.'
        : '엑셀 처리 프로그램을 시작하지 못했습니다.'));
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      let result;
      try {
        result = JSON.parse(stdout);
      } catch {
        reject(new Error('엑셀 처리 프로그램에서 올바른 결과를 받지 못했습니다.'));
        return;
      }
      if (!result.ok) {
        reject(new Error(result.error || '엑셀 파일을 처리하지 못했습니다.'));
        return;
      }
      resolve(result);
    });
    child.stdin.end(JSON.stringify({ password: password || '' }));
  });
}

function addNotification(userId, householdId, type, title, message) {
  db.prepare(`
    INSERT INTO notifications (id, user_id, household_id, notification_type, title, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), userId, householdId, type, title, message, now());
}

app.get('/api/health', (request, response) => {
  response.json({ ok: true, initialized: isInitialized() });
});

app.get('/api/auth/session', (request, response) => {
  const session = readAuthSession(request);
  response.json({
    initialized: isInitialized(),
    authenticated: Boolean(session),
    kakaoConfigured: getKakaoConfig().configured,
    csrfToken: session?.csrfToken || null,
    user: session ? { id: session.userId, username: session.username } : null
  });
});

app.post('/api/auth/setup', (request, response) => {
  if (isInitialized()) return response.status(409).json({ error: '초기 설정은 이미 완료되었습니다.' });
  if (!isLoopback(request.socket.remoteAddress)) {
    return response.status(403).json({ error: '처음 계정 설정은 이 컴퓨터에서 진행해야 합니다.' });
  }
  const password = String(request.body.password || '');
  if (password.length < 12 || password.length > 256) {
    return response.status(400).json({ error: '비밀번호는 12자 이상이어야 합니다.' });
  }

  let user;
  try {
    user = createPersonalAccount('owner', password, true);
  } catch (error) {
    if (error.statusCode) return response.status(error.statusCode).json({ error: error.message });
    throw error;
  }

  const session = createSession(db, user);
  setAuthCookie(response, session.token, session.expiresAt);
  response.status(201).json({
    csrfToken: session.csrfToken,
    user: { id: user, username: 'owner' }
  });
});

app.post('/api/auth/register', createRegistrationLimiter(), (request, response) => {
  if (!isInitialized()) return response.status(409).json({ error: '먼저 이 서버에서 초기 설정을 진행해 주세요.' });
  const username = String(request.body.username || '').trim().toLowerCase();
  const password = String(request.body.password || '');
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return response.status(400).json({ error: '사용자 이름은 영문 소문자, 숫자, 점, 밑줄, 하이픈으로 3~32자 입력해 주세요.' });
  }
  if (password.length < 12 || password.length > 256) {
    return response.status(400).json({ error: '비밀번호는 12자 이상이어야 합니다.' });
  }

  let userId;
  try {
    userId = createPersonalAccount(username, password);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return response.status(409).json({ error: '이미 사용 중인 사용자 이름입니다.' });
    }
    throw error;
  }
  const session = createSession(db, userId);
  setAuthCookie(response, session.token, session.expiresAt);
  response.status(201).json({
    csrfToken: session.csrfToken,
    user: { id: userId, username }
  });
});

app.post('/api/auth/login', createLoginLimiter(), (request, response) => {
  if (!isInitialized()) return response.status(409).json({ error: '먼저 이 컴퓨터에서 초기 설정을 진행해 주세요.' });
  const username = String(request.body.username || 'owner').trim().toLowerCase();
  const password = String(request.body.password || '');
  const user = db.prepare('SELECT id, username, password_hash AS passwordHash FROM users WHERE username = ?')
    .get(username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    recordLoginFailure(request.loginAttemptKey);
    return response.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  }
  loginAttempts.delete(request.loginAttemptKey);
  const session = createSession(db, user.id);
  setAuthCookie(response, session.token, session.expiresAt);
  response.json({
    csrfToken: session.csrfToken,
    user: { id: user.id, username: user.username }
  });
});

app.get('/api/auth/kakao/login', (request, response) => {
  if (!isInitialized()) return kakaoRedirect(response, 'setup-required');
  const config = getKakaoConfig();
  if (!config.configured) return kakaoRedirect(response, 'not-configured');
  const state = createKakaoState('login');
  setKakaoStateCookie(response, state);
  response.redirect(createKakaoAuthorizationUrl(state, config));
});

app.post('/api/auth/kakao/link', requireAuth, requireCsrf, (request, response) => {
  const config = getKakaoConfig();
  if (!config.configured) {
    return response.status(503).json({ error: '카카오 REST API 키, 클라이언트 시크릿, 리다이렉트 URI를 먼저 설정해 주세요.' });
  }
  const state = createKakaoState('link', request.session);
  setKakaoStateCookie(response, state);
  response.json({ authorizationUrl: createKakaoAuthorizationUrl(state, config) });
});

app.get('/api/auth/kakao/status', requireAuth, (request, response) => {
  const config = getKakaoConfig();
  const user = db.prepare(`
    SELECT kakao_user_id AS userId, kakao_nickname AS nickname FROM users WHERE id = ?
  `).get(request.session.userId);
  response.json({
    configured: config.configured,
    connected: Boolean(user?.userId),
    nickname: user?.nickname || null
  });
});

app.delete('/api/auth/kakao/link', requireAuth, requireCsrf, (request, response) => {
  db.prepare('UPDATE users SET kakao_user_id = NULL, kakao_nickname = NULL WHERE id = ?')
    .run(request.session.userId);
  response.status(204).end();
});

app.get('/api/auth/kakao/callback', async (request, response) => {
  const state = String(request.query.state || '');
  const cookieState = readCookie(request, KAKAO_STATE_COOKIE);
  clearKakaoStateCookie(response);
  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !cookieState ||
      !/^[A-Za-z0-9_-]{43}$/.test(cookieState) ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(cookieState))) {
    return kakaoRedirect(response, 'invalid-state');
  }

  const stateHash = hashToken(state);
  const flow = db.prepare(`
    SELECT state_hash AS stateHash, action, user_id AS userId,
      session_token_hash AS sessionTokenHash, expires_at AS expiresAt
    FROM oauth_states WHERE state_hash = ?
  `).get(stateHash);
  db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(stateHash);
  if (!flow || flow.expiresAt <= now()) return kakaoRedirect(response, 'invalid-state');
  if (request.query.error) return kakaoRedirect(response, 'cancelled');

  const code = String(request.query.code || '');
  if (!code) return kakaoRedirect(response, 'failed');

  let kakaoProfile;
  try {
    const config = getKakaoConfig();
    if (!config.configured) return kakaoRedirect(response, 'not-configured');
    kakaoProfile = await fetchKakaoProfile(code, config);
  } catch {
    console.error('Kakao OAuth callback failed while exchanging the authorization code or fetching the user profile.');
    return kakaoRedirect(response, 'failed');
  }

  if (flow.action === 'link') {
    const session = readAuthSession(request);
    if (!session || session.userId !== flow.userId ||
        hashToken(session.token) !== flow.sessionTokenHash) {
      return kakaoRedirect(response, 'session-expired');
    }

    const existing = db.prepare('SELECT id FROM users WHERE kakao_user_id = ?')
      .get(kakaoProfile.userId);
    if (existing && existing.id !== flow.userId) return kakaoRedirect(response, 'already-linked');
    try {
      db.prepare('UPDATE users SET kakao_user_id = ?, kakao_nickname = ? WHERE id = ?')
        .run(kakaoProfile.userId, kakaoProfile.nickname, flow.userId);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return kakaoRedirect(response, 'already-linked');
      throw error;
    }
    return kakaoRedirect(response, 'linked');
  }

  const user = db.prepare('SELECT id FROM users WHERE kakao_user_id = ?')
    .get(kakaoProfile.userId);
  if (!user) return kakaoRedirect(response, 'not-linked');
  const session = createSession(db, user.id);
  setAuthCookie(response, session.token, session.expiresAt);
  return kakaoRedirect(response, 'login');
});

app.post('/api/auth/logout', requireAuth, requireCsrf, (request, response) => {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(request.session.token));
  clearAuthCookie(response);
  response.status(204).end();
});

app.get('/api/invitations/:token', (request, response) => {
  const found = findInvitation(request.params.token);
  if (!found) return response.status(404).json({ error: '초대 링크를 찾을 수 없습니다.' });
  const invitation = activeInvitation(request.params.token);
  if (!invitation) return response.status(410).json({ error: '초대 링크가 만료되었거나 이미 사용되었습니다.' });
  response.json({
    householdName: invitation.householdName,
    inviterName: invitation.inviterName,
    permission: invitation.permission,
    expiresAt: invitation.expiresAt
  });
});

app.post('/api/invitations/register', (request, response) => {
  const token = String(request.body.token || '');
  const username = String(request.body.username || '').trim().toLowerCase();
  const password = String(request.body.password || '');
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return response.status(400).json({ error: '사용자 이름은 영문 소문자, 숫자, 점, 밑줄, 하이픈으로 3~32자 입력해 주세요.' });
  }
  if (password.length < 12 || password.length > 256) {
    return response.status(400).json({ error: '비밀번호는 12자 이상이어야 합니다.' });
  }
  const invitation = activeInvitation(token);
  if (!invitation) return response.status(410).json({ error: '초대 링크가 만료되었거나 올바르지 않습니다.' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return response.status(409).json({ error: '이미 사용 중인 사용자 이름입니다.' });
  }

  let userId;
  const createdAt = now();
  try {
    userId = db.transaction(() => {
      const currentInvitation = activeInvitation(token);
      if (!currentInvitation) throw inviteFailure('초대 링크가 만료되었거나 이미 사용되었습니다.', 410);
      const insertedUser = db.prepare(`
        INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)
      `).run(username, hashPassword(password), createdAt);
      const newUserId = Number(insertedUser.lastInsertRowid);
      db.prepare(`
        INSERT INTO household_members (household_id, user_id, role, permission, joined_at)
        VALUES (?, ?, 'member', ?, ?)
      `).run(currentInvitation.householdId, newUserId, currentInvitation.permission, createdAt);
      db.prepare(`
        UPDATE household_invitations
        SET status = 'accepted', accepted_by = ?, accepted_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(newUserId, createdAt, currentInvitation.id);
      return newUserId;
    })();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return response.status(409).json({ error: '이미 사용 중인 사용자 이름입니다.' });
    }
    if (error.statusCode) return response.status(error.statusCode).json({ error: error.message });
    throw error;
  }

  const session = createSession(db, userId);
  setAuthCookie(response, session.token, session.expiresAt);
  response.status(201).json({
    csrfToken: session.csrfToken,
    user: { id: userId, username },
    household: { id: invitation.householdId, name: invitation.householdName }
  });
});

app.post('/api/invitations/accept', requireAuth, requireCsrf, (request, response) => {
  const token = String(request.body.token || '');
  const invitation = activeInvitation(token);
  if (!invitation) return response.status(410).json({ error: '초대 링크가 만료되었거나 올바르지 않습니다.' });

  const existingMembership = db.prepare(`
    SELECT household_id AS householdId FROM household_members WHERE user_id = ? LIMIT 1
  `).get(request.session.userId);
  if (existingMembership) {
    const message = existingMembership.householdId === invitation.householdId
      ? '이미 이 가계부의 구성원입니다.'
      : '현재 계정은 다른 가계부에 가입되어 있습니다. 초대를 수락하려면 새 계정을 사용해 주세요.';
    return response.status(409).json({ error: message });
  }

  const joinedAt = now();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO household_members (household_id, user_id, role, permission, joined_at)
      VALUES (?, ?, 'member', ?, ?)
    `).run(invitation.householdId, request.session.userId, invitation.permission, joinedAt);
    db.prepare(`
      UPDATE household_invitations
      SET status = 'accepted', accepted_by = ?, accepted_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(request.session.userId, joinedAt, invitation.id);
  })();
  response.json({ household: { id: invitation.householdId, name: invitation.householdName } });
});

app.use('/api', (request, response, next) => {
  if (request.path.startsWith('/auth/')) return next();
  requireAuth(request, response, next);
});
app.use('/api', (request, response, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
  requireCsrf(request, response, next);
});

app.get('/api/household', (request, response) => {
  const householdId = getHouseholdId(request.session.userId);
  if (!householdId) return response.status(404).json({ error: '가계부를 찾을 수 없습니다.' });
  const household = db.prepare(`
    SELECT h.id, h.name, h.household_type AS type, m.role, m.permission
    FROM households h JOIN household_members m ON m.household_id = h.id
    WHERE h.id = ? AND m.user_id = ?
  `).get(householdId, request.session.userId);
  response.json(household);
});

app.get('/api/household/members', (request, response) => {
  const householdId = getHouseholdId(request.session.userId);
  if (!householdId) return response.status(404).json({ error: '가계부를 찾을 수 없습니다.' });
  response.json(db.prepare(`
    SELECT u.id, u.username, m.role, m.permission, m.joined_at AS joinedAt
    FROM household_members m JOIN users u ON u.id = m.user_id
    WHERE m.household_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.joined_at
  `).all(householdId));
});

app.get('/api/household/invitations', requireHouseholdManager, (request, response) => {
  response.json(db.prepare(`
    SELECT id, permission, status, expires_at AS expiresAt, created_at AS createdAt
    FROM household_invitations
    WHERE household_id = ? AND status = 'pending'
    ORDER BY created_at DESC
  `).all(request.householdId));
});

app.post('/api/household/invitations', requireHouseholdManager, (request, response) => {
  const permission = request.body.permission === 'edit' ? 'edit' : 'view';
  const token = randomBytes(32).toString('base64url');
  const createdAt = now();
  const expiresAt = new Date(Date.now() + HOUSEHOLD_INVITATION_MAX_AGE_MS).toISOString();
  const invitationId = randomUUID();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO household_invitations (
        id, household_id, invited_by, token_hash, permission, status, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      invitationId, request.householdId, request.session.userId,
      hashToken(token), permission, expiresAt, createdAt
    );
    db.prepare(`
      UPDATE households
      SET household_type = 'shared',
        name = CASE WHEN name = '개인 가계부' THEN '공용 가계부' ELSE name END
      WHERE id = ?
    `)
      .run(request.householdId);
  })();
  response.status(201).json({
    id: invitationId,
    permission,
    expiresAt,
    inviteUrl: `/?invite=${encodeURIComponent(token)}`
  });
});

app.delete('/api/household/invitations/:id', requireHouseholdManager, (request, response) => {
  const result = db.prepare(`
    UPDATE household_invitations SET status = 'revoked'
    WHERE id = ? AND household_id = ? AND status = 'pending'
  `).run(request.params.id, request.householdId);
  if (!result.changes) return response.status(404).json({ error: '대기 중인 초대를 찾을 수 없습니다.' });
  response.status(204).end();
});

app.delete('/api/household/members/:userId', requireHouseholdOwner, (request, response) => {
  const userId = Number(request.params.userId);
  if (!Number.isSafeInteger(userId) || userId === request.session.userId) {
    return response.status(400).json({ error: '삭제할 구성원을 선택해 주세요.' });
  }
  const result = db.prepare(`
    DELETE FROM household_members
    WHERE household_id = ? AND user_id = ? AND role != 'owner'
  `).run(request.householdId, userId);
  if (!result.changes) return response.status(404).json({ error: '구성원을 찾을 수 없습니다.' });
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  response.status(204).end();
});

app.get('/api/accounts', (request, response) => {
  const householdId = getHouseholdId(request.session.userId);
  if (!householdId) return response.status(404).json({ error: '가계부를 찾을 수 없습니다.' });
  response.json(db.prepare(`
    SELECT id, bank_name AS bankName, name,
      account_number_suffix AS accountNumberSuffix, created_at AS createdAt
    FROM household_accounts WHERE household_id = ? ORDER BY created_at
  `).all(householdId));
});

app.post('/api/accounts', requireHouseholdManager, (request, response) => {
  const name = String(request.body.name || '').trim();
  const accountNumberSuffix = String(request.body.accountNumberSuffix || '').trim();
  if (!name || name.length > 50 || (accountNumberSuffix && !/^\d{4}$/.test(accountNumberSuffix))) {
    return response.status(400).json({ error: '계좌 별칭은 1~50자, 계좌번호 끝 4자리는 숫자 4자리로 입력해 주세요.' });
  }
  const id = randomUUID();
  try {
    db.prepare(`
      INSERT INTO household_accounts (
        id, household_id, bank_name, name, account_number_suffix, created_by, created_at
      ) VALUES (?, ?, '카카오뱅크', ?, ?, ?, ?)
    `).run(id, request.householdId, name, accountNumberSuffix || null, request.session.userId, now());
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return response.status(409).json({ error: '이미 사용 중인 계좌 별칭입니다.' });
    }
    throw error;
  }
  response.status(201).json({ id, bankName: '카카오뱅크', name, accountNumberSuffix: accountNumberSuffix || null });
});

app.delete('/api/accounts/:id', requireHouseholdManager, (request, response) => {
  const account = db.prepare(`
    SELECT id FROM household_accounts WHERE id = ? AND household_id = ?
  `).get(request.params.id, request.householdId);
  if (!account) return response.status(404).json({ error: '계좌를 찾을 수 없습니다.' });
  const transactionCount = db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE account_id = ?')
    .get(account.id).count;
  if (transactionCount) {
    return response.status(409).json({ error: '거래가 연결된 계좌는 삭제할 수 없습니다.' });
  }
  db.prepare('DELETE FROM household_accounts WHERE id = ?').run(account.id);
  response.status(204).end();
});

app.get('/api/categories', (request, response) => {
  const householdId = getHouseholdId(request.session.userId);
  response.json(db.prepare(`
    SELECT id, name, category_type AS type
    FROM categories WHERE household_id = ? ORDER BY category_type, name
  `).all(householdId));
});

app.get('/api/dashboard', (request, response) => {
  const month = String(request.query.month || new Date().toISOString().slice(0, 7));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return response.status(400).json({ error: '월은 YYYY-MM 형식이어야 합니다.' });
  }
  response.json(dashboardForMonth(db, getHouseholdId(request.session.userId), month));
});

app.get('/api/transactions', (request, response) => {
  const householdId = getHouseholdId(request.session.userId);
  const limit = Math.min(Math.max(Number(request.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(request.query.offset) || 0, 0);
  const filters = ['t.household_id = ?'];
  const values = [householdId];
  if (request.query.accountId) {
    filters.push('t.account_id = ?');
    values.push(String(request.query.accountId));
  }
  if (request.query.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(request.query.month)) {
    const monthStart = `${request.query.month}-01`;
    const [year, monthNumber] = request.query.month.split('-').map(Number);
    const monthEnd = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
    filters.push('t.transaction_date >= ? AND t.transaction_date < ?');
    values.push(monthStart, monthEnd);
  }
  if (request.query.type && ['income', 'expense'].includes(request.query.type)) {
    filters.push('t.transaction_type = ?');
    values.push(request.query.type);
  }
  if (request.query.categoryId && /^\d+$/.test(request.query.categoryId)) {
    filters.push('t.category_id = ?');
    values.push(Number(request.query.categoryId));
  }
  if (request.query.search) {
    filters.push('(t.description LIKE ? OR COALESCE(t.counterparty, \'\') LIKE ?)');
    const search = `%${String(request.query.search).slice(0, 100)}%`;
    values.push(search, search);
  }
  const where = filters.join(' AND ');
  const transactions = db.prepare(`
    SELECT t.id, t.transaction_date AS transactionDate,
      t.description, t.original_description AS originalDescription,
      t.counterparty, t.amount, t.balance, t.transaction_type AS transactionType,
      t.category_id AS categoryId, c.name AS category, t.category_manual AS categoryManual,
      t.account_id AS accountId, a.name AS accountName,
      t.source, t.created_at AS createdAt
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN household_accounts a ON a.id = t.account_id
    WHERE ${where}
    ORDER BY t.transaction_date DESC, t.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...values, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS count FROM transactions t WHERE ${where}`)
    .get(...values).count;
  response.json({ transactions, total, limit, offset });
});

app.post('/api/transactions', requireHouseholdEdit, (request, response) => {
  const householdId = getHouseholdId(request.session.userId);
  const transactionDate = String(request.body.transactionDate || '');
  const description = String(request.body.description || '').trim();
  const amount = Number(request.body.amount);
  const balance = request.body.balance == null || request.body.balance === ''
    ? null
    : Number(request.body.balance);
  if (!Number.isFinite(Date.parse(transactionDate)) || !description || description.length > 200 ||
      !Number.isSafeInteger(amount) || amount === 0 ||
      (balance !== null && !Number.isSafeInteger(balance))) {
    return response.status(400).json({ error: '거래 일시, 내용, 0이 아닌 원 단위 금액을 입력해 주세요.' });
  }
  const accountId = request.body.accountId ? String(request.body.accountId) : null;
  if (accountId && !db.prepare(`
    SELECT 1 FROM household_accounts WHERE id = ? AND household_id = ?
  `).get(accountId, householdId)) {
    return response.status(400).json({ error: '선택한 계좌를 찾을 수 없습니다.' });
  }
  const type = amount > 0 ? 'income' : 'expense';
  const categoryId = getCategoryId(householdId, request.body.category, type);
  const id = randomUUID();
  const createdAt = now();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO transactions (
        id, household_id, account_id, transaction_date, description, original_description, counterparty,
        amount, balance, transaction_type, category_id, category_manual, source,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'manual', ?, ?, ?)
    `).run(
      id, householdId, accountId, new Date(transactionDate).toISOString(), description, description,
      request.body.counterparty ? String(request.body.counterparty).slice(0, 120) : null,
      amount, balance,
      type, categoryId, request.session.userId, createdAt, createdAt
    );
    db.prepare(`
      INSERT INTO transaction_audit_logs
      (id, transaction_id, household_id, modified_by, action, new_values, created_at)
      VALUES (?, ?, ?, ?, 'create', ?, ?)
    `).run(randomUUID(), id, householdId, request.session.userId, JSON.stringify({ description, amount, categoryId }), createdAt);
  })();
  response.status(201).json({ id });
});

app.patch('/api/transactions/:id', requireHouseholdEdit, (request, response) => {
  const householdId = getHouseholdId(request.session.userId);
  const existing = db.prepare(`
    SELECT t.*, c.name AS category FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.id = ? AND t.household_id = ?
  `).get(request.params.id, householdId);
  if (!existing) return response.status(404).json({ error: '거래를 찾을 수 없습니다.' });

  const description = request.body.description === undefined
    ? existing.description
    : String(request.body.description).trim();
  if (!description || description.length > 200) {
    return response.status(400).json({ error: '거래 내용은 1~200자로 입력해 주세요.' });
  }
  let categoryId = existing.category_id;
  let categoryName = existing.category;
  if (request.body.category !== undefined) {
    categoryName = String(request.body.category).trim().slice(0, 60) || '미분류';
    categoryId = getCategoryId(householdId, categoryName, existing.transaction_type);
  }
  const updatedAt = now();
  const previous = { description: existing.description, categoryId: existing.category_id, category: existing.category };
  const next = { description, categoryId, category: categoryName };
  db.transaction(() => {
    db.prepare(`
      UPDATE transactions SET description = ?, category_id = ?, category_manual = 1, updated_at = ?
      WHERE id = ? AND household_id = ?
    `).run(description, categoryId, updatedAt, request.params.id, householdId);
    db.prepare(`
      INSERT INTO transaction_audit_logs
      (id, transaction_id, household_id, modified_by, action, previous_values, new_values, created_at)
      VALUES (?, ?, ?, ?, 'update', ?, ?, ?)
    `).run(randomUUID(), request.params.id, householdId, request.session.userId, JSON.stringify(previous), JSON.stringify(next), updatedAt);
    if (request.body.category !== undefined && existing.original_description.trim()) {
      saveCategoryRule(householdId, existing.original_description, categoryId, request.session.userId, updatedAt);
    }
  })();
  response.json({ ok: true });
});

app.delete('/api/transactions/:id', requireHouseholdEdit, (request, response) => {
  const householdId = getHouseholdId(request.session.userId);
  const existing = db.prepare(`
    SELECT id, description, amount, category_id FROM transactions
    WHERE id = ? AND household_id = ?
  `).get(request.params.id, householdId);
  if (!existing) return response.status(404).json({ error: '거래를 찾을 수 없습니다.' });
  const deletedAt = now();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO transaction_audit_logs
      (id, transaction_id, household_id, modified_by, action, previous_values, created_at)
      VALUES (?, ?, ?, ?, 'delete', ?, ?)
    `).run(randomUUID(), existing.id, householdId, request.session.userId, JSON.stringify(existing), deletedAt);
    db.prepare('DELETE FROM transactions WHERE id = ? AND household_id = ?').run(existing.id, householdId);
  })();
  response.status(204).end();
});

app.get('/api/transactions/:id/audit', (request, response) => {
  const householdId = getHouseholdId(request.session.userId);
  response.json(db.prepare(`
    SELECT action, previous_values AS previousValues, new_values AS newValues, created_at AS createdAt
    FROM transaction_audit_logs
    WHERE household_id = ? AND transaction_id = ?
    ORDER BY created_at DESC
  `).all(householdId, request.params.id));
});

app.post('/api/import/preview', requireHouseholdEdit, upload.single('file'), async (request, response, next) => {
  if (!request.file) return response.status(400).json({ error: '가져올 .xlsx 파일을 선택해 주세요.' });
  expirePreviews();
  const householdId = getHouseholdId(request.session.userId);
  const accountId = String(request.body.accountId || '');
  const account = db.prepare(`
    SELECT id, name FROM household_accounts WHERE id = ? AND household_id = ?
  `).get(accountId, householdId);
  if (!account) {
    unlinkSync(request.file.path);
    return response.status(400).json({ error: '가져올 계좌를 선택해 주세요. 가계 관리에서 계좌를 먼저 추가할 수 있습니다.' });
  }
  const savedCredential = db.prepare(`
    SELECT encrypted_password, encryption_iv, encryption_tag
    FROM saved_credentials WHERE household_id = ? AND credential_owner_id = ? AND credential_type = 'kakaobank-xlsx'
  `).get(householdId, request.session.userId);

  let password = String(request.body.password || '');
  if (!password && savedCredential) {
    try {
      password = decryptCredential(savedCredential);
    } catch {
      unlinkSync(request.file.path);
      return response.status(500).json({ error: '저장된 파일 비밀번호를 복호화하지 못했습니다. 설정에서 저장된 비밀번호를 삭제한 뒤 다시 입력해 주세요.' });
    }
  }

  try {
    const parsed = await parseWorkbook(request.file.path, password);
    const previewId = randomBytes(24).toString('base64url');
    const categoryRules = db.prepare(`
      SELECT keyword, c.name AS category
      FROM category_rules r JOIN categories c ON c.id = r.category_id
      WHERE r.household_id = ?
    `).all(householdId);
    const existingKeys = new Set(db.prepare(`
      SELECT external_key FROM transactions
      WHERE household_id = ? AND account_id = ? AND external_key IS NOT NULL
    `).all(householdId, accountId).map(row => row.external_key));
    const seenKeys = new Set();
    const rows = parsed.transactions.map((transaction, index) => {
      const key = externalKey(transaction, accountId);
      const duplicate = existingKeys.has(key) || seenKeys.has(key);
      seenKeys.add(key);
      const rule = categoryRules.find(item => item.keyword === transaction.description.trim().toLocaleLowerCase());
      return {
        ...transaction,
        category: rule?.category || transaction.category,
        categoryRuleApplied: Boolean(rule),
        externalKey: key,
        duplicate,
        index
      };
    });
    let credential = null;
    if (request.body.rememberPassword === 'true' && password) credential = encryptCredential(password);
    previews.set(previewId, {
      rows,
      errors: parsed.errors,
      userId: request.session.userId,
      householdId,
      accountId,
      accountName: account.name,
      fileName: path.basename(request.file.originalname).slice(0, 200),
      credential,
      createdAt: Date.now()
    });
    response.json({
      previewId,
      fileName: path.basename(request.file.originalname),
      accountId,
      accountName: account.name,
      transactions: rows.map(({ externalKey: key, ...transaction }) => transaction),
      errors: parsed.errors,
      counts: {
        parsed: rows.length,
        duplicates: rows.filter(row => row.duplicate).length,
        invalid: parsed.errors.length
      },
      usedSavedPassword: Boolean(savedCredential && !request.body.password)
    });
  } catch (error) {
    db.prepare(`
      INSERT INTO import_history (
        id, household_id, account_id, uploaded_by, file_name, import_date,
        transaction_count, duplicate_count, import_status, error_details
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'failed', ?)
    `).run(
      randomUUID(),
      householdId,
      accountId,
      request.session.userId,
      path.basename(request.file.originalname).slice(0, 200),
      now(),
      error.message
    );
    next(Object.assign(error, { statusCode: 422 }));
  } finally {
    unlinkSync(request.file.path);
  }
});

app.post('/api/import/confirm', requireHouseholdEdit, (request, response) => {
  expirePreviews();
  const { previewId, edits = [] } = request.body;
  const preview = previews.get(String(previewId || ''));
  if (!preview || preview.userId !== request.session.userId) {
    return response.status(404).json({ error: '가져오기 미리보기가 만료되었습니다. 파일을 다시 선택해 주세요.' });
  }
  const householdId = getHouseholdId(request.session.userId);
  if (preview.householdId !== householdId) {
    previews.delete(previewId);
    return response.status(403).json({ error: '이 가계부의 가져오기 권한이 없습니다.' });
  }

  const editMap = new Map();
  if (!Array.isArray(edits)) return response.status(400).json({ error: '거래 수정 정보가 올바르지 않습니다.' });
  for (const edit of edits) {
    if (!Number.isInteger(edit.index) || edit.index < 0 || edit.index >= preview.rows.length) continue;
    editMap.set(edit.index, edit);
  }

  const importId = randomUUID();
  const importedAt = now();
  let transactionCount = 0;
  let duplicateCount = 0;
  db.transaction(() => {
    for (const row of preview.rows) {
      if (row.duplicate) {
        duplicateCount += 1;
        continue;
      }
      const edit = editMap.get(row.index) || {};
      const description = String(edit.description ?? row.description).trim().slice(0, 200);
      if (!description) continue;
      const categoryName = String(edit.category ?? row.category ?? '미분류').trim().slice(0, 60) || '미분류';
      const manuallyEdited = (edit.category !== undefined && categoryName !== row.category) ||
        (edit.description !== undefined && description !== row.description);
      const categoryId = getCategoryId(householdId, categoryName, row.transactionType);
      const transactionId = randomUUID();
      try {
        db.prepare(`
          INSERT INTO transactions (
            id, household_id, account_id, transaction_date, description, original_description, counterparty,
            amount, balance, transaction_type, category_id, category_manual, source,
            external_key, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'kakaobank-xlsx', ?, ?, ?, ?)
        `).run(
          transactionId, householdId, preview.accountId, row.transactionDate, description, row.description,
          row.counterparty, row.amount, row.balance, row.transactionType, categoryId,
          manuallyEdited ? 1 : 0,
          row.externalKey, request.session.userId, importedAt, importedAt
        );
        db.prepare(`
          INSERT INTO transaction_audit_logs
          (id, transaction_id, household_id, modified_by, action, new_values, created_at)
          VALUES (?, ?, ?, ?, 'import', ?, ?)
        `).run(
          randomUUID(), transactionId, householdId, request.session.userId,
          JSON.stringify({ description, amount: row.amount, categoryId, source: 'kakaobank-xlsx' }),
          importedAt
        );
        if (edit.category !== undefined && categoryName !== row.category) {
          saveCategoryRule(householdId, row.description, categoryId, request.session.userId, importedAt);
        }
        transactionCount += 1;
      } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          duplicateCount += 1;
          continue;
        }
        throw error;
      }
    }

    if (preview.credential) {
      db.prepare(`
        INSERT INTO saved_credentials (
          household_id, credential_owner_id, credential_type, encrypted_password,
          encryption_iv, encryption_tag, encryption_key_version, created_at, updated_at
        ) VALUES (?, ?, 'kakaobank-xlsx', ?, ?, ?, 1, ?, ?)
        ON CONFLICT(household_id, credential_owner_id, credential_type)
        DO UPDATE SET encrypted_password = excluded.encrypted_password,
          encryption_iv = excluded.encryption_iv, encryption_tag = excluded.encryption_tag,
          updated_at = excluded.updated_at
      `).run(
        householdId, request.session.userId,
        preview.credential.encryptedPassword, preview.credential.encryptionIv,
        preview.credential.encryptionTag, importedAt, importedAt
      );
    }

    const status = transactionCount || duplicateCount ? 'completed' : 'failed';
    db.prepare(`
      INSERT INTO import_history (
        id, household_id, account_id, uploaded_by, file_name, import_date,
        transaction_count, duplicate_count, import_status, error_details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      importId, householdId, preview.accountId, request.session.userId, preview.fileName, importedAt,
      transactionCount, duplicateCount, status,
      preview.errors.length ? JSON.stringify(preview.errors) : null
    );
    if (transactionCount) {
      addNotification(
        request.session.userId, householdId, 'transactions_imported',
        '새 거래 내역을 가져왔습니다',
        `${transactionCount}건 추가, ${duplicateCount}건 중복 제외`
      );
    }
  })();

  previews.delete(previewId);
  response.status(201).json({
    importId,
    imported: transactionCount,
    duplicates: duplicateCount,
    invalid: preview.errors.length
  });
});

app.get('/api/imports', (request, response) => {
  const householdId = getHouseholdId(request.session.userId);
  response.json(db.prepare(`
    SELECT i.id, i.file_name AS fileName, i.import_date AS importedAt,
      i.account_id AS accountId, a.name AS accountName,
      i.transaction_count AS transactionCount, i.duplicate_count AS duplicateCount,
      i.import_status AS status, i.error_details AS errors
    FROM import_history i LEFT JOIN household_accounts a ON a.id = i.account_id
    WHERE i.household_id = ?
    ORDER BY i.import_date DESC LIMIT 100
  `).all(householdId));
});

app.get('/api/credentials', (request, response) => {
  const householdId = getHouseholdId(request.session.userId);
  const stored = db.prepare(`
    SELECT updated_at AS updatedAt FROM saved_credentials
    WHERE household_id = ? AND credential_owner_id = ? AND credential_type = 'kakaobank-xlsx'
  `).get(householdId, request.session.userId);
  response.json({ saved: Boolean(stored), updatedAt: stored?.updatedAt || null });
});

app.delete('/api/credentials', requireHouseholdEdit, (request, response) => {
  const householdId = getHouseholdId(request.session.userId);
  db.prepare(`
    DELETE FROM saved_credentials
    WHERE household_id = ? AND credential_owner_id = ? AND credential_type = 'kakaobank-xlsx'
  `).run(householdId, request.session.userId);
  response.status(204).end();
});

app.get('/api/notifications', (request, response) => {
  response.json(db.prepare(`
    SELECT id, notification_type AS type, title, message,
      is_read AS isRead, created_at AS createdAt
    FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(request.session.userId));
});

app.patch('/api/notifications/:id/read', (request, response) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
    .run(request.params.id, request.session.userId);
  response.status(204).end();
});

app.use('/api', (request, response) => response.status(404).json({ error: 'API를 찾을 수 없습니다.' }));

app.use(express.static(path.join(projectDirectory, 'dist'), { index: false, fallthrough: true }));
app.get(/.*/, (request, response, next) => {
  if (!request.accepts('html')) return next();
  response.sendFile(path.join(projectDirectory, 'dist', 'index.html'), error => {
    if (error) next(error);
  });
});

app.use((error, request, response, next) => {
  if (response.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    return response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
      .json({ error: error.code === 'LIMIT_FILE_SIZE' ? '엑셀 파일은 10MB 이하여야 합니다.' : '파일 업로드 요청을 처리하지 못했습니다.' });
  }
  if (error.message === 'Unexpected end of form') {
    return response.status(400).json({ error: '파일 업로드가 올바르지 않습니다.' });
  }
  if (request.path.startsWith('/api/')) {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) console.error(error);
    return response.status(statusCode).json({
      error: statusCode < 500 ? error.message : '서버에서 요청을 처리하지 못했습니다.'
    });
  }
  console.error(error);
  response.status(500).send('Internal server error');
});

const server = app.listen(port, host, () => {
  console.log(`Binksalad server listening on http://${host}:${port}`);
  if (networkOnly) console.log("LAN-only access enabled for the host computer's private IPv4 networks.");
  console.log(`Database: ${databasePath}`);
  if (!isInitialized()) console.log('Initial setup: open this app on the host computer to create the owner password.');
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
