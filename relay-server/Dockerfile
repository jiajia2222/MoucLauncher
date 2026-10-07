FROM node:24-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY index.js ./

ENV PORT=8758 \
    MAX_PEERS=8 \
    IDLE_MS=60000

EXPOSE 8758
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8758/healthz || exit 1
CMD ["node", "index.js"]
