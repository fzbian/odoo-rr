#!/bin/sh
set -e

RUNTIME_FILE=/usr/share/nginx/html/env-config.js
echo "window.__RUNTIME_CONFIG__ = {" > $RUNTIME_FILE
VARS="REACT_APP_ODOO_DB REACT_APP_ODOO_USER REACT_APP_ODOO_PASSWORD REACT_APP_NOTIFY_URL REACT_APP_NOTIFY_APIKEY REACT_APP_NOTIFY_NUMBER_TRASPASOS REACT_APP_NOTIFY_NUMBER_PEDIDOS_BOD"
first=1
for v in $VARS; do
  val=$(printenv $v | sed 's/"/\\"/g')
  if [ "$first" = 1 ]; then
    echo "  \"$v\": \"$val\"" >> $RUNTIME_FILE
    first=0
  else
    echo ",  \"$v\": \"$val\"" >> $RUNTIME_FILE
  fi
done
echo "};" >> $RUNTIME_FILE

exec "$@"