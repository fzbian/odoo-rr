# Traspasos entre locales (Odoo + WhatsApp)

Aplicación React con backend Express para crear traspasos internos en Odoo entre ubicaciones y notificar por WhatsApp.

## Variables de entorno
Crea un archivo `.env` en la raíz (puedes copiar `.env.example`):

```
ODOO_URL=http://137.184.137.192:8069/
ODOO_DB=odoo
ODOO_USER=rickyrichpos2023@gmail.com
ODOO_PASSWORD=david12
NOTIFY_URL=http://evo-y4ogkos8wc4kks0wow4so8ks.143.198.70.11.sslip.io/message/sendText/david
NOTIFY_APIKEY=fabian@7167C
NOTIFY_NUMBER=120363419795940402@g.us
BACKEND_PORT=5000
```

## Ejecutar en desarrollo

1. Instalar dependencias:

```sh
npm install
```

2. Iniciar backend y frontend juntos:

```sh
npm run dev
```

- Frontend CRA: http://localhost:3000
- Backend Express: http://localhost:5000

El frontend usa `proxy` para `/api`.

### Si hay conflicto de puertos

CRA usa la variable `PORT` y puede chocar. El backend usa `BACKEND_PORT` (por defecto 5000).

Para liberar un puerto ocupado (ej. 5000 o 8082):

```sh
lsof -ti tcp:5000 | xargs -r kill
lsof -ti tcp:8082 | xargs -r kill
```

## Flujo
- Selecciona ubicación origen y destino (stock.location con uso `internal`).
- Agrega líneas de productos y cantidades.
- Enviar crea un picking interno, confirma, asigna, marca qty_done y valida.
- Se envía notificación de WhatsApp con el resumen.

## Notas
- Si Odoo requiere el wizard de transferencia inmediata, el backend lo procesa automáticamente.
- Manejo de errores básico con mensajes legibles en UI.

## Docker / Deploy (Coolify)

### Build local directo

```bash
docker build \
	--build-arg REACT_APP_ODOO_DB=$REACT_APP_ODOO_DB \
	--build-arg REACT_APP_ODOO_USER=$REACT_APP_ODOO_USER \
	--build-arg REACT_APP_ODOO_PASSWORD=$REACT_APP_ODOO_PASSWORD \
	--build-arg REACT_APP_NOTIFY_URL=$REACT_APP_NOTIFY_URL \
	--build-arg REACT_APP_NOTIFY_APIKEY=$REACT_APP_NOTIFY_APIKEY \
	--build-arg REACT_APP_NOTIFY_NUMBER_TRASPASOS=$REACT_APP_NOTIFY_NUMBER_TRASPASOS \
	--build-arg REACT_APP_NOTIFY_NUMBER_PEDIDOS_BOD=$REACT_APP_NOTIFY_NUMBER_PEDIDOS_BOD \
	-t traspasos:latest .

docker run -p 8080:80 traspasos:latest
```

### docker-compose

```bash
docker compose up --build
```

Servicio disponible en http://localhost:8080

### Coolify
1. Nuevo servicio -> Dockerfile.
2. Repositorio y rama (main).
3. Build args: definir las mismas variables REACT_APP_* necesarias.
4. Puerto de contenedor: 80.
5. Health check opcional: `/healthz`.

### Variables y rebuild
Las variables con prefijo `REACT_APP_` quedan embebidas al momento del build. Cambios requieren rebuild.

Para soporte runtime (no implementado aquí) se podría servir `/env.json` y cargarlo antes de montar React.
