import { Router, Request, Response } from 'express';
import { feishuAPI } from '../services/feishu-api';
import { database } from '../services/database';

// Import WebSocketService - will be initialized later
let wsService: any = null;

export function setWebSocketService(service: any): void {
  wsService = service;
}

interface FeishuWebhookEvent {
  header: {
    event_id: string;
    timestamp: string;
    event_type: string;
    tenant_key: string;
  };
  event: {
    sender: {
      sender_id: {
        open_id: string;
        user_id: string;
      };
      sender_type: string;
    };
    message: {
      message_id: string;
      chat_type: string;
      chat_id: string;
      content: string;
      msg_type: string;
      create_time: string;
    };
  };
  challenge?: string;
}

const router = Router();

// 飞书消息 webhook
router.post('/webhook', async (req: Request, res: Response) => {
  console.log('Received Feishu webhook:', JSON.stringify(req.body, null, 2));

  const { header, event } = req.body as FeishuWebhookEvent;

  // URL 验证（首次配置时）
  if (header.event_type === 'url_verification') {
    const challenge = req.body.challenge;
    return res.json({ challenge });
  }

  // 处理消息事件
  if (header.event_type === 'im.message.receive_v1') {
    const senderId = event.sender.sender_id.user_id;

    // 解析消息内容
    let content = '';
    try {
      const parsedContent = JSON.parse(event.message.content);
      content = parsedContent.text || '';
    } catch {
      content = event.message.content;
    }

    // 查找用户并转发消息
    const user = database.getUserByFeishuId(senderId);

    if (user && user.ws_connected && wsService) {
      // 向用户 WebSocket 连接发送消息
      console.log(`Forwarding message to user ${user.id}: ${content}`);
      wsService.sendToUser(senderId, {
        type: 'message',
        content: content,
        messageId: event.message.message_id,
        chatType: event.message.chat_type,
        chatId: event.message.chat_id,
      });

      res.json({ code: 0, msg: 'Message forwarded' });
    } else {
      console.log(`User ${senderId} not connected, sending fallback message`);

      // 发送未连接提示
      await feishuAPI.sendTextMessage(
        senderId,
        'OpenClaw Gateway 未连接，请先启动控制面板'
      );

      res.json({ code: 0, msg: 'User not connected' });
    }
  }

  res.json({ code: 0, msg: 'ok' });
});

export default router;
