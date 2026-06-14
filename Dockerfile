FROM node:22-alpine AS frontend-build
WORKDIR /app/spx-app
COPY spx-app/package.json spx-app/package-lock.json ./
RUN npm ci
COPY spx-app/ ./
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY options-api/package.json options-api/package-lock.json ./
RUN npm ci --omit=dev
COPY options-api/ ./
COPY --from=frontend-build /app/spx-app/dist /app/spx-app/dist
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=3s \
  CMD curl -f http://localhost:3080/api/health || exit 1
CMD ["node", "server.js"]
