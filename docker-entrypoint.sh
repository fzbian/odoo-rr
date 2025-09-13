#!/bin/sh
# Genera env-config.js (runtime env) incluso si algunas variables no están definidas.
set -e

RUNTIME_FILE=/usr/share/nginx/html/env-config.js
echo "window.__RUNTIME_CONFIG__ = {" > "$RUNTIME_FILE"
VARS="REACT_APP_ODOO_DB REACT_APP_ODOO_USER REACT_APP_ODOO_PASSWORD REACT_APP_NOTIFY_URL REACT_APP_NOTIFY_APIKEY REACT_APP_NOTIFY_NUMBER_TRASPASOS REACT_APP_NOTIFY_NUMBER_PEDIDOS_BOD"
first=1
for v in $VARS; do
  # Evaluar valor sin romper si está vacío
  eval val="\${$v}"
  esc=$(printf '%s' "$val" | sed 's/"/\\"/g')
  if [ $first -eq 1 ]; then
    echo "  \"$v\": \"$esc\"" >> "$RUNTIME_FILE"
    first=0
  else
    echo ",  \"$v\": \"$esc\"" >> "$RUNTIME_FILE"
  fi
done
echo "};" >> "$RUNTIME_FILE"

exec "$@"