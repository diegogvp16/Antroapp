# Avance — noche 5 (rama `post-junta-4`)

> Bitácora para reanudar si la sesión se corta. Rama `post-junta-4` creada
> desde `post-junta-3` (`4862ff2`) el 27/11/2026. Sin funciones nuevas de
> producto; nada en producción (solo lectura); sin merge ni push a `master`.

Leyenda: ✔ hecho y verificado · ⚠ hecho con límites (ver nota) · ✘ no se pudo · ⏳ en curso · ☐ sin empezar

| # | Bloque | Estado | Entregable | Nota |
|---|---|---|---|---|
| 1 | Prueba de carga (club grande) | ⏳ | `docs/prueba-carga.md`, script en `scripts/dev/` | |
| 2 | Recuperación ante desastres | ⏳ | `docs/recuperacion.md`, `scripts/dev/exportar-storage.mjs` | |
| 3 | Stripe en modo prueba (dev) | ☐ | `docs/stripe-prueba-dev.md` | No hay CLI de Stripe ni llaves de prueba en este equipo |
| 4 | Guía de teléfonos reales | ☐ | `docs/prueba-telefonos.md` | |
| 5 | Archivos de ejemplo POS | ⏳ | `fixtures/pos/`, prueba en `scripts/dev/` | |
| 6 | Material de venta | ⏳ | `docs/venta/*.md` | |
| 7 | Plan de piloto | ☐ | `docs/piloto-playbook.md` | |
| 8 | Revisión de privacidad | ⏳ | `docs/privacidad-datos.md` | |
| 9 | Lista de lanzamiento | ☐ | `docs/lanzamiento-checklist.md` | Al final, con lo de los demás |

## Siguiente paso exacto

Esperar a los agentes de los bloques 1, 2, 5, 6 y 8; mientras, escribir 4 y 7.
Después: bloque 3 (cuando termine la prueba de carga, para no medir con el
CPU ocupado), luego 9, y al final revisión del diff y subida de la rama.

## Bitácora

- 27/11 — Rama creada. Bloques 1, 2, 5, 6 y 8 lanzados en paralelo.
