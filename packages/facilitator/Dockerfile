# The Sluice facilitator as a container image. Build it from the repository root:
#
#   docker build -f packages/facilitator/Dockerfile -t sluice-facilitator .
#
# The base image is pinned to an exact version and to the digest Docker Hub listed for it when this file was written; re-check the
# digest when you update the tag. The build installs from the lockfile only, compiles the two packages the facilitator needs, and
# copies just their production files into the final image. The final image runs as the unprivileged "node" user, holds no secret
# (every setting comes from the environment when the container starts), and keeps the queue on a volume at /data.
#
# Nothing here has been built by the author of this file: the Docker daemon was not running where it was written. The build steps
# were run one by one outside Docker against the same context (docs/DEPLOY-FACILITATOR.md says which and what that does not prove).

ARG NODE_IMAGE=node:24.14.0-alpine3.23@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114

# ------------------------------------------------------------------------------------------------ build
FROM ${NODE_IMAGE} AS build
ENV CI=true
RUN npm install --global pnpm@11.28.11
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@sluice/facilitator..." --filter "."
RUN pnpm --filter @sluice/sdk run build && pnpm --filter @sluice/facilitator run build
RUN pnpm --filter @sluice/facilitator deploy --prod --legacy /out

# ------------------------------------------------------------------------------------------------ run
FROM ${NODE_IMAGE} AS run
ENV NODE_ENV=production \
    SLUICE_FACILITATOR_HOST=0.0.0.0 \
    SLUICE_FACILITATOR_PORT=8402 \
    SLUICE_FACILITATOR_STATE=/data/queue.jsonl
# The queue's journal lives on /data, owned by the unprivileged user. Mount a volume there, or a restart loses the queue.
RUN mkdir /data && chown node:node /data
WORKDIR /app
COPY --from=build /out /app
USER node
VOLUME ["/data"]
EXPOSE 8402
# /health answers 503 when the queue store cannot be written or the service is shutting down, so the platform replaces the container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SLUICE_FACILITATOR_PORT||8402)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# SIGTERM stops it in order: it stops listening, lets a batch in progress finish, and closes the queue. Give it time before SIGKILL.
STOPSIGNAL SIGTERM
CMD ["node", "dist/cli.js"]
