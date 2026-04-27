FROM node:20-bookworm-slim

WORKDIR /app

# better-sqlite3 has prebuilt binaries for glibc Linux; build-essential is
# only used as a fallback when no prebuilt matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

# Install only production deps.
COPY server/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# Server source.
COPY server/src ./src

# Static client served from /app/public so the same container delivers
# both the signaling endpoint and the browser UI.
COPY client/public ./public

ENV NODE_ENV=production
ENV PORT=8080
ENV PUBLIC_DIR=/app/public
ENV DB_PATH=/app/data/remotedesk.sqlite

VOLUME ["/app/data"]
EXPOSE 8080

CMD ["node", "src/index.js"]
