FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-inter \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY db ./db
COPY src ./src
COPY assets ./assets
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
