/**
 * ============================================================================
 * WebSocket Tunnel Service - 智能消息隧道
 * ============================================================================
 *
 * 实现透明的双向管道：
 * - Node client (PC) connection
 * - Docker container WebSocket connection (via container hostname)
 * - Relay server (this service)
 *
 * 每个用户有独立的 Node 连接和容器 WebSocket 连接。
 *
 * 内网直连：ws://sandbox-${userId}:38789
 * ============================================================================
 */

import WebSocket from 'ws';
import { generateKeyPairSync, createHash, sign, createPublicKey } from 'crypto';
import { randomUUID } from 'crypto';

/**
 * Device Identity for OpenClaw Gateway authentication
 */
interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

// Protocol constants
const PROTOCOL_VERSION = 3;
const CLIENT_ID = 'gateway-client';
const CLIENT_VERSION = '1.0.0';
const CLIENT_PLATFORM = 'node';
const CLIENT_MODE = 'backend';

// ED25519 SPKI prefix for raw key extraction
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// Device identity cache per user
const deviceIdentityCache = new Map<string, DeviceIdentity>();

/**
 * Derive raw public key from PEM
 */
function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

/**
 * Generate ED25519 device identity
 */
function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const raw = derivePublicKeyRaw(publicKeyPem);
  const deviceId = createHash('sha256').update(raw).digest('hex');

  return { deviceId, publicKeyPem, privateKeyPem };
}

/**
 * Get or create device identity for user
 */
function getDeviceIdentity(userId: string): DeviceIdentity {
  if (!deviceIdentityCache.has(userId)) {
    const identity = generateDeviceIdentity();
    deviceIdentityCache.set(userId, identity);
    console.log(`[WSTunnel] Generated device identity for ${userId}: ${identity.deviceId.substring(0, 16)}...`);
  }
  return deviceIdentityCache.get(userId)!;
}

/**
 * Base64 URL encode
 */
function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build device auth payload for signing
 */
function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | undefined;
  nonce?: string | undefined;
  version?: string;
}): string {
  const version = params.version || (params.nonce ? "v2" : "v1");
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  const base = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
  ];
  if (version === "v2") {
    base.push(params.nonce ?? "");
  }
  return base.join("|");
}

/**
 * Sign device auth payload using ED25519
 */
function signDeviceAuth(payload: string, privateKeyPem: string): string {
  const signature = sign(null, Buffer.from(payload), privateKeyPem);
  return signature.toString('base64');
}

/**
 * Gateway CLI handshake payload (auth-1)
 */
interface GatewayHandshakeAuth {
  type: 'req';
  id: string;
  method: 'gateway.connect';
  params: {
    minProtocol: 3;
    maxProtocol: 3;
    client: { id: 'cli', version: '1.0.0', platform: 'linux', mode: 'cli' };
    role: 'operator';
    auth: { token: string };
  };
}

/**
 * Agent chat request payload
 */
interface AgentChatRequest {
  type: 'req';
  id: string;
  method: 'agent.chat';
  params: {
    agentId: string;
    message: string;
  };
}

/**
 * JSON-RPC response payload (agent.chat res)
 */
interface AgentChatResponse {
  type: 'res';
  id: string;
  method: 'agent.chat';
  result?: {
    type: 'chat';
    content: string;
  };
}

/**
 * Container WebSocket connection interface with handshake state
 */
interface ContainerWSConnection extends WebSocket {
  gatewayToken?: string;
  userId?: string;
  handshakeComplete?: boolean;
  challengeNonce?: string;
  deviceIdentity?: DeviceIdentity;
}

/**
 * WebSocket Tunnel Service
 */
export class WSTunnelService {
  private nodeConnections: Map<string, WebSocket> = new Map();
  private containerConnections: Map<string, ContainerWSConnection> = new Map();
  private forwardConnections: Map<string, WebSocket> = new Map();
  private pendingMessages: Map<string, any[]> = new Map();

  private readonly MAX_RETRIES = 5;
  private readonly RETRY_DELAY_MS = 1000;

