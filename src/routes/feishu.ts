import { Router, Request, Response } from 'express';
import { feishuAPI } from '../services/feishu-api';
import { database } from '../services/database';
import crypto from 'crypto';

// Import WebSocketService - will be initialized later
let wsService: any = null;
let dualWsService: any = null;

export function setWebSocketService(service: any): void {
  wsService = service;
}

export function setDualWebSocketService(service: any): void {
  dualWsService = service;
}

// 飞书加密解密
function decryptFeishuData(encryptedData: string, encryptKey: string): any {
  try {
    console.log('Decrypting with encrypt_key length:', encryptKey.length);

    // Base64 解码加密数据
    const encryptedBuffer = Buffer.from(encryptedData, 'base64');

    // 从加密数据中提取 IV 和密文
    // 飞书加密格式: AES-CBC, PKCS7 padding
    // 前 16 字节是 IV，后面是密文
    const iv = encryptedBuffer.subarray(0, 16);
    const ciphertext = encryptedBuffer.subarray(16);

    // Base64 解码密钥
    const keyBytes = Buffer.from(encryptKey, 'base64');
    console.log('Decoded key bytes length:', keyBytes.length);

    // 根据密钥长度选择 AES 算法
    let cipher: string;
    if (keyBytes.length === 32) {
      cipher = 'aes-256-cbc';
    } else if (keyBytes.length === 24) {
      cipher = 'aes-192-cbc';
    } else if (keyBytes.length === 16) {
      cipher = 'aes-128-cbc';
    } else {
      throw new Error(`Invalid key length: ${keyBytes.length} bytes. Expected 16, 24, or 32 bytes for AES-128/192/256.`);
    }

    console.log(`Using ${cipher} for decryption`);

    // 创建解密器
    const decipher = crypto.createDecipheriv(cipher, keyBytes, iv);

    // 设置自动填充
    decipher.setAutoPadding(true);

    // 解密
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    // 移除 PKCS7 填充
    const paddingLength = decrypted[decrypted.length - 1];
    const unpadded = decrypted.subarray(0, decrypted.length - paddingLength);

    // 解析 JSON
    const result = JSON.parse(unpadded.toString('utf8'));
    console.log('Decrypted successfully:', result);
    return result;
  } catch (error: any) {
    console.error('Failed to decrypt Feishu data:', error.message);
    console.error('Error details:', error);
    return null;
  }
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

  const { encrypt, type, challenge, header, event } = req.body as FeishuWebhookEvent & {
    encrypt?: string;
    type?: string;
    token?: string;
  };

  const encryptKey = process.env.FEISHU_ENCRYPT_KEY || '';

  // 处理加密验证请求
  if (encrypt && encryptKey) {
    console.log('Processing encrypted verification request');
    const decrypted = decryptFeishuData(encrypt, encryptKey);

    if (decrypted) {
      console.log('Decrypted data:', decrypted);

      // 如果是 URL 验证
      if (decrypted.type === 'url_verification' && decrypted.challenge) {
        console.log('URL verification challenge (from encrypted):', decrypted.challenge);
        return res.json({ challenge: decrypted.challenge });
      }
    }
  }

  // URL 验证（非加密格式）
  if (header?.event_type === 'url_verification' || type === 'url_verification') {
    const challengeValue = challenge || req.body.challenge;
    console.log('URL verification challenge:', challengeValue);
    return res.json({ challenge: challengeValue });
  }

  // 处理消息事件
  if (header?.event_type === 'im.message.receive_v1' && event) {
    const senderId = event.sender.sender_id.user_id;

    // 解析消息内容
    let content = '';
    try {
      const parsedContent = JSON.parse(event.message.content);
      content = parsedContent.text || '';
    } catch {
      content = event.message.content;
    }

    const feishuMessage = {
      type: 'message' as const,
      content: content,
      messageId: event.message.message_id,
      chatType: event.message.chat_type,
      chatId: event.message.chat_id,
      senderId: senderId,
    };

    // 使用双 WebSocket 服务
    if (dualWsService) {
      console.log(`[Dual WS] Forwarding message from ${senderId}`);
      dualWsService.receiveFromFeishu(senderId, feishuMessage);
      return res.json({ code: 0, msg: 'Message forwarded via dual WS' });
    }

    // 使用单 WebSocket 服务（向后兼容）
    const user = database.getUserByFeishuId(senderId);
    if (user && user.ws_connected && wsService) {
      console.log(`Forwarding message to user ${user.id}: ${content}`);
      wsService.sendToUser(senderId, feishuMessage);
      return res.json({ code: 0, msg: 'Message forwarded' });
    }

    console.log(`User ${senderId} not connected, sending fallback message`);

    // 发送未连接提示
    await feishuAPI.sendTextMessage(
      senderId,
      'OpenClaw Gateway 未连接，请先启动控制面板'
    );

    return res.json({ code: 0, msg: 'User not connected' });
  }

  res.json({ code: 0, msg: 'ok' });
});

export default router;
