FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
COPY packages/feed/package.json packages/feed/

RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared/ packages/shared/
COPY packages/engine/ packages/engine/
COPY packages/feed/ packages/feed/

RUN npm run build

FROM node:22-slim AS runtime

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
COPY packages/feed/package.json packages/feed/

RUN npm ci --omit=dev

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/engine/dist packages/engine/dist
COPY --from=builder /app/packages/feed/dist packages/feed/dist

CMD ["node", "packages/engine/dist/index.js"]
