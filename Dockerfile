# agentside Dockerfile
# Build context: repo root
#   docker build -t agentside .
FROM oven/bun:1 AS production

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apt-get update && apt-get install -y \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -g 1001 nodejs && \
    useradd -s /bin/bash -u 1001 -g nodejs nodejs

# Install layer
COPY package.json bun.lock* ./
RUN bun install

# Source
COPY --chown=nodejs:nodejs src ./src
COPY --chown=nodejs:nodejs tsconfig.json ./

USER nodejs

EXPOSE 3005

# Health check (root endpoint returns status: ok)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3005/ || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["bun", "run", "start"]
