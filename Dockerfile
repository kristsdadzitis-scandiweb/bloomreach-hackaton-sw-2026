# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public

# Cloud Run injects PORT; server.ts reads it via config.ts.
CMD ["node", "dist/server.js"]
