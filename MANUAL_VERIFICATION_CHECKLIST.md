# Manual Verification Checklist

This checklist provides step-by-step instructions for manually verifying the complete Synapse Orchestrator implementation.

## Prerequisites

- Docker and Docker Compose installed
- Node.js (v18 or higher) installed
- Feishu app credentials configured
- Access to the codebase at `/Users/timo/LingSynapse`

---

## Step 1: Build Docker Image

Before running the system, build the OpenClaw Gateway Docker image:

```bash
cd /Users/timo/LingSynapse
docker build -t openclaw/gateway:latest .
```

**Verification:**
- [ ] Build completes successfully without errors
- [ ] Image is listed in `docker images | grep openclaw/gateway`

---

## Step 2: Verify Environment Configuration

Ensure all required environment variables are set:

```bash
# Check .env file
cat /Users/timo/LingSynapse/.env
```

**Required Environment Variables:**
- [ ] `FEISHU_APP_ID` - Your Feishu app ID
- [ ] `FEISHU_APP_SECRET` - Your Feishu app secret
- [ ] `FEISHU_ENCRYPT_KEY` - Encryption key for Feishu
- [ ] `FEISHU_VERIFICATION_TOKEN` - Verification token for Feishu
- [ ] `JWT_SECRET` - Secret for JWT token generation
- [ ] `PORT` - Server port (default: 3000)

---

## Step 3: Start Services

### Option A: Using Docker Compose (Recommended for production)

```bash
cd /Users/timo/LingSynapse
docker-compose up -d
```

**Verification:**
- [ ] All containers start successfully
- [ ] Check container status: `docker-compose ps`
- [ ] All services show "Up" status

### Option B: Using npm (For development)

```bash
cd /Users/timo/LingSynapse
npm install
npm run dev
```

**Verification:**
- [ ] Server starts without errors
- [ ] Server listens on configured port (default: 3000)
- [ ] Check logs: All services initialized

---

## Step 4: Verify Docker Network

Ensure the synapse network exists:

```bash
docker network ls | grep synapse
```

**Verification:**
- [ ] Network `synapse` exists
- [ ] Network has bridge driver
- [ ] Network is not in error state

If not created, create it:

```bash
docker network create synapse
```

---

## Step 5: Test Feishu Integration

### 5.1 Send a Test Message

1. Open Feishu app
2. Send a message to your bot (any message)
3. Check server logs

**Verification:**
- [ ] Message received in logs
- [ ] User state created for the sender
- [ ] Ignition card/message sent back to user

### 5.2 Test Ignition Card

If using interactive cards:

1. Click "Ignite Sandbox" button in the Feishu app
2. Wait for container to start
3. Check server logs

**Verification:**
- [ ] Card interaction received
- [ ] Docker container created
- [ ] Container assigned a port
- [ ] Success message sent to user

If using text-based fallback:

1. Reply with "ignite" to the bot
2. Check server logs

**Verification:**
- [ ] Message processed
- [ ] Docker container created
- [ ] Success message sent

### 5.3 Test Cancel Action

1. Click "Cancel" button (if available)
2. Check server logs

**Verification:**
- [ ] Cancel action received
- [ ] Awaiting confirmation state cleared
- [ ] Cancel message sent to user

---

## Step 6: Test WebSocket Tunnel

### 6.1 Start a Node Client

Create a test Node client (or use the existing one):

```javascript
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3000/ws?userId=YOUR_USER_ID');

ws.on('open', () => {
  console.log('Connected to relay server');
});

ws.on('message', (data) => {
  console.log('Received:', data.toString());
});

// Send a test message
setTimeout(() => {
  ws.send('Hello from Node client!');
}, 1000);
```

**Verification:**
- [ ] WebSocket connection established
- [ ] Connection authenticated with userId
- [ ] Messages can be sent
- [ ] Messages can be received

### 6.2 Check Connection Counts

