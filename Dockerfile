# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS deps
WORKDIR /app
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm i --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY . .
# 针对 Docker，将 Nitro 预设改为 node-server 运行时
RUN NITRO_PRESET=node-server pnpm build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
# 可根据需要调整日志级别：debug|info|warn|error
ENV NITRO_LOG_LEVEL=info
EXPOSE 3000
COPY --from=build /app/.output ./.output
# 创建 data 目录并设置权限（用于 SQLite 持久化）
RUN mkdir -p /app/data && chmod 777 /app/data
CMD ["node", "--enable-source-maps", ".output/server/index.mjs"]


