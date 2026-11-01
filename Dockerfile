# SDLC agents. Build:  docker build -t sdlc-agents .
# Optional build args (leave empty to skip):
#   INSTALL_JAVA=1                 adds a JDK and Maven (needed to run PIT on Java repos)
#   AGENT_CLI_PACKAGE=<npm pkg>    installs the agent CLI, e.g. @anthropic-ai/claude-code or opencode-ai
# Check the package name with your platform team; internal mirrors may use a different one.

FROM node:22-slim AS build
WORKDIR /app
COPY server/package*.json server/
RUN cd server && npm ci
COPY ui/package*.json ui/
RUN cd ui && npm ci
COPY server server
COPY ui ui
RUN cd server && npm run build && cd ../ui && npx ng build

FROM node:22-slim
ARG INSTALL_JAVA=
ARG AGENT_CLI_PACKAGE=
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
 && if [ -n "$INSTALL_JAVA" ]; then apt-get install -y --no-install-recommends default-jdk-headless maven; fi \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package*.json server/
RUN cd server && npm ci --omit=dev
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/ui/dist ui/dist
COPY .agents .agents
COPY AGENTS.md ./
COPY config config
RUN if [ -n "$AGENT_CLI_PACKAGE" ]; then npm install -g "$AGENT_CLI_PACKAGE"; fi
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
VOLUME ["/app/data", "/app/workspaces"]
EXPOSE 8080
WORKDIR /app/server
CMD ["node", "dist/main.js"]
