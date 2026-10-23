# Build from the cautem workspace root so the generated protocol client is available.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
WORKDIR /workspace

COPY quarshell-proto/typescript ./quarshell-proto/typescript
RUN npm ci --prefix quarshell-proto/typescript \
    && npm run build --prefix quarshell-proto/typescript

COPY quarshell-ui ./quarshell-ui
ARG VITE_OIDC_CLIENT_ID=quarshell-ui
ENV VITE_OIDC_CLIENT_ID=${VITE_OIDC_CLIENT_ID}
RUN npm ci --prefix quarshell-ui \
    && npm run build --prefix quarshell-ui

FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
ENV NGINX_ENVSUBST_FILTER='^CAUTEM_' \
    CAUTEM_CONSOLE_LISTEN_PORT=8080 \
    CAUTEM_GATEWAY_UPSTREAM=quarshell-gateway:7443
COPY --from=build /workspace/quarshell-ui/dist/ /usr/share/nginx/html/
COPY quarshell-ui/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
