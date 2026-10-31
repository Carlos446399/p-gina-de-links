FROM node:20-slim

# ffmpeg + python (necessário para o yt-dlp) + curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# yt-dlp (binário oficial)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js index.html ./

ENV NODE_ENV=production
EXPOSE 3000
CMD ["sh", "-c", "yt-dlp -U || true; node server.js"]
