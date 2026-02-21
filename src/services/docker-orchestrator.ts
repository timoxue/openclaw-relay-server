import Docker from 'dockerode';
import { randomBytes } from 'crypto';
import { execSync } from 'child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import dockerConfig from '../../config/docker.json';
import { DockerContainerInfo, IgniteOptions } from '../types';
import { createLogger } from '../utils/logger';
import { tokenService } from './token';
import { waitForPort } from '../utils/network';

const logger = createLogger('Docker');

// Container name suffixes
const MAIN_CONTAINER_SUFFIX = '';
const PROXY_CONTAINER_SUFFIX = '-proxy';

export class DockerOrchestrator {
  private docker: Docker;
  private containers: Map<string, Docker.Container> = new Map();
  private proxyContainers: Map<string, Docker.Container> = new Map();

  constructor() {
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
  }

  private generateGatewayToken(): string {
    return randomBytes(32).toString('hex');
  }

  private sanitizeUserId(userId: string): string {
    return userId.replace(/_/g, '-').toLowerCase();
  }

  /**
   * Ignite sandbox with sidecar proxy (network parasitism mode)
   *
   * Architecture:
   * 1. Main container: openclaw-sandbox-${safeId} - binds to 127.0.0.1:18789 only
   * 2. Sidecar container: openclaw-proxy-${safeId} - shares network namespace, proxies 38789 -> 127.0.0.1:18789
   */
  async igniteSandbox(options: IgniteOptions): Promise<DockerContainerInfo> {
    const { userId, userToken } = options;
    const gatewayToken = this.generateGatewayToken();
    const safeId = this.sanitizeUserId(userId);
    const mainContainerName = `${dockerConfig.containerPrefix}${safeId}`;
    const proxyContainerName = `${dockerConfig.containerPrefix}${safeId}${PROXY_CONTAINER_SUFFIX}`;
    // 初始化路径：容器内使用 /app/sandbox-data，但 Binds 参数使用宿主机物理路径
    const CONTAINER_SANDBOX_PATH = `/app/sandbox-data/${userId}`;
    const HOST_PATH = `/Users/timo/LingSynapse/sandbox-data/${userId}`;

    // ==================== 初始化宿主机路径 ====================
    try {
      // 动作：如果不存在，则 mkdir -p（使用容器内路径）
      if (!existsSync(CONTAINER_SANDBOX_PATH)) {
        mkdirSync(CONTAINER_SANDBOX_PATH, { recursive: true });
        logger.info(`Created HOST_PATH: ${CONTAINER_SANDBOX_PATH}`);
      }

      // 权限：立即执行 chmod 777（必须在写文件前，确保后续容器能写回）
      execSync(`chmod 777 ${CONTAINER_SANDBOX_PATH}`);
      logger.info(`Set chmod 777 on HOST_PATH: ${CONTAINER_SANDBOX_PATH}`);

      // ==================== 预注入核心配置 ====================
      // 注意：容器内 sandbox-data 挂载在 /app/sandbox-data
      // fs 操作使用容器内路径，但 Binds 参数使用宿主机物理路径
      const templateDir = '/app/sandbox-data/template';

      // 从 template 拷贝 openclaw.json 到 ${CONTAINER_SANDBOX_PATH}/openclaw.json
      const hostConfigPath = `${CONTAINER_SANDBOX_PATH}/openclaw.json`;
      if (!existsSync(hostConfigPath)) {
        const templateConfigPath = `${templateDir}/openclaw.json`;
        try {
          writeFileSync(hostConfigPath, readFileSync(templateConfigPath));
          logger.info(`Copied openclaw.json from template to ${hostConfigPath}`);
        } catch (e) {
          logger.warning(`Failed to copy openclaw.json: ${e}`);
        }
      } else {
        logger.debug(`openclaw.json already exists, skipping copy`);
      }

      // 递归创建 ${CONTAINER_SANDBOX_PATH}/agents/main/agent/，复制 auth-profiles.json 到目录下
      const hostAgentDir = `${CONTAINER_SANDBOX_PATH}/agents/main/agent`;
      if (!existsSync(hostAgentDir)) {
        mkdirSync(hostAgentDir, { recursive: true });
        logger.info(`Created agent directory: ${hostAgentDir}`);
      }

      const hostAuthProfilesPath = `${hostAgentDir}/auth-profiles.json`;
      if (!existsSync(hostAuthProfilesPath)) {
        const templateAuthProfilesPath = `${templateDir}/auth-profiles.json`;
        try {
          writeFileSync(hostAuthProfilesPath, readFileSync(templateAuthProfilesPath));
          logger.info(`Copied auth-profiles.json from template to ${hostAuthProfilesPath}`);
        } catch (e) {
          logger.warning(`Failed to copy auth-profiles.json: ${e}`);
        }
      } else {
        logger.debug(`auth-profiles.json already exists, skipping copy`);
      }

      // 确保 agent 目录也有写权限
      execSync(`chmod -R 777 ${CONTAINER_SANDBOX_PATH}`);
      logger.info(`Set chmod -R 777 on HOST_PATH: ${CONTAINER_SANDBOX_PATH}`);
    } catch (e) {
      logger.warning(`Failed to setup user config: ${e}`);
    }

    logger.info(`Igniting sandbox for user ${userId}...`);

    let mainContainer: Docker.Container | null = null;
    let proxyContainer: Docker.Container | null = null;

    try {
      // ==================== Step 1: Create and Start Main Container ====================
      mainContainer = await this.docker.createContainer({
        name: mainContainerName,
        Hostname: mainContainerName,
        Image: dockerConfig.image,
        Env: [
          ...Object.entries(dockerConfig.environment).map(([k, v]) => `${k}=${v}`),
          `OPENCLAW_GATEWAY_TOKEN=${gatewayToken}`,
          `OPENCLAW_USER_TOKEN=${userToken}`,
          // LLM API Keys
          // Direct API key for zai provider
          `ZHIPU_API_KEY=${process.env.ZHIPU_API_KEY_GLM5 || process.env.ZHIPU_API_KEY_GLM4 || process.env.LLM_API_KEY}`,
          // Alternative with OPENCLAW_ENV_ prefix
          `OPENCLAW_ENV_ZHIPU_API_KEY=${process.env.ZHIPU_API_KEY_GLM5 || process.env.ZHIPU_API_KEY_GLM4 || process.env.LLM_API_KEY}`,
          `OPENCLAW_ENV_ZHIPU_API_KEY_GLM4=${process.env.ZHIPU_API_KEY_GLM4}`,
          `OPENCLAW_ENV_ZHIPU_API_KEY_GLM5=${process.env.ZHIPU_API_KEY_GLM5}`,
          `OPENCLAW_ENV_LLM_API_KEY=${process.env.LLM_API_KEY}`,
          `OPENCLAW_ENV_LLM_MODEL=${process.env.LLM_MODEL || 'glm-4.7'}`,
          `OPENCLAW_ENV_LLM_BASE_URL=${process.env.LLM_BASE_URL}`,
          `OPENCLAW_ENV_LLM_PROVIDER=${process.env.LLM_PROVIDER || 'zai'}`,
        ],
        // Bind to loopback only (127.0.0.1:18789) - NO EXTERNAL ACCESS
        Cmd: [
          'node',
          'openclaw.mjs',
          'gateway',
          '--allow-unconfigured',
          '--bind', 'loopback',
          '--token', gatewayToken,
        ],
        HostConfig: {
          NetworkMode: dockerConfig.network,
          // 全量挂载启动：Binds: [ "${HOST_PATH}:/home/node/.openclaw:rw" ]
          Binds: [
            `${HOST_PATH}:/home/node/.openclaw:rw`
          ],
          AutoRemove: dockerConfig.autoRemove,
          // ABSOLUTELY NO PortBindings - no host port exposure
        },
      });

      await mainContainer.start();
      logger.info(`Main container started: ${mainContainerName} (${mainContainer.id})`);

      // Wait a moment for main container to initialize
      await new Promise(resolve => setTimeout(resolve, 1000));

      // ==================== Step 2: Create and Start Sidecar Proxy ====================
      // Sidecar shares network namespace with main container (network parasitism)
      proxyContainer = await this.docker.createContainer({
        name: proxyContainerName,
        Image: 'alpine/socat:1.0.5',
        HostConfig: {
          NetworkMode: `container:${mainContainer.id}`,
        },
        Cmd: [
          '-d', '-d',
          'tcp-listen:38789,fork,reuseaddr',
          'tcp-connect:127.0.0.1:18789'
        ],
      });

      await proxyContainer.start();
      logger.info(`Sidecar proxy started: ${proxyContainerName} (${proxyContainer.id})`);

      // ==================== Step 3: Store references and return ====================
      this.containers.set(userId, mainContainer);
      this.proxyContainers.set(userId, proxyContainer);

      const info: DockerContainerInfo = {
        containerId: mainContainer.id,
        proxyContainerId: proxyContainer.id,
        userId,
        userToken,
        gatewayToken,
        port: 38789, // External port (via sidecar)
        internalPort: 18789, // Internal port (main container loopback)
        status: 'running',
        createdAt: new Date()
      };

      logger.success(`Sandbox ignited: ${mainContainerName} with sidecar ${proxyContainerName}`);
      logger.debug(`Gateway token: ${gatewayToken}`);
      return info;
    } catch (error: any) {
      // ==================== Cleanup on failure ====================
      logger.error(`Failed to ignite sandbox: ${error.message}`);

      // Try to cleanup proxy container first
      if (proxyContainer) {
        try {
          await proxyContainer.remove({ force: true });
          logger.info(`Cleaned up proxy container: ${proxyContainerName}`);
        } catch (e) {
          logger.warning(`Failed to cleanup proxy container: ${e}`);
        }
      }

      // Then cleanup main container
      if (mainContainer) {
        try {
          await mainContainer.remove({ force: true });
          logger.info(`Cleaned up main container: ${mainContainerName}`);
        } catch (e) {
          logger.warning(`Failed to cleanup main container: ${e}`);
        }
      }

      // Remove from maps
      this.containers.delete(userId);
      this.proxyContainers.delete(userId);

      throw error;
    }
  }

