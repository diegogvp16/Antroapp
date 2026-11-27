# Avance hacia la junta del 25/11/2026

## Estado real (27/11/2026)

**En producción** (detalle y verificaciones en `docs/reporte-pase.md`):

| Qué | Cuándo |
|---|---|
| **Pase 1 completo, pasos 1 a 10** (SQL 2b a 9, merge a `master` `771e7d3`, recorrido 49/49, humo 84/84) | 24/11 |
| Ajustes de Club Demo (cuentas demo, ficha, Club Demo Tijuana oculto, grupo) | 24/11 |
| **Paso 11, `demo-datos` para la junta**: 4 noches, 35 mesas, 173 consumos, 66 comisiones, cuadre sin diferencias, solo Club Demo | 25/11 |
| **Hueco CRÍTICO del perfil cerrado**: `sql/2026-11-25-perfil-sin-club-ajeno.sql`, pegado por Diego. Verificado: catálogo, prueba del hueco en dev 4/4, recorrido 49/49, humo 84/84 | 27/11 |

**Lo que sigue (no está en producción):**

- **El pase 2**, rama `post-junta-2`: alta de antros, equipo, reportes, boleto, caja con mala señal, seguridad y rendimiento.
- Su orden completo está en `docs/pase-2.md` y su avance en `docs/avance.md` de esa rama.
- Espera a que Diego lo pida.

**Ramas:**

- `master` = producción.
- `desarrollo` = `master` + docs y SQL de lo que ya está en producción.
- `post-junta-2` = el pase 2.
- `prejunta` = lo de la junta.

> Bitácora original (antes del pase 1): el trabajo se hizo en `desarrollo` y en
> **antroapp-dev**. Los bloques 1 a 5 de abajo describen ese momento.

## Cómo probar lo de `desarrollo`

- **Vista previa de Vercel** (rama `desarrollo`, apunta a antroapp-dev, no a
  producción): https://antroapp-git-desarrollo-antroapp.vercel.app
  (la URL fija de la rama; cada push genera además una URL propia). Vercel
  pide iniciar sesión con tu cuenta para abrirla (protección de vistas
  previas).
- **Usuarios de prueba de dev**: `dev_admin`, `dev_dueno`, `dev_gerente`,
  `dev_staff`, `dev_rp`, `dev_cliente` (todos `@example.com`). La contraseña
  está en `backups/dev-credenciales.json` (solo en tu computadora).
- Antro de prueba: **Club Demo Dev** (publicado, 12 mesas, reservas de hoy;
  50 mesas con `node scripts/dev/mesas-extra.mjs`).
- Para volver a dejar dev limpio y con la noche demo, en este orden:
  `node scripts/dev/sembrar-dev.mjs`, `node scripts/demo-datos.mjs --env=.env.dev --si`
  y (opcional) `node scripts/dev/mesas-extra.mjs`.

---

## Bloque 1 · Entorno dev — ✅ terminado (commit `b81a85e`)

**Qué quedó**
- antroapp-dev tiene el esquema de producción replicado: tablas, funciones,
  triggers, RLS (incluidas las restrictivas), GRANT explícitos para anon,
  authenticated y service_role, buckets y políticas de Storage, y el event
  trigger `ensure_rls`. Comparado contra el catálogo de producción: idéntico.
- Herramientas con candados (`scripts/db/`): a producción solo lectura del
  catálogo; a dev escritura solo si la URL y las llaves son de dev.
- Datos ficticios en dev con un usuario por rol (`scripts/dev/sembrar-dev.mjs`).
- `scripts/probar-clubs-visibilidad.mjs --env=.env.dev`: **58/58**.
- Vercel Preview apunta a antroapp-dev (verificado en el código que se manda
  al navegador: trae el ref de dev y ninguno de producción). Production no
  se tocó.
- CLAUDE.md: sección "Ramas y entornos".

**Qué falló**: nada pendiente.

**Qué debe probar Diego**: abrir la vista previa, entrar con `dev_cliente` y
ver "Club Demo Dev" en el listado (prueba de que Preview usa dev).

