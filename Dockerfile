FROM node:20-bookworm-slim

# Chromium (Puppeteer) + fonts for rendering templates/labels
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-core python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    CHROME_PATH=/usr/bin/chromium \
    PYTHON_BIN=python3

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
