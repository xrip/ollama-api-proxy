FROM oven/bun:alpine
LABEL authors="xrip"

WORKDIR /application
COPY .env ./src/*.js ./

EXPOSE 11434

CMD ["bun", "index.js"]