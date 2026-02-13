# Ubuntu 部署指南

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
git clone <your-repo-url> openclaw-relay-server
cd openclaw-relay-server
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
JWT_SECRET=<生成一个强密码>

# 飞书配置
FEISHU_APP_ID=<你的飞书应用ID>
FEISHU_APP_SECRET=<你的飞书应用密钥>

# LLM 配置 (默认使用智谱 AI)
LLM_PROVIDER=zhipu
LLM_API_KEY=<你的智谱API密钥>
LLM_MODEL=glm-4.7
LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4/
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
sudo ufw allow 5178/tcp  # 如果不使用 nginx
sudo ufw allow 5179/tcp  # 如果不使用 nginx
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

### 6. 配置飞书机器人 Webhook

1. 登录飞书开放平台
2. 进入你的应用 -> 事件订阅
3. 设置请求 URL: `https://your-domain.com/api/feishu/webhook`

## 本地开发（Ubuntu）

如果需要在 Ubuntu 上本地开发：

```bash
# 安装编译工具
sudo apt install -y build-essential python3

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
docker-compose logs -f relay-server

# 进入容器
docker exec -it openclaw-relay sh
```
