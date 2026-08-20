FROM oven/bun:1.4.0-alpine AS deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.0-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src

EXPOSE 3000
CMD ["bun", "start"]
