# ── Build stage ──────────────────────────────────────
FROM node:22.14.0-alpine3.21 AS builder

WORKDIR /app

# Install build dependencies if needed (e.g. for native build tools if any)
RUN apk add --no-cache python3 make g++

# Copy package manifests first to leverage Docker layer caching
COPY package*.json ./

# Install all dependencies (including devDependencies for TypeScript compilation)
RUN npm ci --ignore-scripts

# Copy application source and configs
COPY tsconfig*.json nest-cli.json ./
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY seeds/ ./seeds/

# Compile TypeScript to JavaScript in /app/dist
RUN npm run build

# ── Production dependencies stage ────────────────────
FROM node:22.14.0-alpine3.21 AS production-deps

WORKDIR /app

COPY package*.json ./
# Install production-only dependencies
RUN npm ci --omit=dev --ignore-scripts

# ── Production runtime stage ─────────────────────────
FROM node:22.14.0-alpine3.21 AS production

# Install dumb-init for proper PID 1 signal forwarding (SIGINT/SIGTERM)
# Install wget for container health checks
RUN apk add --no-cache dumb-init wget \
    && addgroup -g 10001 -S amrutam \
    && adduser -u 10001 -S amrutam -G amrutam

WORKDIR /app

# Set production environment variables
ENV NODE_ENV=production \
    PORT=3000

# Copy production node_modules from production-deps
COPY --from=production-deps --chown=amrutam:amrutam /app/node_modules ./node_modules
COPY --from=production-deps --chown=amrutam:amrutam /app/package.json ./package.json

# Copy compiled JavaScript from builder
COPY --from=builder --chown=amrutam:amrutam /app/dist ./dist

# Switch to least-privilege non-root user
USER amrutam:amrutam

# Expose API port
EXPOSE 3000

# Container healthcheck against NestJS liveness endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/healthz || exit 1

# dumb-init forwards signals properly to Node process
ENTRYPOINT ["dumb-init", "--"]

# Default command starts stateless API server; worker overrides CMD with ["node", "dist/src/worker.js"]
CMD ["node", "dist/src/main.js"]
