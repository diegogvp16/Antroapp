# Caja por mesa y cuadre de la noche — diseño

> Estado (20/11/2026): **SQL aplicado y probado en antroapp-dev**, no en
> producción. Archivos: `sql/2026-11-20-caja-por-mesa.sql`,
> `sql/2026-11-20-caja-candado-puerta.sql` (bloque 21, va después del código
> nuevo), `sql/2026-11-20-cover.sql`, cada uno con su `-rollback.sql`
> (probados: dejan el esquema idéntico al de producción). Pruebas por rol con
> sesiones reales: `node scripts/dev/probar-caja.mjs`. Diseño original del
> 12/11/2026; las decisiones abiertas siguen en la sección 9.
>
> **Cambios por la revisión adversarial del 20/11** (cuatro revisores, cada
> hallazgo reproducido en dev):
> - Reserva de RP solo en su antro, desde la noche en curso, naciendo
>   `pendiente` y limpia (antes podía meter reservas en cualquier antro y
>   cobrar comisión ahí). La cuenta solo toma un RP que sea de ese antro.
> - Origen, RP, antro, cliente, fecha y QR de una reserva ya no se cambian
>   desde el navegador (el staff podía volver "de RP" una orgánica).
> - `profiles.activo`: nadie se reactiva solo; el staff solo da de baja RPs.
> - "Nada se borra" también para service_role/postgres: transiciones de
>   estado válidas (una noche cerrada o una mesa cuadrada no se reabren) e
>   INSERT coherente (nada entra a una noche cerrada ni con ids cruzados).
> - Desbloqueo semanal sin comisiones anuladas y con candado por RP y semana.
> - Reservas "desde la noche en curso" (corte 08:00): a la 1:00 a. m. se
>   puede reservar para la noche que la puerta acepta.
> - El bloque 21 (candado de puerta) va en su propio archivo, después del
>   código nuevo.
> - La bitácora de pagos de nómina no la ve el staff.
> - `registrar_comision_reserva` vieja ya no crea comisiones fuera de la
>   caja (`sql/2026-11-20-estabilidad.sql`, bloque 5).

## 1. Qué hay hoy y qué se reutiliza

| Pieza actual | Qué hace hoy | En el diseño nuevo |
|---|---|---|
| `club_tables` (id, club_id, numero, capacidad) | Catálogo de mesas del antro (lo administra el dueño). | **Se reutiliza tal cual.** Es el catálogo; el estado de la mesa en la noche vive en tablas nuevas. |
| `reservations.mesa_id` | "Asignar mesa": una reserva → una mesa. | Se sigue llenando por compatibilidad, pero la fuente de verdad pasa a ser `mesa_cuentas`. |
| `reservations.status = 'usada'` (check-in por QR) | Marca que el cliente llegó. Hoy lo pone el navegador con un `UPDATE` directo. | **Se reutiliza** con el mismo significado, pero solo lo pone la función `puerta_confirmar_entrada` (sección 12). Solo una reserva con entrada confirmada se puede sentar en una mesa. |
| `reservations.se_retiro_sin_consumir` | Marca de "se fue sin consumir". | Se reutiliza sin cambios; la base solo deja marcarla a quien entró. |
| `consumption_entries` (reservation_id, monto) | Cargos sueltos por reserva, en pesos, **sin quién ni cuándo, sin mesa, sin método de pago, borrables**. | **Se reemplaza** por `caja_consumos`. Queda de solo lectura para la historia. El tablero de "Alertas de reporte" del admin tiene que pasar a leer `caja_consumos`. |
| `commissions` (reservation_id único, rp_id, tipo, monto, status) | Comisión de RP (y el bono de plataforma, que ya no aplica). | **Se reutiliza** como destino, solo `tipo = 'rp'`. Lo que cambia es **quién y cuándo** la calcula: una función de la base, al cuadrar la mesa, con el consumo real de la caja. Se le agregan `pagada_en` y `pagada_por`. |
| `rp_comision_overrides`, `clubs.comision_*`, `clubs.pago_rp_modo` | Reglas de pago de RP, configurables por antro. | **Se reutilizan sin rediseñar**: la caja solo las lee. |
| `clubs.bono_organica_*` | Bono a la plataforma por reserva orgánica. | **No hay bono por cliente nuevo.** Las columnas se quedan (no se borran) pero no se usan ni se muestran. |
| `registrar_comision_reserva()` + bono calculado en el navegador | Comisión con el primer cargo, con consumo y semana mandados por el navegador. | **Se jubilan** cuando la caja entre en uso (pendiente 1 del CLAUDE.md resuelto por este diseño; el 2, bono, ya no aplica). |
| `rp_pagos_dia` | Pago por día de asistencia (modo `dia`). | Se reutiliza tal cual; entra en el reporte de nómina. Se le agregan `pagada_en` y `pagada_por`. |
| Pestaña Nómina de `/rp/panel` | Suma la semana del RP. | Ver sección 13: se reutiliza su lógica, cambia de dónde salen los números. |
| `current_role_name()`, `current_club_id()` | Helpers de RLS. | Se reutilizan dentro de dos helpers nuevos: `caja_puede_ver()` y `caja_tiene_permiso()`. |

