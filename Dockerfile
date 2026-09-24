# Multi-stage build: `deps` (test runner base), `web` (embedded app), `worker` (BullMQ)
FROM node:24-alpine AS deps
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json* ./
RUN npm ci && npm cache clean --force
COPY . .

FROM deps AS build
# Public app URL: its host is baked into the build as an allowed action origin
ARG SHOPIFY_APP_URL
ENV SHOPIFY_APP_URL=$SHOPIFY_APP_URL
ENV NODE_ENV=production
RUN npx prisma generate && npm run build

FROM node:24-alpine AS web
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
EXPOSE 3000
CMD ["npm", "run", "docker-start"]

FROM node:24-alpine AS worker
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci && npm cache clean --force
COPY . .
RUN npx prisma generate
CMD ["npm", "run", "worker"]
