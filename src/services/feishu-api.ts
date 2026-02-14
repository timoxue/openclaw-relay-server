import axios, { AxiosInstance, AxiosError } from 'axios';
import { database } from './database';

const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const TOKEN_CONFIG_KEY = 'feishu_tenant_access_token';

interface FeishuAccessTokenResponse {
  code: number;
  tenant_access_token: string;
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
  private inMemoryToken: string | null = null;
  private tokenExpireAt: number = 0;
  private isRefreshing = false;
  private refreshPromise: Promise<string> | null = null;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://open.feishu.cn',
      timeout: 10000,
    });
  }

  // 获取 tenant_access_token
  async getAccessToken(forceRefresh = false): Promise<string> {
    const now = Date.now() / 1000;

    // 如果正在刷新，等待刷新完成
    if (this.isRefreshing && this.refreshPromise) {
      console.log(`[FeishuAPI] Waiting for token refresh...`);
      return this.refreshPromise;
    }

    // 检查内存缓存（只检查是否过期，不提前刷新）
    if (!forceRefresh && this.inMemoryToken && typeof this.inMemoryToken === 'string' && this.tokenExpireAt > now) {
      console.log(`[FeishuAPI] Using cached token (expires at ${this.tokenExpireAt}, now is ${now})`);
      return this.inMemoryToken;
    }

    // 检查数据库缓存（只检查是否过期，不提前刷新）
    if (!forceRefresh) {
      const dbConfig = database.getConfigWithExpiry(TOKEN_CONFIG_KEY);
      if (dbConfig && dbConfig.expiresAt > now) {
        this.inMemoryToken = dbConfig.value;
        this.tokenExpireAt = dbConfig.expiresAt;
        console.log(`[FeishuAPI] Using DB cached token (expires at ${dbConfig.expiresAt}, now is ${now})`);
        return dbConfig.value;
      }
    }

    // 获取新token
    this.isRefreshing = true;
    this.refreshPromise = this.fetchNewToken();

    try {
      const token = await this.refreshPromise;
      return token;
    } finally {
      this.isRefreshing = false;
      this.refreshPromise = null;
    }
  }

  // 获取新token
  private async fetchNewToken(): Promise<string> {
    const now = Date.now() / 1000;

    console.log(`[FeishuAPI] Fetching new tenant_access_token`);
    const response = await this.client.post<FeishuAccessTokenResponse>(
      '/open-apis/auth/v3/tenant_access_token/internal',
      {
        app_id: FEISHU_APP_ID,
        app_secret: FEISHU_APP_SECRET,
      }
    );

    console.log(`[FeishuAPI] Token response: code=${response.data.code}, expires=${response.data.expire} seconds`);

    if (response.data.code !== 0) {
      throw new Error(`Failed to get Feishu access token: ${JSON.stringify(response.data)}`);
    }

    const token = response.data.tenant_access_token;
    const expireAt = now + response.data.expire;

    // 更新内存缓存
    this.inMemoryToken = token;
    this.tokenExpireAt = expireAt;

    // 持久化到数据库
    const expiresAtDate = new Date(expireAt * 1000);
    database.setConfig(TOKEN_CONFIG_KEY, token, expiresAtDate);

    console.log(`[FeishuAPI] New token expires at ${expiresAtDate.toISOString()}`);

    return token;
  }

  // 发送文本消息（带重试机制）
  async sendTextMessage(userId: string, text: string, maxRetries = 2): Promise<boolean> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const token = await this.getAccessToken(attempt > 0); // 重试时强制刷新token

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

        if (response.data.code === 0) {
          return true;
        } else {
          console.error(`[FeishuAPI] Send failed: code=${response.data.code}, msg=${response.data.msg}`);
          return false;
        }
      } catch (error) {
        const axiosError = error as AxiosError;
        const statusCode = axiosError.response?.status;
        const errorCode = (axiosError.response?.data as any)?.code;

        // Token无效，需要刷新
        if (statusCode === 401 || statusCode === 403 || errorCode === 99991668) {
          console.warn(`[FeishuAPI] Token invalid (attempt ${attempt + 1}/${maxRetries + 1}), refreshing...`);
          if (attempt < maxRetries) {
            // 清除缓存，强制下次获取新token
            this.inMemoryToken = null;
            database.deleteConfig(TOKEN_CONFIG_KEY);
            await new Promise(resolve => setTimeout(resolve, 500)); // 稍作等待
            continue;
          }
        }

        console.error('[FeishuAPI] Failed to send message:', axiosError.message);
        console.error('[FeishuAPI] Response data:', axiosError.response?.data);
        throw error;
      }
    }

    return false;
  }

  // 发送富文本消息（带重试机制）
  async sendPostMessage(userId: string, content: any, maxRetries = 2): Promise<boolean> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const token = await this.getAccessToken(attempt > 0);

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

        if (response.data.code === 0) {
          return true;
        } else {
          console.error(`[FeishuAPI] Send failed: code=${response.data.code}, msg=${response.data.msg}`);
          return false;
        }
      } catch (error) {
        const axiosError = error as AxiosError;
        const statusCode = axiosError.response?.status;
        const errorCode = (axiosError.response?.data as any)?.code;

        if (statusCode === 401 || statusCode === 403 || errorCode === 99991668) {
          console.warn(`[FeishuAPI] Token invalid (attempt ${attempt + 1}/${maxRetries + 1}), refreshing...`);
          if (attempt < maxRetries) {
            this.inMemoryToken = null;
            database.deleteConfig(TOKEN_CONFIG_KEY);
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
        }

        console.error('[FeishuAPI] Failed to send post message:', axiosError.message);
        throw error;
      }
    }

    return false;
  }

  // 获取用户信息（带重试机制）
  async getUserInfo(userId: string, maxRetries = 2): Promise<FeishuUserInfo | null> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const token = await this.getAccessToken(attempt > 0);

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
        const axiosError = error as AxiosError;
        const statusCode = axiosError.response?.status;
        const errorCode = (axiosError.response?.data as any)?.code;

        if (statusCode === 401 || statusCode === 403 || errorCode === 99991668) {
          console.warn(`[FeishuAPI] Token invalid (attempt ${attempt + 1}/${maxRetries + 1}), refreshing...`);
          if (attempt < maxRetries) {
            this.inMemoryToken = null;
            database.deleteConfig(TOKEN_CONFIG_KEY);
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
        }

        console.error('[FeishuAPI] Failed to get user info:', axiosError.message);
        if (attempt === maxRetries) {
          return null;
        }
      }
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
