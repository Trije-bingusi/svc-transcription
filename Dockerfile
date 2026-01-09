FROM node:22-bookworm-slim

WORKDIR /usr/src/app

# System deps: python + ffmpeg + certs (curl optional but useful)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    ffmpeg \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

# Python venv
ENV VENV_PATH=/opt/venv
RUN python3 -m venv ${VENV_PATH}
ENV PATH="${VENV_PATH}/bin:${PATH}"

# Python deps (faster-whisper etc.)
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
  && pip install --no-cache-dir -r requirements.txt

# Cache directory for model downloads
ENV HF_HOME=/opt/hf-cache
RUN mkdir -p /opt/hf-cache

# Node deps 
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# App code
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
