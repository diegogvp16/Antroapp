# Prueba de carga: una noche de un club grande

Rama `post-junta-4`, 27–28/11/2026, contra **antroapp-dev** (nunca producción).
Script: `scripts/dev/probar-carga-noche.mjs`. Propuesta SQL (sin aplicar):
`sql/post-junta-4/10-indices-carga*.sql`.

## Resumen

- **La base aguanta la noche con holgura.** Con 3 gerentes y 4 staff operando
  a la vez (~12 llamadas/s, 9 escrituras/s, unas 5 veces el pico de una noche
  real), todas las funciones de caja y puerta responden en p50 ≈ 90 ms y p95
  ≤ 150 ms por la API, y de eso ~64 ms son la ida y vuelta de la red a
  Supabase. Cuadrar una mesa, cerrar la noche, la nómina y el reporte de
  cierre tardan 2–40 ms dentro de la base. Ningún error en ~3,200–3,400
  llamadas por corrida.
- **Las pantallas cargan en 0.5–1.5 s** a 390×844 con CPU 4×, salvo **la caja**,
  que **crece con los movimientos de la noche**: 1.6 s con 1,189 consumos,
  2.0 s con 2,252, 2.6 s con 3,372 y 2.7 s (p95 3.1 s) con 4,620
  (195 → 386 → 583 → 789 KB). Y con la caja abierta y la noche en
  movimiento, **cada teléfono baja toda la noche cada 10 s: 108 consultas y
  5.5 MB por minuto**. Es el cuello de botella real, y es del teléfono y de
  la red, no de la base (hallazgo 1).
- **Cuello de botella en la base: seis políticas de RLS** de reservas y
  comisiones evalúan `current_role_name()` / `current_club_id()` /
  `auth.uid()` **por fila**. La puerta lee sus 500 reservas en 20 ms en vez de
  1.5 ms; el panel del admin, 200–230 ms en vez de 4–15 ms, y crece lineal
  con las filas de 30 días de todos los antros. Propuesta con rollback y
  probada en dev (hallazgo 2).
- **Los números cuadran al centavo** al final de la noche
  (`scripts/verificar-cuadre.mjs`, sección «Cuadre»).

## Escenario

Un antro propio, «Club Carga Dev &lt;tag&gt;», publicado (verificado y con
suscripción), modo de pago por reserva: $150 fijos con cuota de 3 (la tercera
reserva de la semana que consume ya paga) y 3 RPs con tarifa propia (8 % del
consumo, sin cuota). Cuentas `carga_<rol>_<tag>@example.com`:

| Qué | Cuánto |
|---|---|
| Mesas | 60 (capacidad 6–10) |
| Personal | 1 dueño, 3 gerentes, 4 staff, 15 RPs (turno fijo mié–sáb, asistencia de hoy), 1 admin |
| Historia | 4 semanas × jue–sáb = 12 noches de 500 reservas (72 % con entrada), 120 grupos por noche, ~1,500 consumos por noche, cobradas, cuadradas y cerradas, con sus comisiones y la bitácora de caja. Total: 6,000 reservas y 18,371 consumos. |
| La noche de hoy (al armar) | 500 reservas (86 % de RP). 300 entran por la puerta (`puerta_escanear` + `puerta_confirmar_entrada`). Caja: 60 mesas × 2 grupos; el primero (2 reservas) consume, paga en dos partes, se cierra y se cuadra; el segundo (2 reservas + un walk-in cada tercera mesa) queda abierto con cobro parcial. 1,189 consumos, 6 anulados, 187 cobros (4 anulados), 3 mesas reabiertas («pidieron otra ronda»), 60 cuadres. |
| Durante la medición | 4 staff: puerta (escanear y confirmar a quien va llegando y sentarlo), consumos, cobros con el saldo exacto. 3 gerentes: anulan consumos y cobros con motivo, revisan el reporte de cierre y la nómina, y rotan mesas (cobrar lo que falta, cerrar, cuadrar y sentar al siguiente grupo). Cada uno con la caja abierta: `caja_firma_noche` cada 5 s. ~1,100 consumos más por corrida. |

