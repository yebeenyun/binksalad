import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createKakaoAuthorizationUrl, fetchKakaoProfile, getKakaoConfig } from '../server/kakao.js';
import { getPrivateIPv4Networks, isLocalNetworkAddress } from '../server/network.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('LAN access allows only loopback and clients in a detected private subnet', () => {
  const networks = [{ address: '192.168.10.25', netmask: '255.255.255.0' }];

  assert.equal(isLocalNetworkAddress('192.168.10.80', networks), true);
  assert.equal(isLocalNetworkAddress('::ffff:192.168.10.80', networks), true);
  assert.equal(isLocalNetworkAddress('127.0.0.1', networks), true);
  assert.equal(isLocalNetworkAddress('::1', networks), true);
  assert.equal(isLocalNetworkAddress('192.168.11.80', networks), false);
  assert.equal(isLocalNetworkAddress('8.8.8.8', networks), false);
});

test('private IPv4 network discovery excludes public and loopback interfaces', () => {
  const networks = getPrivateIPv4Networks({
    wifi: [
      { address: '192.168.10.25', netmask: '255.255.255.0', family: 'IPv4', internal: false },
      { address: '203.0.113.8', netmask: '255.255.255.0', family: 'IPv4', internal: false },
      { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }
    ]
  });

  assert.deepEqual(networks, [{ address: '192.168.10.25', netmask: '255.255.255.0' }]);
});

test('Kakao OAuth builds an authorization request and retrieves only a stable profile', async () => {
  const config = getKakaoConfig({
    KAKAO_REST_API_KEY: 'rest-key',
    KAKAO_CLIENT_SECRET: 'client-secret',
    KAKAO_REDIRECT_URI: 'https://finance.example.com/api/auth/kakao/callback'
  });
  assert.equal(config.configured, true);

  const authorizationUrl = new URL(createKakaoAuthorizationUrl('random-state', config));
  assert.equal(authorizationUrl.origin, 'https://kauth.kakao.com');
  assert.equal(authorizationUrl.searchParams.get('state'), 'random-state');
  assert.equal(authorizationUrl.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(getKakaoConfig({ KAKAO_REST_API_KEY: 'only-a-key' }).configured, false);

  const calls = [];
  const profile = await fetchKakaoProfile('authorization-code', config, async (url, options = {}) => {
    calls.push({ url, options });
    if (url === 'https://kauth.kakao.com/oauth/token') {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded;charset=utf-8');
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('client_secret'), 'client-secret');
      assert.equal(body.get('code'), 'authorization-code');
      return { ok: true, json: async () => ({ access_token: 'short-lived-access-token' }) };
    }
    assert.equal(url, 'https://kapi.kakao.com/v2/user/me');
    assert.equal(options.headers.Authorization, 'Bearer short-lived-access-token');
    return {
      ok: true,
      json: async () => ({ id: 987654321, kakao_account: { profile: { nickname: 'Yebeen' } } })
    };
  });

  assert.deepEqual(profile, { userId: '987654321', nickname: 'Yebeen' });
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(profile).includes('short-lived-access-token'), false);
});

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}

