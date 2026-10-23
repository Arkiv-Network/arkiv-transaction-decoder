FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a
WORKDIR /app

# The port the server binds. 3000 is the standalone default; a build that ships this decoder into
# a deployment whose probes and callers already name a port bakes that port in instead, because
# nothing there supplies PORT in the container's environment.
ARG PORT=3000

ENV NODE_ENV=production
ENV PORT=${PORT}

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src

EXPOSE ${PORT}
CMD ["bun", "start"]
