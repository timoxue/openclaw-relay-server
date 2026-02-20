# 部署指南

## 前置要求

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 安装 Node.js 22.x
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 安装 Docker 和 Docker Compose
sudo apt install -y docker.io docker-compose

# 启用 Docker 服务
sudo systemctl enable docker
sudo systemctl start docker
```

## 部署步骤

### 1. 克隆代码

```bash
git clone <your-repo-url> lingsynapse
cd lingsynapse
```

### 2. 配置环境变量

```bash
cp .env.example .env
nano .env  # 编辑配置
```

**必须配置的变量：**
```env
# 基础配置
NODE_ENV=production
PORT=5178
JWT_SECRET=<生成一个强密码>

# 飞书配置
FEISHU_APP_ID=<你的飞书应用ID>
FEISHU_APP_SECRET=<你的飞书应用密钥>
FEISHU_ENCRYPT_KEY=<飞书加密密钥（可选）>
FEISHU_VERIFICATION_TOKEN=<飞书验证令牌（可选）>

# LLM 配置 (默认使用智谱 AI)
LLM_PROVIDER=zhipu
LLM_API_KEY=<你的智谱API密钥>
LLM_MODEL=glm-4.7
LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4/

# Docker 配置
DOCKER_NETWORK=synapse-net
```

**可选 - 使用 Anthropic:**
```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=<你的Anthropic密钥>
ANTHROPIC_MODEL=anthropic/claude-opus-4-5
```

### 3. 启动服务

```bash
# 构建并启动
docker-compose up -d

# 查看日志
docker-compose logs -f

# 检查服务状态
curl http://localhost:5178/health
```

### 4. 配置防火墙

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 5178/tcp  # HTTP API
sudo ufw enable
```

### 5. 配置 Nginx SSL（可选）

```bash
# 安装 certbot
sudo apt install -y certbot

# 获取证书
sudo certbot certonly --standalone -d your-domain.com

# 证书路径
ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
```

### Nginx 配置示例

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:5178;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## 连接方式说明

### 飞书连接

本服务使用 **WebSocket 客户端模式**主动连接飞书服务器，无需配置 Webhook。

飞书应用配置：
- 应用类型：自建应用
- 事件订阅：无需配置（使用 WebSocket 模式）
- 权限：`im:message`、`im:message:group_at_msg`、`contact:user.base:readonly`

### 容器网络

确保 Docker 容器可以访问宿主机的 Docker socket：
```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

## 本地开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

## 常用命令

```bash
# 查看服务状态
docker-compose ps

# 重启服务
docker-compose restart

# 停止服务
docker-compose down

# 查看日志
docker-compose logs -f

# 进入容器
docker exec -it lingsynapse sh
```

## 故障排查

### 飞书连接失败

1. 检查 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 是否正确
2. 查看日志中的 `[FeishuWS]` 相关错误
3. 确认网络可以访问 `open.feishu.cn`

### 容器启动失败

1. 检查 Docker socket 挂载是否正确
2. 确认 Docker 网络存在：`docker network ls`
3. 查看容器日志：`docker-compose logs`

### Token 验证失败

1. 检查 `JWT_SECRET` 是否设置
2. 确认 Token 未过期（默认 30 天）
