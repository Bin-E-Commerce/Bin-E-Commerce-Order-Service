# Order Service dùng build context là root repository vì tsconfig và packages/common
# nằm ở cấp monorepo. Docker chỉ đọc các file được phép trong Dockerfile.dockerignore;
# các service khác không được copy vào image này.

# -----------------------------------------------------------------------------
# Giai đoạn build: cài dependency cố định và compile Order Service.
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Copy manifest trước source để Docker cache dependency khi chỉ sửa TypeScript.
# Order dùng package-lock riêng nên npm ci chạy trong workspace Order.
COPY tsconfig.base.json ./
COPY packages/common ./packages/common
COPY services/order-service/package.json services/order-service/package-lock.json ./services/order-service/
COPY services/order-service/tsconfig.json services/order-service/tsconfig.build.json services/order-service/nest-cli.json ./services/order-service/

# Cài đúng phiên bản trong lockfile; devDependency như TypeScript và tsc-alias
# chỉ tồn tại ở builder để compile và rewrite alias @common/*.
WORKDIR /app/services/order-service
RUN npm ci --include=dev --ignore-scripts

# Chỉ đưa source của Order vào build context; không kéo source service khác vào image.
COPY services/order-service/src ./src

# Script build gồm tsc và tsc-alias, nên JavaScript runtime dùng đường dẫn tương đối
# tới packages/common thay vì cần loader alias trong production.
RUN npm run build

# Runtime chỉ cần dependency production; Nest CLI, Jest và TypeScript bị loại bỏ.
RUN npm prune --omit=dev

# -----------------------------------------------------------------------------
# Giai đoạn runtime: image gọn, non-root, chỉ chứa artifact đã compile.
# -----------------------------------------------------------------------------
FROM node:20-alpine AS production

# npm/npx chỉ cần ở builder để cài dependency; runtime chỉ chạy bằng node.
# Loại chúng khỏi final image để không mang theo dependency/tooling không cần thiết của npm.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  && addgroup -g 1001 -S nodejs \
  && adduser -S nestjs -u 1001

WORKDIR /app

# dist của Order có thể chứa cả packages/common do rootDir là monorepo; copy toàn
# bộ artifact của chính workspace để các import đã được tsc-alias resolve đúng.
COPY --from=builder --chown=nestjs:nodejs /app/services/order-service/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/services/order-service/dist ./dist

ENV NODE_ENV=production \
  PORT=3011 \
  NODE_OPTIONS=--max-old-space-size=128

EXPOSE 3011

# Order health kiểm tra HTTP process và trạng thái DataSource; URI versioning của
# main.ts khiến endpoint thật là /api/v1/health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD wget --quiet --tries=1 --spider "http://localhost:${PORT}/api/v1/health" || exit 1

USER nestjs

# Chạy Node trực tiếp để nhận SIGTERM đúng khi Compose/Kubernetes rolling update.
CMD ["node", "dist/services/order-service/src/main.js"]
