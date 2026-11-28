# Avance — noche 5 (rama `post-junta-4`)

> Bitácora para reanudar si la sesión se corta. Rama `post-junta-4` creada
> desde `post-junta-3` (`4862ff2`) el 27/11/2026. Sin funciones nuevas de
> producto; nada en producción (solo lectura); sin merge ni push a `master`.

Leyenda: ✔ hecho y verificado · ⚠ hecho con límites (ver nota) · ✘ no se pudo · ⏳ en curso · ☐ sin empezar

| # | Bloque | Estado | Entregable | Nota |
|---|---|---|---|---|
| 1 | Prueba de carga (club grande) | ⏳ | `docs/prueba-carga.md`, script en `scripts/dev/` | |
| 2 | Recuperación ante desastres | ⏳ | `docs/recuperacion.md`, `scripts/dev/exportar-storage.mjs` | |
| 3 | Stripe en modo prueba (dev) | ⏳ | `docs/stripe-prueba-dev.md`, script nuevo en `scripts/dev/` | Alcance fijado por Diego: solo lo que no cubre `probar-mensualidad.mjs` (reintentos y acceso, alta de punta a punta, paso de plan, cancelación al final del periodo). Sin CLI ni llaves reales: eventos firmados localmente |
| 4 | Guía de teléfonos reales | ✔ | `docs/prueba-telefonos.md` | 27 pruebas con casilla Android/iPhone, en el Preview (base dev). Commit `212cec2` |
| 5 | Archivos de ejemplo POS | ✔ | `fixtures/pos/` (32 + LEEME), `probar-pos-fixtures.mjs` | 363/363 con la base (321/321 sin ella). 2 bugs arreglados en `lib/pos` (`c3b04a3`): título largo como encabezado; .xlsx dañado sin mensaje. 3 pendientes menores en el LEEME/reporte. Commit `7276337` |
| 6 | Material de venta | ✔ | `docs/venta/una-pagina.md`, `faq.md` (15), `guion-demo-video.md` (9 escenas) | Separa hoy / pase 2 / pase 3. Precio «[por definir]» (los $2,500 solo en notas internas «quitar antes de enviar»). Commit `e8036aa` |
| 7 | Plan de piloto | ✔ | `docs/piloto-playbook.md` | Requisitos R1–R7 (pase 2 en producción primero); criterios son propuesta. Commit `212cec2` |
| 8 | Revisión de privacidad | ✔ | `docs/privacidad-datos.md` | 19 hallazgos, 20 puntos para el aviso, 14 decisiones. Verificados a mano: base en ca-central-1, SHA-256 sin sal, campo «Últimos 4 dígitos». Commit `87162e0` |
| 9 | Lista de lanzamiento | ☐ | `docs/lanzamiento-checklist.md` | Al final, con lo de los demás |

## Siguiente paso exacto

Esperar a los agentes de los bloques 1, 2 y 3 (4, 5, 6, 7 y 8 ya están).
Al llegar cada uno: revisar su diff, typecheck y lint, y commit por bloque.
Después: bloque 9 con lo de todos, y al final revisión del diff y subida de la rama.

## Bitácora

- 27/11 — Rama creada. Bloques 1, 2, 5, 6 y 8 lanzados en paralelo.
- 27/11 — Bloques 4 y 7 escritos y en commit (`212cec2`).
- 27/11 — Bloque 3 lanzado con el alcance que fijó Diego. Se avisó al de carga del ruido de CPU de los servidores 3001/3003.
- 27/11 — Bloques 6 y 8 recibidos, revisados y en commit (`e8036aa`, `87162e0`).
- 27/11 — Bloque 5 recibido; pruebas repetidas por el coordinador (321/321 sin base, dominio 189/189); commits `c3b04a3` (arreglos) y `7276337` (archivos y prueba).
