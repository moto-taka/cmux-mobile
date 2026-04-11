import { describe, it, expect } from 'vitest';
import type { Workspace, ServerMessage, ClientMessage, ServerConfig } from './types.js';

describe('Shared Types', () => {
  it('Workspace should have required fields', () => {
    const ws: Workspace = {
      id: 'ws-1',
      name: 'Test Workspace',
      cwd: '/home/user/project',
      surfaces: [],
    };
    expect(ws.id).toBe('ws-1');
    expect(ws.name).toBe('Test Workspace');
    expect(ws.cwd).toBe('/home/user/project');
    expect(ws.surfaces).toEqual([]);
  });

  it('Workspace should support optional fields', () => {
    const ws: Workspace = {
      id: 'ws-2',
      name: 'Full Workspace',
      cwd: '/home/user/project',
      git_branch: 'main',
      status: 'running',
      progress: 75,
      latest_log: 'Building...',
      ttydPort: 9001,
      surfaces: [
        { id: 's1', name: 'bash', active: true },
        { id: 's2', name: 'vim', title: 'editor', active: false },
      ],
    };
    expect(ws.git_branch).toBe('main');
    expect(ws.status).toBe('running');
    expect(ws.progress).toBe(75);
    expect(ws.latest_log).toBe('Building...');
    expect(ws.ttydPort).toBe(9001);
    expect(ws.surfaces).toHaveLength(2);
  });

  it('ServerMessage should accept all message types', () => {
    const messages: ServerMessage[] = [
      { type: 'workspaces', data: [] },
      { type: 'workspace_update', data: {} },
      { type: 'surface_update', data: {} },
      { type: 'connected', data: { port: 3456 } },
      { type: 'error', data: 'something went wrong' },
    ];
    expect(messages).toHaveLength(5);
  });

  it('ClientMessage should accept all message types', () => {
    const messages: ClientMessage[] = [
      { type: 'select_workspace', data: { workspaceId: 'ws-1' } },
      { type: 'select_surface', data: { workspaceId: 'ws-1', surfaceId: 's1' } },
      { type: 'send_text', data: { surfaceId: 's1', text: 'hello' } },
      { type: 'send_key', data: { surfaceId: 's1', key: 'Enter' } },
      { type: 'refresh', data: {} },
    ];
    expect(messages).toHaveLength(5);
  });

  it('ServerConfig should have all required fields', () => {
    const config: ServerConfig = {
      port: 3456,
      host: '0.0.0.0',
      socketPath: '/tmp/cmux.sock',
      ttydBasePort: 9001,
    };
    expect(config.port).toBe(3456);
    expect(config.host).toBe('0.0.0.0');
  });
});
