# Build from this folder:  docker build -t pulse-monitor .
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
# No dependencies: only Node's own modules.
COPY package.json ./
COPY src ./src
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
CMD ["node", "src/main.js"]
