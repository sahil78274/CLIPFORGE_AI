FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
COPY shared/package.json ./shared/
COPY client/package.json ./client/
RUN npm install
COPY shared ./shared
COPY client ./client
RUN npm --workspace=shared run build && npm --workspace=client run build

FROM nginx:1.27-alpine
COPY --from=build /app/client/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
