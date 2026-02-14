/**
 * 测试双 WebSocket 功能
 *
 * 测试步骤：
 * 1. 测试 OpenClaw WebSocket 连接和认证
 * 2. 测试飞书 WebSocket 连接
 * 3. 测试消息转发
 */

const WebSocket = require('ws');

// 配置
const CONFIG = {
  OPENCLAW_WS_URL: 'ws://localhost:5190/openclaw',
  FEISHU_WS_URL: 'ws://localhost:5189/feishu',
  // 注意：这里使用数据库中用户 xuedu 的最新 token
  // 如果需要重新生成，请访问 http://43.160.237.217:5178/auth/qrcode 扫码
  TOKEN: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ4dWVkdSIsInR5cGUiOiJyZWxheV90b2tlbiIsImlhdCI6MTc3MDk5NzYxNCwiZXhwIjoxNzczNTg5NjE0fQ.NUoXdKcb0z2kELak9RWiwmkhjhvdzIV-GgiKCKqJTDE',
};

console.log('========================================');
console.log('双 WebSocket 测试');
console.log('========================================\n');

// ==================== 测试 1: OpenClaw WebSocket ====================
console.log('【测试 1】连接 OpenClaw WebSocket...');

let openclawWS = null;

function testOpenClawConnection() {
  return new Promise((resolve, reject) => {
    openclawWS = new WebSocket(CONFIG.OPENCLAW_WS_URL);

    openclawWS.on('open', () => {
      console.log('✅ OpenClaw WS 连接成功');

      // 发送认证消息
      console.log('📤 发送认证消息...');
      openclawWS.send(JSON.stringify({
        type: 'auth',
        token: CONFIG.TOKEN,
      }));
    });

    openclawWS.on('message', (data) => {
      const message = JSON.parse(data.toString());
      console.log('📥 收到消息:', message);

      if (message.type === 'auth_success') {
        console.log('✅ 认证成功！\n');
        resolve(true);
      } else if (message.type === 'error') {
        console.log('❌ 认证失败:', message.error);
        reject(message.error);
      }
    });

    openclawWS.on('error', (error) => {
      console.log('❌ OpenClaw WS 错误:', error.message);
      reject(error);
    });

    openclawWS.on('close', () => {
      console.log('🔌 OpenClaw WS 连接关闭');
    });

    // 10秒超时
    setTimeout(() => reject(new Error('OpenClaw WS 连接超时')), 10000);
  });
}

// ==================== 测试 2: 飞书 WebSocket ====================
console.log('【测试 2】连接飞书 WebSocket...');

let feishuWS = null;
// 使用数据库中存在的飞书用户 ID
const FEISHU_USER_ID = 'xuedu';  // 对应数据库中 feishu_user_id

function testFeishuConnection() {
  return new Promise((resolve, reject) => {
    feishuWS = new WebSocket(`${CONFIG.FEISHU_WS_URL}?user_id=${FEISHU_USER_ID}`);

    feishuWS.on('open', () => {
      console.log('✅ 飞书 WS 连接成功\n');
      resolve(true);
    });

    feishuWS.on('message', (data) => {
      const message = JSON.parse(data.toString());
      console.log('📥 飞书 WS 收到消息:', message);
    });

    feishuWS.on('error', (error) => {
      console.log('❌ 飞书 WS 错误:', error.message);
      reject(error);
    });

    feishuWS.on('close', () => {
      console.log('🔌 飞书 WS 连接关闭');
    });

    // 10秒超时
    setTimeout(() => reject(new Error('飞书 WS 连接超时')), 10000);
  });
}

// ==================== 测试 3: 模拟飞书消息 ====================
console.log('【测试 3】模拟飞书消息推送...\n');

function testFeishuMessage() {
  return new Promise((resolve, reject) => {
    if (!feishuWS || feishuWS.readyState !== WebSocket.OPEN) {
      reject(new Error('飞书 WS 未连接'));
      return;
    }

    // 模拟从飞书 Webhook 推送消息到 OpenClaw
    const message = {
      type: 'message',
      content: '测试消息：你好 OpenClaw！',
      messageId: 'msg_test_001',
      chatType: 'p2p',
      chatId: 'oc_test_001',
      senderId: FEISHU_USER_ID,
    };

    console.log('📤 模拟发送飞书消息...');
    feishuWS.send(JSON.stringify(message));

    // 等待 OpenClaw WS 收到消息
    let messageReceived = false;

    const onMessage = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'feishu_message') {
        console.log('✅ OpenClaw WS 收到飞书消息:', msg.content);
        console.log('✅ 消息转发成功！\n');
        messageReceived = true;
        openclawWS.off('message', onMessage);
        resolve(true);
      }
    };

    openclawWS.on('message', onMessage);

    setTimeout(() => {
      if (!messageReceived) {
        reject(new Error('未收到转发消息'));
      }
    }, 5000);
  });
}

// ==================== 运行测试 ====================
async function runTests() {
  try {
    // 测试 1: OpenClaw WebSocket
    await testOpenClawConnection();

    // 测试 2: 飞书 WebSocket
    await testFeishuConnection();

    // 测试 3: 消息转发
    await testFeishuMessage();

    console.log('========================================');
    console.log('✅ 所有测试通过！');
    console.log('========================================');

  } catch (error) {
    console.log('========================================');
    console.log('❌ 测试失败:', error.message);
    console.log('========================================');
  } finally {
    // 关闭连接
    if (openclawWS) openclawWS.close();
    if (feishuWS) feishuWS.close();

    setTimeout(() => process.exit(0), 1000);
  }
}

runTests();
