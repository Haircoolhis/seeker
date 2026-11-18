FROM oven/bun:1.2
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY index.tsx ./
ENV NODE_ENV=production
CMD ["bun", "index.tsx"]
