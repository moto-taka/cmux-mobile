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

  const cmux = new CmuxSocketClient({ socketPath: fullConfig.socketPath });
  const ttyd = new TtydManager(fullConfig.ttydBasePort);
  const clients = new Set<any>();
  let workspaces: Workspace[] = [];

  // ─── Fastify Setup ───

  const fastify = Fastify({ logger: false });

  await fastify.register(fastifyWebSocket);
  await fastify.register(fastifyStatic, {
    root: CLIENT_DIR,
    prefix: '/',
  });

  // ─── Broadcast ───

  function broadcast(message: ServerMessage) {
    const data = JSON.stringify(message);
    for (const client of clients) {
      if ((client as any).readyState === 1) {
        client.send(data);
      }
    }
  }

  // ─── WebSocket (control channel) ───

  fastify.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, (socket, _req) => {
      clients.add(socket);

      socket.send(JSON.stringify({
        type: 'connected',
        data: { port: fullConfig.port, ttydBasePort: fullConfig.ttydBasePort },
      }));

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
  cmux.on('workspace_changed', (wsList: unknown) => {
    const list = (wsList as Workspace[]) ?? [];
    workspaces = list;
    broadcast({ type: 'workspaces', data: workspaces });

    ttyd.syncWorkspaces(
      list.map((w) => ({ id: w.id, cwd: w.cwd, name: w.name }))
    ).catch(() => {});
  });

  // ─── REST API ───

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

  if (workspaces.length > 0) {
    console.log(`   ✓ ${workspaces.length} workspaces found:`);
    for (const ws of workspaces) {
      const info = ttyd.getInfo(ws.id);
      const branch = ws.git_branch ? ` (${ws.git_branch})` : '';
      const ttydPort = info ? ` → :${info.port}` : '';
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
