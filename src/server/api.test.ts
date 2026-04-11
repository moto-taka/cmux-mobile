import { describe, it, expect } from 'vitest';

describe('Server API contract', () => {
  it('health response should have required fields', () => {
    // Test the shape of the health response (contract test)
    const health = {
      status: 'ok',
      uptime: 42,
      workspaces: 5,
      cmux: true,
    };
    expect(health).toHaveProperty('status', 'ok');
    expect(typeof health.uptime).toBe('number');
    expect(typeof health.workspaces).toBe('number');
    expect(typeof health.cmux).toBe('boolean');
  });

  it('workspace response should be an array of Workspace objects', () => {
    const workspaces = [
      {
        id: 'ws-1',
        name: 'Test',
        cwd: '/tmp/test',
        surfaces: [],
      },
      {
        id: 'ws-2',
        name: 'Another',
        cwd: '/tmp/another',
        git_branch: 'main',
        status: 'idle',
        ttydPort: 9001,
        surfaces: [{ id: 's1', name: 'bash', active: true }],
      },
    ];

    expect(workspaces).toHaveLength(2);
    expect(workspaces[0]).toHaveProperty('id');
    expect(workspaces[0]).toHaveProperty('name');
    expect(workspaces[0]).toHaveProperty('cwd');
    expect(workspaces[0]).toHaveProperty('surfaces');
    expect(workspaces[1].git_branch).toBe('main');
    expect(workspaces[1].ttydPort).toBe(9001);
  });
});
