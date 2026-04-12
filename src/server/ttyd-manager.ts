import { spawn, execFile, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const execFileAsync = promisify(execFile);

const DEFAULT_BASE_PORT = 9001;
const MAX_PORT = 65535;
const HEALTH_CHECK_INTERVAL_MS = 30_000;

interface TtydProcessInfo {
  port: number;
  process: ChildProcess;
  cwd: string;
  name: string;
  sanitizedId: string;
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

const CMUX_BIN_PATHS = [
  '/Applications/cmux-superset.app/Contents/Resources/bin/cmux',
  path.join(os.homedir(), '.local/bin/cmux'),
  '/usr/local/bin/cmux',
];

export class TtydManager {
  private processes = new Map<string, TtydProcessInfo>();
  private basePort: number;
  private nextPort: number;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private ttydAvailable: boolean | null = null;
  private tmuxAvailable = false;
  private cmuxBinPath: string | null = null;
  private shuttingDown = false;

  constructor(basePort: number = DEFAULT_BASE_PORT) {
    this.basePort = basePort;
    this.nextPort = basePort;
  }

  async start(): Promise<void> {
    this.ttydAvailable = await this.checkBinaryAvailable('ttyd');
    if (!this.ttydAvailable) {
      console.error(
        'ttydが見つかりません。brew install ttyd でインストールしてください。'
      );
      return;
    }

    this.tmuxAvailable = await this.checkBinaryAvailable('tmux');
    this.cmuxBinPath = await this.findCmuxBin();

    if (this.tmuxAvailable) {
      console.log('   ✓ tmux available — session sharing enabled');
    }
    if (this.cmuxBinPath) {
      console.log(`   ✓ cmux CLI found — content capture enabled`);
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

  /**
   * Capture cmux surface terminal content and inject into the ttyd tmux session.
   * This allows the phone user to see existing terminal history from cmux.
   */
  async injectCmuxContent(workspaceId: string): Promise<void> {
    if (!this.tmuxAvailable || !this.cmuxBinPath) return;

    const info = this.processes.get(workspaceId);
    if (!info) return;

    try {
      // Capture cmux surface content with scrollback (safe: workspaceId is UUID)
      const { stdout } = await execFileAsync(
        this.cmuxBinPath,
        ['capture-pane', '--workspace', workspaceId, '--scrollback', '--lines', '200'],
        { timeout: 5000 }
      );

      if (!stdout || !stdout.trim()) return;

      // Save to temp file (ANSI codes preserved, safe temp name)
      const tmpFile = path.join(os.tmpdir(), `cmux-capture-${info.sanitizedId}.txt`);
      fs.writeFileSync(tmpFile, stdout);

      const session = `cmux-${info.sanitizedId}`;

      // Send Enter to ensure we're at a prompt, then display captured content
      await execFileAsync('tmux', ['send-keys', '-t', session, '', 'C-m']);
      await execFileAsync('tmux', [
        'send-keys', '-t', session,
        `clear && printf '\\033[33m── cmux history ──\\033[0m\\n' && cat '${tmpFile}' && printf '\\033[33m── end history ──\\033[0m\\n' && rm -f '${tmpFile}'`,
        'C-m',
      ]);
    } catch {
      // cmux not running or surface not available — silent fail
    }
  }

  // ─── Private: spawning ───

  private sanitizeId(id: string): string {
    // tmux session names cannot contain : or .
    return id.replace(/[:.]/g, '_').substring(0, 50);
  }

  private async spawnTtyd(workspace: WorkspaceInput): Promise<void> {
    const port = await this.findAvailablePort();
    const sanitizedId = this.sanitizeId(workspace.id);

    // Build shell command: tmux for session sharing, fallback to login shell
    let shellCmd: string;
    if (this.tmuxAvailable) {
      const session = `cmux-${sanitizedId}`;
      shellCmd = `tmux -f /dev/null new-session -A -s ${session} bash -l`;
    } else {
      shellCmd = 'bash -l';
    }

    const proc = spawn(
      'ttyd',
      [
        '-p', String(port),
        '-W',
        '--writable',
        '-t', 'fontSize=14',
        '-t', `theme=${TTYD_THEME}`,
        shellCmd,
      ],
      {
        cwd: workspace.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      }
    );

    // Suppress noisy ttyd logs — only show real errors
    proc.stdout?.on('data', () => {});
    proc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes('EADDRINUSE')) return;
      if (msg.includes(' E: ')) {
        console.error(`[ttyd:${workspace.name}:${port}] ${msg.trim()}`);
      }
    });

    proc.on('exit', () => {
      // Auto-respawn if not shutting down and process is still tracked
      if (!this.shuttingDown && this.processes.has(workspace.id)) {
        this.processes.delete(workspace.id);
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
      sanitizedId,
    });

    // Configure tmux session after it starts (fire-and-forget, safe args)
    if (this.tmuxAvailable) {
      const session = `cmux-${sanitizedId}`;
      setTimeout(() => {
        execFile('tmux', ['set-option', '-t', session, 'status', 'off'], () => {});
        execFile('tmux', ['set-option', '-t', session, 'history-limit', '50000'], () => {});
        execFile('tmux', ['set-option', '-t', session, '-w', 'aggressive-resize', 'on'], () => {});
      }, 2000);
    }
  }

  private async killProcess(
    _workspaceId: string,
    info: TtydProcessInfo
  ): Promise<void> {
    // Kill tmux session if using tmux
    if (this.tmuxAvailable) {
      try {
        await execFileAsync('tmux', ['kill-session', '-t', `cmux-${info.sanitizedId}`]);
      } catch {
        // Ignore — session may already be dead
      }
    }

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

  // ─── Private: binary detection ───

  private async checkBinaryAvailable(name: string): Promise<boolean> {
    try {
      await execFileAsync('which', [name]);
      return true;
    } catch {
      return false;
    }
  }

  private async findCmuxBin(): Promise<string | null> {
    for (const p of CMUX_BIN_PATHS) {
      try {
        await fs.promises.access(p, fs.constants.X_OK);
        return p;
      } catch {
        continue;
      }
    }
    // Try PATH as last resort
    try {
      const { stdout } = await execFileAsync('which', ['cmux']);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private findAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const tryPort = () => {
        if (this.nextPort > MAX_PORT) {
          reject(new Error('No available ports (exhausted range)'));
          return;
        }
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