Todo pasa por las funciones reales de la base con la sesión de cada rol
(supabase-js con la llave anon y login de cada cuenta), salvo la historia,
que se inserta en SQL como `postgres` (coherente: caja = cuadres =
comisiones), y las 500 reservas de hoy, que se insertan con la service role
como si las hubieran hecho los RPs y clientes durante el día.

## Cómo correrlo

```bash
# 1) App de producción contra dev (no next dev: exagera los tiempos 2–5×)
node scripts/dev/servidor-prod-dev.mjs            # puerto 3002

# 2) Todo de una vez: armar, medir, ensayo de cierres, cierre real y limpiar
PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> node scripts/dev/probar-carga-noche.mjs todo

# o por partes (el estado queda en screenshots-carga-noche/estado.json):
node scripts/dev/probar-carga-noche.mjs armar
PLAYWRIGHT_DESDE=… node scripts/dev/probar-carga-noche.mjs medir --etiqueta=antes [--repeticiones=10] [--sin-carga] [--base=http://localhost:3002]
node scripts/dev/probar-carga-noche.mjs ensayo --etiqueta=antes        # cierres en una transacción que se deshace
node scripts/dev/probar-carga-noche.mjs estadisticas --etiqueta=antes  # pg_stat_statements, incluye lo de dentro de funciones
node scripts/dev/probar-carga-noche.mjs explicar --etiqueta=antes [--volumen-anio] [--con=sql/post-junta-4/10-indices-carga.sql]
node scripts/dev/probar-carga-noche.mjs equivalencia --con=sql/post-junta-4/10-indices-carga.sql
node scripts/dev/probar-carga-noche.mjs cierre                         # cierre real por la API + verificar-cuadre
node scripts/dev/probar-carga-noche.mjs limpiar
```

- Se niega a correr contra producción (`verificarEnvDev` y
  `conectarDevEscritura` revisan URL, llaves y conexión) y solo mide una app en
  `localhost`.
- `--volumen-anio` agrega, solo dentro de la transacción de `explicar`, un año
  más de historia (300 noches × 500 reservas y 80,000 comisiones) para ver
  cómo escalan los planes; no deja nada.
- `--con=<archivo>` aplica un SQL solo dentro de la transacción de `explicar`
  o `equivalencia` (antes/después sin tocar dev).
- `limpiar` borra el antro, sus filas en todas las tablas con `club_id` o con
  llave a sus reservas o a sus cuentas, los perfiles, las cuentas de Auth y
  sus intentos de login. La caja no deja borrar (`caja_sin_borrar`): se borra
  como `postgres` con `antroapp.borrado_pruebas = 'on'`, igual que las demás
  pruebas.
- Las medidas quedan en `screenshots-carga-noche/` (ignorada por Git):
  `medidas-<etiqueta>.json`, `ensayo-*.json`, `estadisticas-*.json`,
  `explicar-*.txt` (planes completos), `cierre.json` y una captura por pantalla.

## Por qué estas 10 pantallas

Son las que se usan **durante** la noche o justo al cerrarla, y las que leen
más filas de la noche o del historial:

