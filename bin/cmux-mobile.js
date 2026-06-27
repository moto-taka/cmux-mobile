#!/usr/bin/env node
// cmux-mobile CLI — access cmux workspaces from your phone.
//
// Run it in the foreground (occupies the terminal) OR detached in the
// background (frees the terminal, survives the terminal closing):
//
//   cmux-mobile up         start in the background (LAN only by default)
//   cmux-mobile down       stop the background server
//   cmux-mobile status     is it running? show the URL
//   cmux-mobile url        print the phone URL + QR
//   cmux-mobile logs [-f]  show the server log
//   cmux-mobile start      run in the foreground (Ctrl-C to stop)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const PROJECT_ROOT = join(dirname(SELF), '..');
const SERVER_ENTRY = join(PROJECT_ROOT, 'dist', 'server', 'index.js');
const STATE_DIR = join(os.homedir(), '.local/state/cmux-mobile');
const PID_FILE = join(STATE_DIR, 'server.pid');
const ACCESS_FILE = join(STATE_DIR, 'access.json');
const LOG_FILE = process.platform === 'darwin'
  ? join(os.homedir(), 'Library/Logs/cmux-mobile.log')
  : join(STATE_DIR, 'server.log');

const args = process.argv.slice(2);
const command = args[0];

function die(msg) { console.error('Error: ' + msg); process.exit(1); }

function ensureBuilt() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    die(`build not found at ${SERVER_ENTRY}\n       Run: npm run build`);
  }
}

function parseArgs(argList) {
  const opts = { port: 3456, host: '0.0.0.0', ttydBasePort: 9001 };
  if (process.env.CMUX_SOCKET_PATH) opts.socketPath = process.env.CMUX_SOCKET_PATH;
  for (let i = 0; i < argList.length; i++) {
    switch (argList[i]) {
      case '--port': { const v = argList[++i]; if (!v || isNaN(Number(v))) die('--port requires a number'); opts.port = parseInt(v, 10); break; }
      case '--host': { const v = argList[++i]; if (!v) die('--host requires a value'); opts.host = v; break; }
      case '--socket-path': { const v = argList[++i]; if (!v) die('--socket-path requires a value'); opts.socketPath = v; break; }
      case '--ttyd-base-port': { const v = argList[++i]; if (!v || isNaN(Number(v))) die('--ttyd-base-port requires a number'); opts.ttydBasePort = parseInt(v, 10); break; }
      case '--tunnel': opts.tunnel = true; break;
      case '--no-tunnel': opts.tunnel = false; break;
      case '--help': case '-h': printHelp(); process.exit(0);
    }
  }
  return opts;
}

function readAccess() {
  try { return JSON.parse(fs.readFileSync(ACCESS_FILE, 'utf8')); } catch { return null; }
}
function readPid() {
  try { const p = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10); return Number.isInteger(p) ? p : null; } catch { return null; }
}
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForFreshAccess(timeoutMs = 6000) {
  const start = Date.now();
  let prev = 0;
  try { prev = fs.statSync(ACCESS_FILE).mtimeMs; } catch { /* none */ }
  while (Date.now() - start < timeoutMs) {
    try {
      if (fs.statSync(ACCESS_FILE).mtimeMs > prev) return readAccess();
    } catch { /* not yet */ }
    await sleep(200);
  }
  return readAccess();
}

function printUrls(a) {
  if (!a) { console.log('  (no access info yet — check the logs)'); return; }
  if (a.urls && a.urls.length) {
    console.log('  Phone (same Wi-Fi):');
    for (const u of a.urls) console.log('    ' + u);
  }
  console.log('  Local: ' + (a.local || `http://localhost:${a.port}?token=${a.token}`));
}

