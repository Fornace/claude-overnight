# Minimal runner image for claude-overnight-evolve.
#
# Pins the npm-published CLI so the image is self-contained: no git clone,
# no build step. Users who want a specific version set CLAUDE_OVERNIGHT_VERSION
# at build time (defaults to latest).

FROM node:24-alpine

ARG CLAUDE_OVERNIGHT_VERSION=latest
RUN npm install -g claude-overnight@${CLAUDE_OVERNIGHT_VERSION}

WORKDIR /workspace

ENV PROMPT_EVOLUTION_STORE=/out

ENTRYPOINT ["claude-overnight-evolve"]
