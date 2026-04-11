/**
 * Shared types between server and client
 */

export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  git_branch?: string;
  status?: string;
  progress?: number;
  latest_log?: string;
  ttydPort?: number;
  surfaces: Surface[];
}

export interface Surface {
  id: string;
  name: string;
  title?: string;
  active: boolean;
}

// ─── Server ↔ Client Messages ───

export interface ServerMessage {
  type: 'workspaces' | 'workspace_update' | 'surface_update' | 'connected' | 'error';
  data: unknown;
}

export interface ClientMessage {
  type: 'select_workspace' | 'select_surface' | 'send_text' | 'send_key' | 'refresh';
  data: unknown;
}

// ─── Config ───

export interface ServerConfig {
  port: number;
  host: string;
  socketPath: string;
  ttydBasePort: number;
}
