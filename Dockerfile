FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./
COPY config ./config

RUN npm ci

COPY src ./src

RUN npm run build

FROM node:22-alpine

WORKDIR /app

# 安装 sqlite3 运行时依赖
RUN apk add --no-cache sqlite

# Install Docker CLI for Docker-in-Docker
RUN apk add --no-cache docker-cli

# 复制 package 文件并安装生产依赖
COPY package*.json ./
RUN npm install --omit=dev

# 从构建阶段复制编译后的文件
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/config ./config

# 创建数据库目录
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV WS_PORT=3001
ENV DATABASE_PATH=/app/data/openclaw_relay.db

EXPOSE 3000 3001

CMD ["node", "dist/server.js"]
