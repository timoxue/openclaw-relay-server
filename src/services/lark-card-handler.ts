// src/services/lark-card-handler.ts

import { feishuAPI } from './feishu-api';
import type {
  ProxyRequest,
  RequestStatus,
  FeishuCard,
  LarkCardActionEvent,
} from '../types/proxy-request';
import { truncateResult } from '../utils/text-utils';

export class LarkCardHandler {
  /**
   * Generate pending approval card
   */
  generatePendingCard(request: ProxyRequest): FeishuCard {
    return {
      config: { wide_screen_mode: true },
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '📋 OpenClaw 调用请求' },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**请求者**: @${request.requestorUserId}\n**消息**: ${request.message}\n**智能体**: ${request.agentName}`,
          },
        },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '✅ 同意' },
              type: 'primary',
              value: `approve_${request.id}`,
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '❌ 拒绝' },
              type: 'danger',
              value: `reject_${request.id}`,
            },
          ],
        },
      ],
    };
  }

  /**
   * Generate approved card
   */
  generateApprovedCard(request: ProxyRequest, result: string): FeishuCard {
    return {
      config: { wide_screen_mode: true },
      header: {
        template: 'green',
        title: { tag: 'plain_text', content: '📋 OpenClaw 调用请求' },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**请求者**: @${request.requestorUserId}\n**消息**: ${request.message}`,
          },
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**状态**: ✅ 已执行\n**结果**: ${truncateResult(result)}`,
          },
        },
        {
          tag: 'note',
          elements: [
            {
              tag: 'lark_md',
              content: `本结果由 @${request.targetUserId} 的智能体 OpenClaw 生成，已获得本人授权。`,
            },
          ],
        },
      ],
    };
  }

  /**
   * Generate rejected card
   */
  generateRejectedCard(request: ProxyRequest): FeishuCard {
    return {
      config: { wide_screen_mode: true },
      header: {
        template: 'red',
        title: { tag: 'plain_text', content: '📋 OpenClaw 调用请求' },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**请求者**: @${request.requestorUserId}\n**消息**: ${request.message}`,
          },
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: { tag: 'lark_md', content: '**状态**: ❌ 已拒绝' },
        },
      ],
    };
  }

  /**
   * Generate processing card
   */
  generateProcessingCard(request: ProxyRequest): FeishuCard {
    return {
      config: { wide_screen_mode: true },
      header: {
        template: 'blue',
        title: { tag: 'plain_text', content: '📋 OpenClaw 调用请求' },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**请求者**: @${request.requestorUserId}\n**消息**: ${request.message}`,
          },
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: { tag: 'lark_md', content: '**状态**: ⏳ 处理中...' },
        },
      ],
    };
  }

  /**
   * Send card to user
   */
  async sendCard(userId: string, card: FeishuCard): Promise<string | null> {
    return await feishuAPI.sendCardMessage(userId, card);
  }

  /**
   * Update card
   */
  async updateCard(messageId: string, card: FeishuCard): Promise<boolean> {
    return await feishuAPI.updateCardMessage(messageId, card);
  }

  /**
   * Parse card action event
   */
  parseCardAction(event: LarkCardActionEvent): {
    action: 'approve' | 'reject';
    requestId: string;
  } | null {
    const value = event.action.value || event.action.action_value || '';
    const parts = value.split('_');

    if (parts.length === 2 && ['approve', 'reject'].includes(parts[0])) {
      return {
        action: parts[0] as 'approve' | 'reject',
        requestId: parts[1],
      };
    }

    return null;
  }

  /**
   * Validate operator is the target user
   */
  validateOperator(event: LarkCardActionEvent, targetUserId: string): boolean {
    return event.operator.user_id === targetUserId;
  }

  /**
   * Build card action response
   */
  buildResponse(toast?: { type: string; content: string }): any {
    const response: any = {};
    if (toast) {
      response.toast = toast;
    }
    return response;
  }
}

export const larkCardHandler = new LarkCardHandler();
