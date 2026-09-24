# AntroApp — Documento maestro del proyecto

> Este archivo es la fuente de verdad para cualquier sesión de Claude Code que
> trabaje en AntroApp. Refleja el estado **real** del código al 22 de
> septiembre de 2026, no un ideal. Si algo aquí ya no coincide con el código,
> el código manda y este archivo debe corregirse.
>
> Todo lo que no se pudo confirmar leyendo el código está marcado como
> **(por confirmar con Diego)**.

---

## 1. Qué es AntroApp

Plataforma de reservas para antros mexicanos. Son dos productos en uno:

- **Marketplace para clientes finales**: exploran antros cercanos, ven fotos y
  detalles (ambiente, música, código de vestimenta, edad mínima) y apartan
  lugar en segundos. Reciben un código QR para mostrar al llegar.
- **Sistema de gestión para el antro**: el dueño administra su perfil, fotos,
  mesas y personal; el staff recibe clientes en la puerta (escanea QR, asigna
  mesa, registra consumo) y gestiona a sus RPs; los RPs traen clientes y
  siguen su propio rendimiento y pago.

---

## 2. Stack

| Capa | Tecnología |
|---|---|
| Framework | Next.js 15 (App Router, TypeScript estricto, Turbopack) |
| Backend | Supabase: Postgres + Auth + Storage + RLS |
| UI | Tailwind v4 + shadcn/ui (sobre Base UI), lucide-react |
| Hosting | Vercel |

Notas importantes:

- **Tailwind v4**: no hay `tailwind.config.js`. Los tokens viven en
  `app/globals.css` dentro de `@theme inline`.
- **Todo es client-side**. Prácticamente todas las páginas son `"use client"` y
  hablan con Supabase desde el navegador con la *anon key*. La seguridad
  depende por completo de RLS (ver sección 7, hay problemas serios ahí).
- **Deploy manual**: `npx vercel --prod`. El auto-deploy desde GitHub **está
  roto** (~52 días sin dispararse); los pushes a `master` llegan al repo pero
  no generan build. Pendiente revisar la conexión Git en el dashboard de
  Vercel. El CLI tampoco está instalado ni autenticado en la máquina de Diego.
- Una sola ruta de servidor: `app/api/admin/create-staff/route.ts` (usa la
  *service role key*).

### Comandos

```bash
npm run dev          # desarrollo (Turbopack)
npx tsc --noEmit     # type-check — correr SIEMPRE antes de dar algo por hecho
npx eslint .         # lint
npx next build       # build de producción, antes de cualquier deploy
npx vercel --prod    # deploy manual (requiere login previo)
```

---

## 3. Los 5 roles

El rol vive en `profiles.role`: `cliente | rp | staff | gerente | admin | dueno`
(son 6 valores; `staff` y `gerente` se tratan casi siempre como uno solo).

### Cliente
- Explora antros (`/cliente`), ve la ficha (`/cliente/[clubId]`) y reserva
  (`/cliente/reservar`).
- Ve su historial en `/cliente/perfil`.
- Se auto-registra en `/cliente/signup`.

### RP (promotor)
- Panel en `/rp/panel`, con 4 pestañas: Perfil, Reservas, Turnos y Nómina.
- Crea reservas a nombre de sus clientes (quedan con `source: "rp"`).
- Ve su rendimiento (reservas de la semana y del mes) y lo que va ganando.
- Muestra un QR propio (`rp-attendance-{id}`) para que el staff registre su
  asistencia al llegar a trabajar.
- **No puede reservar como cliente**: es cuenta de trabajo ligada a un club.

### Staff y gerente
- Comparten panel: `/staff/panel`.
- Escanean el QR del cliente para hacer check-in, asignan mesa, registran
  consumo y pueden marcar "se retiró sin consumir".
- Crean y dan de baja RPs de su club.
- Asignan turnos a los RPs (fechas sueltas o repetición semanal) y registran su
  asistencia (por QR o manual).
- **Diferencia única entre ambos**: solo el **gerente** ve la sección "Reglas de
  pago de RPs". El `staff` puro no ve sueldos de nadie. Es la única parte del
  código donde se distinguen.

