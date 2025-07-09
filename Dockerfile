FROM oven/bun:alpine
LABEL authors="xrip"

WORKDIR /application
COPY .env package.json models.json ./src/*.js ./


RUN bun install --backend=hardlink

EXPOSE 11434
CMD ["bun", "./index.js"]