Access the API endpoint:

```bash
curl http://localhost:3000/api/orchestrator/connections
```

**Verification:**
- [ ] Response shows nodeConnections > 0
- [ ] Response shows containerConnections count
- [ ] feishuWebSocketConnected status

---

## Step 7: Verify Docker Container Operations

### 7.1 List Running Containers

```bash
docker ps | grep openclaw
```

**Verification:**
- [ ] Container is running
- [ ] Container name follows pattern: `synapse_user_{userId}`
- [ ] Port mapping is visible (e.g., 0.0.0.0:xxxxx->18789/tcp)

### 7.2 Check Container Logs

```bash
docker logs <container_id>
```

**Verification:**
- [ ] Container logs are readable
- [ ] No error messages in logs
- [ ] Gateway token is set correctly
- [ ] User token is set correctly

### 7.3 Inspect Container

```bash
docker inspect <container_id>
```

**Verification:**
- [ ] Container is in "running" state
- [ ] Environment variables are set
- [ ] Volume mounts are correct
- [ ] Network is set to "synapse"

---

## Step 8: Test API Endpoints

### 8.1 Get All Active States

```bash
curl http://localhost:3000/api/orchestrator/states
```

**Verification:**
- [ ] Response includes count
- [ ] Response includes states array
- [ ] Each state has userId, hasContainer, containerStatus, etc.

### 8.2 Get User State

```bash
curl http://localhost:3000/api/orchestrator/states/{userId}
```

**Verification:**
- [ ] Response includes userId
- [ ] Response includes containerInfo (if container exists)
- [ ] Response includes awaitingConfirmation status

### 8.3 Stop User Sandbox

```bash
curl -X POST http://localhost:3000/api/orchestrator/states/{userId}/stop
```

**Verification:**
- [ ] Response includes success message
- [ ] Container is stopped
- [ ] User state is updated

### 8.4 Get Container Logs

```bash
curl http://localhost:3000/api/orchestrator/logs/{userId}?tail=50
```

**Verification:**
- [ ] Response includes userId
- [ ] Response includes tail count
- [ ] Response includes logs string

### 8.5 Trigger Cleanup

```bash
curl -X POST http://localhost:3000/api/orchestrator/cleanup
```

**Verification:**
- [ ] Response includes cleanup message
- [ ] Inactive states are cleaned up
- [ ] Old containers are stopped

---

## Step 9: Check Server Logs

Monitor the server logs for any errors:

```bash
# If using npm
tail -f /path/to/server/logs

# If using docker-compose
docker-compose logs -f
```

**Verification:**
- [ ] No error messages in logs
- [ ] All services initialized successfully
- [ ] Docker operations logged correctly
- [ ] WebSocket connections logged correctly
- [ ] Feishu messages logged correctly

---

## Step 10: Test Error Handling

### 10.1 Test Invalid User ID

```bash
curl http://localhost:3000/api/orchestrator/states/invalid_user_123
```

**Verification:**
- [ ] Returns 404 status
- [ ] Returns error message

### 10.2 Test Stopping Non-existent Container

```bash
curl -X POST http://localhost:3000/api/orchestrator/states/non_existent_user/stop
```

**Verification:**
- [ ] Request completes without error
- [ ] Graceful handling in logs

### 10.3 Test Missing Environment Variables

Temporarily remove a required environment variable and restart:

```bash
# Remove FEISHU_APP_ID from .env
npm run dev
```

**Verification:**
- [ ] Server logs warning message
- [ ] Service falls back to config file
- [ ] No crash

---

## Step 11: Performance Verification

### 11.1 Check Memory Usage

```bash
docker stats
```

**Verification:**
- [ ] Container memory usage is reasonable
- [ ] No memory leaks observed

### 11.2 Check Response Times

```bash
time curl http://localhost:3000/api/orchestrator/states
```

