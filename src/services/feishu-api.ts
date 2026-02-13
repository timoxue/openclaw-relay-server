import axios, { AxiosInstance } from 'axios';

const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';

interface FeishuAccessTokenResponse {
  code: number;
  app_access_token: string;
  expire: number;
}

interface FeishuMessageResponse {
  code: number;
  msg: string;
}

interface FeishuUserInfo {
  user_id: string;
  name: string;
}

export class FeishuAPI {
  private client: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpireAt: number = 0;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://open.feishu.cn',
      timeout: 10000,
    });
  }

  // 获取 tenant_access_token
  async getAccessToken(): Promise<string> {
    const now = Date.now() / 1000;

    if (this.accessToken && this.tokenExpireAt > now + 300) {
      return this.accessToken;
    }

    const response = await this.client.post<FeishuAccessTokenResponse>(
      '/open-apis/auth/v3/tenant_access_token/internal',
      {
        app_id: FEISHU_APP_ID,
        app_secret: FEISHU_APP_SECRET,
      }
    );

    if (response.data.code !== 0) {
      throw new Error('Failed to get Feishu access token');
    }

    this.accessToken = response.data.app_access_token;
    this.tokenExpireAt = now + response.data.expire - 300; // 提前5分钟刷新

    return this.accessToken;
  }

  // 发送文本消息
  async sendTextMessage(userId: string, text: string): Promise<boolean> {
    const token = await this.getAccessToken();

    const response = await this.client.post<FeishuMessageResponse>(
      `/open-apis/im/v1/messages?receive_id_type=user_id`,
      {
        receive_id: userId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    return response.data.code === 0;
  }

  // 发送富文本消息
  async sendPostMessage(userId: string, content: any): Promise<boolean> {
    const token = await this.getAccessToken();

    const response = await this.client.post<FeishuMessageResponse>(
      `/open-apis/im/v1/messages?receive_id_type=user_id`,
      {
        receive_id: userId,
        msg_type: 'post',
        content: JSON.stringify(content),
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    return response.data.code === 0;
  }

  // 获取用户信息
  async getUserInfo(userId: string): Promise<FeishuUserInfo | null> {
    const token = await this.getAccessToken();

    try {
      const response = await this.client.get<{
        code: number;
        data: { user: FeishuUserInfo };
      }>(`/open-apis/contact/v3/users/${userId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.data.code === 0) {
        return response.data.data.user;
      }
    } catch (error) {
      console.error('Failed to get user info:', error);
    }

    return null;
  }

  // 验证 webhook 请求
  verifyWebhook(headers: any): boolean {
    // TODO: 实现飞书 webhook 验证逻辑
    // 参考: https://open.feishu.cn/document/common-capabilities/message-card/message-card-content-language/using-verification-token-to-verify-event-request
    return true;
  }
}

export const feishuAPI = new FeishuAPI();
