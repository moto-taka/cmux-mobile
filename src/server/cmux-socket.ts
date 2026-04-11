import net from 'node:net';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { JSONRPCClient, isJSONRPCRequest } from 'json-rpc-2.0';
import type { JSONRPCRequest } from 'json-rpc-2.0';
import type { Workspace, Surface } from '../shared/types.js';

const execAsync = promisify(exec);

type EventCallback = (...args: unknown[]) => void;

interface CmuxSocketClientOptions {
  socketPath?: string;
  pollInterval?: number;
}

const DEFAULT_SOCKET_PATH = '/tmp/cmux.sock';
const RECONNECT_BASE_DELAY = 3000;
const MAX_RECONNECT_DELAY = 30000;
const REQUEST_TIMEOUT = 10000;

export class CmuxSocketClient {
  private socket: net.Socket | null = null;
  private rpcClient: JSONRPCClient<void>;
  private buffer = '';
  private connected = false;
  private connecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private previousWorkspaceJson = '';
  private destroyed = false;

  private readonly socketPath: string;
  private readonly pollInterval: number;
  private readonly listeners = new Map<string, Set<EventCallback>>();

  constructor(options: CmuxSocketClientOptions = {}) {
    this.socketPath = options.socketPath ?? process.env.CMUX_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;
    this.pollInterval = options.pollInterval ?? 2000;

    this.rpcClient = new JSONRPCClient<void>((payload) => {
      this.sendRaw(payload);
    });
  }

  // ─── Connection lifecycle ───

