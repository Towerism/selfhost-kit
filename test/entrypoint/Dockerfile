# syntax=docker/dockerfile:1.7
#
# Fixture image for the entrypoint's container tests (ADR-0004, ADR-0008), and the image the sample
# caller builds through app-image.yml. It is assembled the way an app's image is: the kit is packed,
# the tarball is installed with pnpm (symlinked node_modules), and the Docker assets are copied out
# with `selfhost-kit docker-assets`. Build it from the repository root:
#
#   docker build -f test/entrypoint/Dockerfile --target fixture -t selfhost-kit-entrypoint:test .

ARG NODE_IMAGE=node:24.21.0-slim
ARG NODE_ALPINE_IMAGE=node:24.21.0-alpine3.23
ARG PNPM_VERSION=10.34.7

# The kit, built from this checkout and packed exactly as npm publishes it.
FROM ${NODE_IMAGE} AS kit
ARG PNPM_VERSION
WORKDIR /kit
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json README.md LICENSE SECURITY.md ./
COPY src ./src
COPY bin ./bin
COPY docker ./docker
COPY release-config ./release-config
RUN pnpm build \
 && npm pack --pack-destination /tmp \
 && mv /tmp/towerism-selfhost-kit-*.tgz /kit.tgz

# An app's build stage: install the kit with pnpm, then copy its assets out as real files.
FROM ${NODE_IMAGE} AS app-build
ARG PNPM_VERSION
WORKDIR /app
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
COPY --from=kit /kit.tgz /tmp/kit.tgz
RUN echo '{ "name": "fixture-app", "private": true, "type": "module" }' > package.json \
 && pnpm add /tmp/kit.tgz --ignore-scripts \
 && pnpm exec selfhost-kit docker-assets .output/selfhost-kit

# An app's Litestream stage: the pinned release, verified by the kit's script.
FROM ${NODE_ALPINE_IMAGE} AS litestream
ARG TARGETARCH
COPY --from=app-build /app/.output/selfhost-kit/fetch-litestream.sh /tmp/fetch-litestream.sh
RUN sh /tmp/fetch-litestream.sh /opt/litestream

# An app's runtime stage, with a small stand-in server.
FROM ${NODE_IMAGE} AS fixture
# gosu: drop root after fixing /data ownership. tini: PID 1 that forwards SIGTERM.
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu tini \
 && rm -rf /var/lib/apt/lists/* \
 && gosu nobody true
WORKDIR /app
COPY --from=litestream /opt/litestream/litestream /usr/local/bin/litestream
COPY --from=app-build /app/.output/selfhost-kit/litestream.yml /etc/litestream.yml
COPY --from=app-build /app/.output/selfhost-kit/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY test/entrypoint/server.mjs /app/server.mjs
ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    PUID=99 \
    PGID=100 \
    UMASK=022 \
    NUXT_DATABASE_PATH=/data/app.db
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=1s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["tini", "--", "entrypoint.sh"]
CMD ["node", "/app/server.mjs"]
