FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
ENV DATA_DIR=/data
EXPOSE 3000

# Persist uploads on a mounted volume.
VOLUME ["/data"]

CMD ["node", "server.js"]
