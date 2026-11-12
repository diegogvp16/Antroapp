# AntroApp — Documento maestro del proyecto

> Este archivo es la fuente de verdad para cualquier sesión de Claude Code que
> trabaje en AntroApp. Refleja el estado **real** del código al 11 de
> noviembre de 2026, no un ideal. Si algo aquí ya no coincide con el código,
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
  depende por completo de RLS y de los triggers de la base (sección 7).
- **Deploy manual**: `npx vercel --prod --scope antroapp`. Sin `--scope`
  responde "Not authorized". El auto-deploy desde GitHub **está roto**: los
  pushes a `master` llegan al repo pero no generan build. Pendiente revisar
  la conexión Git en el dashboard de Vercel.
- Rutas de servidor (usan la *service role key*, y antes verifican quién
  llama por la cookie de sesión):
  - `app/api/admin/create-staff/route.ts`
  - `app/api/admin/rechazar-verificacion/route.ts` (solo admin)

### Comandos

```bash
npm run dev          # desarrollo (Turbopack)
npx tsc --noEmit     # type-check — correr SIEMPRE antes de dar algo por hecho
npx eslint .         # lint
npx next build       # build de producción, antes de cualquier deploy
npx vercel --prod --scope antroapp   # deploy manual (requiere login previo)
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
- `/rp/panel` valida el rol: si el perfil no es `rp`, redirige.

### Staff y gerente
- Comparten panel: `/staff/panel`.
- Escanean el QR del cliente para hacer check-in, asignan mesa, registran
  consumo y pueden marcar "se retiró sin consumir".
- Crean y dan de baja RPs de su club.
- Asignan turnos a los RPs y registran su asistencia (por QR o manual). Hay
  dos tipos de turno (`lib/turnos.ts`):
  - **Fecha suelta** (`es_fijo` falso/nulo): vale solo ese día (`fecha`).
  - **Turno fijo** (`es_fijo = true`): una sola fila que vale todas las
    semanas en los días de `dias_semana` (domingo=0 … sábado=6), a partir de
    `fecha_inicio`, sin fecha de fin. Ya no se genera una fila por fecha.
- **Diferencia única entre ambos**: solo el **gerente** ve la sección "Reglas de
  pago de RPs". El `staff` puro no ve sueldos de nadie. Es la única parte del
  código donde se distinguen.

### Dueño
- Panel en `/dueno/panel`. Edita los datos de su antro (nombre, dirección,
  horario, depósito, ubicación, ambiente, música, vestimenta, edad mínima),
  sube fotos, gestiona mesas y crea cuentas de staff/gerente.
- Configura cómo se le paga a sus RPs, incluyendo tarifas individuales por RP.
- Ve el bono de plataforma pero **no puede editarlo** (solo lectura). Lo
  impide un trigger en la base, no solo la UI.
- Se auto-registra en `/dueno/signup`, que crea de una vez su cuenta y su club.
- **Verificación de su antro** (arriba de todo en el panel,
  `components/verificacion-antro.tsx`): sube comprobante fiscal o licencia y
  foto del local (requeridos) e identificación (opcional) al bucket privado
  `verificacion-docs`, y pulsa "Enviar a revisión". Estados:
  `borrador → en_revision → verificado | rechazado`. Si lo rechazan, ve el
  motivo y vuelve a subir documentos.

### Admin
- Panel en `/admin`. Dashboard general, alta de antros, edición del bono de
  plataforma por antro, creación de cuentas de staff/gerente y un tablero de
  "Alertas de reporte" que compara el % de reservas con consumo registrado vía
  RP contra las orgánicas, para detectar posible sub-reporte.
- Sección "Verificaciones pendientes": revisa los documentos (URL firmada de
  pocos minutos) y aprueba o rechaza con motivo. Rechazar pasa por
  `POST /api/admin/rechazar-verificacion`, que además borra los documentos
  para que el dueño suba nuevos.
- Los antros que crea el admin nacen ya `verificado`.
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
los roles `staff`, `gerente` y `rp`, y autoriza en el servidor según quién
llama (rol y club leídos de la base, nunca del body): admin → cualquier club;
dueño → solo clubs suyos; staff/gerente → solo `rp` de su club; sin sesión
→ 401; cualquier otro → 403.

No existe una ruta `/rp/signup` pública: los RPs solo se crean desde el panel
de staff, que siempre les asigna el `club_id` de quien los crea.

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
  sesión en `/r/[codigo]` para poder compartirlo por WhatsApp. Esa página no
  lee la tabla: llama a la función `obtener_reserva_por_qr(p_qr)`, que
  devuelve una sola reserva y sin teléfono, consumo ni ids.
- Se puede reservar sin cuenta (INSERT `anon`), pero la política obliga a que
  la reserva nazca limpia: `organica`, `pendiente`, sin RP, sin cliente, sin
  consumo ni mesa, 1–20 personas y fecha de hoy en adelante (hora de México).
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
- Todo lo de fechas sale de **`lib/fechas.ts`**, siempre en
  `America/Mexico_City` sin importar la zona del dispositivo: `hoyMexico()`
  ("YYYY-MM-DD"), `semanaMexico()` (lunes 00:00:00.000 a domingo
  23:59:59.999) y `mesMexico()`. No escribir otra versión de "hoy" o de la
  semana en una página: usar estas.
- Convención de día de semana en todo el código: domingo=0 … sábado=6.

### Turnos y asistencia de RP
- El staff asigna turnos (`rp_schedule`): fechas sueltas o turnos fijos
  semanales (ver sección 3, `lib/turnos.ts`).
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
| `verificacion_documentos` | Documentos de verificación del antro (`tipo`: `comprobante_fiscal`, `foto_local`, `identificacion`; `storage_path` en el bucket privado). |

`profiles_legacy` (tabla vieja con contraseñas en texto plano) **ya no
existe**: la API responde que la tabla no se encuentra (verificado el
11/11/2026).

Columnas de verificación en `clubs`: `estado_verificacion` (`borrador |
en_revision | verificado | rechazado`), `motivo_rechazo`, `verificado_en`.

Buckets de Storage:
- `club-photos` — **público** (galería del catálogo). Rutas
  `{club_id}/{uuid}-{nombre-de-archivo}`.
- `verificacion-docs` — **privado**, 10 MB, imágenes y PDF. Rutas
  `{club_id}/{tipo}-{uuid}.{ext}`. Solo se lee con URL firmada.

Funciones SQL: `current_role_name()`, `current_club_id()` (helpers usados por
todas las políticas de RLS), `registrar_pago_dia()`,
`registrar_comision_reserva()`, `obtener_reserva_por_qr()`,
`rls_auto_enable()` y las funciones de los triggers de abajo.

Triggers (lo que RLS no puede hacer porque no compara valor viejo y nuevo):
- `profiles_no_escalar` en `profiles`: nadie fuera del admin cambia su
  `role` ni su `club_id`.
- `clubs_candado_verificacion`: fuera del admin, la única transición
  permitida es `borrador | rechazado → en_revision`, y solo con los dos
  documentos requeridos subidos. Nadie más toca `verificado_en` ni
  `motivo_rechazo`.
- `clubs_candado_insert`: un antro creado por un no admin nace en
  `borrador`, sin `verificado_en` ni `motivo_rechazo` y con el bono por
  defecto, aunque el INSERT mande otra cosa (lo corrige, no da error).
- `clubs_candado_bono`: solo el admin cambia `bono_organica_tipo` y
  `bono_organica_monto`.

Los tres de `clubs` se aplicaron en producción en noviembre de 2026 y su
comportamiento está verificado con usuarios de prueba. El SQL está en
`sql/`:
- `clubs_candado_verificacion`, el bucket privado y sus 4 políticas:
  `sql/2026-10-27-verificacion-bucket-y-candado.sql`.
- `clubs_candado_insert` y `clubs_candado_bono`:
  `sql/2026-11-11-clubs-candados-insert-y-bono.sql`.
- La política restrictiva `verificacion_docs_restrictiva` y el borrado de
  las políticas viejas del bucket:
  `sql/2026-11-11-verificacion-docs-candado-storage.sql`.

### Desincronizaciones detectadas

- `clubs.ciudad` existe en la base pero **no está** en la interfaz `Club` de
  `types/index.ts`, y ninguna pantalla la usa. **(por confirmar con Diego: se
  usa o se borra)**

---

## 7. Deuda técnica conocida y aceptada

Ordenada por gravedad. Verificado contra producción el 11/11/2026.

### 🔴 Crítico

1. Ninguno abierto (el hueco de `club-photos` quedó resuelto, ver abajo).

### 🟠 Altos

2. **Un dueño puede crear un antro con `suscripcion_activa = true`** directo
   contra la API, y se guarda así. Hoy también se la puede activar con el
   botón del panel porque la suscripción es simulada. Al público ya no le
   basta con eso: también tiene que estar `verificado`, y eso lo exige la
   base (`clubs_select_anon_verificados`), no solo la app. Pero cuando entre
   el cobro real, `suscripcion_activa` debe quedar bajo candado (trigger).
   **(por confirmar con Diego)**
3. **Auto-registro de dueños sin validación.** `/dueno/signup` es público:
   quien sea crea una cuenta de dueño y un antro. Mitigado: el antro nace en
   `borrador` y no se publica sin la verificación del admin.
   **(por confirmar con Diego si el auto-registro abierto es intencional)**

### 🟡 Medios

4. **Auto-deploy de Vercel roto.** Deploy manual con
   `npx vercel --prod --scope antroapp` mientras tanto.
5. **`/dueno/signup` no es transaccional**: crea el perfil y luego el club en
   dos pasos. Si falla el segundo, queda un dueño sin antro que ve "Antro no
   encontrado" para siempre.
6. **`/dueno/panel` asume un solo antro por dueño** (`.maybeSingle()` sobre
   `dueno_id`). Con dos clubs, la consulta falla y el dueño no ve ninguno
   (pasó en las pruebas del 11/11/2026). Y un dueño **sí puede** crear un
   segundo antro directo contra la API.
7. **"1 reserva por cliente / antro / día" no implementada.** Borrador del
   índice único en `sql/2026-11-borrador-una-reserva-por-dia.sql` (sin correr).
   Al aplicarlo, `/cliente/reservar` necesita traducir el error 23505 a un
   mensaje claro ("Ya tienes una reserva en este antro ese día").
8. **Sin flujo para marcar comisiones como pagadas.** Todas se quedan en
   `pendiente`.
9. **Staff puede ver la config de comisión del antro.** `comision_tipo`,
    `comision_monto` y `comision_desbloqueo_reservas` viven en `clubs`, que el
    staff necesita leer para el nombre y dirección. La regla "staff no ve
    sueldos" solo se aplicó a las tablas nuevas. Postgres no tiene RLS por
    columna, así que arreglarlo requiere mover esos campos a otra tabla.
10. **Los documentos de verificación no tienen límite por tipo.** Un dueño
    puede subir varios archivos del mismo tipo; el panel solo muestra que ya
    hay uno.

### ⚪ Bajos

11. `app/admin/page.tsx` calcula sus rangos "desde hace N días" con
    `toISOString().slice(0, 10)`, que es fecha UTC: de 18:00 a 23:59 hora de
    México el corte se corre un día. Debería usar `lib/fechas.ts`.

### ✅ Resuelto (ya no es deuda)

- Fugas sin sesión en `profiles` y `reservations`: un anónimo lee 0 filas
  (verificado 11/11/2026). El boleto público usa `obtener_reserva_por_qr`.
- Escalada de privilegios en `profiles`: políticas por rol y club y trigger
  `profiles_no_escalar`.
- `profiles_legacy` eliminada.
- INSERT anónimo de reservas acotado (nacen `pendiente`, orgánicas, sin
  consumo).
- `/rp/panel` valida el rol.
- `/api/admin/create-staff` autoriza por rol y club.
- Turnos fijos de RP con `es_fijo`, `dias_semana` y `fecha_inicio`.
- `getWeekRange()` duplicada y basada en el dispositivo: reemplazada por
  `lib/fechas.ts` (hora de México).
- **`clubs` abierta por la política del demo**: se borró
  "Acceso abierto demo - clubs" (`using true`) y el anónimo solo lee antros
  verificados y con suscripción activa (`clubs_select_anon_verificados`,
  `sql/2026-11-11-clubs-quitar-politica-abierta.sql`). Verificado el
  11/11/2026: el anónimo no puede INSERT/UPDATE/DELETE, la reserva sin
  cuenta sigue funcionando; dueño, staff, RP, cliente y admin siguen bien.
- **Bucket `club-photos` abierto para escritura, incluso sin sesión**
  (cualquiera podía subir y borrar fotos de cualquier antro). Se aplicó
  `sql/2026-11-11-club-photos-candado.sql` y, como eso no bastó, tres
  políticas **restrictivas** (`club_photos_restrictiva_insert`,
  `_update` y `_delete`): solo el dueño de la carpeta del club o el admin
  suben, sobrescriben o borran. Verificado el 11/11/2026 con sesiones
  reales: anónimo, cliente y dueño ajeno no pueden subir, sobrescribir ni
  borrar; el dueño sí desde `/dueno/panel`; el admin sí; la lectura pública
  y las fotos del listado y de la ficha siguen funcionando.
  **Ojo:** las políticas permisivas abiertas
  `club_photos_storage_insert_open` y `club_photos_storage_delete_open`
  **siguen existiendo**; están neutralizadas por las restrictivas (que se
  aplican con AND), pero conviene borrarlas para que no confundan. El SQL
  de las tres restrictivas está en `sql/2026-11-11-club-photos-restrictivas.sql`.
- **Comisiones, pagos por día y documentos de verificación**
  (`sql/2026-11-11-restrictivas-comisiones-y-pagos.sql`, 4 políticas
  restrictivas): staff, gerente y dueño ya no fabrican comisiones de RP ni
  pagos por día insertando directo (solo nacen por
  `registrar_comision_reserva` / `registrar_pago_dia`; fuera del admin solo
  se inserta el bono de plataforma, pendiente, de una reserva orgánica); el
  staff ya no lee `commissions`; el dueño ya no borra filas de
  `verificacion_documentos`. Verificado el 11/11/2026 con sesiones reales y
  con los flujos de la UI (check-in y consumo, bono orgánico, asistencia por
  QR y manual, nómina del RP, panel del gerente, dashboard del admin).
  **Ojo:** siguen existiendo, neutralizadas por las restrictivas, las
  permisivas viejas `commissions_insert_club_staff`,
  `rp_pagos_dia_insert_club_staff` y `verif_docs_delete`.
- Verificación de dueños: el bucket `verificacion-docs` solo lo usan el dueño
  de cada carpeta y el admin (verificado con dueño ajeno, cliente, RP, staff y
  anónimo); el dueño no puede autoverificarse, ni crear un antro ya
  verificado, ni tocar el bono.

### Datos de prueba en producción

Los antros de prueba "Antro Demo", "Lounge Elite" y "Club Nocturno XYZ" **se
quitaron de producción el 11/11/2026**, con sus reservas de prueba (6, todas
orgánicas y sin cliente ni RP), sus filas de `club_photos` y sus archivos del
bucket. No tenían dueño, staff, RPs, mesas ni comisiones. Quedan solo "SIX
GDL" y "El Vaquero" (este en `borrador`, así que el listado público muestra
solo SIX GDL). El respaldo completo está en
`backups/2026-11-11-antros-de-prueba.json`, **solo local**: `backups/` está en
`.gitignore` porque trae nombres y teléfonos.

El Vaquero tiene 3 fotos que son **copias de las fotos reales de SIX GDL**,
puestas a propósito para evaluar la galería. No son fotos reales de ese antro.

**Panic Room** (`8e433d37-ac56-407e-82a6-4e405d6d9fdc`), negocio real, se
cargó el 12/11/2026 como **borrador oculto**: `estado_verificacion =
'borrador'`, `suscripcion_activa = false`, sin dueño (`dueno_id` nulo), con 4
fotos tomadas de su Instagram (con su marca de agua, sin recortar).
**Pendiente de autorización del cliente**: no publicarlo ni verificarlo hasta
que la dé. Los datos y fotos originales viven en `demo-assets/panic-room/`,
que está en `.gitignore` (imágenes de un tercero, nunca a Git). Ojo: "oculto"
solo vale para la interfaz. Cualquier usuario con sesión puede leer su fila
de `clubs` por la API (ver sección 7, punto 9), cualquiera puede leer sus
filas de `club_photos`, y las fotos están en el bucket público.

Quedan cuentas que parecen de prueba (2 usuarios de auth sin perfil, "Landing
Test" y varios clientes de Diego). Se dejaron a propósito: borrarlas es
decisión de Diego.

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

Por prioridad:

1. **Reescribir `registrar_comision_reserva` y `registrar_pago_dia`**
   (versión actual en `sql/2026-11-11-funciones-registrar-ACTUALES.sql`)
   para que lean el consumo de `consumption_entries`, calculen la semana en
   `America/Mexico_City` dentro de la base, validen que la reserva
   pertenezca al RP y al club, y sean idempotentes. Hoy confían en datos
   del navegador (consumo y rango de la semana) y se pueden duplicar.
2. Mover el cálculo del bono de plataforma a una función en la base (hoy lo
   calcula el staff en el navegador y lo inserta directo).
3. Mover `bono_organica_*` y la config de comisiones de `clubs` a una tabla
   con lectura restringida: hoy cualquier usuario con sesión lee los
   términos de todos los antros (ver sección 7, punto 9).
4. Política de UPDATE en `commissions` para marcarlas pagadas, solo gerente
   y dueño (hoy nadie puede, ni el admin desde el navegador).
5. Cuenta de grupo, caja, coordinador de piso y alta masiva de RPs
   (plantillas de ~130 por antro).
6. El índice de "1 reserva por día"
   (`sql/2026-11-borrador-una-reserva-por-dia.sql`), junto con el cambio de
   código para mostrar un mensaje claro al rechazar un duplicado.
7. Arreglar el auto-deploy de Vercel.
8. El candado de `suscripcion_activa` en la base (sección 7, punto 2).
9. Un dueño con dos antros rompe `/dueno/panel`: soportar varios o impedir
   en la base que un dueño tenga dos.
10. Limpieza menor: borrar las permisivas viejas ya neutralizadas por
    restrictivas (`club_photos_storage_insert_open`,
    `club_photos_storage_delete_open`, `commissions_insert_club_staff`,
    `rp_pagos_dia_insert_club_staff` y `verif_docs_delete`).

---

## 10. Lecciones aprendidas

- **Las políticas permisivas de Storage se suman entre sí (OR).** Una sola
  política mal acotada (por ejemplo, sin filtrar `bucket_id`) abre **todos**
  los buckets aunque los demás tengan políticas correctas. Pasó con
  `verificacion-docs`: una política vieja dejaba a cualquier usuario con
  sesión leer, subir y borrar documentos privados. Para un bucket sensible,
  usar además una política **restrictiva** (`as restrictive`), que se aplica
  con AND sobre todas las demás. Y probar siempre con sesiones reales de cada
  rol, no solo leer las políticas.
- **Una política abierta heredada del demo (`using true`) sigue activa
  aunque se agreguen políticas nuevas, porque las permisivas se suman.** Al
  endurecer una tabla hay que listar y borrar las políticas viejas, no solo
  agregar las nuevas.
- **Un dueño con dos antros rompe `/dueno/panel`**: la consulta usa
  `.maybeSingle()` sobre `dueno_id`, y con dos filas falla y no muestra
  ninguno. Al crear datos de prueba, nunca dar dos clubs al mismo dueño si
  luego se va a abrir su panel.
- **Un dueño puede crear un antro con `suscripcion_activa = true`** directo
  contra la API. Lo que la UI no permite no está prohibido: cualquier campo
  que importe para publicar o cobrar tiene que estar protegido en la base
  (RLS o trigger).
- **Una función SECURITY DEFINER que recibe datos del cliente (montos,
  rangos de fechas) hereda toda la confianza que no debería.** Calcula
  dentro de la base lo que se pueda.
- **Un INSERT que "pasa" no significa que guardó lo que mandaste**:
  `clubs_candado_insert` corrige los valores en silencio. Para probar un
  candado, leer después lo que quedó guardado.
