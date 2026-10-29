FROM oven/bun:1.4.4 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY tsconfig*.json mikro-orm.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
RUN bun run build

FROM build AS test
CMD ["bun", "run", "test:integration"]

FROM oven/bun:1.4.4 AS production-dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun package.json ./
USER bun
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=6s --start-period=15s --retries=3 CMD bun dist/scripts/healthcheck.js
CMD ["bun", "dist/src/main.js"]