test('Kakao account linking is authenticated, CSRF-protected, and server-configured', { timeout: 30000 }, async t => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'binksalad-kakao-e2e-'));
  const port = await unusedPort();
  const server = spawn(process.execPath, ['server/index.js', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: root,
    env: {
      ...process.env,
      BINKSALAD_DATA_DIR: path.join(temporaryDirectory, 'data'),
      BINKSALAD_CREDENTIAL_KEY_FILE: path.join(temporaryDirectory, 'credentials.key'),
      KAKAO_REST_API_KEY: 'test-rest-api-key',
      KAKAO_CLIENT_SECRET: 'test-client-secret',
      KAKAO_REDIRECT_URI: `http://127.0.0.1:${port}/api/auth/kakao/callback`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  server.stdout.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });
  server.stderr.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill();
      await new Promise(resolve => server.once('exit', resolve));
    }
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  assert.equal(ready, true, `Kakao test server did not start: ${serverOutput}`);

  const setup = await fetch(`${origin}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'a-secure-local-test-password' })
  });
  const setupResult = await setup.json();
  const sessionCookie = setup.headers.get('set-cookie').split(';')[0];
  assert.equal(setupResult.kakaoConfigured, undefined);
  assert.equal(setup.headers.get('set-cookie').toLowerCase().includes('samesite=lax'), true);
  assert.equal((await (await fetch(`${origin}/api/auth/session`, { headers: { cookie: sessionCookie } })).json()).kakaoConfigured, true);

  const loginRedirect = await fetch(`${origin}/api/auth/kakao/login`, { redirect: 'manual' });
  assert.equal(loginRedirect.status, 302);
  const loginAuthorizationUrl = new URL(loginRedirect.headers.get('location'));
  assert.equal(loginAuthorizationUrl.origin, 'https://kauth.kakao.com');
  assert.equal(loginAuthorizationUrl.searchParams.get('redirect_uri'), `http://127.0.0.1:${port}/api/auth/kakao/callback`);

  const withoutCsrf = await fetch(`${origin}/api/auth/kakao/link`, {
    method: 'POST',
    headers: { cookie: sessionCookie }
  });
  assert.equal(withoutCsrf.status, 403);

  const linkResponse = await fetch(`${origin}/api/auth/kakao/link`, {
    method: 'POST',
    headers: { cookie: sessionCookie, 'X-CSRF-Token': setupResult.csrfToken }
  });
  assert.equal(linkResponse.status, 200);
  const link = await linkResponse.json();
  const authorizationUrl = new URL(link.authorizationUrl);
  assert.equal(authorizationUrl.origin, 'https://kauth.kakao.com');
  assert.equal(authorizationUrl.searchParams.get('client_id'), 'test-rest-api-key');
  assert.equal(authorizationUrl.searchParams.get('redirect_uri'), `http://127.0.0.1:${port}/api/auth/kakao/callback`);
  assert.equal(authorizationUrl.searchParams.get('state').length, 43);
  assert.equal(linkResponse.headers.get('set-cookie').toLowerCase().includes('httponly'), true);
  assert.equal(linkResponse.headers.get('set-cookie').toLowerCase().includes('samesite=lax'), true);
  assert.equal(linkResponse.headers.get('set-cookie').toLowerCase().includes('path=/api/auth/kakao'), true);
  assert.equal(linkResponse.headers.get('set-cookie').includes('test-client-secret'), false);

  const invalidCallback = await fetch(
    `${origin}/api/auth/kakao/callback?state=${authorizationUrl.searchParams.get('state')}&code=unused`,
    { redirect: 'manual' }
  );
  assert.equal(invalidCallback.status, 303);
  assert.equal(invalidCallback.headers.get('location'), '/?kakao=invalid-state');
});

function createWorkbook(filePath, {
  incomeDate = '2026.08.02 10:30:00',
  expenseDate = '2026.08.03 12:10:00',
  expenseAmount = -12500,
  expenseBalance = 887500
} = {}) {
  const script = [
    'from openpyxl import Workbook',
    'import sys',
    'w = Workbook()',
    's = w.active',
    's.title = "\\uac70\\ub798\\ub0b4\\uc5ed"',
    's.append(["\\uac70\\ub798\\uc77c\\uc2dc", "\\uad6c\\ubd84", "\\uac70\\ub798\\uae08\\uc561", "\\uac70\\ub798 \\ud6c4 \\uc794\\uc561", "\\uac70\\ub798\\uad6c\\ubd84", "\\ub0b4\\uc6a9", "\\uba54\\ubaa8"])',
    `s.append(["${incomeDate}", "\\uc785\\uae08", 450000, 900000, "\\uc77c\\ubc18\\uc785\\uae08", "\\uae09\\uc5ec", "\\ud68c\\ube44"])`,
    `s.append(["${expenseDate}", "\\ucd9c\\uae08", ${expenseAmount}, ${expenseBalance}, "\\uc77c\\ubc18\\uc774\\uccb4", "\\ub3d9\\ub124\\uc2dd\\ub2f9", "\\uc2dd\\ube44"])`,
    'w.save(sys.argv[1])'
  ].join('\n');
  execFileSync('python', ['-c', script, filePath], { cwd: root });
}