Lo que hay que **crear**: la noche operativa, la sesión de mesa, la cuenta
por cliente, los consumos con auditoría, los pagos con método, los cuadres,
los permisos por casilla y la bitácora de eventos.

## 2. Modelo de datos

Todo el dinero nuevo va en **centavos (`bigint`)**. `commissions.monto` sigue
en pesos (`numeric`); la función convierte al escribir.

```
clubs ─┬─ club_tables (catálogo)
       │
       └─ caja_noches (1 por club y fecha operativa)
              │
              └─ mesa_sesiones (una mesa abierta en esa noche; puede haber
                 │               varias seguidas para la misma mesa)
                 │
                 ├─ mesa_cuentas (1 por cliente/grupo sentado: reserva o walk-in,
                 │   │            con el RP que lo trajo)
                 │   └─ caja_consumos (cargos; nunca se borran, se anulan)
                 │
                 ├─ caja_pagos (efectivo / tarjeta / otro; por cuenta o de la mesa)
                 └─ caja_cuadres (tipo 'mesa')

caja_noches ── caja_cuadres (tipo 'noche', con el conteo físico)
caja_permisos (casillas por rol o por usuario, por club)
caja_eventos  (bitácora: aperturas, anulaciones, reaperturas, cierres)
```

### Tablas

- **`caja_noches`**: `club_id`, `fecha_operacion` (date), `estado`
  (`abierta | cerrada`). Única por `(club_id, fecha_operacion)`. Se crea sola
  al abrir la primera mesa de la noche.
  - **Fecha operativa**: la noche pertenece al día en que empieza. Se calcula
    en la base con `club_fecha_operacion(club)`, en la **zona horaria del
    antro** (`clubs.zona_horaria`, sección 10) y con un corte a las 08:00
    locales: lo que pasa entre las 00:00 y las 07:59 cuenta para el día
    anterior.
- **`mesa_sesiones`**: `club_id`, `noche_id`, `mesa_id`, `estado`
  (`abierta | cerrada | cuadrada`), quién y cuándo abrió, cerró y cuadró.
  Índice único: **una sola sesión abierta por mesa** a la vez. Una mesa puede
  tener varias sesiones en la misma noche (se libera y llega otro grupo).
- **`mesa_cuentas`**: `sesion_id`, `reservation_id` (opcional, único: una
  reserva solo se sienta en una cuenta), `rp_id` (copiado de la reserva por la
  base, nunca del navegador), `origen` (`reserva | walk_in`),
  `cliente_nombre`, `personas`, `liquidada_en`. **Una mesa tiene N cuentas**:
  así varios clientes distintos, cada uno con su RP, comparten mesa.
- **`caja_consumos`**: `cuenta_id` + copia de `club_id`, `noche_id`,
  `sesion_id`, `mesa_id`, `reservation_id` y `rp_id` (los pone la base: el
  consumo queda ligado a mesa, cliente y RP aunque algo cambie después),
  `monto_centavos`, `concepto`, `registrado_por`, `registrado_en`,
  `anulado`, `anulado_por`, `anulado_en`, `motivo_anulacion`.
  **No hay DELETE**: un error se anula con motivo y queda en la bitácora.
- **`caja_pagos`**: `sesion_id`, `cuenta_id` (opcional: nulo = pago de la mesa
  completa), `metodo` (`efectivo | tarjeta | otro`), `monto_centavos`,
  `referencia`, quién y cuándo, y anulación igual que los consumos.
- **`caja_cuadres`**: `tipo` (`mesa | noche`), `sesion_id` o `noche_id`, y los
  montos **calculados por la base**: registrado (consumos vigentes), cobrado
  por método, saldo sin cobrar. En el de la noche, además, el **conteo
  físico** que captura el gerente (efectivo, tarjeta, otro) y la diferencia.
  Uno por mesa-sesión y uno por noche.
