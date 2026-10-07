FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/data COOKIE_SECURE=true
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
EXPOSE 3000
CMD ["node", "src/server.js"]
