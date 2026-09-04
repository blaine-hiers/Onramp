# onramp - container image for anything OTHER than the stdio
# MCP entry point itself (a standalone worker, a scheduled script, ...).
# An MCP client (LM Studio, Claude Desktop, ...) launches server.mjs
# NATIVELY on the host via stdio - it cannot talk to a containerized
# process over stdio, so `npm start` here is for sanity-checking the image,
# not for production stdio serving. See README.md's "Docker" section.

FROM node:20-alpine

WORKDIR /app

# Install dependencies first so this layer is cached across code-only changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# var/ and .env are expected to be volume-mounted at runtime (see
# docker-compose.yml) - both are gitignored and never baked into the image.
RUN mkdir -p var/state var/logs var/reports

ENV NODE_ENV=production

CMD ["node", "server.mjs"]