- **`caja_permisos`**: `club_id`, `permiso`, y **o** `rol` (`staff | gerente`)
  **o** `profile_id`, `permitido` (bool). La casilla por usuario gana a la del
  rol; si no hay ninguna, aplica el valor por defecto (sección 4).
- **`caja_eventos`**: bitácora de solo inserción (lo escriben las funciones):
  `tipo`, `detalle` (jsonb), quién y cuándo.

## 3. Estados de una mesa

`libre` **no se guarda**: una mesa está libre en la noche si no tiene una
sesión `abierta`. Guardarlo sería tener dos fuentes de verdad.

```
          abrir_mesa                 cerrar_mesa               cuadrar_mesa
 libre ─────────────────> abierta ──────────────────> cerrada ──────────────> cuadrada
   ^                       │  ^                         │                      (final)
   │                       │  └──── reabrir_mesa ───────┘
   └── (al cuadrar, la mesa queda libre para otra sesión)
```

| Estado | Se puede | No se puede |
|---|---|---|
| **abierta** | sentar clientes (cuentas), registrar consumos, cobrar, anular | — |
| **cerrada** | cuadrar; reabrir (con permiso y motivo) | consumos nuevos, cobros nuevos |
| **cuadrada** | nada: es definitiva; aquí nacen las comisiones | todo lo demás |

Reglas que hace cumplir la base:
- **Cerrar** exige saldo cero: pagos vigentes = consumos vigentes de la sesión.
- **Cuadrar** exige que esté cerrada.
- **Cerrar la noche** exige que todas las sesiones de la noche estén
  cuadradas. Una noche cerrada bloquea todo lo de esa fecha.
- Para que la mesa reciba a otro grupo hay que cerrar la sesión; al estar
  cerrada o cuadrada ya no cuenta como abierta y se puede abrir otra.

## 4. Permisos (casillas)

| Permiso | Qué deja hacer | Staff (defecto) | Gerente (defecto) |
|---|---|---|---|
| `puerta` | Escanear el QR y "Confirmar entrada" | ✅ | ✅ |
| `abrir_mesa` | Abrir mesa y sentar clientes | ✅ | ✅ |
| `registrar_consumo` | Agregar cargos | ✅ | ✅ |
| `cobrar` | Registrar pagos | ✅ | ✅ |
| `cerrar_mesa` | Cerrar la sesión (saldo cero) | ✅ | ✅ |
| `reabrir_mesa` | Reabrir una mesa cerrada | ❌ | ✅ |
| `anular` | Anular un consumo o un pago (con motivo) | ❌ | ✅ |
| `cuadrar_mesa` | Hacer el cuadre de una mesa | ❌ | ✅ |
| `cerrar_noche` | Cuadre general y cierre de la noche | ❌ | ✅ |

- **Dueño del club y admin** tienen todos los permisos siempre.
- **Regla fija, que no es casilla** (`es_gerente_o_dueno`): ver la nómina y
  marcarla pagada. Solo gerente, dueño o admin; no se le puede dar al staff.
- **RP y cliente**: ninguno. No ven la caja.
- Las casillas se guardan por club, para un rol entero o para una persona.
  Orden: casilla de la persona → casilla del rol → valor por defecto.
- Las cambian el **dueño** y el **admin** (`caja_configurar_permiso`).
- **Quién hace cumplir**: la base. Las tablas de caja **no tienen políticas
  de escritura** para nadie (más restrictivas `false` como candado); toda
  escritura pasa por funciones `SECURITY DEFINER` que llaman primero a
  `caja_tiene_permiso(club, permiso)`. La pantalla solo esconde botones.
- **Lectura**: `caja_puede_ver(club)` = admin, dueño del club, o staff/gerente
  de ese club. Política permisiva + restrictiva con la misma regla.
- **Cuenta de grupo**: el **dueño de grupo** lee la caja de todos los
  antros de su grupo (rama `club_es_dueno_grupo` dentro de `caja_puede_ver`)
  pero no la opera (decisión 13). Detalle en la sección 11.

## 5. Cómo se calcula la comisión del RP desde la caja

Se calcula **una sola vez por cuenta, al cuadrar la mesa**, dentro de la base
(`caja_liquidar_cuenta`, no se puede llamar desde el navegador):

1. **Base** = suma de `caja_consumos` vigentes (no anulados) **de esa cuenta**.
   No de la mesa: si tres clientes comparten mesa con tres RPs, cada RP cobra
   sobre lo que consumió su cliente.
2. Si la base es 0 → no hay comisión (igual que hoy: sin consumo no hay
   nada). Una reserva **sin entrada confirmada** nunca tiene cuenta: no
   genera comisión y tampoco cuenta para el desbloqueo. El RP no se
   penaliza.
