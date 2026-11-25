// Reporte HTML autocontenido de la suite e2e: cada flujo con sus pasos,
// tiempo, OK/FALLA/NO CORRIÓ, detalle o error y su captura (embebida UNA vez
// en base64; tocarla la amplía con :target, sin JavaScript; el archivo
// también queda en screenshots-e2e/capturas/ con enlace relativo). En el
// teléfono cada paso se apila y la captura queda debajo del texto.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const seg = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const claseEstado = (e) => "e-" + String(e).replace(/[^A-Z]/gi, "");

export function armarReporte({ flujos, meta }) {
  const pasos = flujos.flatMap((f) => f.pasos);
  const ok = pasos.filter((p) => p.estado === "OK").length;
  const fallas = pasos.filter((p) => p.estado === "FALLA").length;
  const noCorrieron = pasos.filter((p) => p.estado === "NO CORRIÓ").length;
  const flujosOk = flujos.filter((f) => f.estado === "OK").length;
  const global = fallas === 0 && noCorrieron === 0 && flujos.every((f) => f.estado === "OK") ? "OK" : "FALLA";
  let n = 0;

  const imagen = (cap, alt) => {
    const id = `c${++n}`;
    return `<div class="cap" id="${id}"><a href="#${id}" class="abrir" aria-label="Ampliar: ${esc(alt)}"><img src="data:${cap.tipo};base64,${cap.base64}" alt="${esc(alt)}" loading="lazy"></a><a href="#_" class="cerrar">Cerrar ✕</a></div>
      <div class="archivo"><a href="capturas/${esc(cap.archivo)}">${esc(cap.archivo)}</a></div>`;
  };

  const filaResumen = flujos
    .map((f) => `<tr><td><a href="#f-${esc(f.id)}">${esc(f.id)}. ${esc(f.titulo)}</a></td><td><span class="e ${claseEstado(f.estado)}">${f.estado}</span></td>
      <td class="num">${f.pasos.filter((p) => p.estado === "OK").length}/${f.pasos.length}</td><td class="num">${seg(f.ms)}</td></tr>`)
    .join("");

  const secciones = flujos
    .map((f) => {
      const filas = f.pasos
        .map((p, i) => {
          const caps = [p.captura, ...(p.extras ?? [])].filter(Boolean);
          const img = caps.length ? caps.map((cap) => imagen(cap, p.nombre)).join("") : `<span class="tenue">sin captura</span>`;
          return `<tr class="${claseEstado(p.estado).replace("e-", "p-")}"><td class="num">${i + 1}</td><td class="paso"><span class="nombre">${esc(p.nombre)}</span>${p.detalle ? `<div class="det">${esc(p.detalle)}</div>` : ""}${p.error ? `<pre class="err">${esc(p.error)}</pre>` : ""}</td>
            <td class="num">${seg(p.ms)}</td><td><span class="e ${claseEstado(p.estado)}">${p.estado}</span></td><td class="capcol">${img}</td></tr>`;
        })
        .join("");
      return `<section id="f-${esc(f.id)}"><h2>${esc(f.id)}. ${esc(f.titulo)} <span class="e ${claseEstado(f.estado)}">${f.estado}</span> <span class="tenue">${seg(f.ms)}</span></h2>
        ${f.motivo ? `<p class="tenue">Omitido: ${esc(f.motivo)}</p>` : ""}
        ${f.pasos.length ? `<div class="tabla-scroll"><table class="pasos"><thead><tr><th>#</th><th>Paso</th><th>Tiempo</th><th>Estado</th><th>Captura</th></tr></thead><tbody>${filas}</tbody></table></div>` : ""}</section>`;
    })
    .join("");

  const metaFilas = Object.entries(meta)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${typeof v === "object" ? `<code>${esc(JSON.stringify(v))}</code>` : esc(v)}</td></tr>`)
    .join("");

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reporte e2e AntroApp</title>
<style>
:root{--fondo:#f6f6f4;--sup:#fff;--texto:#1a1a1a;--tenue:#666;--borde:#ddd;--ok:#1f7a3a;--warn:#9a6700;--err:#b42318;--okf:#e7f4ea;--errf:#fdecea;--omf:#f3f0e6}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--fondo:#141414;--sup:#1e1e1e;--texto:#eee;--tenue:#aaa;--borde:#333;--ok:#5cc27a;--warn:#e0b040;--err:#ff6b5e;--okf:#16301e;--errf:#3a1714;--omf:#2e2a1e}}
:root[data-theme="dark"]{--fondo:#141414;--sup:#1e1e1e;--texto:#eee;--tenue:#aaa;--borde:#333;--ok:#5cc27a;--warn:#e0b040;--err:#ff6b5e;--okf:#16301e;--errf:#3a1714;--omf:#2e2a1e}
*{box-sizing:border-box}body{margin:0;background:var(--fondo);color:var(--texto);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}
main{max-width:1100px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
table{width:100%;border-collapse:collapse;background:var(--sup);border:1px solid var(--borde);border-radius:6px;overflow:hidden}
th,td{padding:8px 10px;border-bottom:1px solid var(--borde);text-align:left;vertical-align:top}th{font-weight:600;font-size:12px;color:var(--tenue)}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.tenue{color:var(--tenue);font-weight:400}
.e{display:inline-block;padding:1px 8px;border-radius:4px;font-size:12px;font-weight:600;white-space:nowrap}
.e-OK{background:var(--okf);color:var(--ok)}.e-FALLA{background:var(--errf);color:var(--err)}.e-OMITIDO,.e-NOCORRI{background:var(--omf);color:var(--warn)}
tr.p-FALLA td{background:var(--errf)}tr.p-NOCORRI td{background:var(--omf)}
.det{color:var(--tenue);font-size:12px;margin-top:2px;white-space:pre-wrap;word-break:break-word}
pre.err{margin:4px 0 0;white-space:pre-wrap;word-break:break-word;color:var(--err);font-size:12px}
.capcol{width:120px}.cap{margin-bottom:4px}.cap .abrir img{width:96px;border:1px solid var(--borde);border-radius:4px;display:block}.cap .cerrar{display:none}
.cap:target{position:fixed;inset:0;background:rgba(0,0,0,.95);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9;padding:16px;margin:0}
.cap:target .abrir img{width:auto!important;height:auto;max-width:100%;max-height:calc(100vh - 72px);border:0}.cap:target .abrir{display:flex;justify-content:center;max-width:100%}.cap:target .cerrar{display:block;color:#fff;margin-top:10px;font-weight:600}
.archivo{font-size:11px;margin-top:2px;word-break:break-all}
.global{font-size:16px;margin:8px 0 16px}.tabla-scroll{overflow-x:auto;max-width:100%}code{font-size:12px;word-break:break-all}
@media (max-width:600px){
  body{padding:16px 16px 32px}
  table.pasos,table.pasos tbody,table.pasos tr,table.pasos td{display:block;width:100%}
  table.pasos thead{display:none}
  table.pasos tr{border-bottom:1px solid var(--borde);padding:8px 10px;display:grid;grid-template-columns:auto 1fr auto auto;gap:4px 8px}
  table.pasos td{border:0;padding:0;background:transparent!important}
  table.pasos td.paso{grid-column:2/5;grid-row:1}
  table.pasos td.num:first-child{grid-column:1;grid-row:1}
  table.pasos td:nth-child(3){grid-column:3;grid-row:2;text-align:right}
  table.pasos td:nth-child(4){grid-column:4;grid-row:2}
  table.pasos td.capcol{grid-column:1/5;grid-row:3;width:auto;display:flex;flex-wrap:wrap;gap:8px}
  table.pasos td.capcol .cap .abrir img{width:120px}
  tr.p-FALLA{background:var(--errf)}tr.p-NOCORRI{background:var(--omf)}
}
</style></head><body><main>
<h1>Suite de punta a punta</h1>
<p class="global">Resultado: <span class="e ${claseEstado(global)}">${global}</span> · ${ok}/${pasos.length} pasos OK · ${fallas} con falla${noCorrieron ? ` · ${noCorrieron} no corrieron` : ""} · ${flujosOk}/${flujos.length} flujos OK</p>
<div class="tabla-scroll"><table><thead><tr><th>Flujo</th><th>Estado</th><th>Pasos OK</th><th>Tiempo</th></tr></thead><tbody>${filaResumen}</tbody></table></div>
<h2>Corrida</h2><div class="tabla-scroll"><table><tbody>${metaFilas}</tbody></table></div>
${secciones}
</main></body></html>`;
}
