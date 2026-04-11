import { spawn, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';
import * as net from 'node:net';

const execAsync = promisify(exec);

const DEFAULT_BASE_PORT = 9001;
const HEALTH_CHECK_INTERVAL_MS = 30_000;

interface TtydProcessInfo {
  port: number;
  process: ChildProcess;
  cwd: string;
  name: string;
}

interface WorkspaceInput {
  id: string;
  cwd: string;
  name: string;
}

const TTYD_THEME = JSON.stringify({
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  cursorAccent: '#1e1e2e',
  selectionBackground: '#585b70',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8',
});

export class TtydManager {
  private processes = new Map<string, TtydProcessInfo>();
  private basePort: number;
  private nextPort: number;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private ttydAvailable: boolean | null = null;
  private shuttingDown = false;

  constructor(basePort: number = DEFAULT_BASE_PORT) {
    this.basePort = basePort;
    this.nextPort = basePort;
  }

  async start(): Promise<void> {
    this.ttydAvailable = await this.checkTtydAvailable();
    if (!this.ttydAvailable) {
      console.error(
        'ttydが見つかりません。brew install ttyd でインストールしてください。'
      );
      return;
    }

    this.startHealthCheck();
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    this.stopHealthCheck();

    const killPromises: Promise<void>[] = [];
    for (const [workspaceId, info] of this.processes) {
      killPromises.push(this.killProcess(workspaceId, info));
    }
    await Promise.all(killPromises);
    this.processes.clear();
    this.nextPort = this.basePort;
    this.shuttingDown = false;
  }

  async syncWorkspaces(workspaces: WorkspaceInput[]): Promise<void> {
    if (!this.ttydAvailable) {
      return;
    }

    const currentIds = new Set(this.processes.keys());
    const newIds = new Set(workspaces.map((w) => w.id));

    // Kill processes for removed workspaces
    const toRemove = [...currentIds].filter((id) => !newIds.has(id));
    const killPromises = toRemove.map((id) => {
      const info = this.processes.get(id)!;
      return this.killProcess(id, info).then(() => {
        this.processes.delete(id);
      });
    });
    await Promise.all(killPromises);

    // Spawn processes for new workspaces
    const toAdd = workspaces.filter((w) => !currentIds.has(w.id));
    for (const workspace of toAdd) {
      await this.spawnTtyd(workspace);
    }
  }

  getInfo(workspaceId: string): { port: number; url: string } | null {
    const info = this.processes.get(workspaceId);
    if (!info) {
      return null;
    }
    return {
      port: info.port,
      url: `http://localhost:${info.port}`,
    };
  }

  getAllInfo(): Map<string, { port: number; process: ChildProcess }> {
    const result = new Map<string, { port: number; process: ChildProcess }>();
    for (const [id, info] of this.processes) {
      result.set(id, { port: info.port, process: info.process });
    }
    return result;
  }

  private async spawnTtyd(workspace: WorkspaceInput): Promise<void> {
    const port = await this.findAvailablePort();

    const proc = spawn(
      'ttyd',
      [
        '-p', String(port),
        '-W',
        '--writable',
        '-t', 'fontSize=14',
        '-t', `theme=${TTYD_THEME}`,
        'bash',
      ],
      {
        cwd: workspace.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      }
    );

    // Suppress noisy ttyd logs — only show errors
    proc.stdout?.on('data', () => {});
    proc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes(' E: ') || msg.includes('error') || msg.includes('ERROR')) {
        console.error(`[ttyd:${workspace.name}:${port}] ${msg.trim()}`);
      }
    });

    proc.on('exit', (code, signal) => {
      // Auto-respawn if not shutting down and process is still tracked
      if (!this.shuttingDown && this.processes.has(workspace.id)) {
        this.processes.delete(workspace.id);
        // Reclaim the port for reuse
        this.spawnTtyd(workspace).catch((err) => {
          console.error(`[ttyd:${workspace.name}] respawn failed: ${err.message}`);
        });
      }
    });

    proc.on('error', (err) => {
      console.error(`[ttyd:${workspace.name}:${port}] process error: ${err.message}`);
    });

    this.processes.set(workspace.id, {
      port,
      process: proc,
      cwd: workspace.cwd,
      name: workspace.name,
    });
  }

  private async killProcess(
    workspaceId: string,
    info: TtydProcessInfo
  ): Promise<void> {
    return new Promise((resolve) => {
      const proc = info.process;
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 5000);

      proc.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      proc.kill('SIGTERM');
    });
  }

  private async checkTtydAvailable(): Promise<boolean> {
    try {
      await execAsync('which ttyd');
      return true;
    } catch {
      return false;
    }
  }

  private findAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const tryPort = () => {
        const port = this.nextPort++;
        const server = net.createServer();
        server.on('error', () => {
          // Port in use, try next
          tryPort();
        });
        server.listen(port, '127.0.0.1', () => {
          server.close(() => resolve(port));
        });
      };
      tryPort();
    });
  }

  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      return;
    }
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private performHealthCheck(): void {
    for (const [workspaceId, info] of this.processes) {
      if (info.process.exitCode !== null || info.process.killed) {
        console.debug(
          `[ttyd:${info.name}:${info.port}] health check: process is dead, respawning...`
        );
        this.processes.delete(workspaceId);
        this.spawnTtyd({
          id: workspaceId,
          cwd: info.cwd,
          name: info.name,
        }).catch((err) => {
          console.error(
            `[ttyd:${info.name}] health check respawn failed: ${err.message}`
          );
        });
      }
    }
  }
}
