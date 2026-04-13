FROM node:20-slim

# Install FFmpeg, fonts, and Python (for any utility scripts)
RUN apt-get update && \
    apt-get install -y \
        ffmpeg \
        fonts-dejavu-core \
        fonts-dejavu-extra \
        fonts-liberation \
        wget \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create work directories
RUN mkdir -p /app /tmp/longform_work /app/assets

WORKDIR /app

COPY package*.json ./
RUN npm install --production

# Copy server and assets (bg_music.mp3 must be in ./assets/ on your machine)
COPY server.js ./
COPY assets/ ./assets/

EXPOSE 3000
CMD ["node", "server.js"]
