# syntax=docker/dockerfile:1.7

# ---------- Build stage: install deps and build the Vite frontend ----------
FROM node:22-alpine AS build
WORKDIR /app

ARG ENVIRONMENT=production
ENV ENVIRONMENT=${ENVIRONMENT}

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html patterns.html ./
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
# Production runtime has no patches/; postinstall would invoke patch-package (dev-only).
RUN npm ci --omit=dev --ignore-scripts

COPY server ./server
COPY src/banks ./src/banks
COPY src/blackmagic ./src/blackmagic
COPY src/relay ./src/relay
COPY --from=build /app/dist ./dist

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 4000
CMD ["./node_modules/.bin/tsx", "server/index.ts"]
