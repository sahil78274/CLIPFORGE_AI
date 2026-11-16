FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv ffmpeg fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
RUN npm install

COPY processor/requirements.txt ./processor/
RUN python3 -m venv /app/.venv && /app/.venv/bin/pip install --no-cache-dir -r processor/requirements.txt

COPY shared ./shared
COPY server ./server
COPY processor ./processor

RUN npm --workspace=shared run build && npm --workspace=server run build

ENV PYTHON_BIN=/app/.venv/bin/python
EXPOSE 4000
CMD ["node", "server/dist/index.js"]