| # | Pantalla | Quién | Por qué |
|---|---|---|---|
| 1 | Puerta / panel de staff (`/staff/panel`) | staff | La usa la puerta toda la noche; lee las 500 reservas de la noche. |
| 2 | Caja: mapa de mesas (`/staff/caja`) | staff | Lee toda la caja de la noche (grupos, cuentas, consumos, cobros, cuadres). |
| 3 | Caja: abrir una mesa | staff | La acción más repetida; se mide la mesa con más consumos. |
| 4 | Caja: cuadre de la noche | gerente | El cierre de la noche en la caja. |
| 5 | Panel del RP (`/rp/panel`, reservas) | RP | Lo abren los 15 RPs durante la noche (`rp_mis_reservas`, cuota). |
| 6 | Nómina de la semana (`/staff/nomina`) | gerente | Cierre de la semana (`nomina_semana`). |
| 7 | Números del antro (`/grupo`) | dueño | `grupo_resumen` sobre la semana. |
| 8 | Cierre de la noche (`/grupo/noche`) | dueño | `reporte_cierre_noche`, el reporte del cierre. |
| 9 | Panel del dueño (`/dueno/panel`) | dueño | Mesas (60), personal (23), fotos, reglas. |
| 10 | Panel del admin (`/admin`) | admin | Lee reservas y comisiones de 30 días de **todos** los antros. |

Quedaron fuera las pantallas detrás de banderas apagadas (clientes y lista
negra, revisión de RPs, POS, reportes PDF, inventario): no se encendieron
banderas. Las exportaciones CSV se midieron como funciones (sección
«Cierres»).

**Cómo se mide**: Chromium de Playwright a 390×844 (móvil, táctil), CPU 4×
más lenta por CDP, una sesión por rol (login por la pantalla). Cada pantalla
se abre 11 veces: la primera calienta y no cuenta; p50/p95 de las otras 10
(con 10 muestras el p95 es prácticamente el máximo). «Listo» = aparece lo que
el usuario necesita para trabajar (p. ej. el botón «Mesa 60» o el texto
«Estado de la noche»); «con datos» = además terminó la última consulta a
Supabase (800 ms sin peticiones). Las pantallas 3 y 4 se miden desde el toque
(ya con la caja cargada).

## Tiempos de las pantallas

Con los 7 operando a la vez. «Antes» = esquema actual; «con propuesta» =
`10-indices-carga.sql` aplicado en dev. Entre corridas la noche crece
(~1,100 consumos por corrida), por eso se anota el volumen.

| Pantalla | Antes (1,189 consumos) | Con propuesta (2,252) | Antes (3,372) | Antes (4,620) | Consultas · KB |
|---|---|---|---|---|---|
| 1. Puerta | 1,464 / 2,266 | 1,429 / 1,778 | 1,441 / 1,716 | 1,491 / 1,793 | 11 · 66–71 |
| 2. Caja, mapa | 1,567 / 1,712 | 2,044 / 2,222 | 2,565 / 2,631 | **2,671 / 3,130** | 16 → 20 · **195 → 386 → 583 → 789** |
| 3. Caja, abrir mesa | 114 / 191 | 112 / 136 | 111 / 193 | 195 / 292 | 0 |
| 4. Cuadre de la noche | 146 / 177 | 146 / 163 | 127 / 158 | 149 / 189 | 0 |
| 5. Panel del RP | 1,092 / 1,308 | 1,011 / 1,053 | 1,026 / 1,103 | 1,019 / 1,099 | 7 · 22 |
| 6. Nómina | 1,128 / 1,380 | 1,032 / 1,080 | 1,019 / 1,078 | 1,037 / 1,049 | 4 · 5 |
| 7. /grupo | 505 / 855 (datos 666 / 1,164) | 487 / 558 (681 / 762) | 481 / 533 (639 / 717) | 490 / 539 (657 / 745) | 6 · 6 |
| 8. Cierre de la noche | 1,030 / 1,146 | 1,015 / 1,062 | 1,004 / 1,014 | 1,007 / 1,048 | 4 · 6 |
| 9. Panel del dueño | 1,026 / 1,212 (datos 1,026 / 1,482) | 1,016 / 1,176 | 1,000 / 1,059 (datos 1,000 / 1,106) | 1,020 / 1,107 (datos 1,020 / 1,479) | 21 · 23 |
| 10. Panel del admin | 570 / 995 (datos 1,091 / 1,201) | 505 / 1,022 (datos 719 / 1,022) | 551 / 631 (datos 949 / 1,062) | 538 / 644 (datos 990 / 1,102) | 10 · 35 |