### Dueño
- Panel en `/dueno/panel`. Edita los datos de su antro (nombre, dirección,
  horario, depósito, ubicación, ambiente, música, vestimenta, edad mínima),
  sube fotos, gestiona mesas y crea cuentas de staff/gerente.
- Configura cómo se le paga a sus RPs, incluyendo tarifas individuales por RP.
- Ve el bono de plataforma pero **no puede editarlo** (solo lectura).
- Se auto-registra en `/dueno/signup`, que crea de una vez su cuenta y su club.

### Admin
- Panel en `/admin`. Dashboard general, alta de antros, edición del bono de
  plataforma por antro, creación de cuentas de staff/gerente y un tablero de
  "Alertas de reporte" que compara el % de reservas con consumo registrado vía
  RP contra las orgánicas, para detectar posible sub-reporte.
- Login aparte en `/admin/login`.

### Jerarquía de creación de cuentas

```
Admin ──crea──> staff / gerente          (y da de alta antros)
Dueño ──crea──> staff / gerente          (de su propio club)
Staff ──crea──> RP                       (de su propio club)
Cliente ──se auto-registra──> /cliente/signup
Dueño   ──se auto-registra──> /dueno/signup  (crea cuenta + club)
```

Las tres creaciones pasan por `POST /api/admin/create-staff`, que solo acepta
los roles `staff`, `gerente` y `rp`.

> **Corrección a la instrucción original**: no existe una ruta `/rp/signup`
> pública. Bajo `app/rp/` solo hay `layout.tsx` y `panel/`. Los RPs únicamente
> se crean desde el panel de staff, que siempre les asigna el `club_id` de
> quien los crea. El riesgo de "RPs huérfanos sin club" no aplica hoy por esa
> vía — pero sí existe un problema relacionado, ver sección 7.

### Login

`/cliente/login` es el **login unificado**: según el rol del perfil, redirige a
`/cliente`, `/rp/panel`, `/staff/panel`, `/dueno/panel` o `/admin`. Hay logins
separados para dueño (`/dueno/login`) y admin (`/admin/login`). Un RP con
`activo: false` no puede entrar (se le cierra la sesión con un mensaje).

---

## 4. Modelo de negocio

Decidido con el socio. **Nada de esto está implementado como cobro real todavía.**

- **Mensualidad fija: $2,500 MXN por antro.** Hoy la suscripción es un booleano
  (`clubs.suscripcion_activa`) que se activa con un botón, sin cobro. El monto
  de $2,500 no aparece en el código.
- **Bono por reservas orgánicas**: el antro le paga a la plataforma un bono por
  cada reserva orgánica (no traída por RP) **solo si el cliente llega y
  consume**. Configurable por antro como monto fijo o porcentaje del consumo
  (`bono_organica_tipo`, `bono_organica_monto`). **Solo el admin lo edita**; el
  dueño lo ve en modo lectura. Se guarda en `commissions` con `tipo:
  "plataforma"`.
- **Sin cargo al cliente final.** El `deposito_monto` que se muestra en la
  ficha del antro es **informativo**: se muestra al cliente pero la app no
  cobra nada. El cobro real lo hace el antro por su cuenta.
- **Comisión de RP: la paga el antro en su nómina**, no pasa por la
  plataforma. AntroApp solo la calcula y la registra para que ambos tengan el
  mismo número. Dos modos por antro (`clubs.pago_rp_modo`):
  - `reserva`: comisión por reserva válida (fija o % del consumo), con un
    **desbloqueo semanal**: las primeras N reservas de la semana no generan
    comisión (`comision_desbloqueo_reservas`).
  - `dia`: pago por día de asistencia confirmada, con tarifa distinta según si
    es el 1er, 2do, 3er… día de esa semana (`club_dia_tarifas`). Si el RP
    asiste más días de los configurados, se repite la tarifa del último día
    configurado.
  - En ambos modos se puede **personalizar por RP** (`rp_comision_overrides`,
    `rp_dia_tarifa_overrides`), porque no todos los RPs ganan igual. Si el RP
    no tiene override, aplica la regla del antro.
- **Stripe y cobros reales: diferidos.** Hoy todo está simulado.

