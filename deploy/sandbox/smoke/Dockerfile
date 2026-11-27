# Chromium smoke runner for the T1 sandbox. It shares the DSH network
# namespace so the token URL printed by DSH (container IP) stays valid.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      fonts-liberation \
      fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /smoke
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY smoke.mjs ./

ENTRYPOINT ["node", "/smoke/smoke.mjs"]
