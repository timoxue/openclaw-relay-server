import { dockerOrchestrator } from './docker-orchestrator';
import { feishuAPI } from './feishu-api';
import { tokenService } from './token';
import { wsTunnel } from './ws-tunnel';
import { UserSandboxState, DockerContainerInfo, IgniteOptions, FeishuWSMessage } from '../types';
import { waitForPort } from '../utils/network';

// ============================================================================
// Types
// ============================================================================

interface AgentConfig {
  name: string;
  displayName: string;
  containerPrefix: string;
  hasContainer: boolean;
}

enum UserMode {
  DEFAULT = 'default',
  AGENT = 'agent',
}

// ============================================================================
// Helpers
// ============================================================================

function sanitizeUserId(userId: string): string {
  return userId.replace(/_/g, '-').toLowerCase();
}

function extractText(content: string | undefined): string {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content);
    return parsed.text || content;
  } catch (e) {
    return content;
  }
}

export async function sendFeishuMessage(userId: string, text: string): Promise<boolean> {
  return feishuAPI.sendTextMessage(userId, text);
}

function getStatusDescription(status: string): string {
  const descriptions: Record<string, string> = {
    'running': '运行中',
    'exited': '已停止',
    'stopped': '已停止',
    'paused': '已暂停',
    'restarting': '重启中',
    'removing': '删除中',
    'dead': '已停止（异常）',
    'created': '已创建',
    'not_started': '未启动',
  };
  return descriptions[status] || status;
}

// ============================================================================
// Predefined Agents
// ============================================================================

const PREDEFINED_AGENTS = new Map<string, AgentConfig>([
  ['openclaw', {
    name: 'openclaw',
    displayName: 'OpenClaw',
    containerPrefix: 'openclaw-sandbox-',
    hasContainer: true,
  }],
]);

// ============================================================================
// Main Class
// ============================================================================