  async connect(): Promise<void> {
    if (this.connected || this.connecting) return;
    this.connecting = true;
    this.destroyed = false;

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this.socket = socket;

      let settled = false;

      socket.on('connect', () => {
        settled = true;
        this.connected = true;
        this.connecting = false;
        this.reconnectAttempt = 0;
        this.emit('connected');
        this.startPolling();
        resolve();
      });

      socket.on('data', (data: Buffer) => {
        this.handleData(data.toString());
      });

      socket.on('close', () => {
        this.handleDisconnect();
        if (!settled) {
          settled = true;
          this.connecting = false;
          reject(new Error(`Failed to connect to cmux socket at ${this.socketPath}`));
        }
      });

      socket.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          this.connecting = false;
          reject(new Error(`Socket connection error: ${err.message}`));
        }
      });

      socket.connect(this.socketPath);
    });
  }

  disconnect(): void {
    this.destroyed = true;
    this.stopPolling();
    this.clearReconnectTimer();

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    this.connected = false;
    this.connecting = false;
    this.rpcClient.rejectAllPendingRequests('Client disconnected');
  }

  get isConnected(): boolean {
    return this.connected;
  }

  // ─── JSON-RPC request ───

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) {
      throw new Error('Not connected to cmux socket');
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Request timeout: ${method}`));
      }, REQUEST_TIMEOUT);
    });

    return Promise.race([
      this.rpcClient.request(method, params ?? null),
      timeoutPromise,
    ]);
  }

  // ─── High-level workspace methods ───

  async listWorkspaces(): Promise<Workspace[]> {
    const result = await this.request('workspace.list') as {
      workspaces: Array<Record<string, unknown>>;
    };
    if (!result?.workspaces) return [];

    // Map cmux response to our Workspace type
    const workspaces: Workspace[] = result.workspaces.map((w) => {
      const rawTitle = (w.title as string) || '';
      // cmux uses spinner characters like ⠐⠏⠛ at the start of title when busy
      const spinnerMatch = rawTitle.match(/^([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠋⠛⠞⠟⠐⠡⠢⠣⠤⠥⠦⠧⠨⠩⠪⠫⠬⠭⠮⠯⠰⠱⠲⠳⠴⠵⠶⠷⠸⠹⠺⠻⠼⠽⠾⠿✳])\s*/);
      let status: string | undefined;
      let displayName = rawTitle;

      if (spinnerMatch) {
        // Spinner character indicates active process
        if (rawTitle.includes('Claude Code')) {
          status = 'running';
        } else {
          status = 'running';
        }
        displayName = rawTitle.replace(spinnerMatch[0], '').trim();
      } else if (rawTitle.startsWith('~/') || rawTitle.startsWith('/')) {
        // Just a directory path = idle
        status = 'idle';
      } else if (rawTitle.startsWith('✳')) {
        status = 'idle';
        displayName = rawTitle.replace(/^✳\s*/, '').trim();
      }

      return {
        id: w.id as string,
        name: displayName || (w.id as string),
        cwd: (w.current_directory as string) || (w.cwd as string) || '',
        git_branch: undefined, // Will be enriched separately
        status,
        progress: undefined,
        latest_log: undefined,
        surfaces: [],
      };
    });

    // Fetch surfaces and sidebar state for each workspace in parallel
    const enriched = await Promise.all(
      workspaces.map(async (ws) => {
        const [surfaces, gitBranch, sidebarData] = await Promise.all([
          this.listSurfaces(ws.id).catch(() => [] as Surface[]),
          this.getGitBranch(ws.cwd),
          this.getSidebarState(ws.id),
        ]);
        return {
          ...ws,
          surfaces,
          git_branch: gitBranch,
          // Enrich with sidebar state if available, otherwise keep spinner-based status
          status: (sidebarData?.status as string) || ws.status,
          progress: (sidebarData?.progress as number) ?? ws.progress,
          latest_log: (sidebarData?.latest_log as string) || ws.latest_log,
        };
      }),
    );

    return enriched;
  }

  private async getGitBranch(cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
        cwd,
        timeout: 3000,
      });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async selectWorkspace(id: string): Promise<void> {
    await this.request('workspace.select', { workspace_id: id });
  }

  async listSurfaces(workspaceId: string): Promise<Surface[]> {
    const result = await this.request('surface.list', { workspace_id: workspaceId }) as {
      surfaces: Array<Record<string, unknown>>;
    };
    if (!result?.surfaces) return [];
    return result.surfaces.map((s) => ({
      id: s.id as string,
      name: (s.title as string) || (s.name as string) || (s.id as string),
      title: s.title as string | undefined,
      active: (s.focused as boolean) || (s.selected_in_pane as boolean) || false,
    }));
  }

  async focusSurface(surfaceId: string): Promise<void> {
    await this.request('surface.focus', { surface_id: surfaceId });
  }

  async sendText(surfaceId: string, text: string): Promise<void> {
    await this.request('surface.send_text', { surface_id: surfaceId, text });
  }

  async sendKey(surfaceId: string, key: string): Promise<void> {
    await this.request('surface.send_key', { surface_id: surfaceId, key });
  }

  // ─── Additional API methods ───

  async createWorkspace(name: string, cwd?: string): Promise<void> {
    const params: Record<string, string> = { name };
    if (cwd) params.cwd = cwd;
    await this.request('workspace.create', params);
  }

  async closeWorkspace(id: string): Promise<void> {
    await this.request('workspace.close', { workspace_id: id });
  }

  async splitWorkspace(workspaceId: string): Promise<void> {
    await this.request('surface.split', { workspace_id: workspaceId });
  }

  async createNotification(workspaceId: string, message: string, level: string): Promise<void> {
    await this.request('notification.create', { workspace_id: workspaceId, message, level });
  }

  async listNotifications(): Promise<unknown> {
    return this.request('notification.list');
  }

  async clearNotifications(workspaceId: string): Promise<void> {
    await this.request('notification.clear', { workspace_id: workspaceId });
  }

  async systemPing(): Promise<unknown> {
    return this.request('system.ping');
  }

  async systemCapabilities(): Promise<unknown> {
    return this.request('system.capabilities');
  }

  async setSidebarStatus(workspaceId: string, status: string): Promise<void> {
    await this.request('sidebar.set_status', { workspace_id: workspaceId, status });
  }

  async setSidebarProgress(workspaceId: string, progress: number): Promise<void> {
    await this.request('sidebar.set_progress', { workspace_id: workspaceId, progress });
  }

  async sidebarLog(workspaceId: string, message: string): Promise<void> {
    await this.request('sidebar.log', { workspace_id: workspaceId, message });
  }

  async sidebarState(workspaceId: string): Promise<unknown> {
    return this.request('sidebar.sidebar_state', { workspace_id: workspaceId });
  }

  private async getSidebarState(workspaceId: string): Promise<Record<string, unknown> | null> {
    try {
      const result = await this.request('sidebar.sidebar_state', { workspace_id: workspaceId }) as Record<string, unknown>;
      return result;
    } catch {
      return null;
    }
  }

  // ─── Event emitter ───

  on(event: string, callback: EventCallback): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  off(event: string, callback: EventCallback): void {
    this.listeners.get(event)?.delete(callback);
  }

  private emit(event: string, ...args: unknown[]): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(...args);
        } catch {
          // Swallow listener errors
        }
      }
    }
  }

  // ─── Private: data handling ───

  private handleData(chunk: string): void {
    this.buffer += chunk;

    // Messages are newline-delimited JSON
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const payload = JSON.parse(line);
        if (isJSONRPCRequest(payload) && payload.id === undefined) {
          // This is a notification (no id field or id is null)
          this.handleNotification(payload as JSONRPCRequest & { method: string });
        } else {
          // Response to a previous request
          this.rpcClient.receive(payload);
        }
      } catch {
        // Ignore malformed JSON lines
      }
    }
  }

  private handleNotification(notification: JSONRPCRequest & { method: string }): void {
    const method = notification.method;

    // Map cmux notification methods to client events
    if (method === 'on_workspace_changed') {
      this.emit('workspace_changed', notification.params);
    }
  }

  private sendRaw(payload: unknown): void {
    if (!this.socket || !this.connected) return;

    try {
      const data = JSON.stringify(payload) + '\n';
      this.socket.write(data);
    } catch {
      // Socket write failure — will be handled by close/error events
    }
  }

  // ─── Private: reconnect logic ───

  private handleDisconnect(): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.connecting = false;
    this.socket = null;

    this.stopPolling();
    this.rpcClient.rejectAllPendingRequests('Socket disconnected');

    if (wasConnected) {
      this.emit('disconnected');
    }

    if (!this.destroyed) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempt),
      MAX_RECONNECT_DELAY,
    );
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attemptReconnect();
    }, delay);
  }

  private async attemptReconnect(): Promise<void> {
    if (this.destroyed || this.connected) return;

    try {
      await this.connect();
    } catch {
      // connect() rejection means socket failed; handleDisconnect already schedules next attempt
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ─── Private: polling ───

  private startPolling(): void {
    this.stopPolling();
    this.pollWorkspaces(); // Initial fetch

    this.pollTimer = setInterval(() => {
      this.pollWorkspaces();
    }, this.pollInterval);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollWorkspaces(): Promise<void> {
    if (!this.connected) return;

    try {
      const workspaces = await this.listWorkspaces();
      const json = JSON.stringify(workspaces);

      if (json !== this.previousWorkspaceJson) {
        this.previousWorkspaceJson = json;
        this.emit('workspace_changed', workspaces);
      }
    } catch {
      // Polling errors are expected during transient disconnects
    }
  }
}
