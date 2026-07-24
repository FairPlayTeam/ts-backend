# syntax=docker/dockerfile:1

FROM oven/bun:1.3.10-debian AS deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src

RUN DATABASE_URL="postgresql://user:password@localhost:5432/fairplay" bun run prisma:generate
RUN bun run build

FROM deps AS migrator
COPY prisma.config.ts ./
COPY prisma ./prisma

CMD ["bun", "run", "prisma:migrate:deploy"]

FROM oven/bun:1.3.10-debian AS prod-deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.10-debian AS runtime
WORKDIR /app

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && ffmpeg -version \
    && ffprobe -version

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=prod-deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=bun:bun /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun package.json ./

USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bun -e "const port=process.env.PORT||3000; const r=await fetch(`http://127.0.0.1:${port}/health/ready`).catch(()=>null); process.exit(r?.ok ? 0 : 1)"

CMD ["bun", "dist/index.js"]