3. Si la cuenta viene de una **reserva de RP** y el antro está en modo
   `reserva`:
   - Regla: `rp_comision_overrides` del RP si existe; si no, la del antro.
   - **Semana**: lunes a domingo de la `fecha_operacion` de la noche. Como
     esa fecha ya se calculó en la zona del antro, la semana también queda
     en su zona sin convertir nada más.
   - Posición = comisiones de RP de ese RP en ese club con reserva de esa
     semana + 1. Desbloqueo con la misma fórmula que la función actual.
   - Monto: fijo → el monto; porcentaje → `round(base × % / 100)`.
4. Si la cuenta viene de una **reserva orgánica** → nada (no hay bono de
   plataforma).
5. Modo `dia`: no hay comisión por reserva (el RP cobra por asistencia, como
   hoy). Walk-in sin reserva: no genera nada (ver decisión 4).
6. Se inserta en `commissions` con `on conflict (reservation_id) do nothing`:
   **idempotente**, aunque se reintente.
7. Se guarda `reservations.consumo_monto` con la base, por compatibilidad.

**Trazabilidad**: comisión → `reservation_id` → `mesa_cuentas` → sus
`caja_consumos` (con mesa, quién lo registró y cuándo). Ningún monto de la
comisión viene del navegador: el único dato que captura una persona es el
monto de cada cargo (y el conteo físico del cuadre), que es justo lo que se
audita.

## 6. Funciones (todas en la base)

| Función | Permiso | Qué hace |
|---|---|---|
| `caja_abrir_mesa(mesa)` | `abrir_mesa` | Crea la noche si no existe y abre la sesión. Falla si ya está abierta. |
| `caja_sentar_cliente(sesion, reserva?, nombre?, personas?)` | `abrir_mesa` | Crea la cuenta. Con reserva: debe ser del club, de esa noche y con check-in; el RP lo copia la base. Sin reserva: walk-in con nombre. |
| `caja_registrar_consumo(cuenta, centavos, concepto)` | `registrar_consumo` | Solo con la sesión abierta. Monto entre 1 centavo y $1,000,000. |
| `caja_registrar_pago(sesion, cuenta?, metodo, centavos, referencia)` | `cobrar` | Solo con la sesión abierta. |
| `caja_anular_consumo(id, motivo)` / `caja_anular_pago(id, motivo)` | `anular` | Solo con la sesión abierta. Deja bitácora. |
| `caja_cerrar_mesa(sesion)` | `cerrar_mesa` | Exige saldo cero. |
| `caja_reabrir_mesa(sesion, motivo)` | `reabrir_mesa` | Cerrada → abierta, si la mesa no tiene otra sesión abierta. |
| `caja_cuadrar_mesa(sesion, notas)` | `cuadrar_mesa` | Calcula el cuadre de la mesa, la marca cuadrada y liquida comisiones. |
| `caja_cerrar_noche(noche, efectivo, tarjeta, otro, notas)` | `cerrar_noche` | Exige todo cuadrado; calcula totales, guarda el conteo físico y la diferencia; cierra la noche. |
| `caja_configurar_permiso(club, permiso, rol?, persona?, permitido)` | dueño o admin | Guarda una casilla. |

## 7. Pantallas nuevas (staff/gerente), en orden de construcción

0. **Puerta** (reemplaza el escáner actual de `/staff/panel`): escanear →
   ficha del cliente (nombre, personas, RP) → botón **Confirmar entrada**.
   Si el antro no lo deja pasar, no se confirma y ya. Va primero: sin
   entrada confirmada no hay mesa, consumo ni comisión, y el candado del
   bloque 21 exige que el check-in pase por aquí.
1. **Mapa de mesas de la noche** (`/staff/caja`): cuadrícula de mesas con su
   estado (libre / abierta / cerrada / cuadrada), total consumido y saldo.
   Botón "Abrir mesa". Es la base de todo lo demás.
2. **Detalle de mesa abierta**: cuentas sentadas (cliente, RP, consumo de cada
   una), "Sentar cliente" (escanear QR o elegir reserva con check-in, o
   walk-in), "Agregar consumo" por cuenta, lista de cargos con su anulación.
3. **Cobro**: registrar pagos por cuenta o de la mesa, por método, con saldo
   en vivo, y "Cerrar mesa" cuando el saldo llega a cero.
4. **Cuadre de mesa** (gerente): resumen registrado vs cobrado por método,
   "Cuadrar", "Reabrir" con motivo.
