# The Sluice facilitator as a container image. Build it from the repository root:
#
#   docker build -f packages/facilitator/Dockerfile -t sluice-facilitator .
#
# The base image is pinned to an exact version and to the digest Docker Hub listed for it when this file was written; re-check the
# digest when you update the tag. The build installs from the lockfile only, compiles the two packages the facilitator needs, and
# copies just their production files into the final image. The final image holds no secret (every setting comes from the environment
# when the container starts) and keeps the queue on a volume at /data.
#
# A platform mounts a volume as root, after the image is built, and a process that is not root cannot write to it. So the container
# starts as root for one thing only, to give /data to the unprivileged "node" user, and then runs the service as "node": su-exec
# replaces the shell with the service, so signals reach it and nothing keeps running as root. Started as another user (docker run
# --user), it skips the hand-over and runs as that user. If the platform sets PORT (Railway does), the service listens on it.
# There is no VOLUME line: Railway refuses one, and the volume is attached by the platform or by `docker run -v`.
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
RUN apk add --no-cache su-exec && mkdir /data && chown node:node /data
WORKDIR /app
COPY --from=build /out /app
EXPOSE 8402
# /health answers 503 when the queue store cannot be written or the service is shutting down, so the platform replaces the container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SLUICE_FACILITATOR_PORT||8402)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# SIGTERM stops it in order: it stops listening, lets a batch in progress finish, and closes the queue. Give it time before SIGKILL.
STOPSIGNAL SIGTERM
# The entrypoint, as a shell line: use the platform's PORT if it sets one; as root, give /data (and the volume's mount path, if the
# platform names one) to "node" and run the command as "node"; otherwise run the command as the user it was started as.
ENTRYPOINT ["/bin/sh", "-c", "if [ -n \"$PORT\" ]; then export SLUICE_FACILITATOR_PORT=\"$PORT\"; fi; if [ \"$(id -u)\" = 0 ]; then chown -R node:node /data ${RAILWAY_VOLUME_MOUNT_PATH:+\"$RAILWAY_VOLUME_MOUNT_PATH\"}; exec su-exec node \"$@\"; fi; exec \"$@\"", "sluice-facilitator"]
CMD ["node", "dist/cli.js"]
