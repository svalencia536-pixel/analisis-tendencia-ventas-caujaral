'use strict';
/**
 * Sirve el dashboard de ventas A&B y lo refresca solo.
 *
 * Refresco: al arrancar y todos los dias a las 6:00 am hora Colombia.
 * Colombia es UTC-5 fijo (no tiene horario de verano), asi que 6:00 am
 * en Bogota son siempre las 11:00 UTC. No hace falta libreria de zonas.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { extraer } = require('./powerbi');

const PUERTO = Number(process.env.PORT || 3000); // Railway deployment ready
// Por decision del club el tablero va abierto: no se define DASHBOARD_PASSWORD.
// Los mismos datos ya son publicos en el reporte de Power BI del que se alimenta.
// Si algun dia se quiere cerrar, basta con crear la variable en Railway.
const USUARIO = process.env.DASHBOARD_USER || 'caujaral';
const CLAVE = process.env.DASHBOARD_PASSWORD || '';
const HORA_BOGOTA = Number(process.env.HORA_REFRESCO || 6);   // 6:00 am
const OFFSET_BOGOTA = -5;                                      // UTC-5 fijo

const PLANTILLA = fs.readFileSync(path.join(__dirname, 'plantilla.html'), 'utf8');

/* ---------------------------------------------------------------- */
/* Estado                                                            */
/* ---------------------------------------------------------------- */

const estado = {
  html: null,
  gz: null,
  resumen: null,
  actualizado: null,
  error: null,
  refrescando: false,
};

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function refrescar(motivo) {
  if (estado.refrescando) { log('ya hay un refresco en curso, se omite'); return; }
  estado.refrescando = true;
  log(`refrescando (${motivo})...`);
  try {
    const { js, resumen } = await extraer((m) => log('  ' + m));
    const html = PLANTILLA.replace('/*__DATA__*/', () => js);
    estado.html = html;
    estado.gz = zlib.gzipSync(Buffer.from(html, 'utf8'));
    estado.resumen = resumen;
    estado.actualizado = new Date().toISOString();
    estado.error = null;
    log(`ok: ${resumen.filas} filas, corte ${resumen.corte}, ${resumen.segundos}s`);
  } catch (e) {
    estado.error = String((e && e.message) || e);
    log(`ERROR: ${estado.error}`);
    // si ya habia una version buena se sigue sirviendo esa
  } finally {
    estado.refrescando = false;
  }
}

/* ---------------------------------------------------------------- */
/* Programacion diaria 6:00 am Colombia                              */
/* ---------------------------------------------------------------- */

function msHastaProximoRefresco() {
  const ahora = new Date();
  // 6:00 am Bogota = 11:00 UTC
  const horaUtc = HORA_BOGOTA - OFFSET_BOGOTA; // 6 - (-5) = 11
  const obj = new Date(Date.UTC(
    ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate(), horaUtc, 0, 0, 0
  ));
  if (obj.getTime() <= ahora.getTime()) obj.setUTCDate(obj.getUTCDate() + 1);
  return obj.getTime() - ahora.getTime();
}

function programar() {
  const ms = msHastaProximoRefresco();
  const cuando = new Date(Date.now() + ms);
  log(`proximo refresco automatico: ${cuando.toISOString()} (6:00 am Bogota)`);
  setTimeout(async () => {
    await refrescar('programado 6:00 am Bogota');
    programar();
  }, ms);
}

/* ---------------------------------------------------------------- */
/* Autenticacion                                                     */
/* ---------------------------------------------------------------- */

function comparaSegura(a, b) {
  // comparacion en tiempo constante para no filtrar la clave por timing
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  let dif = 0;
  for (let i = 0; i < ba.length; i++) dif |= ba[i] ^ bb[i];
  return dif === 0;
}

function autorizado(req) {
  if (!CLAVE) return true; // sin DASHBOARD_PASSWORD el sitio queda abierto
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  let plano;
  try { plano = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const i = plano.indexOf(':');
  if (i < 0) return false;
  return comparaSegura(plano.slice(0, i), USUARIO) && comparaSegura(plano.slice(i + 1), CLAVE);
}

/* ---------------------------------------------------------------- */
/* Servidor                                                          */
/* ---------------------------------------------------------------- */

const servidor = http.createServer(async (req, res) => {
  const ruta = (req.url || '/').split('?')[0];

  // sonda de salud: sin clave, para que Railway pueda monitorear
  if (ruta === '/salud') {
    res.writeHead(estado.html ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ok: !!estado.html,
      actualizado: estado.actualizado,
      error: estado.error,
      resumen: estado.resumen,
      proximoRefrescoUtc: new Date(Date.now() + msHastaProximoRefresco()).toISOString(),
    }, null, 2));
  }

  if (!autorizado(req)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Dashboard Caujaral", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return res.end('Se requiere usuario y clave.');
  }

  if (ruta === '/actualizar') {
    await refrescar('manual');
    res.writeHead(estado.error ? 500 : 302, estado.error
      ? { 'Content-Type': 'text/plain; charset=utf-8' }
      : { Location: '/' });
    return res.end(estado.error || '');
  }

  if (ruta !== '/' && ruta !== '/index.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('No encontrado');
  }

  if (!estado.html) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '20' });
    return res.end(`<meta charset="utf-8"><meta http-equiv="refresh" content="15">
      <div style="font-family:Segoe UI,sans-serif;padding:40px;color:#252423">
        <h2 style="color:#0F714A">Cargando datos desde Power BI...</h2>
        <p>Esta pagina se recarga sola en unos segundos.</p>
        ${estado.error ? `<p style="color:#E10000">Ultimo error: ${estado.error}</p>` : ''}
      </div>`);
  }

  const aceptaGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const cuerpo = aceptaGzip ? estado.gz : Buffer.from(estado.html, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': cuerpo.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...(aceptaGzip ? { 'Content-Encoding': 'gzip' } : {}),
  });
  res.end(cuerpo);
});

servidor.listen(PUERTO, () => {
  log(`escuchando en el puerto ${PUERTO}`);
  log(CLAVE ? 'acceso: con usuario y clave' : 'acceso: abierto (sin clave, por decision del club)');
  refrescar('arranque');
  programar();
});