Milisegundos, «listo» p50 / p95 (entre paréntesis «con datos» cuando es
distinto). La noche de 1,189–2,252 consumos es la más parecida a una noche
grande real (~1,500); las de 3,372 y 4,620 sirven para ver hacia dónde crece.

Lectura honesta: **a nivel pantalla la propuesta casi no se nota con este
volumen** (lo que ahorra en la base son 15–200 ms de pantallas de ~1 s donde
manda el CPU del teléfono y la red); donde se nota es en el admin («con
datos» 1,091 → 719 ms) y en la base (siguiente sección). La caja es la única
pantalla que empeora con la noche, con o sin propuesta.

**Ruido**: la máquina que mide (16 núcleos) estuvo en 37–40 % de CPU en
promedio (picos de 47–75 %) porque otros agentes compilaban `next dev` en los
puertos 3001/3003 durante las corridas, y antroapp-dev la comparten otras
pruebas. La CPU 4× de Playwright es relativa a esta máquina. Las tres
corridas tuvieron el mismo ruido (37–40 %), así que son comparables entre sí,
pero no son tiempos de un teléfono real.

**Caja abierta 60 s** (teléfono del staff, CPU 4×, con los 7 operando y
4,620 consumos en la noche): **108 consultas y 5,537 KB** en un minuto, 5
tareas largas del navegador (la más larga 137 ms, 597 ms en total). Ver
hallazgo 1.

## Latencia de la API con 7 operando (por llamada)

Corrida «antes» (271 s, 12.4 llamadas/s, 139 mesas rotadas); las otras dos
corridas dan lo mismo ±5 ms.

| Función | n | p50 | p95 | máx |
|---|---|---|---|---|
| caja_registrar_consumo | 1,063 | 90 ms | 117 ms | 431 ms |
| caja_registrar_pago | 306 | 92 ms | 118 ms | 289 ms |
| caja_anular_consumo | 241 | 91 ms | 116 ms | 174 ms |
| caja_anular_pago | 76 | 91 ms | 140 ms | 272 ms |
| puerta_escanear | 134 | 91 ms | 120 ms | 186 ms |
| puerta_confirmar_entrada | 134 | 90 ms | 116 ms | 331 ms |
| caja_sentar_cliente | 232 | 92 ms | 116 ms | 180 ms |
| caja_abrir_mesa | 139 | 91 ms | 117 ms | 143 ms |
| caja_cerrar_mesa | 139 | 91 ms | 128 ms | 252 ms |
| caja_cuadrar_mesa | 139 | 94 ms | 120 ms | 151 ms |
| caja_firma_noche | 371 | 94 ms | 132 ms | 301 ms |
| reporte_cierre_noche | 261 | 112 ms | 155 ms | 441 ms |
| nomina_semana | 122 | 92 ms | 117 ms | 171 ms |

La ida y vuelta de la red a Supabase es ~64 ms (lo que tarda un `select`
vacío desde esta máquina), así que la base pone 25–50 ms. Al armar la noche
(sin calentar), `caja_cuadrar_mesa` tuvo un p95 de 1,061 ms en 60 llamadas;
no se repitió en ninguna de las 470 llamadas siguientes (p95 118–121 ms).

## Cierres

**Ensayo** (`ensayo`): como el gerente, directo en la base (rol
`authenticated` con sus claims y `statement_timeout` de 8 s, como en
Supabase), dentro de una transacción que al final se deshace, sobre la noche
con 2,252 consumos (antes) y 3,372 (con propuesta; cada medición de pantallas
agrega ~1,100). Incluye ~64 ms de red por
llamada.

