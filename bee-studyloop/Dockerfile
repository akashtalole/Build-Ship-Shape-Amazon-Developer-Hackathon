# Multi-stage build: compile TypeScript in a full Node image, then run the
# compiled JS on a slim runtime image with only production dependencies.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

ENV PORT=4466
EXPOSE 4466
CMD ["node", "dist/index.js"]
