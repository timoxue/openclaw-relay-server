import Docker from 'dockerode';
import { randomBytes } from 'crypto';
import dockerConfig from '../../config/docker.json';
import { DockerContainerInfo, IgniteOptions } from '../types';
import { createLogger } from '../utils/logger';
import { tokenService } from './token';

const logger = createLogger('Docker');

export class DockerOrchestrator {
  private docker: Docker;
  private containers: Map<string, Docker.Container> = new Map();

  constructor() {
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
  }

  private generateGatewayToken(): string {
    return randomBytes(32).toString('hex');
  }

  async igniteSandbox(options: IgniteOptions): Promise<DockerContainerInfo> {
    const { userId, userToken, storagePath } = options;
    const gatewayToken = this.generateGatewayToken();
    const containerName = `${dockerConfig.containerPrefix}${userId}`;
    const hostStoragePath = storagePath || dockerConfig.storagePath.replace('{userId}', userId);

    logger.info(`Igniting sandbox for user ${userId}...`);

    // Create container
    const container = await this.docker.createContainer({
      name: containerName,
      Image: dockerConfig.image,
      Env: [
        ...Object.entries(dockerConfig.environment).map(([k, v]) => `${k}=${v}`),
        `OPENCLAW_GATEWAY_TOKEN=${gatewayToken}`,
        `OPENCLAW_USER_TOKEN=${userToken}`,
        `OPENCLAW_HOST=0.0.0.0`, // Fallback: may not be used, keep for compatibility
      ],
      // Override default command to bind to LAN (0.0.0.0) for Docker network access
      Cmd: [
        'node',
        'openclaw.mjs',
        'gateway',
        '--allow-unconfigured',
        '--bind', 'lan',
        '--token', gatewayToken,
      ],
      HostConfig: {
        NetworkMode: dockerConfig.network,
        Binds: [
          `${hostStoragePath}:/app/storage:rw`
        ],
        AutoRemove: dockerConfig.autoRemove,
        // No port bindings needed - containers communicate via Docker network
      },
    });

    // Start container
    await container.start();

    // Containers communicate via Docker network using container name, no host port needed
    const info: DockerContainerInfo = {
      containerId: container.id,
      userId,
      userToken,
      gatewayToken,
      port: 18789, // Internal gateway port (container connects via container name:18789)
      status: 'running',
      createdAt: new Date()
    };

    this.containers.set(userId, container);
    logger.success(`Sandbox ignited: ${containerName} (port: 18789)`);
    logger.debug(`Gateway token: ${gatewayToken}`);
    return info;
  }

  async stopSandbox(userId: string): Promise<void> {
    const container = this.containers.get(userId);
    if (!container) {
      logger.warning(`No container found for user ${userId}`);
      return;
    }

    logger.info(`Stopping sandbox for user ${userId}...`);
    await container.stop({ t: 10 });
    await container.remove();
    this.containers.delete(userId);
    logger.success(`Sandbox stopped for ${userId}`);
  }

  /**
   * Find existing container for user by name (not just in memory)
   * This checks Docker directly for any container with the expected name
   */
  async findExistingContainer(userId: string): Promise<Docker.Container | null> {
    const containerName = `${dockerConfig.containerPrefix}${userId}`;

    try {
      // Get container by name
      const container = await this.docker.getContainer(containerName);
      // Verify it exists by inspecting
      await container.inspect();
      logger.info(`Found existing container: ${containerName}`);
      return container;
    } catch (error: any) {
      if (error.statusCode === 404) {
        logger.info(`No existing container found for user ${userId}`);
        return null;
      }
      logger.error(`Error finding container for user ${userId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get detailed status of existing container
   */
  async getExistingContainerStatus(containerName: string): Promise<{
    exists: boolean;
    status: string;
    container: Docker.Container | null;
  }> {
    try {
      const container = await this.docker.getContainer(containerName);
      const info = await container.inspect();
      const state = info.State;

      return {
        exists: true,
        status: state.Status.toLowerCase(), // running, exited, paused, etc.
        container,
      };
    } catch (error: any) {
      if (error.statusCode === 404) {
        return { exists: false, status: 'not_found', container: null };
      }
      throw error;
    }
  }

  /**
   * Start an existing stopped container
   * @param userId - User ID
   * @param userToken - User token (from orchestrator)
   */
  async startExistingContainer(userId: string, userToken?: string): Promise<DockerContainerInfo> {
    const containerName = `${dockerConfig.containerPrefix}${userId}`;
    logger.info(`Starting existing container for user ${userId}...`);

    try {
      const container = await this.docker.getContainer(containerName);
      await container.start();

      // Generate new gateway token
      const gatewayToken = this.generateGatewayToken();

      // Store in memory
      this.containers.set(userId, container);

      const info: DockerContainerInfo = {
        containerId: container.id,
        userId,
        userToken: userToken || '',
        gatewayToken,
        port: 18789,
        status: 'running',
        createdAt: new Date()
      };

      logger.success(`Existing container started: ${containerName}`);
      return info;
    } catch (error) {
      logger.error(`Failed to start existing container for user ${userId}: ${error}`);
      throw error;
    }
  }

  async getContainerStatus(userId: string): Promise<DockerContainerInfo | null> {
    const container = this.containers.get(userId);
    if (!container) return null;

    try {
      const info = await container.inspect();
      const state = info.State;

      return {
        containerId: container.id,
        userId,
        userToken: '',
        gatewayToken: '',
        port: 0,
        status: state.Running ? 'running' : 'stopped',
        createdAt: new Date(info.Created)
      };
    } catch (error) {
      logger.error(`Error getting container status: ${error}`);
      return null;
    }
  }

  async getContainerLogs(userId: string, tail: number = 100): Promise<string> {
    const container = this.containers.get(userId);
    if (!container) return '';

    const stream = await container.logs({
      stdout: true,
      stderr: true,
      tail: tail
    }) as any;

    return new Promise((resolve, reject) => {
      let logs = '';
      stream.on('data', (chunk: Buffer) => {
        logs += chunk.toString('utf-8');
      });
      stream.on('end', () => {
        resolve(logs);
      });
      stream.on('error', (err: Error) => {
        reject(err);
      });
    });
  }

  getDockerClient(): Docker {
    return this.docker;
  }
}

// Singleton instance
export const dockerOrchestrator = new DockerOrchestrator();
