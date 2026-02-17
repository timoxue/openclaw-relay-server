export interface TokenPayload {
  userId: number;
  feishuUserId: string;
}

export interface User {
  id: number;
  feishu_user_id: string;
  token: string;
  token_expires_at: Date;
  feishu_access_token: string;
  feishu_refresh_token: string;
  feishu_token_expires_at: Date;
  ws_connected: boolean;
  last_seen: Date;
  created_at: Date;
}

export interface Session {
  id: number;
  user_id: number;
  ws_id: string;
  connected_at: Date;
}

export interface FeishuAuthRequest {
  feishu_user_id: string;
}

export interface ConfigResponse {
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export interface DockerContainerInfo {
  containerId: string;
  userId: string;
  userToken: string;
  gatewayToken: string;
  port: number;
  status: 'creating' | 'running' | 'stopped' | 'error';
  createdAt: Date;
}

export interface UserSandboxState {
  userId: string;
  userToken: string;
  containerInfo: DockerContainerInfo | null;
  awaitingConfirmation: boolean;
  lastActivity: Date;
}

export interface IgniteOptions {
  userId: string;
  userToken: string;
  storagePath?: string;
}

export interface FeishuWSMessage {
  header: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_type: string;
    tenant_key: string;
  };
  event: {
    sender: {
      sender_id: {
        user_id: string;
        open_id?: string;
        union_id?: string;
      };
      sender_type: string;
    };
    message: {
      message_id: string;
      chat_type: string;
      chat_id: string;
      content: string;
      create_time: string;
      update_time: string;
      message_type: string;
    };
  };
}

export interface FeishuInteractiveCard {
  config: {
    wide_screen_mode: boolean;
  };
  header: {
    title: {
      tag: 'plain_text';
      content: string;
    };
    template: string;
  };
  elements: any[];
}

export interface FeishuCardButton {
  tag: 'button';
  text: {
    tag: 'plain_text';
    content: string;
  };
  type: 'primary' | 'default';
  value: any;
}
