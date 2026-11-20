# Caja en condiciones reales (noche 2, rama `noche2`)

Un antro tiene mala señal y varios staff a la vez en la misma mesa. Esto es
lo que se revisó, lo que se cambió y cómo se probó. Todo está en `noche2` y
en antroapp-dev; **nada en producción**.

## Qué podía salir mal (antes)

| Situación | Antes | Ahora |
|---|---|---|
| Doble toque en "Agregar a la mesa", "Cobrar" o "Cuadrar" | El botón se desactivaba con el estado de React; un segundo toque antes de repintar podía entrar. En "Agregar" con varios renglones había un hueco entre renglón y renglón. | Candado síncrono (`useRef`) en `useAccion`: un flujo de varios pasos lo conserva de principio a fin. Triple toque = 1 consumo (probado). |
| La base guarda, pero la respuesta se pierde por la señal; el staff vuelve a tocar | El consumo o el cobro quedaba **doble**. | Cada movimiento lleva una **clave de idempotencia** (uuid) que se repite en cada reintento; la base devuelve el que ya existía. |
| Dos staff cobran el saldo completo a la vez | La mesa quedaba **sobrepagada** y no se podía cerrar hasta anular uno. | **Saldo esperado**: la base compara, con la mesa bloqueada, el saldo que el staff tenía en pantalla con el real. Entra uno; al otro se le explica que la mesa ya quedó pagada. |
| "Cuadrar" pierde la respuesta | El reintento daba "La mesa está cuadrada y esta acción requiere que esté cerrada". | La app lee el estado real de la sesión antes y después: si ya quedó cuadrada, termina bien sin pedir nada. Igual "Cerrar mesa" y "Cerrar la noche". |
| Sin conexión | Error genérico; nada avisaba que los montos podían estar viejos. | Aviso fijo "Sin conexión · reconectando…" con la hora de los montos; los botones dicen "Sin conexión" y no envían; lo capturado se queda en la hoja. |
| Otro staff registra algo | Había que tocar "Actualizar". | La caja revisa cada 10 s (4 s sin red) con una **firma de la noche** de ~1 KB y solo vuelve a leer todo si cambió. |
| Mensajes de error | Los de red salían genéricos ("No se pudo completar"). | "No hubo respuesta por la señal. Tu captura sigue aquí: vuelve a intentar; si ya se había guardado, no se duplica." Sin datos técnicos. |

Lo que ya estaba bien y se confirmó: todas las escrituras de caja bloquean la
fila de la sesión (`for update`), así que dos consumos simultáneos nunca se
pierden ni se pisan (30 consumos de 3 staff a la vez: total exacto); dos
cuadres simultáneos: pasa uno, una sola comisión.

## SQL (propuesta para producción; aplicado SOLO en dev)

- `sql/2026-11-21-caja-idempotencia.sql`:
  1. `clave_cliente uuid` en `caja_consumos` y `caja_pagos`, con índice único
     por `(registrado_por, clave_cliente)`.
  2. `caja_registrar_consumo(…, p_clave uuid default null)`.
  3. `caja_registrar_pago(…, p_clave uuid default null, p_saldo_esperado bigint default null)`.
  4. `caja_firma_noche(p_club_id)`: `security invoker` (respeta RLS), no
     devuelve datos, solo un md5.
- Rollback: `sql/2026-11-21-caja-idempotencia-rollback.sql`. Probado en dev:
  aplicar → rollback → el esquema queda **idéntico** (diff vacío) → aplicar.
- Compatible hacia atrás: los parámetros nuevos tienen default; el código de
  `desarrollo` y las pruebas existentes siguen igual (probar-caja 167/167).
- Compatible hacia adelante: si el código de `noche2` llega a una base sin
  este SQL, la app lo detecta (PGRST202) y llama como antes, sin la
  protección nueva; la caja sigue funcionando.
- En el pase va **después** de `2026-11-21-caja-permisos.sql` y antes del
  merge del código que lo usa (ver `docs/pase-produccion.md`, paso 7b).

## Pruebas

| Prueba | Qué cubre | Resultado |
|---|---|---|
| `node scripts/dev/probar-caja-concurrencia.mjs` | Base, sesiones reales: reintentos con la misma clave (también 5 simultáneos y con la mesa ya cerrada), clave con otros datos, 30 consumos de 3 staff a la vez, 3 staff cobrando el saldo completo, dos cuadres simultáneos, llamada sin clave | 29/29 |
| `node scripts/dev/probar-caja-multi.mjs` (Playwright, 3 sesiones) | 2 staff + gerente en la misma mesa: consumo simultáneo, la tercera pantalla ve el cambio sola (8–9 s), triple toque, respuesta perdida en consumo, cobro y cuadre, sin red y regreso, cobro simultáneo | 17/17 |
| `node scripts/dev/probar-carga-caja.mjs` | 50 mesas, 1,150 movimientos con 8 staff a la vez; CPU 4× y 4G lenta | ver abajo |
| `node scripts/verificar-cuadre.mjs` | Cuadres vs renglones y cobros, comisiones vs regla, nómina, /grupo y panel del RP | 955 revisiones (dev) + 483 (noche de carga), sin diferencias |

Capturas: `screenshots-caja-multi/` y `screenshots-carga-caja/` (fuera de Git).

### Carga (build de producción contra dev, `scripts/dev/servidor-prod-dev.mjs`)

| Medida | CPU 4× | CPU 4× + 4G lenta |
|---|---|---|
| Latencia por función de caja (8 staff a la vez) | p50 ~102 ms, p95 ~130–175 ms | — |
| Carga de `/staff/caja` hasta ver las 50 mesas | 3.2–3.6 s | 4.4–4.9 s |
| Consultas / datos de la carga | 14 / 77 KB | 14 / 77 KB |
| Revisión periódica (cada 10 s, sin cambios) | 1 consulta / ~1 KB | 1 / ~1 KB |
| Scroll del mapa (60 cuadros) | 16 ms promedio, 0 cuadros > 50 ms | igual |
| Abrir una mesa / volver al mapa | ~130 ms / ~130 ms | ~140 / ~120 ms |
| Cambiar de pestaña | ~120 ms | ~125 ms |
| Búsqueda (sin contar el tecleo) | ~160 ms | ~175 ms |
| Tareas largas al interactuar | 1, máx. 64 ms | 1, máx. 77 ms |

Antes de la firma, cada revisión bajaba la noche entera (10 consultas,
~73 KB cada 10 s ≈ 26 MB por hora por teléfono). Con el modo de desarrollo de
React las cifras son 2–5× peores; por eso se mide con el build de producción.

## Pendiente / decisiones

- **Sentar a un cliente sin reserva** no tiene clave: si se pierde la
  respuesta y se reintenta, puede quedar el mismo nombre dos veces en la
  mesa. Es visible y no mueve dinero; se puede agregar la misma clave a
  `caja_sentar_cliente` si Diego lo quiere.
- **Anular**: un reintento después de perder la respuesta muestra "El consumo
  ya estaba anulado" (no duplica nada; el mensaje es claro).
- Tiempo real (Supabase Realtime) en lugar de revisión cada 10 s: no hace
  falta con la firma; requeriría publicar tablas de caja en
  `supabase_realtime` y revisar RLS de Realtime. No se hizo.
