'use strict';
/**
 * Extraccion de ventas desde el reporte publico de Power BI del club.
 *
 * El endpoint /public/reports/querydata devuelve el formato DSR comprimido:
 *   C   -> valores presentes en la fila
 *   R   -> mapa de bits de columnas que se repiten de la fila anterior
 *   Ø -> mapa de bits de columnas nulas
 *   ValueDicts -> los textos vienen como indices a estos diccionarios
 */

const CFG = {
  url: 'https://wabi-south-central-us-c-primary-api.analysis.windows.net/public/reports/querydata?synchronous=true',
  // IDs del reporte publicado: extraidos del parametro ?r= de la URL
  // Definir PBI_RESOURCE_KEY, PBI_DATASET_ID, PBI_REPORT_ID en Railway o .env
  resourceKey: process.env.PBI_RESOURCE_KEY || '',
  datasetId: process.env.PBI_DATASET_ID || '',
  reportId: process.env.PBI_REPORT_ID || '',
  modelId: Number(process.env.PBI_MODEL_ID || 1871413),
  visualId: '075bb3a065bae905c5eb',
};

function validarConfig() {
  if (!CFG.resourceKey || !CFG.datasetId || !CFG.reportId) {
    throw new Error(
      'Faltan variables de entorno. Define: PBI_RESOURCE_KEY, PBI_DATASET_ID, PBI_REPORT_ID.\n' +
      'Extrae los valores de la URL del reporte publicado: ?r=... contiene los tres UUIDs en un JSON codificado.'
    );
  }
}

const NULL_MASK = 'Ø';