  /**
   * Register Node (PC) connection for a user
   */
  registerNodeConnection(userId: string, ws: WebSocket): void {
    const existingConnection = this.nodeConnections.get(userId);
    if (existingConnection && existingConnection.readyState === WebSocket.OPEN) {
      console.log(`[WSTunnel] Closing existing Node connection for user ${userId}`);
      existingConnection.close();
    }
    this.nodeConnections.set(userId, ws);
    console.log(`[WSTunnel] Registered Node connection for user ${userId}`);

    ws.on('message', (data: WebSocket.Data) => {
      this.handleNodeMessage(userId, data);
    });

    ws.on('close', () => {
      console.log(`[WSTunnel] Node connection closed for user ${userId}`);
      this.nodeConnections.delete(userId);
      this.disconnectContainer(userId);
    });

    ws.on('error', (error) => {
      console.error(`[WSTunnel] Node connection error for user ${userId}:`, error);
    });
  }

  /**
   * Connect to Docker container WebSocket with retry mechanism
   */
  async connectToContainer(userId: string, gatewayToken: string): Promise<void> {
    const safeId = this.sanitizeUserId(userId);
    const containerName = `openclaw-sandbox-${safeId}`;
    const containerUrl = `ws://${containerName}:38789`;

    console.log(`[WSTunnel] Connecting to container ${containerName}...`);

    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt < this.MAX_RETRIES) {
      attempt++;
      console.log(`[WSTunnel] Connection attempt ${attempt}/${this.MAX_RETRIES} for ${containerName}`);

      try {
        const ws = await this.connectWithRetry(containerUrl, 5000);
        const containerWs = ws as ContainerWSConnection;

        containerWs.gatewayToken = gatewayToken;
        containerWs.userId = userId;
        containerWs.handshakeComplete = false;
        containerWs.deviceIdentity = getDeviceIdentity(userId);

        // Set up message handler BEFORE sending any request
        containerWs.on('message', (data: WebSocket.Data) => {
          this.handleContainerMessage(userId, data);
        });

        containerWs.on('close', () => {
          console.log(`[WSTunnel] Container connection closed for user ${userId}`);
          this.containerConnections.delete(userId);
        });

        containerWs.on('error', (error) => {
          console.error(`[WSTunnel] Container connection error for user ${userId}:`, error);
        });

        this.containerConnections.set(userId, containerWs);

        // Wait for connect.challenge event before sending connect request
        console.log(`[WSTunnel] Waiting for connect challenge...`);
        await this.waitForConnectChallenge(userId, 10000);

        // Send connect request (must be first message)
        await this.sendConnectRequest(containerWs, gatewayToken);

        this.flushPendingMessages(userId);

        console.log(`[WSTunnel] Successfully connected to container ${containerName}`);
        return;
      } catch (error: any) {
        lastError = error;
        if (error.code === 'ECONNREFUSED') {
          console.warn(`[WSTunnel] Connection refused, retrying in ${this.RETRY_DELAY_MS}ms...`);
          await this.sleep(this.RETRY_DELAY_MS);
          continue;
        } else {
          console.error(`[WSTunnel] Connection failed:`, error);
          throw error;
        }
      }
    }