| Cierre | Antes p50 / p95 | Con propuesta p50 / p95 |
|---|---|---|
| Cobrar el saldo de una mesa (52) | 64 / 69 ms | 65 / 71 ms |
| Cerrar mesa (60) | 64 / 67 ms | 65 / 68 ms |
| Cuadrar mesa (60, genera comisiones) | 65 / 72 ms | 66 / 69 ms |
| Cerrar la noche | 66 ms | 69 ms |
| Reporte de cierre de la noche | 92 / 200 ms | 96 / 107 ms |
| Nómina de la semana | 66 / 69 ms | 68 / 72 ms |
| /grupo semana · mes (dueño) | 76 · 135 ms | 76 · 142 ms |
| Rendimiento por RP (semana) | 72 ms | 75 ms |
| Panel RP: mis reservas del mes | 79 / 261 ms | 86 / 261 ms |
| Exportar consumos de la noche (1,000 filas) | 112 / 221 ms | 112 / 230 ms |
| Exportar reservas de la noche · comisiones del mes | 88 · 109 ms | 88 · 110 ms |

La propuesta no cambia los cierres: esas funciones son `SECURITY DEFINER`
(corren como `postgres`, que se salta RLS) y no usan el índice nuevo.

**Cierre real** (`cierre`): por la API, como los 3 gerentes en paralelo,
sobre la noche final (6,265 consumos, 897 anulados; 1,704 cobros, 342
anulados; 824 grupos en 60 mesas; 1,106 cuentas; 498 entradas; 288
comisiones por $55,233.60). Incluye la red (~88 ms por llamada por la API).
La cantidad de anulaciones es alta a propósito (los gerentes de la prueba
anulan seguido).

| Cierre | n | p50 | p95 |
|---|---|---|---|
| Cobrar el saldo de la mesa | 51 | 89 ms | 206 ms |
| Cerrar mesa | 60 | 88 ms | 99 ms |
| Cuadrar mesa (genera comisiones) | 60 | 88 ms | 97 ms |
| Cerrar la noche | 1 | 94 ms | — |
| Reporte de cierre de la noche | 5 | 148 ms | 189 ms |
| Nómina de la semana | 5 | 93 ms | 94 ms |
| /grupo de la semana (dueño) | 5 | 107 ms | 237 ms |
| Exportar consumos de la noche (1,000 filas) | 5 | 257 ms | 271 ms |

## Cuadre

`scripts/verificar-cuadre.mjs --club=<antro> --desde=<noche> --hasta=<noche>`
después del cierre real: **6,662 revisiones, sin diferencias**. Cubre 824
mesas cuadradas, la noche cerrada, 1,106 cuentas liquidadas, 288 comisiones
(una por cuenta de RP con consumo, con el monto de su regla o 0 por la
cuota), la nómina de la semana, `/grupo` y el rendimiento de los 15 RPs, el
panel de los 15 RPs (428 reservas) y el reporte de cierre. Caja, cuadres,
comisiones, nómina, `/grupo` y panel del RP coinciden al centavo.

Un error de la prueba, no de la app: el script calculó el «contado» del
cierre con una lectura de PostgREST, que corta en 1,000 filas, y la noche
tenía 1,362 cobros vigentes. El cuadre de la noche quedó con una diferencia
de −$1,393,606 en lugar de los −$500 que se querían simular. La base calculó
bien lo cobrado (igual a la suma en SQL) y `diferencia = contado − cobrado`
se cumple. El script ya suma en SQL (y lee la caja en SQL), pero esa
corrección no se volvió a probar con un cierre real (el escenario ya estaba
cerrado y se limpió). La caja de la app no tiene ese problema: lee por
páginas (`todas()` en `app/staff/caja/page.tsx`).

## Cuellos de botella (con evidencia)

Ordenados por gravedad.

### 1. La caja baja toda la noche en cada revisión (teléfono y red)

`/staff/caja` lee todos los grupos, cuentas, consumos, cobros y cuadres de la
noche (paginado de 1,000 en 1,000, en serie) y los vuelve a leer completos en
la revisión periódica cada 10 s **si la firma de la noche cambió**. Con 7
personas operando, la firma cambia siempre.

