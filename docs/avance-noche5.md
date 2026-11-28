# Avance — noche 5 (rama `post-junta-4`)

> Bitácora para reanudar si la sesión se corta. Rama `post-junta-4` creada
> desde `post-junta-3` (`4862ff2`) el 27/11/2026. Sin funciones nuevas de
> producto; nada en producción (solo lectura); sin merge ni push a `master`.

Leyenda: ✔ hecho y verificado · ⚠ hecho con límites (ver nota) · ✘ no se pudo · ⏳ en curso · ☐ sin empezar

| # | Bloque | Estado | Entregable | Nota |
|---|---|---|---|---|
| 1 | Prueba de carga (club grande) | ✔ | `docs/prueba-carga.md`, `probar-carga-noche.mjs`, `sql/post-junta-4/10-indices-carga*.sql` | Base holgada; cuello en la caja (relee toda la noche cada 10 s) y 6 políticas por fila (propuesta con rollback, equivalencia 63/63, sin aplicar). Dev comprobado idéntico al de antes |
| 2 | Recuperación ante desastres | ✔ | `docs/recuperacion.md`, `scripts/exportar-storage.mjs`, `scripts/dev/importar-storage.mjs` | Probado en dev (huellas OK, importación en buckets temporales). RTO ≈ 4 h; RPO base ≤ 24 h. Storage de producción **nunca exportado**: lo corre Diego |
| 3 | Stripe en modo prueba (dev) | ⚠ | `docs/stripe-prueba-dev.md`, `probar-mensualidad-recorridos.mjs` | 80/80 nuevos + 60/60 existentes, con eventos firmados localmente (no hay CLI ni llaves de prueba en el equipo). Falta lo que solo se ve con Stripe real (Checkout/portal reales, calendario de Smart Retries, campo que manda el portal al cancelar). 7 hallazgos, ninguno arreglado |
| 4 | Guía de teléfonos reales | ✔ | `docs/prueba-telefonos.md` | 27 pruebas con casilla Android/iPhone, en el Preview (base dev). Commit `212cec2` |
| 5 | Archivos de ejemplo POS | ✔ | `fixtures/pos/` (32 + LEEME), `probar-pos-fixtures.mjs` | 363/363 con la base (321/321 sin ella). 2 bugs arreglados en `lib/pos` (`c3b04a3`): título largo como encabezado; .xlsx dañado sin mensaje. 3 pendientes menores en el LEEME/reporte. Commit `7276337` |
| 6 | Material de venta | ✔ | `docs/venta/una-pagina.md`, `faq.md` (15), `guion-demo-video.md` (9 escenas) | Separa hoy / pase 2 / pase 3. Precio «[por definir]» (los $2,500 solo en notas internas «quitar antes de enviar»). Commit `e8036aa` |
| 7 | Plan de piloto | ✔ | `docs/piloto-playbook.md` | Requisitos R1–R7 (pase 2 en producción primero); criterios son propuesta. Commit `212cec2` |
| 8 | Revisión de privacidad | ✔ | `docs/privacidad-datos.md` | 19 hallazgos, 20 puntos para el aviso, 14 decisiones. Verificados a mano: base en ca-central-1, SHA-256 sin sal, campo «Últimos 4 dígitos». Commit `87162e0` |
| 9 | Lista de lanzamiento | ✔ | `docs/lanzamiento-checklist.md` | Piloto: 7 ✔ · 8 ⚠ · 13 ✘ · 6 ❓; cobro: 2 ⚠ · 9 ✘. Falta poner el resultado de la prueba de carga (renglón A1). Commit `1ca4439` |

## Siguiente paso exacto

Los 9 bloques están y el ensayo se repitió. Falta: subir `post-junta-4`, revisar que Vercel solo cree Preview y el reporte final.

## Bitácora

- 27/11 — Rama creada. Bloques 1, 2, 5, 6 y 8 lanzados en paralelo.
- 27/11 — Bloques 4 y 7 escritos y en commit (`212cec2`).
- 27/11 — Bloque 3 lanzado con el alcance que fijó Diego. Se avisó al de carga del ruido de CPU de los servidores 3001/3003.
- 27/11 — Bloques 6 y 8 recibidos, revisados y en commit (`e8036aa`, `87162e0`).
- 27/11 — Bloque 5 recibido; pruebas repetidas por el coordinador (321/321 sin base, dominio 189/189); commits `c3b04a3` (arreglos) y `7276337` (archivos y prueba).
- 28/11 — Bloque 2 recibido; exportación repetida por el coordinador (7/7 huellas); commit.
- 28/11 — Bloque 3 recibido y en commit (incluye arreglo de una prueba vieja de probar-mensualidad, 60/60).
- 28/11 — Bloque 9 escrito (`1ca4439`); `docs/avance.md` con 39 + 11 pasos.
- 28/11 — Bloque 1 recibido; dev comparado con la foto del final del pase 3: 0 líneas distintas. Commit y renglón A1 de la lista de lanzamiento.
- 28/11 — Si sobra tiempo: ensayo del pase 2 con otra semilla (sembrar-dev + demo-datos nuevos): 39/39 en 10.3 min, mismos resultados y esquema final idéntico a la primera corrida; pase 3 11/11 idéntico. Banderas de dev en 0. Revisión del diff de la noche: sin secretos, correos reales, backups, console.log ni sondas.
