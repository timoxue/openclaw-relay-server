import * as lark from '@larksuiteoapi/node-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { FeishuWSMessage } from '../types';

// Feishu WebSocket Client for testing long connection and message reception
export class FeishuWebSocketClient {
  private wsClient: lark.WSClient;
  private apiClient: lark.Client;
  private config: any;
  private messageHandlers: Array<(message: FeishuWSMessage) => void> = [];
  private isConnected: boolean = false;

  constructor() {
    this.config = this.loadConfig();
    this.apiClient = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      appType: lark.AppType.SelfBuild,
    });

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.debug,
    });
  }

  // Load and expand environment variables from config file
  private loadConfig(): any {
    const configPath = path.join(process.cwd(), 'config', 'feishu.json');
    console.log(`[FeishuWS] Loading config from ${configPath}`);

    const configContent = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configContent);

    // Expand environment variables
    const expandEnvVars = (obj: any): any => {
      if (typeof obj === 'string') {
        return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
          const value = process.env[varName];
          if (value === undefined) {
            console.warn(`[FeishuWS] Environment variable ${varName} not found`);
            return '';
          }
          return value;
        });
      } else if (Array.isArray(obj)) {
        return obj.map(expandEnvVars);
      } else if (obj && typeof obj === 'object') {
        const result: any = {};
        for (const key in obj) {
          result[key] = expandEnvVars(obj[key]);
        }
        return result;
      }
      return obj;
    };

    const expandedConfig = expandEnvVars(config);
    console.log(`[FeishuWS] Config loaded: appId=${expandedConfig.appId.substring(0, 8)}...`);
    return expandedConfig;
  }

  // Start WebSocket connection to Feishu
  async start(): Promise<void> {
    try {
      console.log('[FeishuWS] Starting WebSocket connection...');

      // Create event dispatcher
      const eventDispatcher = new lark.EventDispatcher({
        encryptKey: this.config.encryptKey,
        verificationToken: this.config.verificationToken,
      }).register({
        'im.message.receive_v1': async (data: any) => {
          console.log('[FeishuWS] Received message event:', JSON.stringify(data, null, 2));

          // Parse the message according to FeishuWSMessage interface
          const message = this.parseFeishuMessage(data);
          if (message) {
            // Log message details
            console.log('[FeishuWS] Message parsed:');
            console.log(`  - Event ID: ${message.header.event_id}`);
            console.log(`  - Event Type: ${message.header.event_type}`);
            console.log(`  - Sender ID: ${message.event.sender.sender_id.user_id}`);
            console.log(`  - Chat ID: ${message.event.message.chat_id}`);
            console.log(`  - Message Content: ${message.event.message.content}`);

            // Call all registered message handlers
            for (const handler of this.messageHandlers) {
              try {
                await handler(message);
              } catch (error) {
                console.error('[FeishuWS] Error in message handler:', error);
              }
            }
          }
        },
      });

      // Start the WebSocket connection
      await this.wsClient.start({
        eventDispatcher: eventDispatcher,
      });

      console.log('[FeishuWS] WebSocket client started successfully');
      this.isConnected = true;
    } catch (error) {
      console.error('[FeishuWS] Failed to start WebSocket client:', error);
      throw error;
    }
  }

  // Parse Feishu message event
  private parseFeishuMessage(data: any): FeishuWSMessage | null {
    try {
      // Feishu SDK event data structure
      const header = data.header || {};
      const event = data.event || {};

      return {
        header: {
          event_id: header.event_id || '',
          event_type: header.event_type || '',
          create_time: header.create_time || '',
          token: header.token || '',
          app_type: header.app_type || '',
          tenant_key: header.tenant_key || '',
        },
        event: {
          sender: {
            sender_id: {
              user_id: event.sender?.sender_id?.user_id || '',
            },
            sender_type: event.sender?.sender_type || '',
          },
          message: {
            message_id: event.message?.message_id || '',
            chat_type: event.message?.chat_type || '',
            chat_id: event.message?.chat_id || '',
            content: event.message?.content || '',
            create_time: event.message?.create_time || '',
            update_time: event.message?.update_time || '',
            message_type: event.message?.message_type || '',
          },
        },
      };
    } catch (error) {
      console.error('[FeishuWS] Failed to parse message:', error);
      return null;
    }
  }

  // Register message event handler
  onMessage(handler: (message: FeishuWSMessage) => void): void {
    this.messageHandlers.push(handler);
    console.log(`[FeishuWS] Message handler registered. Total handlers: ${this.messageHandlers.length}`);
  }

  // Send text message to Feishu user
  async sendTextMessage(userId: string, text: string): Promise<boolean> {
    try {
      console.log(`[FeishuWS] Sending text message to user ${userId}: ${text}`);

      const response = await this.apiClient.im.message.create({
        params: {
          receive_id_type: 'user_id',
        },
        data: {
          receive_id: userId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });

      console.log('[FeishuWS] Send message response:', JSON.stringify(response, null, 2));

      if (response.code === 0) {
        console.log('[FeishuWS] Message sent successfully');
        return true;
      } else {
        console.error(`[FeishuWS] Failed to send message: code=${response.code}, msg=${response.msg}`);
        return false;
      }
    } catch (error) {
      console.error('[FeishuWS] Error sending message:', error);
      return false;
    }
  }

  // Get connection status
  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  // Stop WebSocket connection
  stop(force: boolean = false): void {
    try {
      console.log('[FeishuWS] Stopping WebSocket connection...');
      this.wsClient.close({ force });
      this.isConnected = false;
      console.log('[FeishuWS] WebSocket connection stopped');
    } catch (error) {
      console.error('[FeishuWS] Error stopping WebSocket:', error);
      throw error;
    }
  }
}

// Export singleton instance
export const feishuWebSocket = new FeishuWebSocketClient();
