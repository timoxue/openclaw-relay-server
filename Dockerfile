FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

RUN npm ci

COPY src ./src

RUN npm run build

FROM node:22-alpine

WORKDIR /app

# 安装 sqlite3 运行时依赖
RUN apk add --no-cache sqlite

# 复制 package 文件并安装生产依赖
COPY package*.json ./
RUN npm ci --only=production

# 从构建阶段复制编译后的文件
COPY --from=builder /app/dist ./dist

# 创建数据库目录
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV WS_PORT=3001
ENV DATABASE_PATH=/app/data/openclaw_relay.db

EXPOSE 3000 3001

CMD ["node", "dist/server.js"]
