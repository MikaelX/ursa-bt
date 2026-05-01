# syntax=docker/dockerfile:1.7

# ---------- Build stage: install deps and build the Vite frontend ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server

RUN npm run build

# ---------- Runtime stage: small image that runs the banks server and serves dist ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000 \
    DATA_FILE=/data/cameras.json \
    STATIC_DIR=/app/dist

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev \
 && npm install --no-save tsx@^4.20.6

COPY server ./server
COPY src/banks ./src/banks
COPY --from=build /app/dist ./dist

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 4000
CMD ["npx", "tsx", "server/index.ts"]
