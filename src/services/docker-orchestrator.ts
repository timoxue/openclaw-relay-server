import Docker from 'dockerode';
import { randomBytes } from 'crypto';
import * as dockerConfig from '../../config/docker.json';
import { DockerContainerInfo, IgniteOptions } from '../types';
import { createLogger } from '../utils/logger';

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
      ],
      HostConfig: {
        NetworkMode: dockerConfig.network,
        Binds: [
          `${hostStoragePath}:/app/storage:rw`
        ],
        AutoRemove: dockerConfig.autoRemove,
        PortBindings: {
          '18789/tcp': [{ HostPort: '0' }] // Random host port
        }
      },
      ExposedPorts: {
        '18789/tcp': {}
      }
    });

    // Start container
    await container.start();

    // Get assigned port
    const containerInfo = await container.inspect();
    const portBinding = containerInfo.NetworkSettings.Ports['18789/tcp'];
    const hostPort = portBinding && portBinding[0] ? parseInt(portBinding[0].HostPort) : 0;

    const info: DockerContainerInfo = {
      containerId: container.id,
      userId,
      userToken,
      gatewayToken,
      port: hostPort,
      status: 'running',
      createdAt: new Date()
    };

    this.containers.set(userId, container);

    logger.success(`Sandbox ignited: ${containerName} (port: ${hostPort})`);
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
      tail
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
