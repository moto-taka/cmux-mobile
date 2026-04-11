/**
 * Shared types between server and client
 */

// ─── cmux Socket API Types ───

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

// ─── Server → Client Messages (WebSocket) ───

export interface ServerMessage {
  type: 'workspaces' | 'workspace_update' | 'surface_update' | 'connected' | 'error';
  data: unknown;
}

export interface WorkspacesMessage extends ServerMessage {
  type: 'workspaces';
  data: Workspace[];
}

export interface WorkspaceUpdateMessage extends ServerMessage {
  type: 'workspace_update';
  data: Workspace;
}

export interface ConnectedMessage extends ServerMessage {
  type: 'connected';
  data: { port: number; ttydBasePort: number };
}

// ─── Client → Server Messages (WebSocket) ───

export interface ClientMessage {
  type: 'select_workspace' | 'select_surface' | 'send_text' | 'send_key' | 'refresh';
  data: unknown;
}

export interface SelectWorkspaceMessage extends ClientMessage {
  type: 'select_workspace';
  data: { workspaceId: string };
}

export interface SelectSurfaceMessage extends ClientMessage {
  type: 'select_surface';
  data: { workspaceId: string; surfaceId: string };
}

// ─── Config ───

export interface ServerConfig {
  port: number;
  host: string;
  socketPath: string;
  ttydBasePort: number;
}