    throw new Error(`Failed to connect to container ${containerName} after ${this.MAX_RETRIES} attempts. Last error: ${lastError?.message}`);
  }

  /**
   * Connect with timeout
   */
  private connectWithRetry(url: string, timeout: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          'Host': '127.0.0.1:18789'
        }
      });

      const timer = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.close();
          reject(new Error(`Connection timeout after ${timeout}ms`));
        }
      }, timeout);

      ws.on('open', () => {
        clearTimeout(timer);
        if (ws.readyState === WebSocket.OPEN) {
          resolve(ws);
        } else {
          reject(new Error(`WebSocket opened in unexpected state: ${ws.readyState}`));
        }
      });

      ws.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Wait for connect.challenge event from container
   */
  private async waitForConnectChallenge(userId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const containerWs = this.containerConnections.get(userId);
      if (!containerWs) {
        reject(new Error('Container connection not found'));
        return;
      }

      let timeout: NodeJS.Timeout;

      const challengeHandler = (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'event' && message.event === 'connect.challenge') {
            const nonce = message.payload?.nonce;
            if (nonce) {
              containerWs.challengeNonce = nonce;
              console.log(`[WSTunnel] Received connect challenge for user ${userId} with nonce: ${nonce.substring(0, 16)}...`);
            } else {
              console.log(`[WSTunnel] Received connect challenge for user ${userId} (no nonce)`);
            }
            clearTimeout(timeout);
            containerWs.off('message', challengeHandler);
            resolve();
          }
        } catch (e) {
          // Ignore parse errors
        }
      };

      containerWs.on('message', challengeHandler);

      timeout = setTimeout(() => {
        containerWs.off('message', challengeHandler);
        reject(new Error(`Connect challenge timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  /**
   * Send connect request (must be first message after challenge)
   */
  private sendConnectRequest(ws: WebSocket, token: string): void {
    const containerWs = ws as ContainerWSConnection;

    if (!containerWs.deviceIdentity) {
      console.error('[WSTunnel] No device identity available for connect request');
      return;
    }

    const signedAtMs = Date.now();
    const scopes = ['operator.write', 'operator.read'];
    const role = 'operator';

    // Build device auth payload with signature
    const authPayload = buildDeviceAuthPayload({
      deviceId: containerWs.deviceIdentity.deviceId,
      clientId: CLIENT_ID,
      clientMode: CLIENT_MODE,
      role,
      scopes,
      signedAtMs,
      token: token || undefined,
      nonce: containerWs.challengeNonce || undefined,
      version: "v2",
    });

    const signature = signDeviceAuth(authPayload, containerWs.deviceIdentity.privateKeyPem);

    // Get public key raw bytes and base64 URL encode
    const publicKeyRaw = derivePublicKeyRaw(containerWs.deviceIdentity.publicKeyPem);
    const publicKeyBase64 = base64UrlEncode(publicKeyRaw);

    const connectPayload = {
      type: 'req',
      id: 'connect',
      method: 'connect',
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        role,
        scopes,
        client: {
          id: CLIENT_ID,
          displayName: 'LingSynapse Gateway',
          version: CLIENT_VERSION,
          platform: CLIENT_PLATFORM,
          mode: CLIENT_MODE,
          instanceId: randomUUID(),
        },
        auth: token ? { token } : undefined,
        device: {
          id: containerWs.deviceIdentity.deviceId,
          publicKey: publicKeyBase64,
          signature,
          signedAt: signedAtMs,
          nonce: containerWs.challengeNonce || undefined,
        },
      },
    };
    ws.send(JSON.stringify(connectPayload));
    console.log('[WSTunnel] Sent connect request with device identity');
  }

  /**
   * Handle messages from Node client (upstream from PC)
   */
  private handleNodeMessage(userId: string, data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());
      console.log(`[WSTunnel] Received from Node (user ${userId}):`, message);

      switch (message.type) {
        case 'chat':
          this.sendAgentChatRequest(userId, message);
          break;
        case 'ping':
          const containerWs = this.containerConnections.get(userId);
          if (containerWs && containerWs.readyState === WebSocket.OPEN) {
            containerWs.send(JSON.stringify({ type: 'ping' }));
          }
          break;
        case 'disconnect':
          this.disconnectContainer(userId);
          break;
        default:
          console.warn(`[WSTunnel] Unknown message type from Node: ${message.type}`);
      }
    } catch (error) {
      console.error(`[WSTunnel] Error handling Node message:`, error);
    }
  }

  /**
   * Send Agent Chat request to OpenClaw
   */
  private sendAgentChatRequest(userId: string, message: any): void {
    const containerWs = this.containerConnections.get(userId);

    if (!containerWs || containerWs.readyState !== WebSocket.OPEN) {
      this.addPendingMessage(userId, message);
      return;
    }

    if (message.params?.agentId) {
      const chatRequest: AgentChatRequest = {
        type: 'req',
        id: Date.now().toString(),
        method: 'agent.chat',
        params: {
          agentId: message.params.agentId || 'main',
          message: message.params?.message || message.text || '',
        },
      };
      containerWs.send(JSON.stringify(chatRequest));
    } else {
      const text = message.text || message.params?.text || '';
      const chatRequest: AgentChatRequest = {
        type: 'req',
        id: Date.now().toString(),
        method: 'agent.chat',
        params: {
          agentId: 'main',
          message: text,
        },
      };
      containerWs.send(JSON.stringify(chatRequest));
    }
  }

  /**
   * Handle messages from OpenClaw container (downstream)
   */
  private handleContainerMessage(userId: string, data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());
      console.log(`[WSTunnel] Received from container (user ${userId}):`, message);

      switch (message.type) {
        case 'res':
          // Handle connect response
          if (message.id === 'connect') {
            if (message.ok) {
              console.log(`[WSTunnel] ✓ Handshake successful for user ${userId}`);
              const containerWs = this.containerConnections.get(userId) as ContainerWSConnection;
              if (containerWs) {
                containerWs.handshakeComplete = true;
              }
            } else {
              console.error(`[WSTunnel] ✗ Handshake failed for user ${userId}:`, message.error);
            }
          } else if (message.ok === true && message.result?.type === 'chat') {
            const content = message.result.content || '';
            this.sendToFeishu(userId, content);
          } else if (message.ok === false) {
            const errorMsg = typeof message.error === 'string'
              ? message.error
              : JSON.stringify(message.error || 'Unknown error');
            this.sendToFeishu(userId, `Error: ${errorMsg}`);
          }
          break;
        case 'req':
          if (message.method === 'agent.chat') {
            this.sendToFeishu(userId, message.params?.message || '');
          }
          break;
        case 'event':
          if (message.event === 'connect.challenge') {
            console.log(`[WSTunnel] Received connect challenge for user ${userId}`);
            // Handled by waitForConnectChallenge
          } else if (message.event === 'chat') {
            // Handle chat completion events
            if (message.payload?.state === 'final' && message.payload?.message) {
              const msg = message.payload.message;
              if (msg.content && Array.isArray(msg.content) && msg.content.length > 0) {
                // Build message from content blocks
                let text = '';
                for (const block of msg.content) {
                  if (block.type === 'text') {
                    text += block.text;
                  } else if (block.type === 'tool_use') {
                    text += `\n[使用工具: ${block.name}]`;
                  } else if (block.type === 'tool_result') {
                    text += `\n[工具结果]`;
                  }
                }
                if (text) {
                  this.sendToFeishu(userId, text);
                }
              }
            }
          } else if (message.event === 'agent') {
            // Handle agent events including errors
            if (message.payload?.stream === 'lifecycle' && message.payload?.data?.phase === 'error') {
              const error = message.payload.data.error || 'Unknown agent error';
              console.log(`[WSTunnel] Agent error for user ${userId}: ${error}`);
              this.sendToFeishu(userId, error);
            } else if (message.payload?.stream === 'error') {
              const error = message.payload.data?.reason || 'Unknown error';
              console.log(`[WSTunnel] Agent stream error for user ${userId}: ${error}`);
            }
          }
          break;
        case 'ping':
          const nodeWs = this.nodeConnections.get(userId);
          if (nodeWs && nodeWs.readyState === WebSocket.OPEN) {
            nodeWs.send(JSON.stringify({ type: 'pong' }));
          }
          break;
        default:
          console.warn(`[WSTunnel] Unknown message type from container: ${message.type}`);
      }
    } catch (error) {
      console.error(`[WSTunnel] Error handling container message:`, error);
    }
  }

  /**
   * Send message to Feishu
   */
  private sendToFeishu(userId: string, content: string): void {
    console.log(`[WSTunnel] Sending to Feishu for user ${userId}: ${content}`);
    import('./orchestrator.js').then((module: any) => {
      module.sendFeishuMessage(userId, content);
    }).catch((error) => {
      console.error(`[WSTunnel] Failed to send to Feishu: ${userId}:`, error);
    });
  }

  /**
   * Send chat message (main entry for orchestrator)
   */
  async sendChatMessage(userId: string, message: string): Promise<void> {
    const containerWs = this.containerConnections.get(userId);

    if (!containerWs || containerWs.readyState !== WebSocket.OPEN) {
      console.warn(`[WSTunnel] No active container for user ${userId}`);
      return;
    }

    const chatRequest: any = {
      type: 'req',
      id: Date.now().toString(),
      method: 'chat.send',
      params: {
        sessionKey: 'default',
        message,
        idempotencyKey: Date.now().toString(),
      },
    };

    containerWs.send(JSON.stringify(chatRequest));
    console.log(`[WSTunnel] Sent chat message to container for user ${userId}: ${message}`);
  }

  /**
   * Disconnect container connection
   */
  private disconnectContainer(userId: string): void {
    const containerWs = this.containerConnections.get(userId);
    if (containerWs) {
      containerWs.close();
      this.containerConnections.delete(userId);
      console.log(`[WSTunnel] Disconnected container connection for user ${userId}`);
    }
  }

  /**
   * Disconnect Node connection for a user
   */
  private disconnectNode(userId: string): void {
    const nodeWs = this.nodeConnections.get(userId);
    if (nodeWs) {
      nodeWs.close();
      this.nodeConnections.delete(userId);
      console.log(`[WSTunnel] Disconnected Node connection for user ${userId}`);
    }
  }

  /**
   * Disconnect all connections for a user (both Node and container)
   */
  disconnectAll(userId: string): void {
    this.disconnectNode(userId);
    this.disconnectContainer(userId);
  }

  /**
   * Check if user has active container connection
   */
  hasActiveConnections(userId: string): boolean {
    return this.containerConnections.has(userId);
  }

  /**
   * Check if user has any active connection
   */
  hasAnyConnection(userId: string): boolean {
    return this.nodeConnections.has(userId) || this.containerConnections.has(userId);
  }

  /**
   * Get connection counts
   */
  getConnectionCounts(): { nodeConnections: number; containerConnections: number } {
    return {
      nodeConnections: this.nodeConnections.size,
      containerConnections: this.containerConnections.size,
    };
  }

  /**
   * Add a pending message for when container is not ready
   */
  private addPendingMessage(userId: string, message: any): void {
    if (!this.pendingMessages.has(userId)) {
      this.pendingMessages.set(userId, []);
    }
    this.pendingMessages.get(userId)!.push(message);
  }

  /**
   * Flush pending messages after container is ready
   */
  private flushPendingMessages(userId: string): void {
    const pending = this.pendingMessages.get(userId);
    if (pending && pending.length > 0) {
      console.log(`[WSTunnel] Flushing ${pending.length} pending messages for user ${userId}`);
      for (const msg of pending) {
        this.handleNodeMessage(userId, JSON.stringify(msg));
      }
      this.pendingMessages.delete(userId);
    }
  }

  /**
   * Sanitize userId: replace underscores with hyphens, lowercase
   */
  private sanitizeUserId(userId: string): string {
    return userId.replace(/_/g, '-').toLowerCase();
  }

  /**
   * Shutdown all connections (for graceful shutdown)
   */
  shutdown(): void {
    console.log('[WSTunnel] Shutting down all connections...');

    for (const [userId, nodeWs] of this.nodeConnections.entries()) {
      if (nodeWs.readyState === WebSocket.OPEN) {
        nodeWs.close();
      }
    }
    this.nodeConnections.clear();

    for (const [userId, containerWs] of this.containerConnections.entries()) {
      if (containerWs.readyState === WebSocket.OPEN) {
        containerWs.close();
      }
    }
    this.containerConnections.clear();

    this.pendingMessages.clear();

    console.log('[WSTunnel] All connections closed');
  }
}

// Singleton instance
export const wsTunnel = new WSTunnelService();
