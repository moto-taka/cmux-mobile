import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebSocket from '@fastify/websocket';
import { CmuxSocketClient } from './cmux-socket.js';
import { TtydManager } from './ttyd-manager.js';
import crypto from 'crypto';
import type { ServerConfig, Workspace, ServerMessage, ClientMessage } from '../shared/types.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';
import proxy from '@fastify/http-proxy';
import qrcode from 'qrcode-terminal';
import localtunnel from 'localtunnel';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLIENT_DIR = join(__dirname, '..', 'client');

export async function createServer(config: Partial<ServerConfig> = {}) {
  const fullConfig: ServerConfig = {
    port: config.port ?? 3456,
    host: config.host ?? '0.0.0.0',
    socketPath: config.socketPath ?? process.env.CMUX_SOCKET_PATH ?? '/tmp/cmux.sock',
    ttydBasePort: config.ttydBasePort ?? 9001,
    tunnel: config.tunnel ?? true,
  };

  const accessToken = crypto.randomBytes(16).toString('hex');

  const cmux = new CmuxSocketClient({ socketPath: fullConfig.socketPath });
  const ttyd = new TtydManager(fullConfig.ttydBasePort);
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
        clients.delete(clientId);
        broadcast({ type: 'active_view_change', data: { clientId, workspaceId: null, surfaceId: null } });
      });
    });
  });

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
    }
  }

  // ─── Workspace refresh ───

  async function refreshWorkspaces() {
    try {
      const wsList: Workspace[] = await cmux.listWorkspaces() as Workspace[];

      await ttyd.syncWorkspaces(
        wsList.map((w: Workspace) => ({ id: w.id, cwd: w.cwd, name: w.name }))
      );

      workspaces = wsList.map((w: Workspace) => {
        const info = ttyd.getInfo(w.id);
        return { ...w, ttydPort: info?.port };
      });

      broadcast({ type: 'workspaces', data: workspaces });
    } catch {
      // cmux not available — will retry on next poll
    }
  }

  // Listen for cmux polling updates
  cmux.on('workspace_changed', async (wsList: unknown) => {
    const list = (wsList as Workspace[]) ?? [];

    await ttyd.syncWorkspaces(
      list.map((w) => ({ id: w.id, cwd: w.cwd, name: w.name }))
    ).catch(() => {});

    workspaces = list.map((w: Workspace) => {
      const info = ttyd.getInfo(w.id);
      return { ...w, ttydPort: info?.port };
    });

    broadcast({ type: 'workspaces', data: workspaces });
  });

  // ─── ttyd Proxy (@fastify/http-proxy) ───
  // Register one proxy per ttyd port AFTER workspaces are discovered.
  // @fastify/http-proxy handles both HTTP and WebSocket proxying.

  const registeredProxies = new Set<number>();

  function registerTtydProxy(ttydPort: number) {
    if (registeredProxies.has(ttydPort)) return;
    registeredProxies.add(ttydPort);

    fastify.register(proxy, {
      upstream: `http://localhost:${ttydPort}`,
      prefix: `/ttyd/${ttydPort}`,
      websocket: true,
      rewritePrefix: '/',
    });

    console.log(`   [proxy] /ttyd/${ttydPort} → localhost:${ttydPort}`);
  }

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
    console.log(`   Tunnel: enabled`);
  }
  console.log(`   Token:  ${accessToken}\n`);

  await ttyd.start();

  try {
    await cmux.connect();
    console.log('   ✓ Connected to cmux socket');
  } catch {
    console.error('   ✗ Could not connect to cmux socket');
    console.error('     Make sure cmux is running and socket is enabled');
    console.error('     Socket path:', fullConfig.socketPath);
  }

  await refreshWorkspaces();

  // Register ttyd proxies for discovered workspaces BEFORE listen
  for (const ws of workspaces) {
    if (ws.ttydPort) registerTtydProxy(ws.ttydPort);
  }

  if (workspaces.length > 0) {
    console.log(`   ✓ ${workspaces.length} workspaces found:`);
    for (const ws of workspaces) {
      const branch = ws.git_branch ? ` (${ws.git_branch})` : '';
      const ttydPort = ws.ttydPort ? ` → :${ws.ttydPort}` : '';
      console.log(`     - ${ws.name}${branch}${ttydPort}`);
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

  // ─── Tunnel (localtunnel) ───

  let tunnel: localtunnel.Tunnel | null = null;

  if (fullConfig.tunnel) {
    try {
      tunnel = await localtunnel({ port: fullConfig.port });
      const tunnelUrl = `${tunnel.url}?token=${accessToken}`;

      console.log('🌐 Access from anywhere (public tunnel):');
      console.log(`   ${tunnelUrl}`);
      console.log();
      qrcode.generate(tunnelUrl, { small: true }, (qr: string) => {
        console.log(qr);
      });
      console.log();
      console.log('   ⚠  Share this URL only with trusted devices.\n');

      tunnel.on('close', () => {
        console.log('[cmux-mobile] Tunnel closed');
      });

      tunnel.on('error', (err: Error) => {
        console.error('[cmux-mobile] Tunnel error:', err.message);
      });
    } catch (err) {
      console.error('[cmux-mobile] Failed to start tunnel:', err);
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
      await ttyd.stop();
      if (tunnel) tunnel.close();
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
