FROM node:24-bookworm-slim
WORKDIR /app
COPY checkout/server.mjs checkout/telegram-setup.mjs checkout/
COPY data/products.json data/products.json
ENV BIND_ADDRESS=0.0.0.0
CMD ["sh", "-c", "umask 077; exec node checkout/server.mjs"]