---

## Bloque 2 · Cover y caja en dev — ✅ terminado (commit `dc8e280`)

**Qué quedó**
- `sql/2026-11-20-cover.sql`, `sql/2026-11-20-caja-por-mesa.sql` y
  `sql/2026-11-20-caja-candado-puerta.sql` (este último se aplica DESPUÉS de
  publicar el código nuevo), corregidos y aplicados **solo en dev**, cada uno
  con su rollback. Los rollbacks se probaron: dejan dev idéntico a
  producción.
- Errores corregidos de los borradores: no daban GRANT (en dev nadie podía
  leer la caja) y una verificación con `set local role anon` dejaba el resto
  de la transacción corriendo como anónimo.
- **Nada se borra en caja**: un trigger impide DELETE/TRUNCATE incluso con la
  service role; un consumo o pago solo se anula, una vez y con motivo; una
  noche cerrada o una mesa cuadrada no se reabren; nada entra a una noche
  cerrada.
- Revisión adversarial (4 revisores): 15 problemas reales encontrados y
  corregidos. Los más serios: un RP podía meter reservas en cualquier antro
  y cobrar comisión ahí; el staff podía convertir una reserva orgánica en
  una de RP; cualquiera dado de baja podía reactivarse solo.
- `node scripts/dev/probar-caja.mjs`: **148/148** pruebas por rol con
  sesiones reales (anónimo, cliente, RP, staff, gerente, dueño propio y
  ajeno, admin, dueño de grupo): cada rol ve solo lo suyo, la comisión nace
  al cuadrar la mesa (y por cuenta: dos RPs en una misma mesa cobran sobre
  lo de su cliente), nada se borra, el cliente nunca paga.

**Qué falló**: nada pendiente.

**Qué debe probar Diego**: nada a mano en este bloque (es base de datos);
lo visible está en el bloque 3.

## Bloque 3 · Pantallas de mesas y caja — ✅ terminado (commit `69525bb`)

**Qué quedó**
- `/staff/caja`: mesas de la noche con su estado, cuentas por cliente con su
  RP, sentar (reserva con entrada confirmada o walk-in), agregar consumo,
  anular con motivo, cobro por método, cerrar con saldo cero, cuadrar y
  reabrir mesa (gerente), cuadre de la noche con conteo físico y diferencia.
- `/staff/panel`: escáner con "Confirmar entrada" por las funciones de la
  base, aviso "El QR no garantiza la entrada", "Confirmar entrada sin
  cámara" en cada reserva, acceso "Caja y mesas de la noche". Ya no hay
  "Asignar mesa" ni "Agregar consumo" viejos. Después de medianoche sigue
  mostrando la noche en curso (corte 08:00).
- Cover informativo en el panel del dueño y en el alta del admin; el
  listado y la ficha lo muestran ("Cover $350").
- Recorrido con Playwright contra dev, a 390 y 360 px: staff (escáner con
  cámara simulada, confirmar sin cámara, abrir mesa, sentar dos clientes,
  consumo, cobro, cerrar), gerente (cuadrar, walk-in, anular con motivo,
  cerrar la noche), dueño (cover), cliente (ve el cover), admin (campo de
  cover). Sin errores de consola ni de red. La comisión de $150 del RP nació
  al cuadrar la mesa.

**Qué falló**: nada pendiente.

**Qué debe probar Diego a mano** (en la vista previa, con usuarios `dev_*`):
1. `dev_staff`: Panel → "Confirmar entrada sin cámara" en una reserva →
   "Caja y mesas de la noche" → abrir una mesa → "+ Sentar cliente" → agregar
   consumo → registrar pago → "Cerrar mesa".
2. `dev_gerente`: en esa mesa "Cuadrar mesa"; pestaña "Cuadre de la noche".
3. `dev_dueno`: Panel → "Cover en la puerta" → Monto → guardar; luego
   `dev_cliente` ve "Cover $..." en el listado.