/* ------------------------------------------------------------------ */
/* Consulta                                                            */
/* ------------------------------------------------------------------ */

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function consultar(body) {
  const res = await fetch(CFG.url, {
    method: 'POST',
    headers: {
      'X-PowerBI-ResourceKey': CFG.resourceKey,
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json, text/plain, */*',
      ActivityId: uuid(),
      RequestId: uuid(),
    },
    body: Buffer.from(body, 'utf8'),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Power BI respondio ${res.status}. ${txt.slice(0, 300)}`);
  }
  return parseDsr(await res.json());
}

function parseDsr(resp) {
  const ds =
    resp && resp.results && resp.results[0] && resp.results[0].result &&
    resp.results[0].result.data && resp.results[0].result.data.dsr &&
    resp.results[0].result.data.dsr.DS && resp.results[0].result.data.dsr.DS[0];
  if (!ds || !ds.PH || !ds.PH[0] || !ds.PH[0].DM0) return [];

  const dicts = ds.ValueDicts || {};
  const items = ds.PH[0].DM0;
  const schema = items[0].S || [];
  const n = schema.length;

  const filas = [];
  let prev = new Array(n).fill(null);
  for (const it of items) {
    const cur = new Array(n).fill(null);
    const rep = it.R | 0;
    const nul = it[NULL_MASK] | 0;
    const C = it.C || [];
    let ci = 0;
    for (let k = 0; k < n; k++) {
      const bit = 1 << k;
      if (nul & bit) { cur[k] = null; continue; }
      if (rep & bit) { cur[k] = prev[k]; continue; }
      let v = C[ci++];
      const dn = schema[k].DN;
      // el diccionario solo aplica cuando el valor llega como indice numerico
      if (dn && dicts[dn] && typeof v === 'number') {
        const arr = dicts[dn];
        if (v >= 0 && v < arr.length) v = arr[v];
      }
      cur[k] = v;
    }
    filas.push(cur);
    prev = cur;
  }
  return filas;
}

/* ------------------------------------------------------------------ */
/* Armado de consultas                                                 */
/* ------------------------------------------------------------------ */

const col = (src, prop) =>
  `{"Column":{"Expression":{"SourceRef":{"Source":"${src}"}},"Property":${JSON.stringify(prop)}},"Name":${JSON.stringify(src + '.' + prop)}}`;
const suma = (prop) =>
  `{"Aggregation":{"Expression":{"Column":{"Expression":{"SourceRef":{"Source":"c"}},"Property":${JSON.stringify(prop)}}},"Function":0},"Name":${JSON.stringify('Sum.' + prop)}}`;
const igual = (src, prop, val) =>
  `{"Condition":{"In":{"Expressions":[{"Column":{"Expression":{"SourceRef":{"Source":"${src}"}},"Property":${JSON.stringify(prop)}}}],"Values":[[{"Literal":{"Value":"${val}L"}}]]}}}`;

// mismos filtros que aplica el reporte: sin clasificacion "Dep" ni consumo de funcionarios
const FILTROS_BASE = [
  `{"Condition":{"Not":{"Expression":{"In":{"Expressions":[{"Column":{"Expression":{"SourceRef":{"Source":"c"}},"Property":"CLASIFICACION"}}],"Values":[[{"Literal":{"Value":"'Dep'"}}]]}}}}}`,
  `{"Condition":{"Not":{"Expression":{"In":{"Expressions":[{"Column":{"Expression":{"SourceRef":{"Source":"c"}},"Property":"FUNCIONARIO"}}],"Values":[[{"Literal":{"Value":"'S'"}}]]}}}}}`,
];

function query(selects, wheres, tope) {
  const proj = selects.map((_, i) => i).join(',');
  const where = (wheres || []).concat(FILTROS_BASE).join(',');
  return `{"version":"1.0.0","queries":[{"Query":{"Commands":[{"SemanticQueryDataShapeCommand":{
"Query":{"Version":2,
 "From":[{"Name":"c","Entity":"consumos","Type":0},{"Name":"f","Entity":"Dim Fecha","Type":0}],
 "Select":[${selects.join(',')}],
 "Where":[${where}]},
"Binding":{"Primary":{"Groupings":[{"Projections":[${proj}]}]},
 "DataReduction":{"DataVolume":4,"Primary":{"Window":{"Count":${tope}}}},"Version":1},
"ExecutionMetricsKind":1}}]},
"QueryId":"","ApplicationContext":{"DatasetId":"${CFG.datasetId}","Sources":[{"ReportId":"${CFG.reportId}","VisualId":"${CFG.visualId}"}]}}],
"cancelQueries":[],"modelId":${CFG.modelId}}`;
}

const P_ANIO = 'Año';        // Año
const P_MES = 'Mes Nº';      // Mes Nº
const P_DIA = 'Día';         // Día

/* ------------------------------------------------------------------ */
/* Clasificacion de categorias                                         */
/* ------------------------------------------------------------------ */

// TIPOPROD: A = alimentos, B = bebidas, O = otros.
// Dentro de B, estas son las unicas agrupaciones sin alcohol.
const NO_ALCOHOLICAS = new Set([
  'BEBIDAS REFRESCANTES',
  'JUGOS/LIMONADAS',
  'CAPUCHINO',
  'BEBIDAS REFRESCANTES KIOSKO',
  'JUGOS Y LIMONADAS KIOSKO',
]);

function categoria(tipo, agrupacion) {
  if (tipo === 'A') return 0;                                   // Alimentos
  if (tipo === 'B') return NO_ALCOHOLICAS.has(agrupacion) ? 2 : 1; // no alc / alc
  return 3;                                                     // Otros
}

/* ------------------------------------------------------------------ */
/* Extraccion completa                                                 */
/* ------------------------------------------------------------------ */

const num = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);

async function extraer(log = () => {}) {
  validarConfig();
  const t0 = Date.now();

  // 1. anios disponibles: se descubren solos, asi sirve tambien en 2027+
  const rAnios = await consultar(query([col('f', P_ANIO), suma('VVENTA')], [], 200));
  const anios = rAnios.map((r) => Number(r[0])).filter(Boolean).sort((a, b) => a - b);
  if (!anios.length) throw new Error('El reporte no devolvio ningun anio.');
  log(`anios: ${anios.join(', ')}`);

  // 2. ultima fecha con venta
  const ultimoAnio = anios[anios.length - 1];
  const rMeses = await consultar(query([col('f', P_MES), suma('VVENTA')], [igual('f', P_ANIO, ultimoAnio)], 50));
  const ultimoMes = Math.max(...rMeses.map((r) => Number(r[0])));
  const rDias = await consultar(
    query([col('f', P_DIA), suma('VVENTA')], [igual('f', P_ANIO, ultimoAnio), igual('f', P_MES, ultimoMes)], 100)
  );
  const ultimoDia = Math.max(...rDias.map((r) => Number(r[0])));
  log(`datos hasta ${ultimoDia}/${ultimoMes}/${ultimoAnio}`);

  // 3. hecho: mes x ambiente x tipo x agrupacion, un anio por consulta
  const hecho = [];
  for (const y of anios) {
    const sel = [
      col('f', P_MES), col('c', 'LOCALIZACION'), col('c', 'TIPOPROD'),
      col('c', 'AGRUPRODUTO'), suma('CANTIDAD'), suma('VVENTA'),
    ];
    const filas = await consultar(query(sel, [igual('f', P_ANIO, y)], 50000));
    log(`${y}: ${filas.length} filas`);
    for (const r of filas) {
      hecho.push({
        anio: y,
        mes: Number(r[0]) || 0,
        ambiente: String(r[1] == null ? '' : r[1]),
        tipo: String(r[2] == null ? '' : r[2]),
        agrupacion: String(r[3] == null ? '' : r[3]),
        cantidad: num(r[4]),
        venta: num(r[5]),
      });
    }
  }

  // 4. codificar para el navegador (indices en vez de repetir textos)
  const ambientes = [...new Set(hecho.map((h) => h.ambiente))].sort();
  const agrupas = [...new Set(hecho.map((h) => h.agrupacion))].sort();
  const iAmb = new Map(ambientes.map((a, i) => [a, i]));
  const iAgr = new Map(agrupas.map((a, i) => [a, i]));

  const catDe = new Map();
  for (const h of hecho) if (!catDe.has(h.agrupacion)) catDe.set(h.agrupacion, categoria(h.tipo, h.agrupacion));

  const F = hecho.map((h) => [
    h.anio, h.mes, iAmb.get(h.ambiente), iAgr.get(h.agrupacion),
    Math.round(h.cantidad * 10) / 10, Math.round(h.venta),
  ]);

  const js =
    `const AMB=${JSON.stringify(ambientes)};\n` +
    `const AGR=${JSON.stringify(agrupas.map((a) => [a, catDe.get(a)]))};\n` +
    `const F=${JSON.stringify(F)};\n` +
    `const META={ultimoDia:${ultimoDia},ultimoMes:${ultimoMes},ultimoAnio:${ultimoAnio}};`;

  return {
    js,
    resumen: {
      filas: hecho.length,
      ambientes: ambientes.length,
      subcategorias: agrupas.length,
      anios,
      corte: `${String(ultimoDia).padStart(2, '0')}/${String(ultimoMes).padStart(2, '0')}/${ultimoAnio}`,
      ventaTotal: Math.round(hecho.reduce((s, h) => s + h.venta, 0)),
      segundos: Math.round((Date.now() - t0) / 100) / 10,
    },
  };
}

module.exports = { extraer, parseDsr, categoria };
