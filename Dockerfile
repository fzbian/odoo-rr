## --- Stage 1: Build React app ---
FROM node:20-alpine AS build
WORKDIR /app

# Instalar dependencias
COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./
RUN npm install --legacy-peer-deps || yarn install || pnpm install

# Copiar código
COPY . .

# Variables de entorno de build (pueden sobreescribirse en Coolify)
ARG REACT_APP_ODOO_DB
ARG REACT_APP_ODOO_USER
ARG REACT_APP_ODOO_PASSWORD
ARG REACT_APP_NOTIFY_URL
ARG REACT_APP_NOTIFY_APIKEY
ARG REACT_APP_NOTIFY_NUMBER_TRASPASOS
ARG REACT_APP_NOTIFY_NUMBER_PEDIDOS_BOD

ENV REACT_APP_ODOO_DB=$REACT_APP_ODOO_DB \
    REACT_APP_ODOO_USER=$REACT_APP_ODOO_USER \
    REACT_APP_ODOO_PASSWORD=$REACT_APP_ODOO_PASSWORD \
    REACT_APP_NOTIFY_URL=$REACT_APP_NOTIFY_URL \
    REACT_APP_NOTIFY_APIKEY=$REACT_APP_NOTIFY_APIKEY \
    REACT_APP_NOTIFY_NUMBER_TRASPASOS=$REACT_APP_NOTIFY_NUMBER_TRASPASOS \
    REACT_APP_NOTIFY_NUMBER_PEDIDOS_BOD=$REACT_APP_NOTIFY_NUMBER_PEDIDOS_BOD

RUN npm run build

## --- Stage 2: Nginx to serve static ---
FROM nginx:1.27-alpine AS prod
WORKDIR /usr/share/nginx/html

# Limpiar contenido por defecto
RUN rm -rf ./*

# Copiar build
COPY --from=build /app/build .
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Copiar config Nginx SPA
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx","-g","daemon off;"]