4. Para repetir la prueba con datos frescos: `node scripts/dev/sembrar-dev.mjs`.

## Bloque 4 · Nómina semanal y panel de grupo — ✅ terminado (commit `a33b82d`)

**Qué quedó**
- Nómina por la noche de la reserva (semana lunes a domingo) con estados
  **pendiente → en revisión → validada → pagada**, y **anulada** con motivo
  (lo anulado no se borra y no suma). Las transiciones las valida la base;
  solo gerente, dueño o admin las hacen; queda quién, cuándo y bitácora.
- `/staff/nomina` (gerente) y `/dueno/nomina`: selector de semana, totales
  por estado, una tarjeta por RP con sus botones, anular con motivo,
  **Exportar CSV**. El staff ve "Solo el gerente ve la nómina".
- `/grupo`: panel de solo lectura con totales del grupo (reservas, % de
  entrada, consumo de la caja, ticket promedio, comisiones, noches cerradas)
  y cada antro por ciudad, en su propia hora. El dueño de grupo ve todos sus
  antros; el gerente solo el suyo ("Resumen de tu antro"); staff, RP y
  cliente no.
- Dev ahora tiene un segundo antro en Tijuana, un grupo (dueña: `dev_dueno`)
  y 8 noches de historia por antro.
- Pruebas: `probar-caja` 167/167 (incluye estados de nómina y grupo),
  `probar-clubs-visibilidad --env=.env.dev` 68/68. Recorrido con Playwright
  (gerente, dueño, staff, RP) sin errores de consola ni de red.

**Qué falló**: nada pendiente. No hubo que recortar alcance.

**Qué debe probar Diego a mano** (vista previa, usuarios `dev_*`):
1. `dev_gerente`: Panel → "Nómina" → en la semana en curso, "Enviar a
   revisión" → "Validar" → "Marcar pagada" en RP Dev; prueba "Anular" (pide
   motivo) y "Exportar CSV". Luego "Resumen de mi antro" (solo su antro).
2. `dev_dueno`: Panel → "Resumen y grupo": deben salir Guadalajara y Tijuana.
3. `dev_staff`: no le aparecen "Nómina" ni "Resumen de mi antro".
4. `dev_rp`: pestaña Nómina con los montos por estado.

## Bloque 5 · Estabilidad — ✅ terminado

**Qué quedó**
- **Límite de intentos de login**: los tres logins (cliente, dueño, admin)
  entran por `/api/auth/login`. Con 5 fallos de un mismo correo (o 20 de una
  misma IP) en 15 minutos, bloquea 15 minutos aunque la contraseña sea la
  correcta. Correo e IP se guardan como hash; nunca la contraseña.
- **Una reserva por cliente, antro y noche** (índice único; las anónimas y
  las de RP no chocan). El cliente ve "Ya tienes una reserva en este antro
  para esa noche."
- **Panel de staff después de medianoche**: usa la noche operativa (corte
  08:00); hecho en el bloque 3.
- **`registrar_comision_reserva` y `registrar_pago_dia` reescritas**: ya no
  confían en el navegador (consumo, semana, RP o club). La comisión solo nace
  en la caja al cuadrar la mesa; la función vieja solo re-liquida, sin
  duplicar. El pago por día calcula su semana en la base y no se duplica.
- **Aviso de errores**: pantallas de error con mensaje amable que avisan
  solas; el admin ve "Errores recientes" en su panel.
- **Respaldos**: guía en `docs/respaldos.md` (revisar y probar una
  restauración sin tocar producción).
- Todos los rollbacks, aplicados en orden inverso, dejan dev idéntico a
  producción. `npx next build` pasa.
- Pruebas: 23/23 del bloque (límite de login, avisos, reserva duplicada,
  login de los 6 roles), `probar-caja` 167/167 y visibilidad 68/68.

**Qué falló**: nada pendiente.

**Qué debe probar Diego a mano**:
1. En la vista previa, entra con `dev_cliente` y una contraseña mala 6
   veces: al sexto intento debe decir "Demasiados intentos. Espera 15
   minutos…".
