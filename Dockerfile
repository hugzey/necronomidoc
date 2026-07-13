# necronomidoc — portable single-process docs server (decision 0002).
#
# Language toolchains are opt-in per image so hosts only carry what their
# repos need (slice 5 toolchain packaging pattern, decision 0013):
#
#   docker build -t necronomidoc .                                   # TS/OpenAPI/Markdown only
#   docker build -t necronomidoc --build-arg WITH_PYTHON=1 .         # + Python (griffe)
#   docker build -t necronomidoc --build-arg WITH_DOTNET=1 .         # + C#/.NET (docfx)
#   docker run -p 4319:4319 -v docs-data:/data necronomidoc
#
# Repos in languages the image doesn't bundle can still publish docs from
# their own CI via POST /api/ir. `necronomidoc doctor` reports what a
# running host is missing.

# ---- build stage: compile the TypeScript workspaces + the site ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json vitest.config.ts ./
RUN npm run build:all

# ---- runtime stage ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    DOCS_DATA_DIR=/data \
    SITE_DIR=/app/packages/site/dist \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1

# git is required at runtime: the server shallow-clones registered repos.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Opt-in Python toolchain: an isolated venv with a pinned griffe, exposed as
# `necronomidoc-python` (the python adapter probes for it — no env var needed).
ARG WITH_PYTHON=0
ARG GRIFFE_VERSION=2.1.0
RUN if [ "$WITH_PYTHON" = "1" ]; then \
        apt-get update \
        && apt-get install -y --no-install-recommends python3 python3-venv \
        && python3 -m venv /opt/necronomidoc-python \
        && /opt/necronomidoc-python/bin/pip install --no-cache-dir "griffe==${GRIFFE_VERSION}" \
        && ln -s /opt/necronomidoc-python/bin/python /usr/local/bin/necronomidoc-python \
        && rm -rf /var/lib/apt/lists/*; \
    fi

# Opt-in .NET toolchain: SDK + docfx global tool (the csharp adapter probes
# PATH and ~/.dotnet/tools for `docfx`).
ARG WITH_DOTNET=0
ARG DOCFX_VERSION=2.78.5
RUN if [ "$WITH_DOTNET" = "1" ]; then \
        apt-get update \
        && apt-get install -y --no-install-recommends wget \
        && wget -qO /tmp/packages-microsoft-prod.deb https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb \
        && dpkg -i /tmp/packages-microsoft-prod.deb && rm /tmp/packages-microsoft-prod.deb \
        && apt-get update \
        && apt-get install -y --no-install-recommends dotnet-sdk-8.0 \
        && dotnet tool install -g docfx --version "${DOCFX_VERSION}" \
        && ln -s /root/.dotnet/tools/docfx /usr/local/bin/docfx \
        && rm -rf /var/lib/apt/lists/*; \
    fi

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/node_modules ./node_modules

VOLUME /data
EXPOSE 4319
CMD ["node", "packages/cli/dist/index.js", "serve"]
