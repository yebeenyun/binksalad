import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';

const viteCli = 'node_modules/vite/bin/vite.js';
const serverFile = 'server/index.js';
const origin = 'http://127.0.0.1:4173';

if (!existsSync(viteCli)) {
  console.error('Dependencies are missing. Run "npm install" first.');
  process.exit(1);
}

const build = spawnSync(process.execPath, [viteCli, 'build'], { stdio: 'inherit' });
if (build.error) {
  console.error(`Could not run the production build: ${build.error.message}`);
  process.exit(1);
}
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const server = spawn(process.execPath, [
  serverFile, '--host', '127.0.0.1', '--port', '4173'
], { stdio: 'inherit' });

let tunnel;
let shuttingDown = false;

function stop(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (tunnel && tunnel.exitCode === null) tunnel.kill();
  if (server.exitCode === null) server.kill();
  process.exitCode = code;
}

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
server.on('error', error => {
  console.error(`Could not start the app server: ${error.message}`);
  stop(1);
});
server.on('exit', code => {
  if (!shuttingDown) {
    console.error('The app server stopped unexpectedly.');
    stop(code || 1);
  }
});

let ready = false;
let initialized = false;
for (let attempt = 0; attempt < 40; attempt += 1) {
  if (server.exitCode !== null) break;
  try {
    const response = await fetch(`${origin}/api/health`);
    if (response.ok) {
      const health = await response.json();
      ready = true;
      initialized = health.initialized;
      break;
    }
  } catch {
    await delay(500);
  }
}

if (!ready) {
  console.error('The app server did not become ready at http://127.0.0.1:4173.');
  stop(1);
} else if (!initialized) {
  console.error('Create the owner password first: run start-internal.bat and open the app on this computer.');
  stop(1);
} else {
  console.log('\nStarting a temporary public HTTPS tunnel. Anyone with the URL can reach the login screen. Press Ctrl+C to stop.\n');
  tunnel = spawn('cloudflared', ['tunnel', '--url', origin], { stdio: 'inherit' });
  tunnel.on('error', error => {
    if (error.code === 'ENOENT') {
      console.error('cloudflared was not found. Install it, then run "npm run external" again.');
    } else {
      console.error(`Could not start cloudflared: ${error.message}`);
    }
    stop(1);
  });
  tunnel.on('exit', code => {
    if (!shuttingDown) stop(code || 0);
  });
}
