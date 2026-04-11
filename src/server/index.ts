import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebSocket from '@fastify/websocket';
import { CmuxSocketClient } from './cmux-socket.js';
import { TtydManager } from './ttyd-manager.js';
import type { ServerConfig, Workspace, ServerMessage, ClientMessage } from '../shared/types.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLIENT_DIR = join(__dirname, '..', 'client');

export async function createServer(config: Partial<ServerConfig> = {}) {
  const fullConfig: ServerConfig = {
    port: config.port ?? 3456,
    host: config.host ?? '0.0.0.0',
    socketPath: config.socketPath ?? process.env.CMUX_SOCKET_PATH ?? '/tmp/cmux.sock',
    ttydBasePort: config.ttydBasePort ?? 9001,
  };

  // Initialize components
  const cmux = new CmuxSocketClient({ socketPath: fullConfig.socketPath });
  const ttyd = new TtydManager(fullConfig.ttydBasePort);

  // Connected clients
  const clients = new Set<any>();

  // Current workspace state
  let workspaces: Workspace[] = [];

  // ─── Fastify Setup ───

  const fastify = Fastify({ logger: false });

  await fastify.register(fastifyWebSocket);
  await fastify.register(fastifyStatic, {
    root: CLIENT_DIR,
    prefix: '/',
  });

  // ─── Broadcast helper ───

  function broadcast(message: ServerMessage) {
    const data = JSON.stringify(message);
    for (const client of clients) {
      if ((client as any).readyState === 1) {
        client.send(data);
      }
    }
  }

  // ─── WebSocket endpoint ───

  fastify.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, (socket, _req) => {
      clients.add(socket);

      // Send current state on connect
      const connectMsg: ServerMessage = {
        type: 'connected',
        data: { port: fullConfig.port, ttydBasePort: fullConfig.ttydBasePort },
      };
      socket.send(JSON.stringify(connectMsg));

      if (workspaces.length > 0) {
        socket.send(JSON.stringify({ type: 'workspaces', data: workspaces }));
      }

      socket.on('message', async (raw: any) => {
        try {
          const msg: ClientMessage = JSON.parse(raw.toString());
          await handleClientMessage(msg);
        } catch (err) {
          socket.send(JSON.stringify({ type: 'error', data: String(err) }));
        }
      });

      socket.on('close', () => {
        clients.delete(socket);
      });
    });
  });

  // ─── Client message handler ───

  async function handleClientMessage(msg: ClientMessage) {
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
    }
  }

  // ─── Workspace refresh ───

  async function refreshWorkspaces() {
    try {
      // listWorkspaces already fetches surfaces in cmux-socket.ts
      const wsList: Workspace[] = await cmux.listWorkspaces() as Workspace[];
      workspaces = wsList;
      broadcast({ type: 'workspaces', data: workspaces });

      // Sync ttyd processes
      await ttyd.syncWorkspaces(
        wsList.map((w: Workspace) => ({ id: w.id, cwd: w.cwd, name: w.name }))
      );
    } catch {
      // cmux not available — that's ok, will retry
    }
  }

  // Listen for cmux workspace changes (pushed from polling in cmux-socket.ts)
  cmux.on('workspace_changed', (wsList: unknown) => {
    const list = (wsList as Workspace[]) ?? [];
    workspaces = list;
    broadcast({ type: 'workspaces', data: workspaces });

    // Sync ttyd
    ttyd.syncWorkspaces(
      list.map((w) => ({ id: w.id, cwd: w.cwd, name: w.name }))
    ).catch(() => {});
  });

  // ─── REST API ───

  fastify.get('/api/workspaces', async () => {
    return workspaces;
  });

  fastify.post('/api/workspaces/:id/select', async (req) => {
    const { id } = req.params as { id: string };
    await cmux.selectWorkspace(id);
    return { ok: true };
  });

  fastify.post('/api/surfaces/:id/focus', async (req) => {
    const { id } = req.params as { id: string };
    await cmux.focusSurface(id);
    return { ok: true };
  });

  // Terminal proxy — redirect to ttyd port
  fastify.get('/terminal/:workspaceId', async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const info = ttyd.getInfo(workspaceId);
    if (info) {
      const host = fullConfig.host === '0.0.0.0' ? req.hostname : fullConfig.host;
      reply.redirect(`http://${host}:${info.port}/`);
    } else {
      reply.code(404).send({ error: 'Workspace terminal not found' });
    }
  });

  // SPA fallback
  fastify.setNotFoundHandler((_req, reply) => {
    return reply.type('text/html').sendFile('index.html');
  });

  // ─── Startup ───

  console.log('\n🚀 cmux-mobile starting...\n');
  console.log(`   Socket: ${fullConfig.socketPath}`);
  console.log(`   Port:   ${fullConfig.port}`);

  // Start ttyd manager
  await ttyd.start();

  // Connect to cmux
  try {
    await cmux.connect();
    console.log('   ✓ Connected to cmux socket');
  } catch {
    console.error('   ✗ Could not connect to cmux socket');
    console.error('     Make sure cmux is running and socket is enabled');
    console.error('     Socket path:', fullConfig.socketPath);
  }

  // Initial refresh
  await refreshWorkspaces();

  // Start HTTP server
  await fastify.listen({ port: fullConfig.port, host: fullConfig.host });

  // Get network IPs for mobile access
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

  console.log('\n📱 Access from your phone:');
  for (const ip of ips) {
    console.log(`   http://${ip}:${fullConfig.port}`);
  }
  console.log(`\n   Local: http://localhost:${fullConfig.port}\n`);

  // ─── Graceful shutdown ───

  const shutdown = async () => {
    console.log('\nShutting down...');
    cmux.disconnect();
    await ttyd.stop();
    await fastify.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return fastify;
}

// Direct execution
const args = process.argv.slice(2);
if (args[0] === 'start') {
  createServer().catch(console.error);
}
