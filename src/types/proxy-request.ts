// src/types/proxy-request.ts

export enum RequestStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

export interface ProxyRequest {
  id: string;
  requestorUserId: string;
  targetUserId: string;
  agentName: string;
  message: string;
  status: RequestStatus;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  result?: string;
  cardMessageId?: string;
}

export interface LarkCardActionEvent {
  event_id: string;
  token: any;
  action: { value: string; action_value: string };
  operator: { user_id: string; open_id: string };
  locale: string;
}

export interface FeishuCardElement {
  tag: string;
  text?: any;
  actions?: any[];
  elements?: any[];
}

export interface FeishuCard {
  config: { wide_screen_mode: boolean };
  header: {
    template: string;
    title: { tag: 'plain_text'; content: string };
  };
  elements: FeishuCardElement[];
}

export interface LarkCardResponse {
  toast?: { type: string; content: string };
}
