# syntax=docker/dockerfile:1

# ---- Stage 1: build — compile TypeScript to dist/ ----
FROM node:24-slim AS build
WORKDIR /app

# Install all dependencies (including dev tooling such as TypeScript) from the lockfile.
COPY package.json package-lock.json ./
RUN npm ci

# Compile using the existing production build configuration.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- Stage 2: production dependencies only ----
FROM node:24-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- Stage 3: runtime ----
FROM node:24-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Copy production dependencies and compiled output, owned by the non-root node user.
COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist         ./dist
COPY --chown=node:node package.json ./

# Mount point for the persistent volume, created before dropping privileges:
# /app is root-owned, so the `node` user could not create it at runtime. Docker
# seeds a fresh named volume with this directory's ownership, which makes the
# volume writable by the runtime user as well.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 3000

# Health check via Node.js native fetch (no extra runtime dependency such as curl).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