5. **Cuadre general y cierre de la noche** (gerente): totales por método,
   captura del conteo físico, diferencia, mesas pendientes de cuadrar.
6. **Permisos de caja** (en `/dueno/panel`): matriz de casillas por rol y
   excepciones por persona.
7. **Historial de noches** (gerente y dueño): noches cerradas con su cuadre y
   bitácora de anulaciones y reaperturas.
8. **Nómina** (gerente y dueño): reporte por semana del año y por RP con
   totales y estado, exportable a CSV, y "Marcar semana pagada" por RP
   (sección 13).
9. **Migración del panel actual**: quitar "Asignar mesa" y "+ Agregar consumo"
   de `/staff/panel` (o redirigir a la caja), pasar las "Alertas de reporte"
   del admin a `caja_consumos`, y ocultar el bono de plataforma (sección 14).

Cada pantalla, según la skill de código limpio: server actions por feature
(`features/caja/actions.ts`) que solo llaman a las funciones de la base,
validación con zod, cálculos de presentación en `lib/domain/caja.ts` con
tests (Vitest), montos formateados con `Intl.NumberFormat('es-MX')`.

## 8. Seguridad (resumen)

- Escritura solo por funciones `SECURITY DEFINER` con `search_path = ''`,
  `revoke execute from public, anon` y `grant` solo a `authenticated`.
- La función interna `caja_liquidar_cuenta` no se puede llamar desde la API.
- Club, mesa, RP, reserva, noche, totales y comisiones los decide la base.
- RLS activado, sin políticas de escritura, más restrictivas de
  lectura (`caja_puede_ver`) y de escritura (`false`) como candado.
- Bloqueos `for update` en sesión y cuenta para que dos meseros no
  dejen la caja inconsistente al mismo tiempo.
- Nada se borra: consumos y pagos se anulan con motivo y quedan en la
  bitácora.
- Las funciones escriben porque corren como dueño de las tablas, que se
  salta RLS. **No activar `force row level security`** en estas tablas o las
  funciones también quedarían bloqueadas por los candados.
- Antes de aplicar, conviene una prueba con sesiones reales (como
  `scripts/probar-clubs-visibilidad.mjs`): cada rol contra cada función,
  casillas por persona y por rol, saldo cero al cerrar, mesa compartida con
  tres RPs y comisión por cuenta.

## 9. Decisiones abiertas (de Diego)

1. **Corte de la noche operativa**: propuesto a las 08:00 locales de cada
   antro, igual para todos. Si algún antro necesita otro corte, se agrega
   una columna y solo cambia `club_fecha_operacion`.
2. **Cobro por cliente o por mesa**: el diseño deja las dos (pago con o sin
   cuenta). ¿Se quiere obligar a cobrar por cliente?
3. **Cerrar con saldo pendiente**: propuesto que no se pueda (saldo cero). ¿Se
   necesita "cortesía" o "cuenta por cobrar" como método de pago?
4. **Walk-ins con RP**: un cliente sin reserva que dice venir con un RP, ¿le
   genera comisión a ese RP? El diseño hoy dice que no (el RP se toma solo de
   la reserva, para evitar atribuciones falsas).
5. **Cuándo nace la comisión**: propuesto al **cuadrar la mesa** (definitivo),
   no con el primer consumo como hoy. Así incluye todo el consumo de la noche.
6. **Desbloqueo semanal**: la fórmula actual paga desde la reserva número N
   (`(conteo + 1) < N` → 0), y el CLAUDE.md dice "las primeras N no generan
   comisión". Son distintas por una reserva. Se mantuvo la actual: ¿cuál es
   la correcta?
7. **Propinas**: ¿entran al cuadre? ¿Afectan la comisión? Hoy no se modelan.
8. **Quién configura casillas**: propuesto solo dueño y admin. ¿También el
   gerente?
9. **Cambio de mesa**: un cliente que se mueve de mesa a mitad de la noche.
   Hoy no está contemplado (se cerraría su cuenta y se abriría otra).
10. **Convivencia con el flujo actual**: ¿se apaga "Agregar consumo" de
    `/staff/panel` en cuanto exista la caja, o conviven un tiempo?
11. **Quién cambia la zona horaria**: propuesto solo el admin (trigger
    `clubs_candado_zona_horaria`); un antro que se auto-registra nace en
    `America/Mexico_City` y el admin la corrige al verificarlo. ¿O se le
    pregunta la ciudad al dueño en el registro?
12. **Un antro en un solo grupo**: propuesto que sí (`unique (club_id)` en
    `grupo_clubs`). ¿Puede un antro estar en dos grupos (por ejemplo, socios
    distintos)?