2. Con `dev_cliente`, reserva dos veces en Club Demo Dev para la misma
   noche: la segunda debe decir "Ya tienes una reserva…".
3. Entra con `dev_admin`: arriba aparece "Errores recientes".

---

## Lo que Diego tiene que hacer a mano (antes del bloque 6)

1. **Respaldos** (`docs/respaldos.md`, paso 1): revisar el plan de Supabase y
   que haya respaldos diarios de producción. Si el plan es Free, subirlo a
   Pro antes de tener caja real.
2. **Protección de login en Supabase** (dashboard de **producción** →
   Authentication):
   - Rate Limits: revisar el límite de inicios de sesión por IP.
   - Attack Protection: activar CAPTCHA (Turnstile o hCaptcha) y
     "Leaked password protection".
   Nuestro límite cubre los formularios de la app; esto cubre a quien llame
   a Supabase directo.
3. **Probar en la vista previa** lo listado en cada bloque (usuarios `dev_*`,
   contraseña en `backups/dev-credenciales.json`).
4. **Cuando quieras el pase**: pídelo explícitamente. El paso a paso, con
   diagnósticos, verificación y rollback de cada paso, está en
   `docs/pase-produccion.md`. La mañana del 25 corre
   `node scripts/demo-datos.mjs --fecha=2026-11-25 --si` (no antes).

---

## Noche demo en dev y diagnóstico de duplicados (20/11/2026)

### Noche demo sembrada en antroapp-dev

Con `node scripts/demo-datos.mjs --env=.env.dev --si` (candado: se niega si
la URL o la llave son de producción; probado con un `.env.dev` falso).
Sin `--fecha`, usa la **noche en curso** (corte 08:00) para que la caja se
pueda operar en vivo. Quedó la noche del **jueves 19/11/2026**:

- 40 reservas de 5 RPs (Mariana, Diego, Valeria, Luis, Fernanda) y
  orgánicas; 27 con entrada confirmada y 13 por llegar (para escanear).
- Caja: 12 mesas compartidas (2 o 3 cuentas cada una, cada cuenta con su
  RP): **5 cuadradas** (con sus comisiones), **2 cerradas** (pagadas, falta
  cuadrar) y **5 abiertas** (con saldo). En una mesa abierta hay un walk-in
  y un consumo **anulado con motivo** ("Capturada dos veces por error").
- Semana anterior (jue 12, vie 13 y sáb 14 de noviembre): todas las mesas
  cuadradas, noches cerradas con su cuadre y comisiones **pendientes** (para
  recorrer los estados de la nómina).
- Club Demo Dev Tijuana conserva su historia (panel de grupo).

**Importante:** la caja solo opera la noche en curso. Después de las 08:00
del 20/11 la noche cambia; el día que pruebes, primero corre
`node scripts/dev/sembrar-dev.mjs` y luego
`node scripts/demo-datos.mjs --env=.env.dev --si`.

### Qué usuario usar en cada pantalla (vista previa o `node scripts/dev/servidor-dev.mjs`)

Contraseña de todos: `backups/dev-credenciales.json` (campo `password`).