function createInvalidWorkbook(filePath) {
  const script = [
    'from openpyxl import Workbook',
    'import sys',
    'w = Workbook()',
    'w.active.append(["not a transaction column", "value"])',
    'w.save(sys.argv[1])'
  ].join('\n');
  execFileSync('python', ['-c', script, filePath], { cwd: root });
}

test('authenticated user can import, deduplicate, edit, and analyze real transactions', { timeout: 60000 }, async t => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'binksalad-e2e-'));
  const dataDirectory = path.join(temporaryDirectory, 'data');
  mkdirSync(dataDirectory, { recursive: true });
  const legacyDatabase = new Database(path.join(dataDirectory, 'binksalad.sqlite'));
  legacyDatabase.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  legacyDatabase.close();
  const port = await unusedPort();
  const server = spawn(process.execPath, ['server/index.js', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: root,
    env: {
      ...process.env,
      BINKSALAD_DATA_DIR: path.join(temporaryDirectory, 'data'),
      BINKSALAD_CREDENTIAL_KEY_FILE: path.join(temporaryDirectory, 'credentials.key')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverOutput = '';
  server.stdout.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });
  server.stderr.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill();
      await new Promise(resolve => server.once('exit', resolve));
    }
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  assert.equal(ready, true, `API server did not start: ${serverOutput}`);

  const unauthenticated = await fetch(`${origin}/api/dashboard?month=2026-08`);
  assert.equal(unauthenticated.status, 401);

  const setupResponse = await fetch(`${origin}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ password: 'a-secure-local-test-password' })
  });
  assert.equal(setupResponse.status, 201);
  assert.match(setupResponse.headers.get('set-cookie'), /;\s*secure/i);
  const setup = await setupResponse.json();
  const cookie = setupResponse.headers.get('set-cookie').split(';')[0];

  async function request(url, options = {}) {
    let response;
    try {
      response = await fetch(`${origin}${url}`, {
        ...options,
        headers: {
          cookie,
          ...(options.body instanceof FormData ? { Connection: 'close' } : {}),
          ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
          ...(options.method && options.method !== 'GET' ? { 'X-CSRF-Token': setup.csrfToken } : {}),
          ...options.headers
        },
        body: options.body instanceof FormData ? options.body :
          options.body ? JSON.stringify(options.body) : undefined
      });
    } catch (error) {
      throw new Error(`Request ${options.method || 'GET'} ${url} failed. API output: ${serverOutput}`, { cause: error });
    }
    const result = response.status === 204 ? null : await response.json();
    return { response, result };
  }

  async function requestWithSession(sessionCookie, csrfToken, url, options = {}) {
    let response;
    try {
      response = await fetch(`${origin}${url}`, {
        ...options,
        headers: {
          cookie: sessionCookie,
          ...(options.body instanceof FormData ? { Connection: 'close' } : {}),
          ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
          ...(options.method && options.method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {}),
          ...options.headers
        },
        body: options.body instanceof FormData ? options.body :
          options.body ? JSON.stringify(options.body) : undefined
      });
    } catch (error) {
      throw new Error(`Request ${options.method || 'GET'} ${url} failed. API output: ${serverOutput}`, { cause: error });
    }
    const result = response.status === 204 ? null : await response.json();
    return { response, result };
  }

  const accountResponse = await request('/api/accounts', {
    method: 'POST',
    body: { name: '공용 생활비', accountNumberSuffix: '1234' }
  });
  assert.equal(accountResponse.response.status, 201);
  const accountId = accountResponse.result.id;

  const created = await request('/api/transactions', {
    method: 'POST',
    body: {
      transactionDate: '2026-08-04T09:00:00',
      description: '수동 수입',
      amount: 1000,
      category: '회비',
      accountId
    }
  });
  assert.equal(created.response.status, 201);

  const kakaoStatus = await request('/api/auth/kakao/status');
  assert.deepEqual(kakaoStatus.result, { configured: false, connected: false, nickname: null });
  const kakaoLink = await request('/api/auth/kakao/link', { method: 'POST' });
  assert.equal(kakaoLink.response.status, 503);
  const kakaoLogin = await fetch(`${origin}/api/auth/kakao/login`, { redirect: 'manual' });
  assert.equal(kakaoLogin.status, 303);
  assert.equal(kakaoLogin.headers.get('location'), '/?kakao=not-configured');

  const workbookPath = path.join(temporaryDirectory, 'statement.xlsx');
  createWorkbook(workbookPath);
  const workbook = readFileSync(workbookPath);
  const form = new FormData();
  form.set('file', new Blob([workbook], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'statement.xlsx');
  form.set('rememberPassword', 'true');
  form.set('password', 'not-used-for-this-unencrypted-test');
  form.set('accountId', accountId);

  const previewResult = await request('/api/import/preview', { method: 'POST', body: form });
  assert.equal(previewResult.response.status, 200, JSON.stringify(previewResult.result));
  assert.deepEqual(previewResult.result.counts, { parsed: 2, duplicates: 0, invalid: 0 });
  assert.equal(previewResult.result.transactions[1].category, '식비');

  const imported = await request('/api/import/confirm', {
    method: 'POST',
    body: {
      previewId: previewResult.result.previewId,
      edits: previewResult.result.transactions.map(row => ({
        index: row.index,
        description: row.description,
        category: row.description === '동네식당' ? '외식' : row.category
      }))
    }
  });
  assert.equal(imported.response.status, 201);
  assert.equal(imported.result.imported, 2);

  const followupPath = path.join(temporaryDirectory, 'followup.xlsx');
  createWorkbook(followupPath, {
    incomeDate: '2026.09.02 10:30:00',
    expenseDate: '2026.09.03 12:10:00',
    expenseAmount: -3000,
    expenseBalance: 884500
  });
  const followupForm = new FormData();
  followupForm.set('file', new Blob([readFileSync(followupPath)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'followup.xlsx');
  followupForm.set('accountId', accountId);
  const followupPreview = await request('/api/import/preview', { method: 'POST', body: followupForm });
  assert.equal(followupPreview.result.transactions.find(row => row.description === '동네식당').category, '외식');

  const duplicateForm = new FormData();
  duplicateForm.set('file', new Blob([workbook], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'statement-again.xlsx');
  duplicateForm.set('accountId', accountId);
  const duplicatePreview = await request('/api/import/preview', { method: 'POST', body: duplicateForm });
  assert.deepEqual(duplicatePreview.result.counts, { parsed: 2, duplicates: 2, invalid: 0 });

  const secondAccount = await request('/api/accounts', {
    method: 'POST',
    body: { name: '개인 입출금' }
  });
  assert.equal(secondAccount.response.status, 201);
  const secondAccountForm = new FormData();
  secondAccountForm.set('file', new Blob([workbook], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'other-account.xlsx');
  secondAccountForm.set('accountId', secondAccount.result.id);
  const secondAccountPreview = await request('/api/import/preview', { method: 'POST', body: secondAccountForm });
  assert.deepEqual(secondAccountPreview.result.counts, { parsed: 2, duplicates: 0, invalid: 0 });
  await request(`/api/accounts/${secondAccount.result.id}`, { method: 'DELETE' });

  const duplicateImport = await request('/api/import/confirm', {
    method: 'POST',
    body: { previewId: duplicatePreview.result.previewId, edits: [] }
  });
  assert.equal(duplicateImport.result.imported, 0);
  assert.equal(duplicateImport.result.duplicates, 2);

  const dashboard = await request('/api/dashboard?month=2026-08');
  assert.equal(dashboard.result.totals.income, 451000);
  assert.equal(dashboard.result.totals.expenses, 12500);
  assert.equal(dashboard.result.totals.netSavings, 438500);
  assert.equal(dashboard.result.categories.find(category => category.name === '외식').amount, 12500);
  assert.equal(dashboard.result.latestImport.transactionCount, 0);

  const transactionList = await request('/api/transactions?month=2026-08&search=동네식당');
  assert.equal(transactionList.result.total, 1);
  const expense = transactionList.result.transactions[0];
  assert.equal(expense.accountId, accountId);
  assert.equal(expense.accountName, '공용 생활비');
  assert.equal(expense.categoryManual, 1);
  assert.equal(expense.category, '외식');
  const edited = await request(`/api/transactions/${expense.id}`, {
    method: 'PATCH',
    body: { description: '동네식당', category: '생활' }
  });
  assert.equal(edited.response.status, 200);
  const audit = await request(`/api/transactions/${expense.id}/audit`);
  assert.equal(audit.result.length, 2);
  assert.equal(audit.result.some(entry => entry.action === 'update'), true);

  const laterPath = path.join(temporaryDirectory, 'later.xlsx');
  createWorkbook(laterPath, {
    incomeDate: '2026.10.02 10:30:00',
    expenseDate: '2026.10.03 12:10:00',
    expenseAmount: -3000,
    expenseBalance: 881500
  });
  const laterForm = new FormData();
  laterForm.set('file', new Blob([readFileSync(laterPath)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'later.xlsx');
  laterForm.set('accountId', accountId);
  const laterPreview = await request('/api/import/preview', { method: 'POST', body: laterForm });
  assert.equal(laterPreview.result.transactions.find(row => row.description === '동네식당').category, '생활');

  const invalidPath = path.join(temporaryDirectory, 'invalid.xlsx');
  createInvalidWorkbook(invalidPath);
  const invalidForm = new FormData();
  invalidForm.set('file', new Blob([readFileSync(invalidPath)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'invalid.xlsx');
  invalidForm.set('accountId', accountId);
  const invalidPreview = await request('/api/import/preview', { method: 'POST', body: invalidForm });
  assert.equal(invalidPreview.response.status, 422);
  assert.match(invalidPreview.result.error, /거래 내역 열을 찾지 못했습니다/);

  const credentialStatus = await request('/api/credentials');
  assert.equal(credentialStatus.result.saved, true);
  const imports = await request('/api/imports');
  assert.equal(imports.result.length, 3);
  assert.equal(imports.result.every(item => item.accountName === '공용 생활비'), true);
  assert.equal(imports.result.some(item => item.status === 'failed' && item.fileName === 'invalid.xlsx'), true);
  assert.equal(imports.result.some(item => item.duplicateCount === 2), true);
  const notifications = await request('/api/notifications');
  assert.equal(notifications.result.length, 1);
  await request(`/api/notifications/${notifications.result[0].id}/read`, { method: 'PATCH' });
  assert.equal((await request('/api/notifications')).result[0].isRead, 1);
  await request('/api/credentials', { method: 'DELETE' });
  assert.equal((await request('/api/credentials')).result.saved, false);
  const emptyMonth = await request('/api/dashboard?month=2026-07');
  assert.equal(emptyMonth.result.totals.income, 0);
  assert.equal(emptyMonth.result.insights.length, 0);

  const ownerHousehold = await request('/api/household');
  const standaloneSignup = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'personal-user', password: 'a-secure-personal-password' })
  });
  assert.equal(standaloneSignup.status, 201);
  const standaloneAccount = await standaloneSignup.json();
  const standaloneCookie = standaloneSignup.headers.get('set-cookie').split(';')[0];
  const standaloneHousehold = await requestWithSession(standaloneCookie, standaloneAccount.csrfToken, '/api/household');
  assert.equal(standaloneHousehold.result.type, 'personal');
  assert.notEqual(standaloneHousehold.result.id, ownerHousehold.result.id);
  assert.equal((await requestWithSession(standaloneCookie, standaloneAccount.csrfToken, '/api/transactions')).result.total, 0);

  const viewerInvite = await request('/api/household/invitations', {
    method: 'POST',
    body: { permission: 'view' }
  });
  assert.equal(viewerInvite.response.status, 201);
  const viewerToken = new URL(viewerInvite.result.inviteUrl, origin).searchParams.get('invite');
  const viewerSignup = await fetch(`${origin}/api/invitations/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: viewerToken, username: 'ledger-viewer', password: 'a-secure-viewer-password' })
  });
  assert.equal(viewerSignup.status, 201);
  const viewerAccount = await viewerSignup.json();
  const viewerCookie = viewerSignup.headers.get('set-cookie').split(';')[0];
  const viewerDashboard = await requestWithSession(viewerCookie, viewerAccount.csrfToken, '/api/dashboard?month=2026-08');
  assert.equal(viewerDashboard.result.totals.income, 451000);
  assert.equal((await requestWithSession(viewerCookie, viewerAccount.csrfToken, '/api/household')).result.type, 'shared');
  assert.equal((await requestWithSession(viewerCookie, viewerAccount.csrfToken, '/api/transactions?month=2026-08&search=동네식당')).result.total, 1);
  const viewerWrite = await requestWithSession(viewerCookie, viewerAccount.csrfToken, '/api/transactions', {
    method: 'POST',
    body: {
      transactionDate: '2026-08-05T09:00:00',
      description: 'viewer write attempt',
      amount: -100,
      accountId
    }
  });
  assert.equal(viewerWrite.response.status, 403);
  const viewerUploadForm = new FormData();
  viewerUploadForm.set('file', new Blob(['blocked']), 'blocked.xlsx');
  viewerUploadForm.set('accountId', accountId);
  assert.equal((await requestWithSession(viewerCookie, viewerAccount.csrfToken, '/api/import/preview', {
    method: 'POST',
    body: viewerUploadForm
  })).response.status, 403);
  assert.equal((await requestWithSession(viewerCookie, viewerAccount.csrfToken, '/api/credentials', {
    method: 'DELETE'
  })).response.status, 403);
  await requestWithSession(viewerCookie, viewerAccount.csrfToken, '/api/auth/logout', { method: 'POST' });
  const viewerLogin = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ledger-viewer', password: 'a-secure-viewer-password' })
  });
  assert.equal(viewerLogin.status, 200);

  const editorInvite = await request('/api/household/invitations', {
    method: 'POST',
    body: { permission: 'edit' }
  });
  assert.equal(editorInvite.response.status, 201);
  const editorToken = new URL(editorInvite.result.inviteUrl, origin).searchParams.get('invite');
  const editorSignup = await fetch(`${origin}/api/invitations/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: editorToken, username: 'ledger-editor', password: 'a-secure-editor-password' })
  });
  assert.equal(editorSignup.status, 201);
  const editorAccount = await editorSignup.json();
  const editorCookie = editorSignup.headers.get('set-cookie').split(';')[0];
  const editorWrite = await requestWithSession(editorCookie, editorAccount.csrfToken, '/api/transactions', {
    method: 'POST',
    body: {
      transactionDate: '2026-08-05T09:00:00',
      description: '공용 거래',
      amount: -100,
      accountId
    }
  });
  assert.equal(editorWrite.response.status, 201);
  assert.equal((await request('/api/household/members')).result.length, 3);

  const failedSetup = await fetch(`${origin}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'another-secure-password' })
  });
  assert.equal(failedSetup.status, 409);

  const savedPassword = readFileSync(path.join(temporaryDirectory, 'data', 'binksalad.sqlite'));
  assert.equal(savedPassword.includes(Buffer.from('not-used-for-this-unencrypted-test')), false);

  await request('/api/auth/logout', { method: 'POST' });
  assert.equal((await request('/api/dashboard?month=2026-08')).response.status, 401);
  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'a-secure-local-test-password' })
  });
  assert.equal(login.status, 200);
});