- Carga de la pantalla: 1.57 s / 195 KB (1,189 consumos) → 2.04 s / 386 KB
  (2,252) → 2.57 s / 583 KB (3,372): ~0.45 s y ~170 KB más por cada 1,000
  movimientos, a CPU 4×.
- Revisión periódica: con la caja abierta 60 s y la noche en movimiento, el
  teléfono hizo **108 consultas y bajó 5,537 KB** (6 revisiones de ~18
  consultas: firma + toda la noche paginada). Son **~330 MB por hora por
  teléfono** con datos móviles, y lo mismo multiplicado por cada teléfono con
  la caja abierta como transferencia de Supabase (egress). La carga además
  gana ~0.3 s de CPU por revisión (5 tareas largas por minuto, hasta 137 ms:
  la pantalla se traba un instante cada 10 s).

No es la base: las consultas de la caja tardan 3–4 ms (`EXPLAIN`, consumos de
la noche, 102–144 bloques). Es transferencia y trabajo de React en el
teléfono. Una noche de un club grande real (1,500–2,500 consumos) queda en
~2 s por carga; no rompe nada, pero con datos móviles flojos y con la noche
larga empeora. **Propuesta (no implementada, para decidir)**: que la revisión
pida solo lo nuevo desde la última lectura (consumos/cobros con
`registrado_en` o `anulado_en` posterior) en lugar de toda la noche, o
alargar el intervalo cuando no hay cambios en la mesa abierta. Es cambio de
código de la caja, fuera del alcance de este bloque.

### 2. Políticas de RLS que se evalúan por fila (base)

`pg_stat_statements` con `track = 'all'` (modo `estadisticas`): en 5 vueltas
de las consultas de las pantallas, **136,911 llamadas** a
`select role from profiles where id = auth.uid() …` (el cuerpo de
`current_role_name()`), una por fila revisada. Las políticas:

| Política | Expresión hoy |
|---|---|
| `reservations_select_admin` | `current_role_name() = 'admin'` |
| `reservations_select_club_staff` | `current_role_name() = any(…) and club_id = current_club_id()` |
| `reservations_select_cliente_own` | `cliente_id = auth.uid()` |
| `commissions_select_club_staff` | `exists (… current_role_name() … current_club_id() …)` |
| `commissions_select_rp_own` | `rp_id = auth.uid()` |
| `consumption_entries_select_club_staff` | igual que la de comisiones |

Las demás tablas del proyecto ya usan `(select current_role_name())`, que
Postgres calcula una vez por consulta (InitPlan). Estas seis son iguales en
producción (comparadas por catálogo, solo lectura, el 28/11/2026).

`EXPLAIN (ANALYZE, BUFFERS)` como cada rol (modo `explicar`; planes completos
en `screenshots-carga-noche/explicar-*.txt`). «Hoy» con 2,252 consumos en la
noche y «con propuesta» con 3,372 (aplicada en dev); las 500 reservas de la
noche y la historia son las mismas. Las columnas de «1 año más» son las dos
sobre los mismos datos, con la propuesta aplicada solo dentro de la
transacción (`--con`).