| Pantalla | Usuario | Qué ver |
|---|---|---|
| `/staff/panel` | `dev_staff@example.com` | Reservas de la noche; "Confirmar entrada sin cámara" en las 13 que faltan; acceso a la caja. |
| `/staff/caja` | `dev_staff@example.com` | Mesas abiertas, cerradas y cuadradas; sentar, consumir y cobrar en las abiertas. El staff **no** anula ni cuadra. |
| `/staff/caja` (gerente) | `dev_gerente@example.com` | Cuadrar las 2 mesas cerradas, ver el anulado con su motivo, pestaña "Cuadre de la noche". |
| `/staff/nomina` | `dev_gerente@example.com` | Semana anterior (‹): los 5 RPs con comisiones pendientes → Enviar a revisión → Validar → Marcar pagada; Anular con motivo; CSV. |
| `/grupo` | `dev_gerente@example.com` | "Resumen de tu antro": solo Club Demo Dev. |
| `/dueno/panel`, `/dueno/nomina` | `dev_dueno@example.com` | Panel del dueño (cover), nómina del antro. |
| `/grupo` | `dev_dueno@example.com` | Panel de grupo: Guadalajara y Tijuana, cada uno en su hora. |
| `/rp/panel` | `demo_mariana@example.com` (o `demo_diego`, `demo_valeria`, `demo_luis`, `demo_fernanda`) | Reservas de la semana, nómina con esta semana y la anterior. |
| `/cliente` | `dev_cliente@example.com` | Listado con Club Demo Dev y su cover; reservar (la segunda la misma noche se rechaza). |
| `/admin` | `dev_admin@example.com` | Antros (los no publicados colapsados), "Errores recientes". |
| Staff de Tijuana | `dev_staff_tijuana`, `dev_gerente_tijuana` | Su propio antro (otra zona horaria). |

### Diagnóstico de duplicados en PRODUCCIÓN (solo lectura)

Corrido el 20/11/2026 con solo SELECT (no se creó el índice):
- 136 reservas que cuentan (pendiente, confirmada, usada); **ninguna** tiene
  cuenta de cliente (todas son anónimas o de RP).
- **Opción A** (la del índice: cliente, antro, noche): **0 duplicados**. El
  índice de `sql/2026-11-20-estabilidad.sql` se puede crear sin conflictos.
- Opción B (informativa: teléfono, antro, noche): 0.

---

## Trabajo de la noche del 19/11/2026

Detalle completo en `docs/reporte-noche.md`. Resumen de lo que se puede
probar:

### Qué usuario usar en cada pantalla nueva

Contraseña: `backups/dev-credenciales.json` (campo `password`). Antes de
probar otro día: `sembrar-dev`, `demo-datos --env=.env.dev --si` y
`mesas-extra` (la noche demo es la noche en curso).

| Pantalla | Usuario | Qué ver |
|---|---|---|
| `/rp/panel` → Reservas | `demo_mariana@example.com` | Tema oscuro; periodo (Esta semana / Anterior / Mes), barra de colores, filtros. Estados: Consumió, Llegó sin consumo, No llegó, Por llegar. Tarjeta "Cuota alcanzada". Detalle con línea de tiempo, comisión y "Escribirle". |
| `/rp/panel` → Reservas | `demo_diego@example.com` | Igual, con cuota **no** alcanzada ("3 de 10 reservas que consumen"). |
| `/rp/panel` → Nómina | `demo_mariana` / `demo_diego` | La misma tarjeta de cuota (antes contaba "entraron"). |
| `/staff/caja` | `dev_staff@example.com` | Mapa con 50 mesas (pestañas Todas / Abiertas / Por cuadrar / Libres, búsqueda); Mesa 1 con 3 grupos y Mesa 2 con 2. El staff no ve "Cuadrar". |
| `/staff/caja` | `dev_gerente@example.com` | Cuadrar, anular con motivo, reabrir una mesa cerrada, "Cuadre de la noche". |
| Login (cualquiera) | — | 5 contraseñas malas desde el mismo equipo bloquean ese correo **en ese equipo** 15 min; desde otro sigue entrando. Un RP dado de baja recibe "Tu cuenta ha sido desactivada". |

### Pruebas (todas contra antroapp-dev)

| Prueba | Resultado |
|---|---|
| `node scripts/dev/probar-caja.mjs` | 167/167 |
| `node scripts/probar-clubs-visibilidad.mjs --env=.env.dev` | 68/68 |
| `node scripts/dev/probar-login.mjs` (nueva) | 15/15 |
| `node scripts/dev/probar-rp-panel.mjs` (Playwright) | 40/40 |
| `node scripts/dev/recorrido-roles.mjs` (nueva, 6 roles a 390 px) | 32/32 |
| `npx tsc --noEmit`, `npx eslint .`, `npx next build` | sin errores |
