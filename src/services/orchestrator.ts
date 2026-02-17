import { dockerOrchestrator } from './docker-orchestrator';
import { sendFeishuMessage } from './feishu-client';
import { tokenService } from './token';
import { wsTunnel } from './ws-tunnel';
import { UserSandboxState, DockerContainerInfo, IgniteOptions, FeishuWSMessage } from '../types';

/**
 * User interaction modes
 */
enum UserMode {
  DEFAULT = 'default',        // 默认模式，正常交流
  AGENT = 'agent',             // 智能体/用户模式
}

/**
 * Agent configuration
 */
interface AgentConfig {
  name: string;              // 智能体名称 (如 "_user_1", "claude", "gpt", "openclaw")
  displayName: string;         // 显示名称 (如 "User 1", "Claude", "GPT", "OpenClaw")
  containerPrefix?: string;   // 容器前缀 (如 "openclaw-sandbox-", "claude-sandbox-", "gpt-sandbox-")
  hasContainer?: boolean;     // 是否有容器
}

/**
 * Core Orchestrator with State Machine
 *
 * Manages user sandbox states, agent modes, and coordinates Docker containers and Feishu WebSocket.
 */
export class SynapseOrchestrator {
  // In-memory state machine: userId -> UserSandboxState
  private stateMachine: Map<string, UserSandboxState> = new Map();

  // User interaction modes: userId -> UserMode
  private userModes: Map<string, UserMode> = new Map();

  // User current agent: userId -> agent name (如 "_user_1", "claude", "openclaw")
  private userAgents: Map<string, string> = new Map();

