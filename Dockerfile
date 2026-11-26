# syntax=docker/dockerfile:1

# ---- build: compile TypeScript --------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production deps + compiled JS + migrations ------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY docker-start.sh ./docker-start.sh
USER node
EXPOSE 3000
# Applies migrations and seeds (safe to repeat), then starts the API.
CMD ["sh", "docker-start.sh"]