---

## 5. Reglas de negocio clave

### Reservas
- Estados: `pendiente` → `confirmada` → `usada`. El check-in del staff pone
  `usada`.
- `source`: `organica` (el cliente la hizo solo) o `rp` (la creó un RP). De esto
  depende si se genera comisión de RP o bono de plataforma.
- Entre 1 y 20 personas (`MIN_PERSONAS` / `MAX_PERSONAS`).
- La fecha no puede ser en el pasado.
- Cada reserva genera un `qr_code` único (`antro-{uuid}`), consultable sin
  sesión en `/r/[codigo]` para poder compartirlo por WhatsApp.
- **El QR no garantiza acceso.** Apartar lugar no es lo mismo que entrar: el
  antro conserva su derecho de admisión, código de vestimenta y edad mínima.
- **"1 reserva por cliente / antro / día": está definida como regla de negocio
  pero NO está implementada.** No hay validación de duplicados ni en el código
  ni en la base; hoy un cliente puede reservar el mismo día en el mismo antro
  cuantas veces quiera. Pendiente de implementar (idealmente como índice único
  en Postgres, no solo en el cliente).

### Comisiones
- Se generan **solo con check-in + consumo**: al registrar el **primer**
  `consumption_entries` de una reserva. Si el cliente nunca llega o nunca
  consume, no hay comisión ni bono.
- Se calcula una sola vez, con el monto del primer cargo. Si después se agregan
  más consumos, la comisión **no** se recalcula. Es una simplificación
  consciente.
- Estados: `pendiente`, `validada`, `pagada` (así aparecen en la UI). **No hay
  pantalla para cambiar el estado**: todas nacen `pendiente` y ahí se quedan.
  Marcarlas como pagadas es un flujo que aún no existe.
- El cálculo vive en Postgres, no en el cliente: `registrar_comision_reserva()`
  y `registrar_pago_dia()`, ambas `SECURITY DEFINER`. Es así a propósito: el
  staff dispara la creación pero no debe poder leer las tablas de sueldo.

### Semana
- Va de **lunes a domingo** y se usa para el desbloqueo de comisión y para
  contar los días de asistencia del RP.
- **Ojo**: se calcula con la **hora local del dispositivo**
  (`getTimezoneOffset()`), no con `America/Mexico_City` fijo. Mientras todos
  estén en México funciona, pero un dispositivo con otra zona horaria vería
  límites de semana distintos. La función `getWeekRange()` está **duplicada en
  3 archivos** (`app/staff/panel`, `app/rp/panel`, y una variante en
  `components/turno-recurrente-form.tsx`). Unificarla es deuda pendiente.

### Turnos y asistencia de RP
- El staff asigna turnos (`rp_schedule`), en fechas sueltas o repitiendo días de
  la semana dentro de un rango.
- El RP solo cuenta como asistente si hay **asistencia confirmada**
  (`rp_attendance`), por escaneo de su QR o marca manual del staff. Tener turno
  asignado no basta.

---

## 6. Modelo de datos

Tablas reales en Supabase (verificadas por introspección):

| Tabla | Para qué |
|---|---|
| `profiles` | Usuarios y su rol. Ligada 1:1 a `auth.users` por `id`. |
| `clubs` | Los antros y toda su configuración de pagos. |
| `club_photos` | Galería, en el bucket `club-photos`. |
| `club_tables` | Mesas del antro. |
| `reservations` | Reservas, con su QR y consumo. |
| `consumption_entries` | Cargos de consumo por reserva (varios por reserva). |
| `commissions` | Comisión de RP (`tipo: "rp"`) y bono de plataforma (`tipo: "plataforma"`). |
| `rp_schedule` | Turnos asignados. |
| `rp_attendance` | Asistencia confirmada del RP. |
| `club_dia_tarifas` | Tarifa por día de asistencia, a nivel antro. |
| `rp_dia_tarifa_overrides` | Igual, pero personalizada para un RP. |
| `rp_comision_overrides` | Comisión por reserva personalizada para un RP. |
| `rp_pagos_dia` | Pago generado por cada día de asistencia. |
| `profiles_legacy` | **Tabla vieja archivada. Tiene contraseñas en texto plano.** Ver sección 7. |

