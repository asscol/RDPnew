FROM node:20-alpine

WORKDIR /app

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

EXPOSE 8080

CMD ["node", "src/index.js"]
