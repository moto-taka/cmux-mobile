import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TtydManager } from './ttyd-manager.js';

describe('TtydManager', () => {
  let manager: TtydManager;

  beforeEach(() => {
    manager = new TtydManager(9001);
  });

  describe('start()', () => {
    it('should fail gracefully when ttyd is not available', async () => {
      // On systems without ttyd, start should not throw
      await expect(manager.start()).resolves.toBeUndefined();
    });
  });

  describe('getInfo()', () => {
    it('should return null for unknown workspace', () => {
      expect(manager.getInfo('nonexistent')).toBeNull();
    });
  });

  describe('stop()', () => {
    it('should complete without error when no processes are running', async () => {
      await expect(manager.stop()).resolves.toBeUndefined();
    });
  });

  describe('syncWorkspaces()', () => {
    it('should be a no-op when ttyd is not available', async () => {
      // Without calling start(), ttydAvailable is null
      await expect(
        manager.syncWorkspaces([{ id: 'ws1', cwd: '/tmp', name: 'test' }])
      ).resolves.toBeUndefined();
      expect(manager.getInfo('ws1')).toBeNull();
    });
  });
});
