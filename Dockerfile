FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js index.html styles.css script.js admin.html admin.css admin.js ./

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
