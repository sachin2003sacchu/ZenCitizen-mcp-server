# syntax=docker/dockerfile:1
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM base AS runner
ENV NODE_ENV=production

RUN addgroup -S app && adduser -S app -G app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/resources ./resources
COPY --from=build /app/.mcp-use ./.mcp-use
COPY --from=build /app/package.json ./package.json

USER app
EXPOSE 3000

CMD ["npm", "run", "start"]