13. **Qué hace el dueño de grupo**: propuesto que **solo lea** (caja,
    cuadres, reportes) de todos sus antros, sin operar la caja ni configurar
    casillas. ¿Debe poder operar o configurar como el dueño de cada antro?
14. **Quién da de alta grupos**: propuesto solo el admin (no hay pantalla
    todavía; se haría desde el panel de admin).
15. **Reservar "esta noche" después de medianoche**: la reserva usa la fecha
    de calendario del antro; a la 1:00 a. m. ya no se puede reservar con la
    fecha de la noche en curso. ¿Se cambia a fecha operativa?
16. **Llegada tarde**: si el antro define `tolerancia_hora`, la base solo
    marca `llegada_tarde`; no cambia la comisión ni nada más. ¿Debe
    tener algún efecto, y cuál?
17. **Comisiones "validada"**: en la nómina cuentan como pendientes (solo hay
    pendiente y pagada). ¿Se elimina el estado `validada`?
18. **Quién marca la nómina pagada**: propuesto gerente, dueño y admin (no el
    dueño de grupo, que solo lee). ¿Se puede desmarcar un pago por error?
    Hoy no hay función para eso.

## 10. Zona horaria por antro

- **Columna nueva**: `clubs.zona_horaria` (texto IANA, por defecto
  `America/Mexico_City`). Un trigger valida que exista en
  `pg_timezone_names` y que solo el admin la cambie (bloque 1A).
- **En la base** todo pasa por `club_fecha_operacion(club, momento)`: noche
  operativa, corte de las 08:00 y, a partir de la fecha operativa, la semana
  de comisiones. Los reportes por noche se agrupan por `fecha_operacion`, que
  queda guardada en `caja_noches`: un grupo con antros en Tijuana y Cancún
  compara "la noche del viernes" de cada uno en su propia hora.
