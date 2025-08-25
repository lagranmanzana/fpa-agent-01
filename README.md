# fpa-agent-01

Node.js + Express que lee datos de Google Sheets y expone endpoints.

## Endpoints
- `/` ? verifica que el servidor funciona.
- `/test-sheets` ? devuelve primeras filas de la hoja.

## Variables de entorno
- `GOOGLE_SERVICE_ACCOUNT_JSON`: contenido completo del JSON de tu service account.