  async stopSandbox(userId: string): Promise<void> {
    logger.info(`Stopping sandbox for user ${userId}...`);

    // Stop and remove proxy container first
    const proxyContainer = this.proxyContainers.get(userId);
    if (proxyContainer) {
      try {
        await proxyContainer.stop({ t: 10 });
        await proxyContainer.remove();
        this.proxyContainers.delete(userId);
        logger.info(`Proxy container stopped for ${userId}`);
      } catch (e) {
        logger.warning(`Failed to stop proxy container: ${e}`);
      }
    }

    // Stop and remove main container
    const container = this.containers.get(userId);
    if (!container) {
      logger.warning(`No main container found for user ${userId}`);
      return;
    }

    try {
      await container.stop({ t: 10 });
      await container.remove();
      this.containers.delete(userId);
      logger.success(`Sandbox stopped for ${userId}`);
    } catch (e) {
      logger.error(`Failed to stop main container: ${e}`);
      throw e;
    }
  }

  /**
   * Find existing main container for user by name
   */
  async findExistingContainer(userId: string): Promise<Docker.Container | null> {
    const safeId = this.sanitizeUserId(userId);
    const containerName = `${dockerConfig.containerPrefix}${safeId}`;

    try {
      const container = await this.docker.getContainer(containerName);
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
   * Remove sandbox containers (main + proxy) for user
   */
  async removeSandbox(userId: string): Promise<void> {
    const safeId = this.sanitizeUserId(userId);
    const mainContainerName = `${dockerConfig.containerPrefix}${safeId}`;
    const proxyContainerName = `${dockerConfig.containerPrefix}${safeId}${PROXY_CONTAINER_SUFFIX}`;

    // Remove proxy container first
    try {
      const proxyContainer = await this.docker.getContainer(proxyContainerName);
      await proxyContainer.remove({ force: true });
      logger.info(`Removed proxy container: ${proxyContainerName}`);
      this.proxyContainers.delete(userId);
    } catch (error: any) {
      if (error.statusCode !== 404) {
        logger.warning(`Failed to remove proxy container: ${error.message}`);
      }
    }

    // Remove main container
    try {
      const mainContainer = await this.docker.getContainer(mainContainerName);
      await mainContainer.remove({ force: true });
      logger.info(`Removed main container: ${mainContainerName}`);
      this.containers.delete(userId);
    } catch (error: any) {
      if (error.statusCode !== 404) {
        logger.warning(`Failed to remove main container: ${error.message}`);
      }
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
        status: state.Status.toLowerCase(),
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
   * Start an existing stopped container (with sidecar support)
   */
  async startExistingContainer(userId: string, userToken?: string): Promise<DockerContainerInfo> {
    const safeId = this.sanitizeUserId(userId);
    const mainContainerName = `${dockerConfig.containerPrefix}${safeId}`;
    const proxyContainerName = `${dockerConfig.containerPrefix}${safeId}${PROXY_CONTAINER_SUFFIX}`;
    logger.info(`Starting existing container for user ${userId}...`);

    try {
      const mainContainer = await this.docker.getContainer(mainContainerName);
      await mainContainer.start();

      // Start proxy container if it exists
      const proxyContainer = await this.docker.getContainer(proxyContainerName);
      try {
        await proxyContainer.start();
        this.proxyContainers.set(userId, proxyContainer);
        logger.info(`Proxy container started: ${proxyContainerName}`);
      } catch (e) {
        // Proxy may not exist, that's ok
        logger.warning(`Proxy container not found or failed to start: ${e}`);
      }

      const gatewayToken = this.generateGatewayToken();
      this.containers.set(userId, mainContainer);

      const info: DockerContainerInfo = {
        containerId: mainContainer.id,
        proxyContainerId: proxyContainer?.id,
        userId,
        userToken: userToken || '',
        gatewayToken,
        port: 38789,
        status: 'running',
        createdAt: new Date()
      };

      logger.success(`Existing container started: ${mainContainerName}`);
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