- **Políticas existentes con la zona de México fija**:
  `reservations_insert_anonimo` (reserva sin cuenta, "fecha de hoy en
  adelante"). El bloque 18 la pasa a la zona del antro.
- **Funciones existentes con semana del navegador**: `registrar_comision_reserva`
  y `registrar_pago_dia` (pendiente 1 del CLAUDE.md). Al reescribirlas, la
  semana debe salir de la zona del antro dentro de la base, igual que en
  `caja_liquidar_cuenta`.

### Cambios necesarios en el código actual (no hechos todavía)

`lib/fechas.ts` hoy tiene la zona fija (`ZONA_OPERACION`) en un
`Intl.DateTimeFormat` creado una sola vez. Habría que:

1. Recibir la zona como parámetro: `hoyEnZona(zona, ahora?)`,
   `semanaEnZona(zona, ahora?)`, `mesEnZona(zona, ahora?)`, y agregar
   `fechaOperacion(zona, ahora?)` con el mismo corte de 08:00 que la base.
   Los formateadores de `Intl` se guardan en un `Map` por zona (crearlos es
   caro).
2. Dejar `hoyMexico()`, `semanaMexico()` y `mesMexico()` como envolturas con
   la zona por defecto mientras se migran las pantallas, y borrarlas al final.
3. Agregar `zona_horaria` a la interfaz `Club` de `types/index.ts`.

`lib/turnos.ts` **no necesita la zona**: `diaSemanaDeISO` da el día de la
semana de una fecha de calendario y eso no depende de la zona. Lo que sí
depende es la fecha que le pasan sus llamadores. Cambio menor: reemplazar
`diaSemanaDeISO` por `diaSemanaISO` de `lib/fechas.ts` (son el mismo cálculo
duplicado; el de `turnos.ts` usa la zona del dispositivo, el de `fechas.ts`
no).

Llamadores a cambiar (todos ya tienen el club cargado o pueden traerlo):

| Archivo | Hoy usa | Debe usar |
|---|---|---|
| `app/staff/panel/page.tsx` (reservas del día, turnos, asistencia, semana para comisiones) | `hoyMexico()`, `semanaMexico()` | `fechaOperacion(club.zona_horaria)` y `semanaEnZona(club.zona_horaria)` |
| `app/rp/panel/page.tsx` (turnos, rendimiento semana/mes, mínimo del calendario) | `hoyMexico()`, `semanaMexico()`, `mesMexico()` | Las mismas con `club.zona_horaria` (agregar la columna al `select` del club) |
| `app/cliente/reservar/page.tsx` (fecha mínima) | `hoyMexico()` | `hoyEnZona(club.zona_horaria)` |
| `components/turno-recurrente-form.tsx` (fecha de inicio mínima) | `hoyMexico()` | Recibir la zona como prop desde el panel de staff |
| `lib/verificacion.ts` (formatea fechas de verificación) | `timeZone: "America/Mexico_City"` | La zona del antro al mostrarlas |
| `app/admin/page.tsx` (rangos "desde hace N días") | `toISOString().slice(0, 10)` (UTC, deuda 11) | Rango por antro con su zona, o agrupar por `fecha_operacion` |

**Hallazgo que ya afecta hoy, con cualquier zona**: `/staff/panel` usa
`hoyMexico()`, que es el día de **calendario**. Después de medianoche, el
panel pasa al día siguiente: deja de mostrar las reservas de la noche en
curso (que tienen la fecha del día anterior), los turnos que ve son los de
mañana y la asistencia del RP se guarda con la fecha de mañana. Con
`fechaOperacion()` (corte 08:00) se corrige. No se tocó: es cambio de
código y espera aprobación.

## 11. Cuenta de grupo

- **Tablas** (bloque 4B): `grupos`, `grupo_clubs` (qué antros tiene cada
  grupo, de cualquier ciudad) y `grupo_miembros` (quién y con qué rol de
  grupo; hoy solo `dueno_grupo`).
- **No es un rol en `profiles.role`**: es membresía. Así una persona puede ser
  dueña de un antro suelto y además dueña de un grupo, no hay que cambiar el
  trigger `profiles_no_escalar` y el login unificado no se toca. Cuando haya
  pantallas de grupo, el login revisa además si la persona está en
  `grupo_miembros`.
- **Escritura**: solo el admin. Lectura: el admin todo; cada miembro, sus
  grupos.
- **Cómo se extiende el acceso sin reescribir políticas**: todas las
  políticas de caja llaman a `caja_puede_ver(club_id)`; las funciones de
  escritura llaman a `caja_tiene_permiso(club, permiso)`. Ambas ya llaman a
  `club_es_dueno_grupo(club)`: `caja_puede_ver` le da lectura al dueño de
  grupo, y `caja_tiene_permiso` tiene la línea comentada para darle permisos
  si se decide (decisión 13). Un acceso nuevo = `create or replace` de la
  función, cero políticas tocadas.
- **La excepción, una sola vez**: la restrictiva de `clubs` que se aplicó el
  12/11/2026 tiene la regla escrita dentro de la política. Sin cambiarla, un
  dueño de grupo no vería los antros **no publicados** de su grupo. El
  bloque 17 la reemplaza por `puede_ver_club(id)` (misma regla + rama de
  grupo). `club_photos` no cambia: hereda de `clubs`.
- **Fuera de la caja**: las políticas actuales de `reservations`,
  `commissions`, `rp_*` y `profiles` no conocen al grupo. Para reportes de
  grupo de esas tablas hay dos caminos: ir pasando sus políticas a
  `puede_ver_club()` / funciones equivalentes, o hacer funciones de reporte
  `SECURITY DEFINER` que devuelvan solo agregados. Se decide cuando se
  diseñen las pantallas de grupo.

## 12. Puerta: escanear y "Confirmar entrada"

**La app no cobra nada a los clientes**: no hay depósito, ni reembolso, ni
crédito, ni retención. Si el antro no deja pasar a alguien, simplemente no
se confirma su entrada: no hay "no entra", ni lista de motivos, ni nada que
registrar.

**Cómo encaja con lo que hay** (`reservations`):

| Hoy | Con la puerta |
|---|---|
| `status`: `pendiente → confirmada → usada`. `usada` = check-in, y todo el código lo lee así (panel de staff, panel del RP, admin). | **Se reutiliza igual.** "Confirmar entrada" pone `status = 'usada'`. |
| `se_retiro_sin_consumir` | **Se reutiliza igual**, solo para quien entró (lo hace cumplir el candado). |
| El staff pone `usada` con un `UPDATE` directo desde el navegador. | Solo por funciones; un trigger (bloque 21) rechaza el `UPDATE` directo. |

**Columnas nuevas en `reservations`** (bloque 1C): `puerta_estado`
(`en_puerta | entro`, nulo = no ha llegado), `en_puerta_en/por`,
`entrada_en/por` (**hora real de entrada**) y `llegada_tarde`.

**Flujo** (funciones de la base, permiso `puerta`):

```
(sin llegar) ── puerta_escanear(qr) ──> en_puerta ── puerta_confirmar_entrada ──> entro  (status = 'usada')
```

- `puerta_escanear` valida que el QR sea del antro de quien escanea y de la
  noche operativa en curso; devuelve nombre, personas y RP, **sin teléfono
  ni consumo**. Para un QR de otro antro responde lo mismo que para uno que
  no existe.
- `puerta_confirmar_entrada` guarda `entrada_en = now()`. **No penaliza**: si
  el antro no tiene `tolerancia_hora` (por defecto no tiene),
  `llegada_tarde` queda nulo. Si la tiene (hora local, por ejemplo `00:30`;
  antes de las 08:00 se entiende de madrugada), la base marca
  `llegada_tarde` y nada más.
- **El RP no se penaliza**: una reserva sin entrada confirmada no tiene
  cuenta en la caja, así que no genera comisión ni cuenta para el
  desbloqueo.

## 13. Nómina para gerente y dueño

**Función** `nomina_semana(club, año, semana)` (bloque 23): una fila por RP
con reservas que entraron, número de comisiones, comisión pendiente y
pagada, días asistidos, pago por día pendiente y pagado, y totales. Todo en
centavos y **calculado en la base**.

- **Semana del año**: ISO 8601 (lunes a domingo), la misma que usa el
  desbloqueo. Una comisión cae en la semana de la **noche de su reserva**
  (`reservations.fecha`, en la zona del antro); un pago por día, en la de su
  fecha de asistencia.
- **Estado**: `pagada` o pendiente (`validada` cuenta como pendiente,
  decisión 17). `nomina_marcar_pagada(club, rp, año, semana)` marca la
  semana de un RP con quién y cuándo, y deja bitácora.
- **Quién**: gerente, dueño y admin (el dueño de grupo solo lee). El staff
  no: no ve sueldos. El RP tiene `nomina_semana_mia(año, semana)` con
  exactamente la misma cuenta, solo su fila.
- **Exportable**: CSV generado desde la pantalla con las filas de la función
  (UTF-8 con BOM para que Excel respete acentos; columnas en pesos con dos
  decimales, convertidas de centavos solo al exportar). Si se quiere el
  archivo desde el servidor, un route handler que llame a la misma función.

**Qué se reutiliza de la pestaña Nómina actual del RP** (`app/rp/panel/page.tsx`):

| Hoy | Se reutiliza | Cambia |
|---|---|---|
| Etiquetas de estado (`COMISION_STATUS_LABEL`) | Sí, movidas a `lib/domain/nomina.ts` para que las use también el reporte. | Solo pendiente/pagada. |
| Las dos vistas por modo (`reserva`: comisión de la semana y desbloqueo; `dia`: lista de días y total) | Sí, como componentes compartidos entre la pestaña del RP y el reporte del gerente. | — |
| Totales sumados en el navegador con `Number(row.monto)` y `toLocaleString("en-US")` | No. | Los totales vienen de la función en centavos; se formatean con `Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })`. |
| Semana por `created_at` de la comisión / del pago (`semanaMexico()`) | No. | La semana sale de la noche de la reserva. Hoy una comisión de una reserva del domingo registrada el lunes cae en la semana equivocada. |
| Indicador de desbloqueo ("Llevas X de N") | Sí. | El conteo debe usar la misma regla que la base (comisiones de reservas de esa semana). |

## 14. Cambios de código que esto implica (no hechos)

1. **Puerta**: reemplazar `handleConfirmCheckIn` (`UPDATE status = 'usada'`)
   y la búsqueda por `qr_code` de `/staff/panel` por `puerta_escanear` y
   `puerta_confirmar_entrada`. Esto va **antes** del bloque 21.
2. **Sin bono de plataforma**:
   - `/staff/panel` (`createCommissionForReservation`) deja de insertar
     `tipo: 'plataforma'` en reservas orgánicas.
   - `/admin` oculta "Bono plataforma" y "Editar bono de plataforma".
   - `/dueno/panel` oculta "Bono a la plataforma".
   - Las columnas `bono_organica_*`, el trigger `clubs_candado_bono` y las
     comisiones `plataforma` ya registradas **se quedan**.
   - Opcional, después: que `commissions_restrictiva_insert` ya no acepte
     `plataforma` de nadie fuera del admin.
3. **Sin depósito**: `deposito_monto` sale del producto y lo reemplaza el
   cover informativo (`sql/2026-11-borrador-cover.sql`). La lista de
   pantallas a cambiar está en ese archivo.
4. **Nómina**: pestaña del RP con `nomina_semana_mia`; pantalla nueva del
   gerente/dueño con `nomina_semana`, exportar CSV y marcar pagada.
