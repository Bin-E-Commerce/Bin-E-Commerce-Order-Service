# Dockerfile độc lập cho Order Service; build context là thư mục submodule này.

FROM node:20-alpine AS builder
WORKDIR /app
COPY tsconfig.base.json ./
COPY services/order-service/package.json services/order-service/package-lock.json ./services/order-service/
COPY services/order-service/tsconfig.json services/order-service/tsconfig.build.json services/order-service/nest-cli.json ./services/order-service/
COPY services/order-service/src ./services/order-service/src
WORKDIR /app/services/order-service
RUN npm ci
RUN npm run build

FROM node:20-alpine AS production
RUN addgroup -g 1001 -S nodejs && adduser -S nestjs -u 1001
WORKDIR /app
COPY services/order-service/package.json services/order-service/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/services/order-service/dist ./dist
ENV NODE_ENV=production
EXPOSE 3004
USER nestjs
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://localhost:3004/api/health || exit 1
CMD ["node", "--max-old-space-size=128", "dist/main.js"]
