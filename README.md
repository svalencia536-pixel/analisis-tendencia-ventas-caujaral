# Dashboard Ventas A&B — Club Lagos de Caujaral

Sirve el dashboard de participación Alimentos/Bebidas y el comparativo por año,
leyendo los datos del reporte público de Power BI del club.

**Se refresca solo todos los días a las 6:00 a.m. hora Colombia**, y además cada
vez que el servicio arranca. Hosted en Railway con auto-deploy.

## Cómo funciona

```
Power BI (API pública)  →  powerbi.js  →  plantilla.html  →  HTML servido
        ↑                                                         ↑
   6:00 am Bogotá (y al arrancar)                        navegador del socio
```

- `powerbi.js` — consulta el dataset y arma el bloque de datos. Descubre solo los
  años disponibles y la última fecha con venta, así que en 2027 sigue funcionando
  sin tocar nada.
- `server.js` — servidor HTTP, autenticación, programación del refresco y gzip.
- `plantilla.html` — el dashboard. Lleva el marcador `/*__DATA__*/` donde se
  inyectan los datos.

No usa dependencias externas: solo módulos nativos de Node 18+.

## Rutas

| Ruta | Qué hace |
|---|---|
| `/` | El dashboard |
| `/actualizar` | Fuerza un refresco inmediato y redirige al dashboard |
| `/salud` | JSON con el estado, sin clave (para el monitoreo de Railway) |

## Variables de entorno

| Variable | Por defecto | Para qué |
|---|---|---|
| `PBI_RESOURCE_KEY` | — | **Obligatoria.** El `k` del reporte publicado (UUID dentro de `?r=` en la URL). |
| `PBI_DATASET_ID` | — | **Obligatoria.** El `ti` del reporte (UUID dentro de `?r=` en la URL). |
| `PBI_REPORT_ID` | — | **Obligatoria.** El `r` del reporte (UUID dentro de `?r=` en la URL). |
| `PBI_MODEL_ID` | `1871413` | ID del modelo de datos (casi nunca cambia). |
| `DASHBOARD_PASSWORD` | *(vacía)* | Sin definir, el tablero queda **abierto**. Es la decisión tomada: los mismos datos ya son públicos en el reporte de Power BI del que se alimenta. Para cerrarlo, basta con crear esta variable en Railway. |
| `DASHBOARD_USER` | `caujaral` | Usuario del login, solo aplica si se define la clave |
| `PORT` | `3000` | Lo asigna Railway automáticamente |
| `HORA_REFRESCO` | `6` | Hora de Bogotá del refresco diario |

## Desplegar en Railway

1. Subir este repo a GitHub.
2. En Railway: **New Project → Deploy from GitHub repo** y elegirlo.
3. En **Settings → Networking**, generar el dominio público.

No hay variables obligatorias: el tablero arranca abierto y se refresca solo.

Railway detecta Node por el `package.json` y ejecuta `npm start`. No hay build.

## Mantenimiento

- **Si cambia el link del reporte de Power BI**, actualizar la variable
  `PBI_RESOURCE_KEY` en Railway. No hay que tocar código.
- **Si crean una agrupación de bebidas sin alcohol nueva**, agregarla al conjunto
  `NO_ALCOHOLICAS` en `powerbi.js`. Si no, queda contada como alcohólica.
- El servicio excluye la clasificación `Dep` y el consumo de funcionarios, igual
  que el reporte original, para que las cifras cuadren.

## Notas sobre los datos

- `VVENTA` viene separada de IVA y servicio en el modelo.
- Colombia es UTC−5 fijo, sin horario de verano, así que las 6:00 a.m. de Bogotá
  son siempre las 11:00 UTC. Por eso la programación no necesita librería de
  zonas horarias.
