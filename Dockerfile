# Deepscord — 生产镜像
FROM node:22-alpine

WORKDIR /app

# Install only the pinned standalone server dependency closure.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.js LICENSE ./
COPY lib ./lib
COPY public ./public
COPY deploy/livekit-config.cjs ./deploy/livekit-config.cjs

ENV NODE_ENV=production \
    PORT=3000

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