Funciones SQL: `current_role_name()`, `current_club_id()` (helpers usados por
todas las políticas de RLS), `registrar_pago_dia()`,
`registrar_comision_reserva()` y `rls_auto_enable()`.

### Desincronizaciones detectadas

- `clubs.ciudad` existe en la base pero **no está** en la interfaz `Club` de
  `types/index.ts`, y ninguna pantalla la usa. **(por confirmar con Diego: se
  usa o se borra)**
- `rp_schedule` tiene `es_fijo`, `dias_semana` y `fecha_inicio` en la base, pero
  el código **no las usa**: los turnos recurrentes se resuelven generando una
  fila por fecha. Parecen de un diseño anterior. **(por confirmar con Diego)**

---

## 7. Deuda técnica conocida y aceptada

Ordenada por gravedad. Los primeros cuatro puntos los **verifiqué contra la
base de datos de producción** el 22/09/2026.

### 🔴 Críticos — datos personales expuestos sin sesión

Con solo la *anon key* (que es pública por diseño, va en el bundle del
navegador) y **sin iniciar sesión**, hoy se puede leer:

1. **`profiles` completa** — 12 filas: nombre, teléfono, rol y club de todos los
   usuarios, incluido el staff.
2. **`profiles_legacy` completa** — 2 filas **con la columna `password` en
   texto plano y poblada**. Es una tabla vieja archivada, pero sigue siendo
   legible por cualquiera.
3. **`reservations` completa** — 24 filas: nombre y teléfono del cliente, fecha
   y **el `qr_code`**. Con ese código cualquiera puede abrir `/r/{codigo}` y
   presentarse en la puerta con la reserva de otra persona.
4. **INSERT anónimo permitido en `reservations`** — se puede crear una reserva
   sin cuenta, directo contra la API. (Verificado insertando una fila de
   sondeo, ya borrada.)

Las tablas que sí están protegidas: `commissions`, `consumption_entries`,
`club_tables`, `rp_attendance`, `rp_schedule`, `club_dia_tarifas`,
`rp_pagos_dia` y las dos de overrides. `clubs` y `club_photos` son públicas a
propósito (son el catálogo).

**Esto debería ser lo primero que resuelva la sesión de security hardening.**

### 🟠 Altos — control de acceso

5. **`/rp/panel` no verifica el rol.** Solo comprueba que haya sesión y perfil.
   Un cliente, gerente o dueño logueado puede abrirlo; si tiene `club_id`, vería
   el panel de RP con datos como si lo fuera. Arreglo: pedir `role` en el
   `select` de `loadSession` y redirigir si no es `rp`, igual que hace
   `/staff/panel` (`app/rp/panel/page.tsx`, ~línea 176).
6. **`POST /api/admin/create-staff` no verifica quién llama.** No revisa sesión
   ni rol; cualquiera que conozca la URL puede crear cuentas de staff, gerente
   o RP en cualquier club. Ya está anotado como deuda en el propio archivo.
7. **Auto-registro de dueños sin validación.** `/dueno/signup` es público: quien
   sea crea una cuenta de dueño y un antro. El antro nace con
   `suscripcion_activa: false`, así que no aparece en el listado, pero la cuenta
   sí se crea. **(por confirmar con Diego si esto es intencional)**

### 🟡 Medios

8. **Auto-deploy de Vercel roto** (~52 días). Deploy manual con
   `npx vercel --prod` mientras tanto.
9. **`/dueno/signup` no es transaccional**: crea el perfil y luego el club en
   dos pasos. Si falla el segundo, queda un dueño sin antro que ve "Antro no
   encontrado" para siempre.
10. **`/dueno/panel` asume un solo antro por dueño** (`.maybeSingle()` sobre
    `dueno_id`). Con dos clubs, la consulta falla y el dueño no ve ninguno.
11. **Sin flujo para marcar comisiones como pagadas.** Todas se quedan en
    `pendiente`.
12. **`getWeekRange()` duplicada en 3 archivos** y basada en la zona horaria del
    dispositivo.
