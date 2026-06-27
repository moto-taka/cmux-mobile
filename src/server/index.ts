import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebSocket from '@fastify/websocket';
import { CmuxSocketClient, resolveCmuxSocketPath, type MobileReplay } from './cmux-socket.js';
import crypto from 'crypto';
import type { ServerConfig, Workspace, ServerMessage, ClientMessage } from '../shared/types.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import qrcode from 'qrcode-terminal';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLIENT_DIR = join(__dirname, '..', 'client');
const STATE_DIR = join(os.homedir(), '.local/state/cmux-mobile');

// Persist the access token so the phone URL stays stable across restarts —
// essential once the server runs in the background (you bookmark it once).
function loadOrCreateToken(): string {
  const tokenPath = join(STATE_DIR, 'token');
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // none yet
  }
  const token = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  } catch {
    // state dir not writable — fall back to an ephemeral token
  }
  return token;
}

// Resolve cloudflared by absolute path. When launched from the .app, the server
// runs with a minimal PATH (/usr/bin:/bin) that omits Homebrew, so `cloudflared`
// alone would not be found.
function findCloudflared(): string {
  const candidates = [
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  return 'cloudflared'; // last resort: rely on PATH
}

export async function createServer(config: Partial<ServerConfig> = {}) {
  const fullConfig: ServerConfig = {
    port: config.port ?? 3456,
    host: config.host ?? '0.0.0.0',
    socketPath: config.socketPath ?? resolveCmuxSocketPath(),
    ttydBasePort: config.ttydBasePort ?? 9001,
    tunnel: config.tunnel ?? true,
  };

  const accessToken = loadOrCreateToken();

  const cmux = new CmuxSocketClient({ socketPath: fullConfig.socketPath });
  const clients = new Map<string, { socket: any; clientId: string; currentWorkspaceId: string | null; currentSurfaceId: string | null }>();
  let workspaces: Workspace[] = [];

  // ─── Fastify Setup ───

  const fastify = Fastify({ logger: false });

  await fastify.register(fastifyWebSocket);
  await fastify.register(fastifyStatic, {
    root: CLIENT_DIR,
    prefix: '/',
  });

  // ─── Token Auth Helper ───

  function isLocalRequest(req: any): boolean {
    const remote = req.ip ?? req.socket?.remoteAddress ?? '';
    return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  }

  function validateToken(req: any): boolean {
    if (isLocalRequest(req)) return true;
    const token = (req.query as any)?.token ?? req.headers['x-cmux-token'];
    return token === accessToken;
  }

  // ─── REST Auth Hook ───

  fastify.addHook('onRequest', async (req, reply) => {
    if (req.url === '/' || req.url.startsWith('/?token=')) return;
    if (req.url.startsWith('/app.js') || req.url.startsWith('/styles/') || req.url.startsWith('/sw.js') || req.url.startsWith('/manifest.json')) return;
    if (req.url.startsWith('/api/') && !isLocalRequest(req)) {
      if (!validateToken(req)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }
    }
  });

  // ─── Broadcast ───

  function broadcast(message: ServerMessage, excludeClientId?: string) {
    const data = JSON.stringify(message);
    for (const [id, client] of clients) {
      if (id === excludeClientId) continue;
      try {
        if (client.socket.readyState === 1) {
          client.socket.send(data);
        }
      } catch {
        clients.delete(id);
      }
    }
  }

  // ─── WebSocket (control channel) ───

  fastify.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, (socket, req) => {
      if (!isLocalRequest(req) && !validateToken(req)) {
        socket.send(JSON.stringify({ type: 'error', data: 'Unauthorized: invalid token' }));
        socket.close();
        return;
      }

      const clientId = crypto.randomUUID();
      clients.set(clientId, {
        socket,
        clientId,
        currentWorkspaceId: null,
        currentSurfaceId: null,
      });

      socket.send(JSON.stringify({
        type: 'connected',
        data: { port: fullConfig.port, ttydBasePort: fullConfig.ttydBasePort, clientId },
      }));

      if (workspaces.length > 0) {
        socket.send(JSON.stringify({ type: 'workspaces', data: workspaces }));
      }

      for (const [id, client] of clients) {
        if (id === clientId) continue;
        if (client.currentWorkspaceId) {
          socket.send(JSON.stringify({
            type: 'active_view_change',
            data: { clientId: client.clientId, workspaceId: client.currentWorkspaceId, surfaceId: client.currentSurfaceId },
          }));
        }
      }

      socket.on('message', async (raw: any) => {
        try {
          const msg: ClientMessage = JSON.parse(raw.toString());
          await handleClientMessage(msg, clientId);
        } catch (err) {
          socket.send(JSON.stringify({ type: 'error', data: String(err) }));
        }
      });

      socket.on('close', () => {
        stopTerminalStream(clientId);
        clients.delete(clientId);
        broadcast({ type: 'active_view_change', data: { clientId, workspaceId: null, surfaceId: null } });
      });
    });
  });

  // ─── Terminal Mirror (cmux capture-pane → browser) ───

  type TerminalStream = {
    interval: ReturnType<typeof setInterval>;
    // The last frame message we broadcast. We dedupe on CONTENT, not on the
    // replay `seq`: over the local control socket (no data-plane subscriber)
    // the byte-tee seq stays 0, so seq-based dedupe would freeze the mirror
    // after the first frame.
    lastFrame: string;
    viewers: Set<string>;
    workspaceId: string;
    surfaceId: string | null;
    poking: boolean;
  };
  const terminalStreams = new Map<string, TerminalStream>();

  // Turn a replay response into the WS frame message, or null if it had no
  // renderable content.
  function buildFrameMessage(stream: TerminalStream, res: MobileReplay | null): string | null {
    if (!res) return null;
    const data: Record<string, unknown> = {
      workspaceId: stream.workspaceId,
      surfaceId: stream.surfaceId,
      seq: String(res.seq ?? ''),
      columns: res.columns,
      rows: res.rows,
    };
    if (res.render_grid) data.renderGrid = res.render_grid;
    else if (res.snapshot_data_b64) data.vtBase64 = res.snapshot_data_b64;
    else if (res.data_b64) data.vtBase64 = res.data_b64;
    else return null;
    return JSON.stringify({ type: 'terminal_frame', data });
  }

  // Poll the surface's render-grid and push to viewers only when the rendered
  // content changed (an idle terminal yields an identical frame → no send).
  async function replayAndBroadcast(stream: TerminalStream) {
    const res = await cmux.replayTerminal(stream.workspaceId, stream.surfaceId);
    if (!res) return;
    const msg = buildFrameMessage(stream, res);
    if (!msg || msg === stream.lastFrame) return;
    stream.lastFrame = msg;
    for (const viewerId of stream.viewers) {
      const client = clients.get(viewerId);
      if (client?.socket.readyState === 1) client.socket.send(msg);
    }
  }

  // After a viewer sends input, replay immediately instead of waiting for the
  // next tick — this is what makes typing feel responsive. The `poking` flag
  // throttles bursts of keystrokes to one in-flight replay at a time.
  function pokeTerminalStream(viewerClientId: string) {
    const client = clients.get(viewerClientId);
    if (!client) return;
    const key = (client as any).__terminalStreamKey;
    if (!key) return;
    const stream = terminalStreams.get(key);
    if (!stream || stream.poking) return;
    stream.poking = true;
    // Give cmux a beat to apply the input, then replay.
    setTimeout(() => {
      replayAndBroadcast(stream).catch(() => {}).finally(() => { stream.poking = false; });
    }, 40);
  }

  function startTerminalStream(viewerClientId: string, workspaceId: string, surfaceId: string | null) {
    const key = `${workspaceId}:${surfaceId ?? 'active'}`;

    let stream = terminalStreams.get(key);
    if (!stream) {
      const created: TerminalStream = {
        interval: setInterval(() => {
          replayAndBroadcast(created).catch(() => {});
        }, 300),
        lastFrame: '',
        viewers: new Set(),
        workspaceId,
        surfaceId,
        poking: false,
      };
      stream = created;
      terminalStreams.set(key, stream);
    }

    stream.viewers.add(viewerClientId);

    // Send the current frame to the (possibly new) viewer immediately.
    const attached = stream;
    cmux.replayTerminal(workspaceId, surfaceId).then((res) => {
      const client = clients.get(viewerClientId);
      if (!client || client.socket.readyState !== 1) return;
      client.socket.send(JSON.stringify({ type: 'terminal_attached', data: { workspaceId, surfaceId } }));
      const msg = buildFrameMessage(attached, res);
      if (msg) {
        attached.lastFrame = msg;
        client.socket.send(msg);
      }
    }).catch(() => {});

    const client = clients.get(viewerClientId);
    if (client) {
      (client as any).__terminalStreamKey = key;
    }
  }

  function stopTerminalStream(viewerClientId: string) {
    const client = clients.get(viewerClientId);
    if (!client) return;
    const key = (client as any).__terminalStreamKey;
    if (!key) return;
    (client as any).__terminalStreamKey = null;

    const stream = terminalStreams.get(key);
    if (stream) {
      stream.viewers.delete(viewerClientId);
      if (stream.viewers.size === 0) {
        clearInterval(stream.interval);
        terminalStreams.delete(key);
      }
    }
  }

  // ─── Client message handler ───

  async function handleClientMessage(msg: ClientMessage, clientId: string) {
    switch (msg.type) {
      case 'select_workspace': {
        const { workspaceId } = msg.data as { workspaceId: string };
        await cmux.selectWorkspace(workspaceId);
        break;
      }
      case 'select_surface': {
        const { surfaceId } = msg.data as { surfaceId: string };
        await cmux.focusSurface(surfaceId);
        break;
      }
      case 'send_text': {
        const { surfaceId, text } = msg.data as { surfaceId: string; text: string };
        await cmux.sendText(surfaceId, text);
        break;
      }
      case 'send_key': {
        const { surfaceId, key } = msg.data as { surfaceId: string; key: string };
        await cmux.sendKey(surfaceId, key);
        break;
      }
      case 'refresh': {
        await refreshWorkspaces();
        break;
      }
      case 'view_changed': {
        const { workspaceId, surfaceId } = msg.data as { workspaceId: string | null; surfaceId: string | null };
        const client = clients.get(clientId);
        if (client) {
          client.currentWorkspaceId = workspaceId;
          client.currentSurfaceId = surfaceId ?? null;
        }
        broadcast(
          { type: 'active_view_change', data: { clientId, workspaceId: workspaceId ?? null, surfaceId: surfaceId ?? null } },
          clientId,
        );
        break;
      }
      case 'terminal_attach': {
        const { workspaceId, surfaceId } = msg.data as { workspaceId: string; surfaceId: string | null };
        startTerminalStream(clientId, workspaceId, surfaceId);
        break;
      }
      case 'terminal_detach': {
        stopTerminalStream(clientId);
        break;
      }
      case 'terminal_input': {
        const { surfaceId, data } = msg.data as { surfaceId: string | null; data: string };
        if (data) {
          // mobile.terminal.input (text only — never carries a viewport report,
          // which would shrink the user's live desktop terminal).
          await cmux.sendMobileInput(surfaceId ?? null, data);
          pokeTerminalStream(clientId);
        }
        break;
      }
    }
  }

  // ─── Workspace refresh ───

  async function refreshWorkspaces() {
    try {
      workspaces = await cmux.listWorkspaces() as Workspace[];
      broadcast({ type: 'workspaces', data: workspaces });
    } catch {
      // cmux not available — will retry on next poll
    }
  }

  // Listen for cmux polling updates
  cmux.on('workspace_changed', (wsList: unknown) => {
    workspaces = (wsList as Workspace[]) ?? [];
    broadcast({ type: 'workspaces', data: workspaces });
  });

  // ─── REST API ───

  fastify.get('/api/health', async () => ({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    workspaces: workspaces.length,
    cmux: cmux.isConnected,
  }));

  fastify.get('/api/workspaces', async () => workspaces);

  fastify.post('/api/workspaces/:id/select', async (req) => {
    await cmux.selectWorkspace((req.params as { id: string }).id);
    return { ok: true };
  });

  fastify.post('/api/surfaces/:id/focus', async (req) => {
    await cmux.focusSurface((req.params as { id: string }).id);
    return { ok: true };
  });

  // SPA fallback
  fastify.setNotFoundHandler((_req, reply) => {
    return reply.type('text/html').sendFile('index.html');
  });

  // ─── Startup ───

  console.log('\n🚀 cmux-mobile starting...\n');
  console.log(`   Socket: ${fullConfig.socketPath}`);
  console.log(`   Port:   ${fullConfig.port}`);
  if (fullConfig.tunnel) {
    console.log(`   Tunnel: Cloudflare`);
  }
  console.log(`   Token:  ${accessToken}\n`);

  try {
    await cmux.connect();
    console.log('   ✓ Connected to cmux socket');
  } catch {
    console.error('   ✗ Could not connect to cmux socket');
    console.error('     Make sure cmux is running and socket is enabled');
    console.error('     Socket path:', fullConfig.socketPath);
  }

  await refreshWorkspaces();

  if (workspaces.length > 0) {
    console.log(`   ✓ ${workspaces.length} workspaces found:`);
    for (const ws of workspaces) {
      const branch = ws.git_branch ? ` (${ws.git_branch})` : '';
      console.log(`     - ${ws.name}${branch}`);
    }
  } else {
    console.log('   ⚠ No workspaces found');
  }

  await fastify.listen({ port: fullConfig.port, host: fullConfig.host });

  // Show access URLs
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const iface of Object.values(nets)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }

  // Persist access info so `cmux-mobile url`/`qr` (and background launchers) can
  // surface the URL without scraping stdout. Embeds the token, so it is a
  // credential file — write owner-only (0600) in an owner-only dir (0700).
  // Rewritten once the Cloudflare tunnel URL is known (see below).
  const persistAccess = (tunnelUrl: string | null) => {
    try {
      const accessPath = join(STATE_DIR, 'access.json');
      fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
      fs.chmodSync(STATE_DIR, 0o700); // tighten even a pre-existing looser dir
      fs.writeFileSync(accessPath, JSON.stringify({
        token: accessToken,
        port: fullConfig.port,
        pid: process.pid,
        tunnel: tunnelUrl,
        local: `http://localhost:${fullConfig.port}?token=${accessToken}`,
        urls: ips.map((ip) => `http://${ip}:${fullConfig.port}?token=${accessToken}`),
      }, null, 2), { mode: 0o600 });
      // mode on writeFileSync only applies on creation — enforce 0600 even if an
      // older, looser-permissioned file already existed.
      fs.chmodSync(accessPath, 0o600);
    } catch {
      // non-fatal
    }
  };
  persistAccess(null);

  console.log('\n📱 Access from your phone (same network):');
  for (const ip of ips) {
    const url = `http://${ip}:${fullConfig.port}?token=${accessToken}`;
    console.log(`   ${url}`);
    console.log();
    qrcode.generate(url, { small: true }, (qr: string) => {
      console.log(qr);
    });
    console.log();
  }
  console.log(`   Local: http://localhost:${fullConfig.port}\n`);

  // ─── Tunnel (Cloudflare quick tunnel) ───
  //
  // Spawn `cloudflared tunnel --url ...`, which prints a https://<random>.
  // trycloudflare.com URL (no account needed). We scan its output for that URL,
  // append the token, persist it to access.json (so `qr`/`url` use the PUBLIC
  // URL, not the LAN IP), and print a QR.

  let cfproc: ReturnType<typeof spawn> | null = null;

  if (fullConfig.tunnel) {
    try {
      cfproc = spawn(
        findCloudflared(),
        ['tunnel', '--url', `http://localhost:${fullConfig.port}`, '--no-autoupdate'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let announced = false;
      const scan = (buf: Buffer) => {
        const match = buf.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match && !announced) {
          announced = true;
          const tunnelUrl = `${match[0]}?token=${accessToken}`;
          persistAccess(tunnelUrl);
          console.log('\n🌐 Access from anywhere (Cloudflare tunnel):');
          console.log(`   ${tunnelUrl}\n`);
          qrcode.generate(tunnelUrl, { small: true }, (qr: string) => console.log(qr));
          console.log('   ⚠  Anyone with this URL + token can reach your terminals.\n');
        }
      };
      cfproc.stdout?.on('data', scan);
      cfproc.stderr?.on('data', scan); // cloudflared prints the URL on stderr
      cfproc.on('error', (err: Error) => {
        console.error('[cmux-mobile] cloudflared failed (install it: `brew install cloudflared`):', err.message);
      });
      cfproc.on('exit', (code: number | null) => {
        if (code) console.error(`[cmux-mobile] cloudflared exited with code ${code}`);
      });
    } catch (err) {
      console.error('[cmux-mobile] Failed to start cloudflared:', err);
    }
  }

  // ─── Graceful shutdown ───

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down...');
    try {
      cmux.disconnect();
      if (cfproc) cfproc.kill();
      await fastify.close();
    } catch (err) {
      console.error('Error during shutdown:', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.on('unhandledRejection', (reason) => {
    console.error('[cmux-mobile] Unhandled rejection:', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('[cmux-mobile] Unhandled exception:', err);
    shutdown();
  });

  return fastify;
}

// Direct execution support (tsx dev or node dist)
const args = process.argv.slice(2);
if (args[0] === 'start') {
  createServer().catch(console.error);
}