async function doUp() {
  ensureBuilt();
  const existing = readPid();
  if (isAlive(existing)) {
    console.log(`Already running (pid ${existing}).`);
    printUrls(readAccess());
    return;
  }
  const fwd = args.slice(1);
  // Background default: LAN only. Opt into a public tunnel with `up --tunnel`.
  if (!fwd.includes('--tunnel')) fwd.push('--no-tunnel');

  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(STATE_DIR, 0o700); } catch { /* ignore */ }
  // The log captures the server's startup banner, which prints the token/URL —
  // keep it owner-only (chmod too, since the mode arg only applies on creation).
  const out = fs.openSync(LOG_FILE, 'a', 0o600);
  try { fs.chmodSync(LOG_FILE, 0o600); } catch { /* ignore */ }
  const child = spawn(process.execPath, [SELF, 'start', ...fwd], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: PROJECT_ROOT,
  });
  child.unref();
  fs.closeSync(out);
  fs.writeFileSync(PID_FILE, String(child.pid));

  console.log(`cmux-mobile started in the background (pid ${child.pid}).`);
  printUrls(await waitForFreshAccess());
  console.log(`\n  Logs: ${LOG_FILE}`);
  console.log('  Stop: cmux-mobile down');
}

async function doDown() {
  const pid = readPid();
  if (!isAlive(pid)) {
    console.log('Not running.');
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  for (let i = 0; i < 30 && isAlive(pid); i++) await sleep(200);
  if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  console.log(`Stopped (pid ${pid}).`);
}

function printHelp() {
  console.log(`
cmux-mobile - Access cmux workspaces from your phone

Foreground:
  cmux-mobile start [options]    Run in this terminal (Ctrl-C to stop)

Background (frees the terminal):
  cmux-mobile up [options]       Start detached (LAN only by default)
  cmux-mobile down               Stop the background server
  cmux-mobile restart [options]  Restart the background server
  cmux-mobile status             Show running state + URL
  cmux-mobile url                Print the phone URL + QR code
  cmux-mobile logs [-f]          Show (or follow) the server log

Options:
  --port <n>            Server port (default: 3456)
  --host <s>            Bind host (default: 0.0.0.0)
  --socket-path <p>     cmux socket path (default: auto-detected)
  --ttyd-base-port <n>  Base port for ttyd (default: 9001)
  --tunnel              Enable the public tunnel (off by default for 'up')
  --no-tunnel           Disable the public tunnel
  --help                Show this help

State:
  token / access info   ~/.local/state/cmux-mobile/
  log                    ${LOG_FILE}
`);
}

async function main() {
  switch (command) {
    case 'start': {
      ensureBuilt();
      const opts = parseArgs(args.slice(1));
      const { createServer } = await import('../dist/server/index.js');
      await createServer(opts).catch((err) => { console.error('Failed to start cmux-mobile:', err); process.exit(1); });
      break;
    }
    case 'up':
      await doUp();
      break;
    case 'down':
      await doDown();
      break;
    case 'restart':
      await doDown();
      await sleep(500);
      await doUp();
      break;
    case 'status': {
      const pid = readPid();
      if (isAlive(pid)) { console.log(`Running (pid ${pid}).`); printUrls(readAccess()); }
      else console.log('Not running.');
      break;
    }
    case 'url': {
      const a = readAccess();
      if (!a) { console.log('No access info. Start it first:  cmux-mobile up'); break; }
      printUrls(a);
      try {
        const target = (a.urls && a.urls[0]) || a.local;
        const { default: qrcode } = await import('qrcode-terminal');
        console.log('');
        qrcode.generate(target, { small: true }, (qr) => console.log(qr));
      } catch { /* qrcode unavailable — text URL is enough */ }
      break;
    }
    case 'logs': {
      console.log(LOG_FILE + '\n');
      if (args.includes('-f')) {
        spawn('tail', ['-f', LOG_FILE], { stdio: 'inherit' });
      } else {
        try { console.log(fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-40).join('\n')); }
        catch { console.log('(no log yet)'); }
      }
      break;
    }
    case '--help': case '-h': case undefined:
      printHelp();
      break;
    default:
      printHelp();
      process.exit(1);
  }
}

main();