  // Predefined agent configurations
  private predefinedAgents: Map<string, AgentConfig> = new Map([
    ['openclaw', {
      name: 'openclaw',
      displayName: 'OpenClaw',
      containerPrefix: 'openclaw-sandbox-',
      hasContainer: false,
    }],
  ]);

  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start periodic cleanup of inactive states
    this.startCleanupInterval();
  }

  /**
   * Get or create user state
   */
  getUserState(userId: string): UserSandboxState {
    let state = this.stateMachine.get(userId);

    if (!state) {
      state = {
        userId,
        userToken: this.generateUserToken(userId),
        containerInfo: null,
        awaitingConfirmation: false,
        lastActivity: new Date(),
      };
      this.stateMachine.set(userId, state);
      console.log(`[Orchestrator] Created new state for user ${userId}`);
    } else {
      // Update last activity
      state.lastActivity = new Date();
    }

    return state;
  }

  /**
   * Get current user mode
   */
  getUserMode(userId: string): UserMode {
    return this.userModes.get(userId) || UserMode.DEFAULT;
  }

  /**
   * Set user mode
   */
  setUserMode(userId: string, mode: UserMode): void {
    this.userModes.set(userId, mode);
    console.log(`[Orchestrator] User ${userId} mode set to: ${mode}`);
  }

  /**
   * Get user's current agent
   */
  getUserAgent(userId: string): string | null {
    return this.userAgents.get(userId) || null;
  }

  /**
   * Set user's current agent
   */
  setUserAgent(userId: string, agentName: string): void {
    this.userAgents.set(userId, agentName);
    console.log(`[Orchestrator] User ${userId} agent set to: ${agentName}`);
  }

  /**
   * Get agent configuration by name
   */
  getAgentConfig(agentName: string): AgentConfig | null {
    return this.predefinedAgents.get(agentName) || null;
  }

  /**
   * Generate user-specific token using tokenService
   */
  private generateUserToken(userId: string): string {
    return tokenService.getOrCreateUserToken(userId);
  }

  /**
   * Handle incoming Feishu messages with agent mode support
   */
  async handleFeishuMessage(message: FeishuWSMessage): Promise<void> {
    const userId = message.event.sender.sender_id.user_id;
    const content = message.event.message.content;

    console.log(`[Orchestrator] Handling message from user ${userId}: content=${content}`);

    // Parse message content to extract actual text
    const textContent = this.extractText(content);

    // Priority 1: Handle explicit commands (highest priority)
    if (await this.handleExplicitCommands(userId, textContent)) {
      return;
    }

    // Priority 2: Handle agent mode messages
    const currentMode = this.getUserMode(userId);
    if (currentMode === UserMode.AGENT) {
      await this.handleAgentMode(userId, textContent);
      return;
    }

    // Priority 3: Default mode - normal conversation
    await this.handleDefaultMode(userId, textContent);
  }

  /**
   * Extract text from Feishu message content
   * Feishu sends content as JSON string like {"text":"启动"}
   */
  private extractText(content: string | undefined): string {
    if (!content) return '';

    try {
      const parsed = JSON.parse(content);
      return parsed.text || content;
    } catch (e) {
      // Not JSON, use content as-is
      return content;
    }
  }

  /**
   * Handle explicit commands (@agent, @exit, etc.)
   * Returns true if command was handled, false otherwise
   */
  private async handleExplicitCommands(userId: string, textContent: string): Promise<boolean> {
    const text = textContent.trim();

    console.log(`[Orchestrator] Checking explicit commands: "${text}"`);

    // Handle @agent format: @_user_1, @claude, @openclaw, @gpt, etc.
    const agentRegex = /^@([a-zA-Z0-9_]+)\s*(.*)?$/i;
    const agentMatch = text.match(agentRegex);
    if (agentMatch) {
      const agentName = agentMatch[1].toLowerCase();
      const command = agentMatch[2] ? agentMatch[2].trim() : '';
      console.log(`[Orchestrator] Agent command: @${agentName} ${command ? command : '(no command)'}`);
      await this.handleAgentCommand(userId, agentName, command);
      return true;
    }

    // Handle @exit/@quit (exit current mode)
    const exitRegex = /^@(exit|quit)$/i;
    if (exitRegex.test(text)) {
      console.log(`[Orchestrator] Exiting current mode`);
      await this.exitCurrentMode(userId);
      return true;
    }

    // Legacy commands for backward compatibility
    if (text.toLowerCase() === '启动' || text.toLowerCase() === 'ignite') {
      console.log(`[Orchestrator] Legacy ignite command`);
      await this.igniteSandboxWithCheck(userId);
      return true;
    }

    if (text.toLowerCase() === '停止' || text.toLowerCase() === 'stop') {
      console.log(`[Orchestrator] Legacy stop command`);
      await this.stopSandbox(userId);
      return true;
    }

    if (text.toLowerCase() === '取消' || text.toLowerCase() === 'cancel') {
      console.log(`[Orchestrator] Legacy cancel command`);
      await sendFeishuMessage(userId, '已取消操作。');
      return true;
    }

    if (text.toLowerCase() === '重新搭建' || text.toLowerCase() === 'rebuild') {
      console.log(`[Orchestrator] Legacy rebuild command`);
      await this.rebuildSandbox(userId);
      return true;
    }

    return false;
  }

  /**
   * Handle agent mode messages
   */
  private async handleAgentMode(userId: string, textContent: string): Promise<void> {
    const agentName = this.getUserAgent(userId);
    if (!agentName) {
      console.warn(`[Orchestrator] No agent set for user ${userId}`);
      await this.exitCurrentMode(userId);
      return;
    }

    const agentConfig = this.getAgentConfig(agentName);
    const text = textContent.trim();

    console.log(`[Orchestrator] [Agent模式 ${agentName}] 处理消息: ${text}`);

    // Check if @exit is included in message
    const exitRegex = /^@(exit|quit)$/i;
    if (exitRegex.test(text)) {
      await this.exitCurrentMode(userId);
      return;
    }

    // Check agent status and container
    const state = this.getUserState(userId);
    const containerPrefix = agentConfig?.containerPrefix || `${agentName}-sandbox-`;
    const containerName = `${containerPrefix}${userId}`;
    const hasContainer = !!state.containerInfo;

    if (!hasContainer) {
      await sendFeishuMessage(
        userId,
        `容器${containerName}未运行。请先使用 @${agentName} status 查看状态，或 @${agentName} start/restart 启动容器。`
      );
      return;
    }

    // Forward message to container
    console.log(`[Orchestrator] [${agentName}模式] 转发消息给容器${containerName}: ${text}`);
    await this.forwardToContainer(userId, text);
  }

  /**
   * Handle default mode messages
   */
  private async handleDefaultMode(userId: string, textContent: string): Promise<void> {
    const state = this.getUserState(userId);
    const agentName = this.getUserAgent(userId);
    const containerPrefix = agentName ? (this.getAgentConfig(agentName)?.containerPrefix || `${agentName}-sandbox-`) : 'openclaw-sandbox-';
    const containerName = `${containerPrefix}${userId}`;

    // If user has no container, send quick start hint
    if (!state.containerInfo) {
      const hint = `
**欢迎使用 OpenClaw**

快速开始：
• @openclaw - 进入OpenClaw控制模式
• 启动 - 启动沙箱容器

帮助：
• @openclaw help - 查看所有可用命令
• @exit - 退出当前模式
      `.trim();
      await sendFeishuMessage(userId, hint);
      return;
    }

    // Default response for normal conversation
    const agentDisplay = agentName ? this.getAgentConfig(agentName)?.displayName || agentName : 'OpenClaw';
    await sendFeishuMessage(
      userId,
      `收到消息: ${textContent}\n\n提示：使用 @${agentName} 进入${agentDisplay}模式与容器${containerName}交互。`
    );
  }

  /**
   * Enter agent control mode
   */
  private async enterAgentMode(userId: string, agentName: string): Promise<void> {
    this.setUserMode(userId, UserMode.AGENT);
    this.setUserAgent(userId, agentName);
    await this.sendAgentMenu(userId, agentName);
  }

  /**
   * Exit current mode (return to default)
   */
  private async exitCurrentMode(userId: string): Promise<void> {
    const previousMode = this.getUserMode(userId);
    const previousAgent = this.getUserAgent(userId);

    if (previousMode === UserMode.DEFAULT) {
      await sendFeishuMessage(userId, '当前已在默认模式。');
      return;
    }

    this.userModes.delete(userId);
    this.userAgents.delete(userId);

    const agentDisplay = previousAgent ? (this.getAgentConfig(previousAgent)?.displayName || previousAgent) : previousAgent;
    await sendFeishuMessage(userId, `已退出${agentDisplay}模式，返回默认模式。`);
  }

  /**
   * Handle @agent <command> explicit commands
   */
  private async handleAgentCommand(userId: string, agentName: string, command: string): Promise<void> {
    const cmd = command.toLowerCase().trim();
    const agentConfig = this.getAgentConfig(agentName);
    const agentDisplay = agentConfig?.displayName || agentName;

    console.log(`[Orchestrator] Executing @${agentName} command: ${cmd}`);

    switch (cmd) {
      case 'status':
        await this.handleAgentStatus(userId, agentName);
        break;

      case 'start':
      case 'restart':
        await this.handleAgentStartOrRestart(userId, agentName, cmd);
        break;

      case 'stop':
        await this.handleAgentStop(userId, agentName);
        break;

      case 'rebuild':
        await this.handleAgentRebuild(userId, agentName);
        break;

      case 'help':
        await this.handleAgentHelp(userId, agentName);
        break;

      case '':
        // Just @agent, show menu
        await this.enterAgentMode(userId, agentName);
        break;

      default:
        // Unknown command, show menu
        await sendFeishuMessage(userId, `未知命令: ${cmd}\n\n请使用 @${agentName} help 查看所有可用命令。`);
    }
  }

  /**
   * Handle @agent status
   */
  private async handleAgentStatus(userId: string, agentName: string): Promise<void> {
    const agentConfig = this.getAgentConfig(agentName);
    const agentDisplay = agentConfig?.displayName || agentName;
    const containerPrefix = agentConfig?.containerPrefix || `${agentName}-sandbox-`;
    const containerName = `${containerPrefix}${userId}`;

    const state = this.getUserState(userId);
    const status = state.containerInfo ? state.containerInfo.status : 'not_started';

    if (!state.containerInfo) {
      await sendFeishuMessage(
        userId,
        `
**${agentDisplay} 状态**

容器名称：${containerName}
状态：不存在

可用操作：
• @${agentName} start - 启动容器
• @${agentName} rebuild - 创建新容器
        `.trim()
      );
      return;
    }

    await sendFeishuMessage(
      userId,
      `
**${agentDisplay} 状态**

容器名称：${containerName}
状态：${this.getStateDescription(status)}
        `.trim()
    );

    if (status === 'running') {
      await sendFeishuMessage(
        userId,
        `
当前容器正在运行。

可用操作：
• @${agentName} <消息> - 转发消息给容器
• @${agentName} restart - 重启容器
• @${agentName} stop - 停止容器
• @${agentName} rebuild - 重新部署
• @exit - 退出控制模式
        `.trim()
      );
    }
  }

  /**
   * Handle @agent start/restart
   */
  private async handleAgentStartOrRestart(userId: string, agentName: string, command: string): Promise<void> {
    const agentConfig = this.getAgentConfig(agentName);
    const agentDisplay = agentConfig?.displayName || agentName;
    const containerPrefix = agentConfig?.containerPrefix || `${agentName}-sandbox-`;
    const containerName = `${containerPrefix}${userId}`;
    const state = this.getUserState(userId);

    // Check if container exists using correct prefix
    const status = await dockerOrchestrator.getExistingContainerStatus(containerName);

    if (!status.exists) {
      // Container doesn't exist, start new one
      console.log(`[Orchestrator] Creating new container for user ${userId}`);
      await this.igniteSandboxForAgent(userId, agentName);
      return;
    }

    if (status.status === 'running') {
      if (command === 'restart') {
        console.log(`[Orchestrator] Restarting container for user ${userId}`);
        await this.rebuildSandboxForAgent(userId, agentName);
      } else {
        await sendFeishuMessage(userId, `容器已在运行。\n\n使用 @${agentName} restart 重启容器。`);
      }
      return;
    }

    // Container is stopped, start it
    console.log(`[Orchestrator] Starting existing container for user ${userId}`);
    try {
      const containerInfo = await dockerOrchestrator.startExistingContainer(userId, state.userToken);
      this.getUserState(userId).containerInfo = containerInfo;

      // Connect to container via WebSocket tunnel
      await wsTunnel.connectToContainer(userId, containerInfo.port);

      await sendFeishuMessage(
        userId,
        `容器启动成功！\n\n容器名称：${containerName}\n智能体：${agentDisplay}`
      );
    } catch (error) {
      console.error(`[Orchestrator] Failed to start container: ${error}`);
      await sendFeishuMessage(userId, '容器启动失败。请重试。');
    }
  }

  /**
   * Handle @agent stop
   */
  private async handleAgentStop(userId: string, agentName: string): Promise<void> {
    await this.stopSandboxForAgent(userId, agentName);
  }

  /**
   * Handle @agent rebuild
   */
  private async handleAgentRebuild(userId: string, agentName: string): Promise<void> {
    await this.rebuildSandboxForAgent(userId, agentName);
  }

  /**
   * Handle @agent help
   */
  private async handleAgentHelp(userId: string, agentName: string): Promise<void> {
    const agentConfig = this.getAgentConfig(agentName);
    const agentDisplay = agentConfig?.displayName || agentName;

    const help = `
**${agentDisplay} 控制命令**

**容器管理**
• @${agentName} status - 查看容器状态
• @${agentName} start - 启动容器
• @${agentName} restart - 重启容器
• @${agentName} stop - 停止容器
• @${agentName} rebuild - 重新部署容器

**模式控制**
• @${agentName} - 进入控制模式
• @exit / @quit - 退出当前模式

**控制模式**
在控制模式下，所有消息都会转发给容器进行交互。

**一次性命令**
• @${agentName} <命令> - 执行一次性命令而不进入模式

**示例**
• @${agentName} status - 查看状态
• @${agentName} 你好 - 一次性交流
• @${agentName} - 进入控制模式
• 你好 - 在控制模式下转发给容器
• @exit - 退出控制模式
    `.trim();

    await sendFeishuMessage(userId, help);
  }

  /**
   * Send agent control mode menu
   */
  private async sendAgentMenu(userId: string, agentName: string): Promise<void> {
    const agentConfig = this.getAgentConfig(agentName);
    const agentDisplay = agentConfig?.displayName || agentName;
    const containerPrefix = agentConfig?.containerPrefix || `${agentName}-sandbox-`;
    const containerName = `${containerPrefix}${userId}`;
    const state = this.getUserState(userId);
    const status = state.containerInfo ? state.containerInfo.status : 'not_started';

    await sendFeishuMessage(
      userId,
      `
**${agentDisplay} 控制模式**

容器名称：${containerName}
当前状态：${this.getStateDescription(status)}

可用命令：
• @${agentName} status - 查看容器状态
• @${agentName} start/restart - ${status === 'running' ? '重启' : '启动'}容器
• @${agentName} stop - 停止容器
• @${agentName} rebuild - 重新部署
• @${agentName} <消息> - 转发消息给容器
• @${agentName} help - 查看所有命令
• @exit - 退出控制模式

现在处于${agentDisplay}控制模式，所有消息都会转发给容器${containerName}。
      `.trim()
    );
  }

  /**
   * Get user-friendly state description
   */
  private getStateDescription(status: string): string {
    const descriptions: { [key: string]: string } = {
      'running': '✅ 运行中',
      'exited': '⏹ 已停止',
      'stopped': '⏹ 已停止',
      'paused': '⏸ 已暂停',
      'restarting': '🔄 重启中',
      'removing': '🗑 删除中',
      'dead': '💀 已停止（异常）',
      'created': '⏳ 已创建',
      'not_started': '⏳ 未启动',
    };

    return descriptions[status] || status;
  }

  /**
   * Ignite sandbox: Create Docker container for user
   */
  private async igniteSandbox(userId: string): Promise<void> {
    const state = this.getUserState(userId);

    console.log(`[Orchestrator] Igniting sandbox for user ${userId}`);

    try {
      const options: IgniteOptions = {
        userId,
        userToken: state.userToken,
      };

      const containerInfo = await dockerOrchestrator.igniteSandbox(options);
      state.containerInfo = containerInfo;
      state.lastActivity = new Date();

      // Connect to container via WebSocket tunnel
      await wsTunnel.connectToContainer(userId, containerInfo.port);

      const containerName = `openclaw-sandbox-${userId}`;
      await sendFeishuMessage(
        userId,
        `沙箱启动成功！\n\n容器名称：${containerName}`
      );

      console.log(`[Orchestrator] Sandbox ignited for user ${userId}: ${containerInfo.containerId}`);
    } catch (error) {
      console.error(`[Orchestrator] Failed to ignite sandbox for user ${userId}:`, error);
      await sendFeishuMessage(userId, '沙箱启动失败。请重试。');
    }
  }

  /**
   * Ignite sandbox for specific agent
   */
  private async igniteSandboxForAgent(userId: string, agentName: string): Promise<void> {
    const state = this.getUserState(userId);
    const agentConfig = this.getAgentConfig(agentName);
    const agentDisplay = agentConfig?.displayName || agentName;
    const containerPrefix = agentConfig?.containerPrefix || `${agentName}-sandbox-`;
    const containerName = `${containerPrefix}${userId}`;

    console.log(`[Orchestrator] Igniting ${agentDisplay} sandbox for user ${userId}`);

    try {
      const options: IgniteOptions = {
        userId,
        userToken: state.userToken,
      };

      // Update docker config to use correct prefix if needed
      // For now, use the standard igniteSandbox which uses openclaw prefix
      // TODO: Update docker-orchestrator to support custom container prefixes
      const containerInfo = await dockerOrchestrator.igniteSandbox(options);
      state.containerInfo = containerInfo;
      state.lastActivity = new Date();

      // Connect to container via WebSocket tunnel
      await wsTunnel.connectToContainer(userId, containerInfo.port);

      await sendFeishuMessage(
        userId,
        `沙箱启动成功！\n\n容器名称：${containerName}\n智能体：${agentDisplay}`
      );

      console.log(`[Orchestrator] Sandbox ignited for user ${userId}: ${containerInfo.containerId}`);
    } catch (error) {
      console.error(`[Orchestrator] Failed to ignite sandbox for user ${userId}:`, error);
      await sendFeishuMessage(userId, '沙箱启动失败。请重试。');
    }
  }

  /**
   * Ignite sandbox with container status check (legacy support)
   */
  private async igniteSandboxWithCheck(userId: string): Promise<void> {
    const state = this.getUserState(userId);
    const agentName = this.getUserAgent(userId) || 'openclaw';
    const agentConfig = this.getAgentConfig(agentName);
    const agentDisplay = agentConfig?.displayName || agentName;
    const containerPrefix = agentConfig?.containerPrefix || `${agentName}-sandbox-`;
    const containerName = `${containerPrefix}${userId}`;

    console.log(`[Orchestrator] Checking container status for user ${userId}`);

    try {
      const containerStatus = await dockerOrchestrator.getExistingContainerStatus(containerName);

      if (!containerStatus.exists) {
        console.log(`[Orchestrator] No existing container for user ${userId}, creating new one`);
        await this.igniteSandboxForAgent(userId, agentName);
        return;
      }

      const status = containerStatus.status;

      if (status === 'running') {
        console.log(`[Orchestrator] Container already running for user ${userId}`);
        await sendFeishuMessage(
          userId,
          `
**检测到沙箱已在运行**

您的沙箱容器正在运行中。

容器名称：${containerName}
智能体：${agentDisplay}

请选择操作：
• 回复 \`重新搭建\` - 停止当前沙箱并创建新的
• 回复 \`停止\` - 停止当前沙箱
• 发送其他消息 - 继续使用当前沙箱
          `.trim()
        );
        return;
      }

      if (status === 'exited' || status === 'stopped') {
        console.log(`[Orchestrator] Container stopped for user ${userId}`);
        await sendFeishuMessage(
          userId,
          `
**检测到已停止的沙箱**

您的沙箱容器已停止。

容器名称：${containerName}
智能体：${agentDisplay}

请选择操作：
• 回复 \`启动\` - 启动现有沙箱
• 回复 \`重新搭建\` - 删除并创建新的沙箱
          `.trim()
        );
        return;
      }

      console.log(`[Orchestrator] Container in state '${status}' for user ${userId}`);
      await sendFeishuMessage(
        userId,
          `
**沙箱状态异常**

检测到您的沙箱处于异常状态：${status}

容器名称：${containerName}
智能体：${agentDisplay}

请选择操作：
• 回复 \`重新搭建\` - 删除并创建新的沙箱
• 回复 \`取消\` - 取消操作
          `.trim()
      );
    } catch (error) {
      console.error(`[Orchestrator] Error checking container status for user ${userId}:`, error);
      await sendFeishuMessage(userId, '检查沙箱状态时出错，请重试。');
    }
  }

  /**
   * Rebuild sandbox: Stop, remove, and create new container
   */
  private async rebuildSandbox(userId: string): Promise<void> {
    const state = this.getUserState(userId);
    const agentName = this.getUserAgent(userId) || 'openclaw';
    const agentDisplay = (this.getAgentConfig(agentName)?.displayName || agentName);
    const containerPrefix = (this.getAgentConfig(agentName)?.containerPrefix || `${agentName}-sandbox-`);
    const containerName = `${containerPrefix}${userId}`;

    console.log(`[Orchestrator] Rebuilding ${agentDisplay} sandbox for user ${userId}`);

    try {
      // Disconnect existing tunnel if any
      wsTunnel.disconnectAll(userId);

      // Check if container exists
      const containerStatus = await dockerOrchestrator.getExistingContainerStatus(containerName);

      if (containerStatus.exists && containerStatus.container) {
        // Stop and remove existing container
        console.log(`[Orchestrator] Stopping existing container: ${containerName}`);
        try {
          await containerStatus.container.stop({ t: 10 });
          console.log(`[Orchestrator] Container stopped`);
        } catch (e) {
          console.warn(`[Orchestrator] Failed to stop container: ${e}`);
        }

        try {
          await containerStatus.container.remove({ force: true });
          console.log(`[Orchestrator] Container removed`);
        } catch (e) {
          console.warn(`[Orchestrator] Failed to remove container: ${e}`);
        }

        // Remove from orchestrator state
        state.containerInfo = null;
      }

      // Create new container
      await this.igniteSandboxForAgent(userId, agentName);

      await sendFeishuMessage(userId, '沙箱已重新搭建。');
    } catch (error) {
      console.error(`[Orchestrator] Failed to rebuild sandbox for user ${userId}:`, error);
      await sendFeishuMessage(userId, '沙箱重新搭建失败。请重试。');
    }
  }

  /**
   * Rebuild sandbox for specific agent
   */
  private async rebuildSandboxForAgent(userId: string, agentName: string): Promise<void> {
    const state = this.getUserState(userId);
    const agentDisplay = (this.getAgentConfig(agentName)?.displayName || agentName);
    const containerPrefix = (this.getAgentConfig(agentName)?.containerPrefix || `${agentName}-sandbox-`);
    const containerName = `${containerPrefix}${userId}`;

    console.log(`[Orchestrator] Rebuilding ${agentDisplay} sandbox for user ${userId}`);

    try {
      // Disconnect existing tunnel if any
      wsTunnel.disconnectAll(userId);

      // Check if container exists
      const containerStatus = await dockerOrchestrator.getExistingContainerStatus(containerName);

      if (containerStatus.exists && containerStatus.container) {
        // Stop and remove existing container
        console.log(`[Orchestrator] Stopping existing container: ${containerName}`);
        try {
          await containerStatus.container.stop({ t: 10 });
          console.log(`[Orchestrator] Container stopped`);
        } catch (e) {
          console.warn(`[Orchestrator] Failed to stop container: ${e}`);
        }

        try {
          await containerStatus.container.remove({ force: true });
          console.log(`[Orchestrator] Container removed`);
        } catch (e) {
          console.warn(`[Orchestrator] Failed to remove container: ${e}`);
        }

        // Remove from orchestrator state
        state.containerInfo = null;
      }

      // Create new container
      await this.igniteSandboxForAgent(userId, agentName);

      await sendFeishuMessage(userId, '沙箱已重新搭建。');
    } catch (error) {
      console.error(`[Orchestrator] Failed to rebuild sandbox for user ${userId}:`, error);
      await sendFeishuMessage(userId, '沙箱重新搭建失败。请重试。');
    }
  }

  /**
   * Forward messages to container via WebSocket tunnel
   */
  private async forwardToContainer(userId: string, message: string): Promise<void> {
    const state = this.getUserState(userId);

    if (!state.containerInfo) {
      console.warn(`[Orchestrator] No container for user ${userId}`);
      return;
    }

    console.log(`[Orchestrator] Forwarding message to container ${state.containerInfo.containerId}`);
    console.log(`[Orchestrator] Message: ${message}`);

    // Check if Node connection is registered and has active tunnel
    if (!wsTunnel.hasActiveConnections(userId)) {
      console.warn(`[Orchestrator] No active Node or container connection for user ${userId}`);
      await sendFeishuMessage(
        userId,
        '无法转发消息：Node 或容器连接未激活。请确保您的 Node 客户端已连接。'
      );
      return;
    }

    // Note: The actual message forwarding happens via ws-tunnel service
    // when messages are received from Node WebSocket connection.
    // This method is called for Feishu messages, which would need to be
    // sent to Node client first, then forwarded to container.

    console.log(`[Orchestrator] Message forwarding is handled via WebSocket tunnel between Node and container`);
  }

  /**
   * Stop user's sandbox (public for routes access)
   */
  public async stopSandbox(userId: string): Promise<void> {
    const agentName = this.getUserAgent(userId) || 'openclaw';
    const agentDisplay = (this.getAgentConfig(agentName)?.displayName || agentName);
    const containerPrefix = (this.getAgentConfig(agentName)?.containerPrefix || `${agentName}-sandbox-`);
    const containerName = `${containerPrefix}${userId}`;
    const state = this.stateMachine.get(userId);

    if (!state || !state.containerInfo) {
      console.log(`[Orchestrator] No sandbox to stop for user ${userId}`);
      await sendFeishuMessage(userId, '容器未运行，无需停止。');
      return;
    }

    console.log(`[Orchestrator] Stopping ${agentDisplay} sandbox for user ${userId}`);

    try {
      // Disconnect container WebSocket connection
      wsTunnel.disconnectContainer(userId);

      // Stop container
      await dockerOrchestrator.stopSandbox(userId);
      state.containerInfo = null;
      state.awaitingConfirmation = false;
      state.lastActivity = new Date();

      await sendFeishuMessage(userId, '沙箱已停止。');
      console.log(`[Orchestrator] Sandbox stopped for user ${userId}`);
    } catch (error) {
      console.error(`[Orchestrator] Failed to stop sandbox for user ${userId}:`, error);
      await sendFeishuMessage(userId, '沙箱停止失败。请重试。');
    }
  }

  /**
   * Stop sandbox for specific agent
   */
  private async stopSandboxForAgent(userId: string, agentName: string): Promise<void> {
    const agentDisplay = (this.getAgentConfig(agentName)?.displayName || agentName);
    const containerPrefix = (this.getAgentConfig(agentName)?.containerPrefix || `${agentName}-sandbox-`);
    const containerName = `${containerPrefix}${userId}`;
    const state = this.getUserState(userId);

    if (!state || !state.containerInfo) {
      console.log(`[Orchestrator] No sandbox to stop for user ${userId}`);
      await sendFeishuMessage(userId, '容器未运行，无需停止。');
      return;
    }

    console.log(`[Orchestrator] Stopping ${agentDisplay} sandbox for user ${userId}`);

    try {
      // Disconnect container WebSocket connection
      wsTunnel.disconnectContainer(userId);

      // Stop container
      await dockerOrchestrator.stopSandbox(userId);
      state.containerInfo = null;
      state.awaitingConfirmation = false;
      state.lastActivity = new Date();

      await sendFeishuMessage(userId, '沙箱已停止。');
      console.log(`[Orchestrator] Sandbox stopped for user ${userId}`);
    } catch (error) {
      console.error(`[Orchestrator] Failed to stop sandbox for user ${userId}:`, error);
      await sendFeishuMessage(userId, '沙箱停止失败。请重试。');
    }
  }

  /**
   * Get all user states
   */
  getActiveStates(): UserSandboxState[] {
    return Array.from(this.stateMachine.values());
  }

  /**
   * Get all user modes
   */
  getUserModes(): Map<string, UserMode> {
    return new Map(this.userModes);
  }

  /**
   * Get all user agents
   */
  getUserAgents(): Map<string, string> {
    return new Map(this.userAgents);
  }

  /**
   * Clean up inactive states (> 1 hour inactive)
   */
  private cleanupInactiveStates(): void {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const statesToCleanup: string[] = [];

    for (const [userId, state] of this.stateMachine.entries()) {
      if (state.lastActivity < oneHourAgo) {
        statesToCleanup.push(userId);
      }
    }

    if (statesToCleanup.length > 0) {
      console.log(`[Orchestrator] Cleaning up ${statesToCleanup.length} inactive states`);

      for (const userId of statesToCleanup) {
        const state = this.stateMachine.get(userId);
        if (state?.containerInfo) {
          // Disconnect container WebSocket connection
          wsTunnel.disconnectContainer(userId);

          // Stop container if running
          dockerOrchestrator.stopSandbox(userId).catch((error) => {
            console.error(`[Orchestrator] Failed to stop container for user ${userId}:`, error);
          });
        }
        this.stateMachine.delete(userId);
        this.userModes.delete(userId);
        this.userAgents.delete(userId);
        console.log(`[Orchestrator] Cleaned up state for user ${userId}`);
      }
    }
  }

  /**
   * Start periodic cleanup interval (every 5 minutes)
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupInactiveStates();
    }, 5 * 60 * 1000); // 5 minutes

    console.log('[Orchestrator] Cleanup interval started (every 5 minutes)');
  }

  /**
   * Stop cleanup interval
   */
  private stopCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      console.log('[Orchestrator] Cleanup interval stopped');
    }
  }

  /**
   * Initialize orchestrator with Feishu WebSocket
   */
  async initialize(): Promise<void> {
    console.log('[Orchestrator] Initializing orchestrator...');
    console.log('[Orchestrator] Orchestrator initialized');
  }

  /**
   * Shutdown orchestrator
   */
  async shutdown(): Promise<void> {
    console.log('[Orchestrator] Shutting down orchestrator...');

    // Stop cleanup interval
    this.stopCleanupInterval();

    // Shutdown WebSocket tunnel
    wsTunnel.shutdown();

    // Stop all containers
    const states = this.getActiveStates();
    for (const state of states) {
      if (state.containerInfo) {
        await dockerOrchestrator.stopSandbox(state.userId).catch((error) => {
          console.error(`[Orchestrator] Failed to stop container for user ${state.userId}:`, error);
        });
      }
    }

    // Clear state machine and modes
    this.stateMachine.clear();
    this.userModes.clear();
    this.userAgents.clear();

    console.log('[Orchestrator] Orchestrator shut down');
  }
}

// Export singleton instance
export const orchestrator = new SynapseOrchestrator();