**Verification:**
- [ ] Response time < 100ms
- [ ] No significant delays

---

## Step 12: Cleanup Verification

### 12.1 Automatic Cleanup

Wait for 5+ minutes without activity on a user sandbox.

**Verification:**
- [ ] Inactive states are cleaned up
- [ ] Containers are stopped
- [ ] Logs show cleanup action

### 12.2 Manual Cleanup

```bash
# Stop all containers
docker stop $(docker ps -q --filter "name=synapse_user_")

# Remove network
docker network rm synapse
```

**Verification:**
- [ ] Containers stop gracefully
- [ ] Network removed successfully
- [ ] No orphaned processes

---

## Step 13: Integration Test Results

Run the integration tests:

```bash
cd /Users/timo/LingSynapse
npm test tests/integration/orchestrator.test.ts
```

**Expected Results:**
- [ ] All user state tests pass (3 tests)
- [ ] Docker container tests may fail if image not built (4 tests)
- [ ] Orchestrator state machine tests pass (3 tests)
- [ ] Edge case tests pass (3 tests)
- [ ] Cleanup test passes (1 test)

**Note:** Docker-related tests will fail if the `openclaw/gateway:latest` image is not built. This is expected behavior.

---

## Step 14: End-to-End Demo

### Demo Scenario 1: New User Flow

1. User sends first message to bot
2. Bot creates user state
3. Bot sends ignition card
4. User clicks "Ignite Sandbox"
5. Container is created
6. User sends another message
7. Message is logged (can be forwarded when Node client connects)

**Verification:**
- [ ] Each step completes successfully
- [ ] Logs show proper state transitions
- [ ] User receives appropriate feedback

### Demo Scenario 2: Existing User Flow

1. User who already has a running container sends a message
2. Container status is checked
3. Message is logged/forwarded

**Verification:**
- [ ] Existing container is reused
- [ ] No new container is created
- [ ] Message is processed

### Demo Scenario 3: Cleanup Flow

1. User has active sandbox
2. User becomes inactive for >1 hour (or wait for automatic cleanup)
3. Cleanup interval triggers
4. Container is stopped
5. State is removed

**Verification:**
- [ ] Cleanup process executes
- [ ] Resources are freed
- [ ] Logs show cleanup details

---

## Step 15: Final Verification

### Check All Components

- [ ] Docker Orchestrator: Working
- [ ] Feishu WebSocket Client: Working
- [ ] Core Orchestrator: Working
- [ ] WebSocket Tunnel: Working
- [ ] API Routes: Working
- [ ] Token Service: Working
- [ ] Database: Working
- [ ] Configuration: Working
- [ ] Logging: Working

### Health Check

```bash
curl http://localhost:3000/health
```

**Verification:**
- [ ] Health endpoint responds
- [ ] Status is "healthy"
- [ ] All services operational

---

## Troubleshooting Guide

### Issue: Docker image not found
**Solution:** Build the image: `docker build -t openclaw/gateway:latest .`

### Issue: Network not found
**Solution:** Create network: `docker network create synapse`

### Issue: Feishu connection fails
**Solution:** Check environment variables and app credentials

### Issue: WebSocket connection refused
**Solution:** Check if server is running on correct port

### Issue: Container fails to start
**Solution:** Check container logs: `docker logs <container_id>`

---

## Success Criteria

All verification steps should be completed with:

- [ ] No critical errors in logs
- [ ] All API endpoints responding correctly
- [ ] Docker containers managing lifecycle properly
- [ ] WebSocket connections working
- [ ] Feishu integration functional
- [ ] Integration tests passing (non-Docker tests)
- [ ] End-to-end demo successful

---

## Notes

- Some tests may fail without the Docker image built - this is expected
- Automatic cleanup runs every 5 minutes for states inactive >1 hour
- Containers use random host ports for security
- All operations are logged for debugging
- The system is designed to be fault-tolerant and graceful degradation
