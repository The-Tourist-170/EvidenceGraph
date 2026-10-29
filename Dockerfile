FROM oven/bun:1.4.3-slim
WORKDIR /app
COPY package.json bun.lock ./
COPY apps apps
COPY packages packages
RUN bun install --frozen-lockfile
EXPOSE 3000
CMD ["bun", "--cwd", "apps/api", "start"]
