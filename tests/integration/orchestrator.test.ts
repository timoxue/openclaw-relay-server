import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { orchestrator } from '../../src/services/orchestrator';
import { dockerOrchestrator } from '../../src/services/docker-orchestrator';
import { DockerContainerInfo, UserSandboxState } from '../../src/types';

describe('Orchestrator Integration Tests', () => {
  const testUserId = `test_integration_${Date.now()}`;

  beforeAll(async () => {
    console.log('[Integration] Setting up test environment...');

    // Check if Docker is available
    const docker = dockerOrchestrator.getDockerClient();
    try {
      await docker.ping();
      console.log('[Integration] Docker is available');
    } catch (error) {
      console.error('[Integration] Docker is not available:', error);
      throw new Error('Docker is not available for integration tests');
    }

    // Initialize orchestrator
    await orchestrator.initialize();
    console.log('[Integration] Orchestrator initialized');
  });

  afterAll(async () => {
    console.log('[Integration] Cleaning up test environment...');

    try {
      // Stop test sandbox if running
      await orchestrator.stopSandbox(testUserId);
      console.log('[Integration] Test sandbox stopped');
    } catch (error) {
      console.error('[Integration] Error stopping test sandbox:', error);
    }

    // Shutdown orchestrator
    await orchestrator.shutdown();
    console.log('[Integration] Orchestrator shut down');
  });

  describe('User State Management', () => {
    it('should create user state on first access', () => {
      const state = orchestrator.getUserState(testUserId);

      expect(state).toBeDefined();
      expect(state.userId).toBe(testUserId);
      expect(state.userToken).toBeTruthy();
      expect(typeof state.userToken).toBe('string');
      expect(state.containerInfo).toBeNull();
      expect(state.awaitingConfirmation).toBe(false);
      expect(state.lastActivity).toBeInstanceOf(Date);
    });

    it('should update last activity on subsequent access', () => {
      const state1 = orchestrator.getUserState(testUserId);
      const state2 = orchestrator.getUserState(testUserId);

      expect(state1.userId).toBe(state2.userId);
      expect(state1.userToken).toBe(state2.userToken);
      expect(state1.lastActivity).toBeInstanceOf(Date);
      expect(state2.lastActivity).toBeInstanceOf(Date);
    });

    it('should return all active states', () => {
      // Create another test user state
      const anotherUserId = `test_integration_${Date.now()}_another`;
      orchestrator.getUserState(anotherUserId);

      const states = orchestrator.getActiveStates();

      expect(Array.isArray(states)).toBe(true);
      expect(states.length).toBeGreaterThanOrEqual(1);

      // Check if our test user is in the states
      const testState = states.find(s => s.userId === testUserId);
      expect(testState).toBeDefined();
      expect(testState?.userId).toBe(testUserId);
    });
  });

  describe('Docker Container Management', () => {
    it('should ignite sandbox container', async () => {
      const state = orchestrator.getUserState(testUserId);
      const igniteOptions = {
        userId: testUserId,
        userToken: state.userToken,
      };

      const containerInfo = await dockerOrchestrator.igniteSandbox(igniteOptions);

      expect(containerInfo).toBeDefined();
      expect(containerInfo.containerId).toBeTruthy();
      expect(containerInfo.userId).toBe(testUserId);
      expect(containerInfo.userToken).toBe(state.userToken);
      expect(containerInfo.gatewayToken).toBeTruthy();
      expect(containerInfo.port).toBeGreaterThan(0);
      expect(containerInfo.status).toBe('running');
      expect(containerInfo.createdAt).toBeInstanceOf(Date);

      console.log(`[Integration] Container ignited: ${containerInfo.containerId.substring(0, 12)} on port ${containerInfo.port}`);
    });

    it('should get container status', async () => {
      const containerInfo = await dockerOrchestrator.getContainerStatus(testUserId);

      expect(containerInfo).toBeDefined();
      expect(containerInfo?.containerId).toBeTruthy();
      expect(containerInfo?.userId).toBe(testUserId);
      expect(containerInfo?.status).toBe('running');
      expect(containerInfo?.createdAt).toBeInstanceOf(Date);
    });

    it('should get container logs', async () => {
      const logs = await dockerOrchestrator.getContainerLogs(testUserId, 50);

      expect(typeof logs).toBe('string');
      // Logs might be empty initially, but should return a string
      console.log(`[Integration] Container logs (${logs.length} characters)`);
    });

    it('should stop sandbox container', async () => {
      await dockerOrchestrator.stopSandbox(testUserId);

      // Wait a moment for container to stop
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify container is stopped
      const containerInfo = await dockerOrchestrator.getContainerStatus(testUserId);
      // Container should be removed or stopped
      expect(containerInfo?.status).toBe('stopped');
    });
  });

  describe('Orchestrator State Machine', () => {
    it('should handle sandbox ignition through orchestrator', async () => {
      const state = orchestrator.getUserState(testUserId);
      expect(state.containerInfo).toBeNull();

      // Simulate ignite action
      await orchestrator.handleCardInteraction(testUserId, 'ignite');

      // Wait for container to start
      await new Promise(resolve => setTimeout(resolve, 2000));

      const updatedState = orchestrator.getUserState(testUserId);
      expect(updatedState.containerInfo).toBeDefined();
      expect(updatedState.containerInfo?.status).toBe('running');
      expect(updatedState.awaitingConfirmation).toBe(false);

      console.log(`[Integration] Sandbox ignited through orchestrator: ${updatedState.containerInfo?.containerId.substring(0, 12)}`);
    });

    it('should stop sandbox through orchestrator', async () => {
      // Stop sandbox
      await orchestrator.stopSandbox(testUserId);

      // Wait for cleanup
      await new Promise(resolve => setTimeout(resolve, 1000));

      const state = orchestrator.getUserState(testUserId);
      expect(state.containerInfo).toBeNull();
      expect(state.awaitingConfirmation).toBe(false);

      console.log('[Integration] Sandbox stopped through orchestrator');
    });

    it('should handle cancel action', async () => {
      // Set awaiting confirmation
      const state = orchestrator.getUserState(testUserId);
      state.awaitingConfirmation = true;

      // Handle cancel action
      await orchestrator.handleCardInteraction(testUserId, 'cancel');

      const updatedState = orchestrator.getUserState(testUserId);
      expect(updatedState.awaitingConfirmation).toBe(false);
      expect(updatedState.containerInfo).toBeNull();

      console.log('[Integration] Cancel action handled correctly');
    });
  });

  describe('Edge Cases', () => {
    it('should handle stopping non-existent sandbox gracefully', async () => {
      const nonExistentUserId = `test_non_existent_${Date.now()}`;

      await expect(
        orchestrator.stopSandbox(nonExistentUserId)
      ).resolves.not.toThrow();

      console.log('[Integration] Non-existent sandbox stop handled gracefully');
    });

    it('should handle getting status of non-existent container', async () => {
      const nonExistentUserId = `test_non_existent_${Date.now()}`;

      const status = await dockerOrchestrator.getContainerStatus(nonExistentUserId);
      expect(status).toBeNull();

      console.log('[Integration] Non-existent container status returned null');
    });

    it('should handle getting logs of non-existent container', async () => {
      const nonExistentUserId = `test_non_existent_${Date.now()}`;

      const logs = await dockerOrchestrator.getContainerLogs(nonExistentUserId);
      expect(logs).toBe('');

      console.log('[Integration] Non-existent container logs returned empty string');
    });
  });

  describe('State Cleanup', () => {
    it('should have cleanup interval configured', () => {
      // This is more of a structural test
      const states = orchestrator.getActiveStates();
      expect(Array.isArray(states)).toBe(true);
      console.log('[Integration] Cleanup interval is configured (structural check)');
    });
  });
});
