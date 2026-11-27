# T1 local multi-plugin sandbox image.
#
# BuildKit's bundled frontend is used on purpose: a top-level syntax directive
# would make Docker pull docker/dockerfile from Docker Hub, which is not
# reachable from some restricted networks. Override NODE_IMAGE when the public
# registry is blocked, for example:
#   docker compose build --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:24-bookworm-slim
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ENV DSH_HOME=/opt/dsh-seed \
    DEBIAN_FRONTEND=noninteractive

# DSH profiles are backed by pnpm.
RUN corepack enable && corepack prepare pnpm@11.28.5 --activate

# npm 11 defers install-time lifecycle scripts unless a package is approved.
# These four packages carry native/protocol helpers used by a normal DSH
# install; without approval koffi/node-pty are left unbuilt.
RUN npm install -g \
      --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,protobufjs \
      @deepseek-ai/dsh@0.2.2-rc.5

COPY fixtures /opt/plugins

# Every fixture is its own bundle with exactly one leaf row, so the native
# plugin page can enable and disable each row independently.
RUN dsh plugin --profile web add file:/opt/plugins/sandbox-ui --save-exact && \
    dsh plugin --profile web add file:/opt/plugins/sandbox-host --save-exact && \
    dsh plugin --profile web add file:/opt/plugins/sandbox-worker --save-exact

COPY entrypoint.sh /usr/local/bin/dsh-sandbox-entrypoint
COPY healthcheck.mjs /usr/local/bin/dsh-sandbox-health.mjs
RUN chmod 0755 /usr/local/bin/dsh-sandbox-entrypoint

# Fingerprint the image seed and the fixture sources. The entrypoint refreshes
# a named volume from this seed when the fingerprint changes, while preserving
# the user's patch layer. Hashing the source fixtures as well matters because
# file: installs can reference /opt/plugins instead of copying every file.
RUN { find /opt/dsh-seed/profiles/web -type f -print0; \
      find /opt/plugins -type f -print0; } \
    | sort -z | xargs -0 sha256sum \
    | sha256sum | awk '{print $1}' > /opt/dsh-seed/.seed-id

# The seed is build-time only. Runtime state lives on the named volume, so the
# default for a bare "docker run" is the same as the compose service.
ENV DSH_HOME=/data/dsh-home

EXPOSE 3080
ENTRYPOINT ["/usr/local/bin/dsh-sandbox-entrypoint"]