export class SynapseOrchestrator {
  private stateMachine: Map<string, UserSandboxState> = new Map();
  private userModes: Map<string, UserMode> = new Map();
  private userAgents: Map<string, string> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startCleanupInterval();
  }

  // ==================== Public API ====================

  async handleFeishuMessage(message: FeishuWSMessage): Promise<void> {
    const userId = sanitizeUserId(message.event.sender.sender_id.user_id);
    const textContent = extractText(message.event.message.content);
    const text = textContent.trim();

    console.log(`[Orchestrator] ${userId}: ${text}`);

    // Check for commands first
    if (await this.handleCommand(userId, text)) {
      return;
    }

    // Handle mode-specific messages
    const mode = this.getUserMode(userId);
    if (mode === UserMode.AGENT) {
      await this.handleAgentMode(userId, text);
      return;
    }

    await this.handleDefaultMode(userId, text);
  }

  // ==================== Command Handling ====================

  private async handleCommand(userId: string, text: string): Promise<boolean> {
    // Exit commands
    if (/^!(exit|quit)$/i.test(text)) {
      await this.exitAgentMode(userId);
      return true;
    }

    // Agent commands: !openclaw [command]
    const agentMatch = text.match(/^!([a-z0-9_]+)\s*(.*)?$/i);
    if (agentMatch) {
      const agentName = agentMatch[1].toLowerCase();
      const command = (agentMatch[2] || '').trim();
      await this.handleAgentCommand(userId, agentName, command);
      return true;
    }

    return false;
  }

  private async handleAgentCommand(userId: string, agentName: string, command: string): Promise<void> {
    const config = PREDEFINED_AGENTS.get(agentName);
    if (!config) {
      await sendFeishuMessage(userId, `未知智能体: ${agentName}`);
      return;
    }

    this.setUserAgent(userId, agentName);

    const handlers: Record<string, () => Promise<void>> = {
      '': () => this.enterAgentMode(userId, agentName),
      'start': () => this.startContainer(userId, agentName),
      'stop': () => this.stopContainer(userId),
      'status': () => this.sendStatus(userId, agentName),
      'restart': () => this.restartContainer(userId, agentName),
      'rebuild': () => this.rebuildContainer(userId),
      'help': () => this.sendHelp(userId, agentName),
    };

    const handler = handlers[command];
    if (handler) {
      await handler();
    } else {
      await sendFeishuMessage(userId, `未知命令: ${command}\n使用 !${agentName} help 查看帮助`);
    }
  }

  // ==================== Mode Handling ====================

  private async handleAgentMode(userId: string, text: string): Promise<void> {
    const agentName = this.getUserAgent(userId);
    if (!agentName) {
      await this.exitAgentMode(userId);
      return;
    }

    if (/^!(exit|quit)$/i.test(text)) {
      await this.exitAgentMode(userId);
      return;
    }

    await this.forwardMessage(userId, text);
  }

  private async handleDefaultMode(userId: string, text: string): Promise<void> {
    const state = this.getUserState(userId);
    if (!state.containerInfo) {
      const hint = this.getWelcomeHint();
      await sendFeishuMessage(userId, hint);
      return;
    }

    await sendFeishuMessage(userId, `收到: ${text}\n使用 !openclaw 进入交互模式`);
  }

  private async enterAgentMode(userId: string, agentName: string): Promise<void> {
    this.setUserMode(userId, UserMode.AGENT);
    await this.sendStatus(userId, agentName);
  }

  private async exitAgentMode(userId: string): Promise<void> {
    const agent = this.getUserAgent(userId);
    this.userModes.delete(userId);
    this.userAgents.delete(userId);
    await sendFeishuMessage(userId, agent ? `已退出 ${agent} 模式` : '已退出');
  }

  // ==================== Container Operations ====================

  private async startContainer(userId: string, agentName: string): Promise<void> {
    const config = PREDEFINED_AGENTS.get(agentName);
    const containerName = `${config?.containerPrefix || 'sandbox-'}${userId}`;

    const existingStatus = await this.getContainerStatus(containerName);
    if (existingStatus.status === 'running') {
      await sendFeishuMessage(userId, `容器 ${containerName} 已在运行`);
      return;
    }

    if (existingStatus.exists) {
      await this.stopContainer(userId);
    }

    await this.igniteSandbox(userId, agentName);
  }

  private async stopContainer(userId: string): Promise<void> {
    const agentName = this.getUserAgent(userId) || 'openclaw';
    const config = PREDEFINED_AGENTS.get(agentName);
    const containerName = `${config?.containerPrefix || 'sandbox-'}${userId}`;

    const status = await this.getContainerStatus(containerName);
    if (!status.exists || status.status === 'stopped') {
      await sendFeishuMessage(userId, '容器未运行');
      return;
    }

    wsTunnel.disconnectAll(userId);
    await dockerOrchestrator.stopSandbox(userId);
    this.clearContainerState(userId);
    await sendFeishuMessage(userId, '容器已停止');
  }

  private async restartContainer(userId: string, agentName: string): Promise<void> {
    await this.rebuildContainer(userId);
  }

  private async rebuildContainer(userId: string): Promise<void> {
    const agentName = this.getUserAgent(userId) || 'openclaw';
    const config = PREDEFINED_AGENTS.get(agentName);
    const containerName = `${config?.containerPrefix || 'sandbox-'}${userId}`;

    wsTunnel.disconnectAll(userId);

    const existingStatus = await dockerOrchestrator.getExistingContainerStatus(containerName);
    if (existingStatus.exists && existingStatus.container) {
      try {
        await existingStatus.container.stop({ t: 10 });
        await existingStatus.container.remove();
        console.log(`[Orchestrator] Removed ${containerName}`);
      } catch (e) {
        console.error(`[Orchestrator] Remove error: ${e}`);
      }
    }

    this.clearContainerState(userId);
    await this.igniteSandbox(userId, agentName);
    await sendFeishuMessage(userId, '容器已重新搭建');
  }

  private async igniteSandbox(userId: string, agentName: string): Promise<void> {
    const state = this.getUserState(userId);
    const config = PREDEFINED_AGENTS.get(agentName);
    const containerName = `${config?.containerPrefix || 'sandbox-'}${userId}`;

    try {
      const result = await dockerOrchestrator.igniteSandbox({
        userId,
        userToken: state.userToken,
      });

      // Note: Sidecar proxy waits for main container internally, no external port check needed
      // Just give containers a moment to fully initialize before WebSocket connection
      // Main container takes ~10 seconds to fully start the Gateway service
      console.log(`[Orchestrator] Waiting for containers to initialize...`);
      await new Promise(resolve => setTimeout(resolve, 10000));
      console.log(`[Orchestrator] Containers initialized, connecting WS...`);

      // Establish WebSocket tunnel connection to sidecar proxy
      try {
        await wsTunnel.connectToContainer(userId, result.gatewayToken);
        console.log(`[Orchestrator] WS tunnel connected for user ${userId}`);
      } catch (tunnelError) {
        console.error(`[Orchestrator] Failed to connect WS tunnel: ${tunnelError}`);
        // Continue anyway, will be retried on send
      }

      state.containerInfo = {
        containerId: result.containerId,
        proxyContainerId: result.proxyContainerId,
        userId,
        userToken: state.userToken,
        gatewayToken: result.gatewayToken,
        port: result.port || 38789,
        status: 'running',
        createdAt: new Date(),
      };

      state.lastActivity = new Date();
      await sendFeishuMessage(userId, `容器 ${containerName} 启动成功`);
    } catch (e) {
      console.error(`[Orchestrator] Ignite error: ${e}`);
      await sendFeishuMessage(userId, '容器启动失败，请重试');
    }
  }

  // ==================== Status & Messages ====================

  private async sendStatus(userId: string, agentName: string): Promise<void> {
    const config = PREDEFINED_AGENTS.get(agentName);
    const containerName = `${config?.containerPrefix || 'sandbox-'}${userId}`;
    const status = await this.getContainerStatus(containerName);

    let message = `**${config?.displayName || agentName}**\n\n`;
    message += `容器: ${containerName}\n`;
    message += `状态: ${getStatusDescription(status.status)}\n\n`;

    if (status.status === 'running') {
      message += `可用命令:\n`;
      message += `• !${agentName} <消息> - 发送消息\n`;
      message += `• !${agentName} stop - 停止\n`;
      message += `• !${agentName} rebuild - 重建\n`;
      message += `• !exit - 退出模式`;
    } else {
      message += `可用命令:\n`;
      message += `• !${agentName} start - 启动\n`;
      message += `• !${agentName} rebuild - 重建`;
    }

    await sendFeishuMessage(userId, message);
  }

  private async sendHelp(userId: string, agentName: string): Promise<void> {
    const config = PREDEFINED_AGENTS.get(agentName);
    const help = `**${config?.displayName || agentName} 帮助**\n\n` +
      `命令:\n` +
      `• !${agentName} status - 状态\n` +
      `• !${agentName} start - 启动\n` +
      `• !${agentName} stop - 停止\n` +
      `• !${agentName} restart - 重启\n` +
      `• !${agentName} rebuild - 重建\n` +
      `• !${agentName} help - 帮助\n` +
      `• !exit - 退出`;
    await sendFeishuMessage(userId, help);
  }

  private getWelcomeHint(): string {
    return `**欢迎使用 OpenClaw**\n\n` +
      `快速开始:\n` +
      `• !openclaw start - 启动容器\n` +
      `• !openclaw help - 查看帮助\n` +
      `• !exit - 退出`;
  }

  private async forwardMessage(userId: string, text: string): Promise<void> {
    const state = this.getUserState(userId);
    if (!state.containerInfo) {
      await sendFeishuMessage(userId, '容器未运行');
      return;
    }

    console.log(`[Orchestrator] Forwarding to ${userId}: ${text}`);
    await wsTunnel.sendChatMessage(userId, text);
  }

  // ==================== State Helpers ====================

  private getUserState(userId: string): UserSandboxState {
    let state = this.stateMachine.get(userId);
    if (!state) {
      state = {
        userId,
        userToken: tokenService.getOrCreateUserToken(userId),
        containerInfo: null,
        awaitingConfirmation: false,
        lastActivity: new Date(),
      };
      this.stateMachine.set(userId, state);
    } else {
      state.lastActivity = new Date();
    }
    return state;
  }

  private clearContainerState(userId: string): void {
    const state = this.stateMachine.get(userId);
    if (state) {
      state.containerInfo = null;
      state.awaitingConfirmation = false;
      state.lastActivity = new Date();
    }
  }

  private getUserMode(userId: string): UserMode {
    return this.userModes.get(userId) || UserMode.DEFAULT;
  }

  private setUserMode(userId: string, mode: UserMode): void {
    this.userModes.set(userId, mode);
  }

  private getUserAgent(userId: string): string | null {
    return this.userAgents.get(userId) || null;
  }

  private setUserAgent(userId: string, agentName: string): void {
    this.userAgents.set(userId, agentName);
  }

  private async getContainerStatus(containerName: string): Promise<{ exists: boolean; status: string }> {
    try {
      const result = await dockerOrchestrator.getExistingContainerStatus(containerName);
      return {
        exists: result.exists,
        status: result.status || 'not_started',
      };
    } catch (e) {
      console.error(`[Orchestrator] Status check error: ${e}`);
      return { exists: false, status: 'not_started' };
    }
  }

  // ==================== Cleanup ====================

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupInactiveStates();
    }, 5 * 60 * 1000);
    console.log('[Orchestrator] Cleanup started');
  }

  private stopCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  private cleanupInactiveStates(): void {
    const now = Date.now();
    const hourAgo = now - 60 * 60 * 1000;

    for (const [userId, state] of this.stateMachine.entries()) {
      if (state.lastActivity.getTime() < hourAgo) {
        this.cleanupUser(userId);
      }
    }
  }

  private cleanupUser(userId: string): void {
    const state = this.stateMachine.get(userId);
    if (state?.containerInfo) {
      wsTunnel.disconnectAll(userId);
      dockerOrchestrator.stopSandbox(userId).catch((e) => {
        console.error(`[Orchestrator] Cleanup error: ${e}`);
      });
    }
    this.stateMachine.delete(userId);
    this.userModes.delete(userId);
    this.userAgents.delete(userId);
  }

  // ==================== Public Sandbox Control ====================

  async stopSandbox(userId: string): Promise<void> {
    await this.stopContainer(userId);
  }

  async rebuildSandbox(userId: string): Promise<void> {
    await this.rebuildContainer(userId);
  }

  // ==================== Lifecycle ====================

  async initialize(): Promise<void> {
    console.log('[Orchestrator] Initialized');
  }

  async shutdown(): Promise<void> {
    console.log('[Orchestrator] Shutting down...');
    this.stopCleanupInterval();
    wsTunnel.shutdown();

    for (const userId of this.stateMachine.keys()) {
      await dockerOrchestrator.stopSandbox(userId).catch((e) => {
        console.error(`[Orchestrator] Stop error: ${e}`);
      });
    }

    this.stateMachine.clear();
    this.userModes.clear();
    this.userAgents.clear();
    console.log('[Orchestrator] Shutdown complete');
  }

  // ==================== Public Accessors ====================

  getActiveStates(): UserSandboxState[] {
    return Array.from(this.stateMachine.values());
  }

  getUserModes(): Map<string, UserMode> {
    return new Map(this.userModes);
  }

  getUserAgents(): Map<string, string> {
    return new Map(this.userAgents);
  }
}

// Singleton
export const orchestrator = new SynapseOrchestrator();