| Consulta (como la manda la app) | Hoy | Con propuesta | Hoy, con 1 año más | Con propuesta, 1 año más |
|---|---|---|---|---|
| Puerta: reservas de la noche (staff) | 20.2 ms · 3,041 bloques | 1.5 ms · 46 | 20.2 ms · 3,041 | 1.6 ms · 48 |
| Caja: reservas con entrada (staff) | 18.1 ms · 2,645 | 1.7 ms · 46 | 18.3 ms · 2,645 | 1.7 ms · 48 |
| Admin: reservas de 30 días | 203.9 ms · 26,911 | 3.5 ms · 275 | 206.9 ms · 28,150 | 5.6 ms · 1,633 |
| Admin: reservas usadas + consumos (alertas) | 166.8 ms · 24,586 | 9.3 ms · 275 | 167.2 ms · 25,825 | 15.0 ms · 6,496 |
| Admin: comisiones de 30 días | 221.0 ms · 41,235 | 7.6 ms · 350 | 232.8 ms · 42,341 | 14.8 ms · 14,904 (23.8 ms sin el índice) |
| Gerente: comisiones de la semana | 41.9 ms · 8,200 | 4.7 ms · 2,954 | 42.6 ms · 8,700 | 5.2 ms · 2,791 |
| Cuadrar: conteo semanal de comisiones del RP | 0.4 ms | 0.4 ms | 1.8 ms | 2.0 ms |
| Firma de la noche (staff) | 4.3 ms | 4.9 ms | 4.7 ms | 4.5 ms |

(«1 año más» = 156,660 reservas y 80,830 comisiones en la base, solo dentro
de la transacción.) El costo de hoy es ~30 µs por reserva y ~65 µs por
comisión que entra en la ventana, sumando todos los antros en el caso del
admin: con unas 120,000 comisiones o 260,000 reservas en 30 días (unos
35–40 antros como este, que hace ~3,400 comisiones y 6,500 reservas al
mes) la consulta del admin pasaría de 8 s y Supabase la cortaría
(`statement_timeout`). Para la puerta y la caja el costo es por noche de un
antro (20 ms con 500 reservas), molesto pero no peligroso.

Ojo con una variante que **no** sirve: envolver solo las funciones y dejar
`auth.uid()` suelto en `commissions_select_rp_own` y
`reservations_select_cliente_own` hizo que el planificador convirtiera el
`EXISTS` de comisiones en un recorrido de TODAS las reservas (admin: 315 ms,
peor que hoy). Por eso la propuesta envuelve las seis.

### 3. Lo que no es cuello (medido)

- **Funciones de caja, puerta, cierre, nómina, /grupo y reportes**: 2–40 ms
  dentro de la base. La más pesada es `grupo_resumen` de un mes: 67–87 ms y
  ~60,000–80,000 bloques (dos `EXISTS` por reserva contra cuentas y
  consumos); crece con las reservas del rango, aceptable hoy. Si un grupo
  pide 3 meses (el máximo es 93 días) serían ~250 ms.
- **`rp_mis_reservas`** dio 64 ms en dos corridas y 6–11 ms en otras seis
  (incluida la del año extra); repetida 4 veces en la misma sesión: 6–11 ms.
  Su consulta interna, aislada, 6 ms con buen plan (`reservations_rp_fecha`).
  Lo atribuyo al ruido de dev compartida, no se pudo reproducir.
- **Índices de caja**: todas las lecturas de caja usan sus índices
  (`caja_consumos_noche`, `_cuenta`, `_sesion`, `mesa_cuentas_sesion`,
  `mesa_cuentas_reserva_unica`). El conteo semanal de comisiones al cuadrar
  usa `commissions_rp_tipo` + `reservations_pkey` (0.4–2 ms).
- **Un índice que se probó y se descartó**: `reservations (fecha)` para las
  reservas de 30 días del admin. El plan no lo usa (va por
  `reservations_club_fecha`), así que no entra en la propuesta.

## Propuesta (sin aplicar en producción)

Archivos:

- `sql/post-junta-4/10-indices-carga.sql` — dev, en una transacción.
- `sql/post-junta-4/10-indices-carga-rollback.sql` — deja las 6 políticas
  con su texto exacto de hoy y borra el índice.
- `sql/post-junta-4/10-indices-carga-prod.sql` — producción: paso 1 las
  políticas (un bloque `begin … commit`), paso 2 el índice con
  `create index concurrently` (sola).
- `sql/post-junta-4/10-indices-carga-prod-rollback.sql`.

Qué hace:

