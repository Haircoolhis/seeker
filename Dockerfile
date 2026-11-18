FROM oven/bun:1
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY index.tsx ./
ENV NODE_ENV=production
CMD ["bun", "index.tsx"]
