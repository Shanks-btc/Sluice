# The hosted tool server (the example paid tools over Streamable HTTP) as a container image. Build it from the repository root:
#
#   docker build -f examples/paid-tools/Dockerfile -t sluice-tool-server .
#
# The same pinned base, lockfile-only install and unprivileged user as packages/facilitator/Dockerfile. The image holds no key: the
# tool server only reads from the chain and verifies and settles through a facilitator, and every setting comes from the environment
# when the container starts.
#
# Nothing here has been built by the author of this file: the Docker daemon was not running where it was written. The build steps
# were run one by one outside Docker against the same context (docs/DEPLOY-TOOL-SERVER.md says which and what that does not prove).

ARG NODE_IMAGE=node:24.14.0-alpine3.23@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114

# ------------------------------------------------------------------------------------------------ build
FROM ${NODE_IMAGE} AS build
ENV CI=true
RUN npm install --global pnpm@11.28.11
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@sluice/paid-tools..." --filter "."
RUN pnpm --filter @sluice/sdk run build && pnpm --filter @sluice/paid-tools run build
RUN pnpm --filter @sluice/paid-tools deploy --prod --legacy /out

# ------------------------------------------------------------------------------------------------ run
FROM ${NODE_IMAGE} AS run
ENV NODE_ENV=production \
    SLUICE_TOOLS_HOST=0.0.0.0 \
    SLUICE_TOOLS_PORT=8403
WORKDIR /app
COPY --from=build /out /app
USER node
EXPOSE 8403
# /health answers 200 while the server is up. It reads nothing from the chain, so it does not depend on the node's being reachable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SLUICE_TOOLS_PORT||8403)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "dist/cli.js", "--http"]
