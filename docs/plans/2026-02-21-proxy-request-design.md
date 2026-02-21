# Proxy Request System Design

## Overview

User A can invoke User B's OpenClaw agent via the relay service, requiring User B's approval through a Feishu card before execution.

## Architecture

```
Feishu Platform
  ┌─────────────────────────────────────┐
  │  Existing feishuWSClient            │
  │  - im.message.receive_v1            │
  │  + p2_card_action_trigger (new)    │
  └─────────────────────────────────────┘
                │
                ▼
┌───────────────────────────────────────┐
│        Proxy Request Services          │
│  ┌──────────────────┐ ┌──────────────┐ │
│  │ LarkCardHandler  │ │ProxyRequest  │ │
│  │ - Card events    │ │ Service      │ │
│  │ - Permission     │ │ - CRUD       │ │
│  └──────────────────┴──────────────┘  │
└───────────────────────────────────────┘
                │
                ▼
┌───────────────────────────────────────┐
│     Existing Services (Reused)         │
│  • feishuAPI - Send/update cards       │
│  • wsTunnel - Send to container       │
│  • database - Store proxy_requests    │
│  • orchestrator - Parse @ commands    │
└───────────────────────────────────────┘
```

## Core Flow

1. **User A**: Sends `@userB !openclaw "help me check weather"`
2. **Orchestrator**: Parses @mention and calls ProxyRequestService
3. **ProxyRequestService**: Creates request and sends approval card to User B
4. **User B**: Clicks "Approve" on Feishu card
5. **LarkCardHandler**: Receives card action, validates permissions
6. **ProxyRequestService**: Executes via wsTunnel, updates card, notifies User A

## File Structure

```
src/
├── services/
│   ├── proxy-request.ts          # Core service (~200 lines)
│   ├── lark-card-handler.ts      # Card event handler (~100 lines)
├── types/
│   └── proxy-request.ts          # Type definitions (~50 lines)
├── utils/
│   └── text-utils.ts             # Text truncation (~30 lines)
```

## Data Types

```typescript
enum RequestStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

interface ProxyRequest {
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
```

## Concurrency Control

Use in-memory Set for optimistic locking to prevent duplicate approvals:

```typescript
private processingRequests = new Set<string>();
```

## Security

- Only target user can approve their requests
- 24-hour expiry for pending requests
- Request ID validation (UUID)
- Audit trail with "Authorized by @userB" message

## Commands

| Command | Description |
|---------|-------------|
| `@userB !openclaw "message"` | Request to invoke userB's agent |
| `!openclaw request status` | Check request status |
| `!openclaw request cancel <id>` | Cancel pending request |

## Integration Points

1. **orchestrator.ts**: Parse `@userB !openclaw` format
2. **server.ts**: Register `p2_card_action_trigger` handler
3. **database.ts**: Add `proxy_requests` table and operations
