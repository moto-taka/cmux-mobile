import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebSocket from '@fastify/websocket';
import { CmuxSocketClient } from './cmux-socket.js';
import { TtydManager } from './ttyd-manager.js';
import type { ServerConfig, Workspace, ServerMessage, ClientMessage } from '../shared/types.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';
import http from 'node:http';

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

  // ─── ttyd WebSocket proxy ───
  // Proxy WebSocket connections from /terminal/:workspaceId/ws to ttyd's WS
  fastify.register(async function (fastify) {
    fastify.get('/terminal/:workspaceId/ws', { websocket: true }, async (socket, req) => {
      const { workspaceId } = req.params as { workspaceId: string };
      const info = ttyd.getInfo(workspaceId);
      if (!info) {
        socket.close(404, 'Workspace not found');
        return;
      }

      // Connect to ttyd's WebSocket
      const ttydWsUrl = `ws://127.0.0.1:${info.port}/ws`;
      const { default: WebSocket } = await import('ws');
      const ttydSocket = new WebSocket(ttydWsUrl);

      // Bidirectional proxy
      ttydSocket.on('open', () => {
        socket.on('message', (msg: any) => {
          if (ttydSocket.readyState === 1) {
            ttydSocket.send(msg);
          }
        });
      });

      ttydSocket.on('message', (msg: any) => {
        if (socket.readyState === 1) {
          socket.send(msg);
        }
      });

      ttydSocket.on('close', (code: number, reason: Buffer) => {
        if (socket.readyState === 1) {
          socket.close(code, reason);
        }
      });

      socket.on('close', () => {
        if (ttydSocket.readyState === 1) {
          ttydSocket.close();
        }
      });

      ttydSocket.on('error', () => {
        socket.close(1011, 'ttyd connection failed');
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

      // Sync ttyd processes
      await ttyd.syncWorkspaces(
        wsList.map((w: Workspace) => ({ id: w.id, cwd: w.cwd, name: w.name }))
      );

      // Enrich with ttyd port info
      workspaces = wsList.map((w: Workspace) => {
        const info = ttyd.getInfo(w.id);
        return { ...w, ttydPort: info?.port };
      });

      broadcast({ type: 'workspaces', data: workspaces });
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

  // Terminal proxy — proxy HTTP and WS to ttyd process
  // All requests go through port 3456 so mobile browsers don't need to access other ports
  fastify.all('/terminal/:workspaceId/*', async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const wildcard = (req.params as any)['*'] || '';
    const info = ttyd.getInfo(workspaceId);
    if (!info) {
      reply.code(404).send({ error: 'Workspace terminal not found' });
      return;
    }

    const targetUrl = `http://127.0.0.1:${info.port}/${wildcard}`;
    proxyRequest(req, reply, targetUrl);
  });

  // Terminal root endpoint
  fastify.get('/terminal/:workspaceId', async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const info = ttyd.getInfo(workspaceId);
    if (!info) {
      reply.code(404).send({ error: 'Workspace terminal not found' });
      return;
    }
    proxyRequest(req, reply, `http://127.0.0.1:${info.port}/`);
  });

  // ─── HTTP Proxy helper ───

  function proxyRequest(req: any, reply: any, targetUrl: string) {
    const parsedUrl = new URL(targetUrl);

    const proxyHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string' && !['host', 'connection'].includes(key.toLowerCase())) {
        proxyHeaders[key] = value;
      }
    }
    proxyHeaders['host'] = `127.0.0.1:${parsedUrl.port}`;

    const options = {
      hostname: parsedUrl.hostname,
      port: parseInt(parsedUrl.port),
      path: parsedUrl.pathname + parsedUrl.search,
      method: req.method,
      headers: proxyHeaders,
    };

    const proxyReq = http.request(options, (proxyRes) => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (typeof value === 'string') {
          // Rewrite ttyd's WebSocket URL to go through our proxy
          if (key.toLowerCase() === 'set-cookie' && value.includes('port=')) {
            continue;
          }
          headers[key] = value;
        }
      }
      // Add CORS headers for iframe access
      headers['x-proxy-target'] = targetUrl;
      reply.code(proxyRes.statusCode ?? 200);
      reply.headers(headers);
      proxyRes.pipe(reply.raw);
    });

    proxyReq.on('error', (err) => {
      reply.code(502).send({ error: `Proxy error: ${err.message}` });
    });

    if (req.body) {
      proxyReq.write(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    }
    proxyReq.end();
  }

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
