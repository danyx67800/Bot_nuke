FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=4321 \
    DATA_DIR=/data

WORKDIR /app

# Dipendenze prima del codice: layer cache efficiente
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; \
    else npm install --omit=dev --no-audit --no-fund; fi

COPY src ./src
COPY public ./public

RUN mkdir -p /data

VOLUME ["/data"]
EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4321)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