1. Las seis políticas pasan a `(select public.current_role_name())`,
   `(select public.current_club_id())` y `(select auth.uid())`. `ALTER POLICY`:
   mismo nombre, tipo, comando y roles; solo cambia `USING`.
2. `create index commissions_created_at on public.commissions (created_at)`
   para las comisiones de 30 días del admin.

Pruebas en dev:

- **Mismo resultado para cada sesión** (modo `equivalencia`): 63/63
  combinaciones sesión × tabla ven exactamente las mismas filas (huella md5
  de los ids) antes y después: dueño, admin, gerente, staff, 2 RPs del antro
  de carga; los 11 usuarios ficticios de dev (dueños, gerentes y staff de dos
  antros, RPs, cliente, admin); un cliente con reservas propias; una cuenta
  sin perfil; una con contraseña temporal; y anon. Con consumos viejos
  (`consumption_entries`) en dos antros, agregados solo para la prueba.
- Aplicado en dev con `aplicar-dev.mjs`, medido (pantallas, ensayo y
  EXPLAIN) y deshecho con el rollback. **Esquema de dev idéntico** antes de
  aplicar y después del rollback (`extraer-esquema.mjs --origen=dev`, diff
  vacío).

Riesgos:

- Cambiar una política mal escrita puede abrir o cerrar datos. Mitigado:
  mismas expresiones con la llamada envuelta, prueba de equivalencia por
  sesión y el rollback con el texto exacto de hoy (comparado con producción).
  Antes de correrlo en producción, confirmar que las 6 políticas siguen igual
  (consulta en la cabecera del archivo de producción).
- `ALTER POLICY` toma un candado breve sobre la tabla (instantáneo). El
  índice con `CONCURRENTLY` no bloquea escrituras, pero si falla deja un
  índice INVALID: borrarlo y repetir. Mejor fuera de horario.
- El índice suma una escritura por comisión (una por cuenta cuadrada):
  despreciable.
- Va como SQL aparte en un pase, con su rollback; no depende de código nuevo.

## Qué no se midió

- **Teléfonos reales ni red celular**: Chromium de escritorio con CPU 4× y la
  red de la oficina (Supabase a ~64 ms). Una red 4G floja suma latencia por
  consulta y pega más a la caja (16–18 consultas y hasta 583 KB por carga).
  `probar-carga-caja.mjs` ya mide la caja con 4G lento emulado.
- **Más de un antro ocupado a la vez**: la carga es de un solo antro. El
  admin y `/grupo` se midieron con un solo antro grande; el riesgo del admin
  crece con el número de antros (hallazgo 2).
- **El plan de Supabase de producción**: dev y producción pueden tener
  distinta capacidad (CPU, conexiones del pooler). No se midió el límite de
  conexiones con decenas de teléfonos.
- **Realtime, Storage (fotos), login masivo** (el login tiene límite por IP)
  y el arranque en frío de Vercel.
- **Las 500 reservas de hoy** no pasaron por la pantalla de reservar ni por
  el panel del RP (se insertaron con la service role); la puerta, la caja y
  los cierres sí usaron las funciones reales con la sesión de cada rol.
- **Pantallas detrás de banderas** (apagadas a propósito).

## Limpieza

Al terminar (28/11/2026): `limpiar` borró el antro de prueba y todo lo suyo.
Revisado después: 0 filas con su `club_id` en las 56 tablas que tienen esa
columna, 0 cuentas `carga_*` en Auth, 0 perfiles, 0 antros «Club Carga
Dev», 0 reservas de prueba. El esquema de dev quedó idéntico al de antes de
aplicar la propuesta (`extraer-esquema.mjs --origen=dev`, diff vacío, antes
y después de limpiar). No se tocaron banderas (`club_funciones`,
`grupo_funciones`, `plataforma_banderas`). Las capturas y medidas siguen en
`screenshots-carga-noche/` (ignorada por Git); el `estado.json` con la
contraseña temporal se borró.
