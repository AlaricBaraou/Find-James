FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3000
ENV DATA_DIR=/data
ENV NODE_ENV=production
EXPOSE 3000

# Persist uploads + metadata on a mounted volume.
VOLUME ["/data"]

CMD ["node", "server.js"]