13. **Staff puede ver la config de comisión del antro.** `comision_tipo`,
    `comision_monto` y `comision_desbloqueo_reservas` viven en `clubs`, que el
    staff necesita leer para el nombre y dirección. La regla "staff no ve
    sueldos" solo se aplicó a las tablas nuevas. Postgres no tiene RLS por
    columna, así que arreglarlo requiere mover esos campos a otra tabla.

### Datos de prueba en producción

La base de producción tiene antros de prueba ("Antro Demo", "Lounge Elite",
"Club Nocturno XYZ") junto a los reales ("SIX GDL", "El Vaquero"). Además, los
5 antros tienen 3 fotos cada uno que son **copias de las fotos reales de SIX
GDL**, puestas a propósito para poder evaluar la galería. No son fotos reales de
esos antros.

---

## 8. Cómo se trabaja en este proyecto

- **Español siempre**: conversación, comentarios de código, mensajes de commit y
  textos de la UI.
- **Por fases, con aprobación de Diego en cada paso.** Los cambios grandes se
  parten en checkpoints: se entrega una parte, Diego la revisa, y hasta
  entonces se sigue. No adelantarse a la siguiente fase.
- **SQL**: Claude Code **no tiene acceso** al dashboard de Supabase ni conexión
  directa a Postgres (solo PostgREST con las keys del `.env.local`). Todo cambio
  de esquema se entrega como SQL **completo y listo para pegar** en el SQL
  Editor, en un solo bloque. Después de que Diego lo corra, verificar por
  introspección que quedó aplicado antes de seguir.
- **Nada de `git commit`, `git push` ni deploy sin que Diego lo pida
  explícitamente.** El trabajo se deja en el working tree para que él lo revise.
- **Verificar antes de afirmar**: `npx tsc --noEmit` después de cada cambio, y
  `npx next build` antes de cualquier deploy. Para cambios de UI, capturas con
  Playwright a 390×844 (y 360×740 para revisar el caso apretado).
- **Datos de prueba**: se crean con la *service role key*, se usan y **se
  borran al terminar**. Nunca dejar usuarios ni antros de prueba sueltos en la
  base salvo que Diego lo pida.
- **Reportes cortos y honestos**: qué se hizo, qué falló, qué quedó pendiente.
  Si algo no se pudo verificar, se dice; no se da por bueno.

### Temas visuales

Dos identidades separadas, ambas con sus tokens en `app/globals.css` y
aplicadas por `layout.tsx` con un componente envolvente. Los componentes de
shadcn se restilizan solos vía tokens; **no hardcodear colores en las páginas**.

- **`.theme-noche`** (`components/theme-noche.tsx`) — cara al cliente: landing,
  `/cliente/*`, `/r/*` y `/acceso-negocios`. Negro obsidiana `#0B0A0A`, oro
  latón `#C9A227`, vino `#4A0E0E` para detalles puntuales, texto cálido
  `#F2EFE9`, grano sutil de papel impreso. Instrument Serif para títulos, Inter
  para el cuerpo. Esquinas de ~5px, nunca píldoras.
- **`.theme-control`** (`components/theme-control.tsx`) — operativo:
  `/rp/*`, `/staff/*`, `/dueno/*`, `/admin/*` y las de contraseña. Fondo claro
  `#F6F6F4`, alto contraste, solo Inter. **El color se reserva para estados**:
  `--status-ok` (verde), `--status-warn` (ámbar), `--status-err` (rojo). Nada
  decorativo, sin fotos ni degradados.

Referencia de marca para el tema noche: mexicana premium (Clase Azul, Casa
Dragones). Evitar explícitamente el look genérico morado-degradado.

---

## 9. Pendientes inmediatos

1. **Cerrar las fugas de RLS** de la sección 7 (puntos 1 a 4). Es lo más
   urgente: hay datos personales de clientes reales expuestos.
2. Borrar o proteger `profiles_legacy` (contraseñas en texto plano).
3. Gate de rol en `/rp/panel`.
4. Verificar quién llama a `/api/admin/create-staff`.
5. Arreglar el auto-deploy de Vercel.
6. Implementar la regla de 1 reserva por cliente/antro/día.
