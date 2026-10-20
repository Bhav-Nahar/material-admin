FROM node:20-bookworm-slim

# Chromium (Puppeteer) + fonts for rendering templates/labels, Python for PDF extraction and rectify
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-core python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Python venv at the path lib/productImages/rectify.js looks for (it needs a real file path,
# so PYTHON_BIN=python3 would NOT resolve). PyMuPDF = PDF image extraction, OpenCV = rectify.
RUN python3 -m venv /app/.venv-cv \
    && /app/.venv-cv/bin/pip install --no-cache-dir pymupdf opencv-python-headless numpy

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    CHROME_PATH=/usr/bin/chromium \
    PYTHON_BIN=/app/.venv-cv/bin/python

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
