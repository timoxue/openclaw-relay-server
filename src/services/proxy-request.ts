// src/services/proxy-request.ts

import { database } from './database';
import { larkCardHandler } from './lark-card-handler';
import { sendFeishuMessage } from './orchestrator';
import { wsTunnel } from './ws-tunnel';
import type {
  ProxyRequest,
  RequestStatus,
} from '../types/proxy-request';

const REQUEST_EXPIRY_HOURS = 24;
const REQUEST_TIMEOUT_SECONDS = 30;

export class ProxyRequestService {
  private processingRequests = new Set<string>();

  /**
   * Create new proxy request
   */
  async createRequest(
    requestorUserId: string,
    targetUserId: string,
    agentName: string,
    message: string
  ): Promise<string | null> {
    // Prevent self-request
    if (requestorUserId === targetUserId) {
      await sendFeishuMessage(requestorUserId, '不能向自己发起请求');
      return null;
    }

    const id = this.generateId();
    const expiresAt = Math.floor(Date.now() / 1000) + (REQUEST_EXPIRY_HOURS * 3600);

    // Create request in database
    database.createProxyRequest({
      id,
      requestorUserId,
      targetUserId,
      agentName,
      message,
      expiresAt,
    });

    // Generate and send card
    const request: ProxyRequest = {
      id,
      requestorUserId,
      targetUserId,
      agentName,
      message,
      status: 'pending' as RequestStatus,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(expiresAt * 1000),
    };

    const card = larkCardHandler.generatePendingCard(request);
    const messageId = await larkCardHandler.sendCard(targetUserId, card);

    if (messageId) {
      // Update card_message_id
      database.updateProxyRequest(id, { cardMessageId: messageId });

      // Notify requestor
      await sendFeishuMessage(
        requestorUserId,
        `已向 @${targetUserId} 发起 ${agentName} 调用请求`
      );

      return id;
    }

    return null;
  }

  /**
   * Handle card action event
   */
  async handleCardAction(event: any): Promise<any> {
    const parsed = larkCardHandler.parseCardAction(event);
    if (!parsed) {
      return larkCardHandler.buildResponse({
        type: 'warning',
        content: '无效的操作',
      });
    }

    const { action, requestId } = parsed;

    // Check concurrency
    if (this.processingRequests.has(requestId)) {
      return larkCardHandler.buildResponse({
        type: 'warning',
        content: '请求正在处理中，请勿重复操作',
      });
    }

    // Get request
    const request = database.getProxyRequest(requestId);
    if (!request) {
      return larkCardHandler.buildResponse({
        type: 'warning',
        content: '请求不存在',
      });
    }

    // Check status
    if (request.status !== 'pending') {
      return larkCardHandler.buildResponse({
        type: 'warning',
        content: '请求已处理',
      });
    }

    // Validate operator
    if (!larkCardHandler.validateOperator(event, request.targetUserId)) {
      return larkCardHandler.buildResponse({
        type: 'error',
        content: '无权操作此请求',
      });
    }

    // Mark as processing
    this.processingRequests.add(requestId);

    try {
      // Update to processing card first
      const processingCard = larkCardHandler.generateProcessingCard(request as ProxyRequest);
      if (request.cardMessageId) {
        await larkCardHandler.updateCard(request.cardMessageId, processingCard);
      }

      if (action === 'approve') {
        await this.approveRequest(request as ProxyRequest);
      } else {
        await this.rejectRequest(request as ProxyRequest);
      }

      return larkCardHandler.buildResponse({
        type: 'success',
        content: action === 'approve' ? '已同意请求' : '已拒绝请求',
      });
    } finally {
      this.processingRequests.delete(requestId);
    }
  }

  /**
   * Approve request and execute
   */
  private async approveRequest(request: ProxyRequest): Promise<void> {
    // orchestrator is imported at module level, no dynamic import needed

    // Check if container is running
    if (!wsTunnel.hasActiveConnections(request.targetUserId)) {
      await this.rejectRequestWithError(request, '智能体容器未运行，请先启动容器');
      return;
    }

    try {
      // Send message via wsTunnel
      await wsTunnel.sendChatMessage(request.targetUserId, request.message);

      // Wait for response (simplified - in real app would use event)
      await new Promise(resolve => setTimeout(resolve, REQUEST_TIMEOUT_SECONDS * 1000));

      // Update request status
      database.updateProxyRequest(request.id, {
        status: 'approved',
        result: '请求已执行',
      });

      // Update card to approved
      const approvedCard = larkCardHandler.generateApprovedCard(request, '请求已执行');
      if (request.cardMessageId) {
        await larkCardHandler.updateCard(request.cardMessageId, approvedCard);
      }

      // Notify requestor
      await sendFeishuMessage(
        request.requestorUserId,
        `✅ 请求已执行\n\n消息: ${request.message}\n\n---\n本结果由 @${request.targetUserId} 的智能体 ${request.agentName} 生成，已获得本人授权。`
      );
    } catch (error) {
      await this.rejectRequestWithError(request, `执行失败: ${(error as Error).message}`);
    }
  }

  /**
   * Reject request
   */
  private async rejectRequest(request: ProxyRequest): Promise<void> {
    database.updateProxyRequest(request.id, { status: 'rejected' });

    const rejectedCard = larkCardHandler.generateRejectedCard(request);
    if (request.cardMessageId) {
      await larkCardHandler.updateCard(request.cardMessageId, rejectedCard);
    }

    // Notify requestor
    await sendFeishuMessage(
      request.requestorUserId,
      `❌ 您向 @${request.targetUserId} 发起的请求已被拒绝`
    );
  }

  /**
   * Reject request with error message
   */
  private async rejectRequestWithError(request: ProxyRequest, error: string): Promise<void> {
    database.updateProxyRequest(request.id, {
      status: 'rejected',
      result: error,
    });

    const rejectedCard = larkCardHandler.generateRejectedCard(request);
    if (request.cardMessageId) {
      await larkCardHandler.updateCard(request.cardMessageId, rejectedCard);
    }

    await sendFeishuMessage(request.targetUserId, `⚠️ ${error}`);
    await sendFeishuMessage(
      request.requestorUserId,
      `❌ 请求执行失败: ${error}`
    );
  }

  /**
   * Cancel request
   */
  async cancelRequest(requestId: string, requestorUserId: string): Promise<boolean> {
    const success = database.cancelProxyRequest(requestId, requestorUserId);
    if (success) {
      await sendFeishuMessage(requestorUserId, '请求已取消');
    }
    return success;
  }

  /**
   * Get pending requests for user
   */
  getPendingRequests(targetUserId: string): any[] {
    return database.getPendingRequests(targetUserId);
  }

  /**
   * Get user's requests
   */
  getUserRequests(requestorUserId: string): any[] {
    return database.getUserRequests(requestorUserId);
  }

  /**
   * Generate UUID
   */
  private generateId(): string {
    return crypto.randomUUID();
  }
}

export const proxyRequestService = new ProxyRequestService();
