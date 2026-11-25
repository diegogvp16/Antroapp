# Carril b-equipo

- **Etapa 1 — B7**, correos en modo «archivo» (24/11/2026): esta primera parte.
- **Etapa 2 — B12**, invitaciones por correo y la pantalla Equipo
  (24–25/11/2026): ver [más abajo](#etapa-2--b12-invitaciones-por-correo-y-pantalla-equipo).
- **Etapa 3 — B1**, importadores CSV de mesas y de personal (25/11/2026):
  ver [al final](#etapa-3--b1-importadores-csv-mesas-y-personal).
- **Correcciones de la revisión** (25/11/2026, tarde): cupos de invitaciones
  que suman sueltas y lotes, antro sin verificar, revocar con límite,
  «Volver a sacar los enlaces», lista por páginas, «Copiar todo» sin
  fórmulas y la carrera de reenviar. SQL 24. Ver
  [al final](#correcciones-de-la-revisión-25112026-tarde).

Rama `b-equipo` (desde `post-junta-2`). Todo se hizo en **antroapp-dev**;
producción no se tocó (ni lectura ni escritura).

> **Commits.** Los subagentes no pueden hacer commit (el sistema de permisos
> lo bloquea). El coordinador hizo el commit `a86d4d2` (B7 completo y B12
> PARCIAL). Lo que se terminó de B12 el 25/11 en la mañana, toda la etapa 3
> y las correcciones de la revisión quedaron **en el working tree** para que
> él los integre (la revisión lo marcó como defecto bajo: los SQL 22, 23 y
> 24 ya están aplicados en dev y no están en ningún commit).

# Etapa 1 — B7, correos en modo «archivo»

## Qué se hizo

### Punto único de envío: `lib/correo.ts` (solo servidor)

- `enviarCorreo(svc, { plantilla, para, asunto, texto, clubId?, ocultar? })`.
  Nunca lanza: si algo falla al mandar, no se rompe lo que lo provocó.
- Las reglas están en `lib/domain/correo.ts`, que es puro (sin `@/` ni
  `server-only`) para que las pruebas lo carguen con Node.
- **Modos** (`CORREO_MODO`):

  | Modo | Qué hace |
  |---|---|
  | `archivo` (**por defecto**, y con cualquier valor desconocido) | No manda nada. Guarda el correo en la bandeja. |
  | `enviar` | Manda con Resend y guarda el resultado (`enviado` o `fallido`). |
  | `apagado` | No manda ni guarda nada. |

- **Candado de entorno**: en modo `enviar` solo se manda de verdad si
  **las dos** cosas se cumplen:
  - `VERCEL_ENV=production`;
  - la URL de Supabase **no** es la de dev (`ygumrpckbtlngzspqdvo`).
    Así, un Preview mal configurado con `VERCEL_ENV=production` tampoco
    manda.

  En Preview, development o local solo se manda a los correos de
  `CORREO_LISTA_BLANCA`, con el asunto marcado «[Prueba]». A los demás se
  archiva con el motivo «Fuera de producción… no está en la lista blanca».
- Si faltan `RESEND_API_KEY` o el remitente (`CORREO_DE`, o `ALERTAS_DE`),
  todo se archiva y se muestra un aviso.
- **Datos que se limpian** antes de guardar o mandar:
  - el destinatario es uno solo, validado y en minúsculas (sin listas ni
    «Nombre <correo>»);
  - el asunto queda en una sola línea, sin saltos que inyecten cabeceras, y
    con 200 caracteres como máximo;
  - el cuerpo se corta a 20,000 caracteres.
- `ocultar: [...]`: esos textos (enlaces con token, contraseñas temporales)
  **sí van en el correo**, pero en la bandeja quedan como «[oculto]».
- Cada envío lleva la cabecera `Idempotency-Key: correo-<id>` (la que pide
  Resend), con un tiempo límite de 5 s. Los errores se registran con
  `registrarError` (solo etiqueta y código).
- Si la bandeja falla:
  - en modo `enviar`, el correo se manda igual;
  - en modo `archivo`, se reporta `fallido`.
- `purgarCorreos(svc, 30)`: la tarea diaria (`/api/cron/mensualidad`) la
  llama **siempre**, antes de revisar la bandera de la mensualidad.

### Bandeja `correos_salida` (SQL 20)

Columnas:
- `destinatario`, `asunto`, `cuerpo` (sin lo ocultado) y `plantilla`;
- `estado`: `archivado | enviado | fallido`;
- `motivo`, `entorno`, `club_id`, `proveedor_id`, `enviado_en` y
  `creado_en`.

Permisos:
- RLS: solo el **admin** puede hacer `select`, con
  `coalesce(current_role_name() = 'admin', false)`. No pasan la cuenta sin
  perfil, el admin dado de baja ni el admin con contraseña temporal.
- No hay políticas de escritura. Los GRANT son explícitos: `revoke all from
  public, anon, authenticated`, `grant select to authenticated` y
  `grant all to service_role`.
- `correos_purgar(p_dias)`: `SECURITY DEFINER` con `search_path = ''`, solo
  para `service_role`. Acepta de 7 a 365 días (con `coalesce`, así que un
  valor nulo se rechaza).

### Pantalla `/admin/correos`

- Botón «Bandeja de correos» en `/admin`, junto a «Mensualidades».
- Arriba, el **modo de envío** actual (archivo, enviar, en prueba, sin llave
  o apagado), el entorno y los avisos. Sale de `GET /api/admin/correos`,
  que solo responde al admin: valida la cookie, lee el rol de la base y
  rechaza la contraseña temporal. Responde sin caché y nunca devuelve la
  llave ni el remitente, solo si existen.
- Aviso fijo: los correos de Supabase no aparecen aquí.
- Filtros: Todos, Archivados, Enviados y Fallidos. Muestra 30 por página,
  con «Ver más».
- Al tocar un correo se abre el detalle: para, tipo, entorno, motivo,
  enviado e id en Resend. El cuerpo se carga solo al abrirlo.
- Estados de cargando, vacío y error (con «Reintentar»).
- **No hay botón para mandar ni para reenviar.**

### Envíos existentes que ahora pasan por ahí

El único envío propio era `lib/alertas.ts`, que llamaba directo a Resend.
Lo usan:
- el pico de errores (`/api/errores`);
- el cobro fallido (`lib/mensualidad/webhook.ts`, que ahora pasa el
  `club_id`);
- la tarea diaria de la mensualidad.

`enviarAlerta` conserva su límite de una alerta por tipo por hora
(`alertas_enviadas`) y ahora llama a `enviarCorreo`:
- plantilla: `alerta:<tipo>`;
- generar la alerta requiere `ALERTAS_CORREO=1` y `ALERTAS_PARA`;
- si llega o no, lo decide `CORREO_MODO`.

No hay otro `fetch` a proveedores de correo en `app/`, `lib/` ni
`components/` (revisado con grep).

### Correos que NO cubre

Los manda **Supabase Auth** con su propio SMTP, no la app:
- recuperar contraseña (`app/recuperar-contrasena`,
  `resetPasswordForEmail`);
- confirmar el registro (`signUp` en `/cliente/signup`, `/dueno/signup` y
  `/api/auth/registro`);
- cambio de correo y enlaces mágicos, si algún día se encienden.

No quedan en la bandeja ni respetan `CORREO_MODO`. Para cubrirlos haría
falta el **Send Email Hook** de Supabase hacia una ruta firmada de la app
(fase aparte). En dev, la confirmación por correo está encendida y la
limita el cupo de Supabase.

## SQL, en orden

1. `sql/post-junta-2/20-correos-salida.sql`
   Rollback: `sql/post-junta-2/20-correos-salida-rollback.sql`. Borra la
   función y la tabla. El código sobrevive sin la tabla: registra el error
   y, en modo `enviar`, manda igual.

En dev se aplicó, se probó, se aplicó el rollback (tabla 0, función 0), se
volvió a aplicar (tabla 1, función 1) y se probó otra vez: 44/44. **Dev
queda CON el SQL aplicado.**

Producción: va en el pase 2, **antes** del merge del código. Si el código
llega primero, la tabla no existe: las alertas en modo archivo se pierden
(con error en el log) y la purga diaria falla sin romper la tarea.

## Pruebas automáticas (resultados reales)

`node scripts/dev/probar-correos.mjs [--base=URL] [--alertas] [--modo=…] [--pantalla]`
(Playwright con `PLAYWRIGHT_DESDE`).

| Corrida | Resultado |
|---|---|
| Solo base (reglas puras, `procesarCorreo` con base real y fetch falso, RLS por 10 sujetos, purga) | **44/44** |
| + ruta + alerta de punta a punta + pantalla, servidor con `ALERTAS_CORREO=1 CORREO_MODO=enviar RESEND_API_KEY=re_falsa_prueba` (local) | **69/69** |
| + ruta + pantalla, servidor con el modo por defecto (archivo) | **66/66** |
| Regresión `probar-monitoreo.mjs` contra el mismo servidor | **8/8** |

Qué cubren:
- **Modo**: sin variable es `archivo`, y un valor raro también; `apagado`
  no deja fila ni hace llamadas.
- **Fuera de producción**: `enviar` en preview, development y local archiva
  con **0 llamadas** al proveedor. Con `VERCEL_ENV=production` pero la base
  de dev, también archiva. Con lista blanca, 1 llamada con «[Prueba]».
- **Producción simulada**:
  - se manda el texto completo y la bandeja guarda «[oculto]»;
  - si el proveedor responde 500, queda `fallido`;
  - si no responde (timeout), queda `fallido`;
  - si la bandeja está caída, el correo sale igual.
- **RLS**: anónimo, cliente, RP, staff, gerente, dueño, cuenta sin perfil,
  admin dado de baja y admin con contraseña temporal leen 0 filas y no
  insertan, actualizan, borran ni purgan. El admin lee todo, pero tampoco
  escribe ni purga desde el navegador.
- **Purga**: borra lo de hace 40 días, deja lo reciente y rechaza menos de
  7 días o un valor nulo.
- **Ruta**: sin sesión, 401; cliente, staff, gerente, dueño y admin con
  contraseña temporal, 403; admin, 200 sin secretos y `no-store`.
- **Alerta de punta a punta**: 11 errores por `/api/errores` dejan **un**
  correo `alerta:pico_errores`, archivado («Fuera de producción (local)») y
  sin correos en el cuerpo.
- **Pantalla** a 390 y 360 px:
  - el enlace desde `/admin`, el aviso de Supabase, el detalle con
    «[oculto]» y el filtro Fallidos funcionan;
  - sin scroll horizontal;
  - todos los controles miden 40 px o más;
  - 0 errores de página.
  - Capturas en `screenshots-b-equipo/` (ignorada por git): las revisé, se
    ven bien en el tema oscuro de admin.
- **Limpieza**: borra sus cuentas `t_equipo_*` y sus filas, aunque falle.
  Terminó en 0 correos `t_equipo_`. En la corrida con alerta, también
  borra la fila de `alertas_enviadas` y sus errores de prueba.

**Build**: `next build` con `NEXT_DIST_DIR=.next-build` y las llaves de dev
(con `servidor-prod-dev.mjs`) salió bien; `tsconfig.json` no cambió.
`npx tsc --noEmit` y `npx eslint` de los archivos tocados: limpios.

**Nota del entorno**: el servidor de desarrollo (Turbopack) **no arranca en
el worktree**. `node_modules` es un junction a la carpeta principal y
Turbopack lo rechaza («Symlink node_modules is invalid»). Por eso las
pruebas de pantalla se hicieron contra el build de producción
(`PUERTO=3022 node scripts/dev/servidor-prod-dev.mjs`).

## Prueba manual, clic a clic

1. Aplica `sql/post-junta-2/20-correos-salida.sql` en dev (ya está).
2. Levanta la app contra dev: `node scripts/dev/servidor-dev.mjs`, en la
   carpeta principal. En un worktree usa `servidor-prod-dev.mjs`.
3. Entra en `/cliente/login` como **`dev_admin@example.com`** (la
   contraseña está en `backups/dev-credenciales.json`). Debe llevarte a
   `/admin`.
4. Toca **«Bandeja de correos»**. Debes ver:
   - «Modo de envío: **Archivo**»;
   - el aviso de los correos de Supabase;
   - «Todavía no hay correos en la bandeja», si está vacía.
5. Para ver una alerta archivada:
   1. Para el servidor y levántalo con
      `ALERTAS_CORREO=1 ALERTAS_PARA=<tu correo>`.
   2. Provoca 10 errores en 10 minutos, por ejemplo con
      `curl -X POST localhost:3001/api/errores -H 'content-type: application/json' -d '{"mensaje":"prueba manual"}'`
      diez veces.
   3. Recarga la bandeja: aparece «[AntroApp] N errores en 10 minutos»,
      **Archivado**. Tócalo para ver el texto.
   4. No llega nada a tu correo.
   5. Al terminar, borra la fila `pico_errores` de `alertas_enviadas` y tus
      errores de prueba de `app_errores`. Si no, `probar-monitoreo` falla
      durante una hora.
6. Con **`dev_gerente@example.com`** (o cualquier otro rol), abre
   `/admin/correos`: te regresa a `/admin/login`.
7. En una vista previa de Vercel, con `CORREO_MODO=enviar`, la llave y
   `CORREO_LISTA_BLANCA=<tu correo>`: la alerta te llega con el asunto
   «[Prueba] [AntroApp] …» y en la bandeja sale **Enviado** con su id de
   Resend. Esto **no se probó** porque no hay llave real de Resend.

## Decisiones pendientes para Diego

1. **En producción, ¿`archivo` o `enviar`?** El valor por defecto es
   `archivo`, así que en producción **nadie recibe nada** hasta que pongas
   `CORREO_MODO=enviar`. Ojo: antes bastaba con `ALERTAS_CORREO=1` y la
   llave. Ya lo actualicé en `docs/operacion.md`, pero las alertas aún no
   están en producción.
2. **`apagado` no guarda nada.** ¿Prefieres que también deje registro
   («no mandado: modo apagado»)?
3. **Purga a 30 días** para todos los estados. ¿Más tiempo para los
   enviados?
4. **Correos de Supabase Auth**: ¿se mete el Send Email Hook para que
   también pasen por la bandeja y por la lista blanca en Preview? Es otra
   fase y necesita configurar el dashboard de Supabase.
5. **Lista blanca**: solo acepta correos exactos, no dominios
   (`@tu-dominio`). Es más seguro; ¿te sirve así?

## Riesgos

- **Datos personales**: la bandeja guarda correos de destinatarios. Hoy solo
  hay alertas al admin, sin datos de clientes. Cuando B12 (invitaciones)
  mande enlaces, **debe** pasarlos en `ocultar`. Ya está en el inventario
  legal (`docs/legal/inventario-datos.md`).
- **Prueba de alerta en la base compartida**: durante segundos deja una
  fila `pico_errores` en `alertas_enviadas`. Si otro agente corre
  `probar-monitoreo` justo en ese momento, verá 1 en lugar de 0. Por eso
  `--alertas` es opcional.
- **Cambio en la tarea diaria**: ahora llama a `correos_purgar` aunque la
  mensualidad esté apagada. Si la función no existe, solo registra el error
  y sigue.
- **Para el coordinador**: `ensayo-pase2.mjs` y `pase-produccion.md` no
  conocen el SQL 20 (no los edité). Agrega su paso al pase 2 y al ensayo:
  antes del merge, con su rollback.

## Archivos

Nuevos:
- `sql/post-junta-2/20-correos-salida.sql`
- `sql/post-junta-2/20-correos-salida-rollback.sql`
- `lib/domain/correo.ts`
- `lib/correo.ts`
- `app/api/admin/correos/route.ts`
- `app/admin/correos/page.tsx`
- `components/admin/bandeja-correos.tsx`
- `scripts/dev/probar-correos.mjs`
- este documento

Modificados:
- `lib/alertas.ts`
- `lib/mensualidad/webhook.ts`
- `app/api/cron/mensualidad/route.ts`
- `app/admin/page.tsx`
- `docs/operacion.md`
- `docs/legal/inventario-datos.md`

---

# Etapa 2 — B12, invitaciones por correo y pantalla Equipo

24–25/11/2026. La primera parte se cortó por el límite de uso a las 23:40
del 24/11, y el coordinador la guardó en el commit `a86d4d2` como PARCIAL.
El 25/11 en la mañana:
- se revisó contra el código y la base;
- se corrigió lo que faltaba;
- se probó todo;
- se hizo en dev el ciclo aplicar → rollback → aplicar.

## Qué se hizo, por función

### 1. Invitar (dueño, gerente, staff y admin)

- La ruta es `POST /api/equipo/invitar` (`app/api/equipo/invitar/route.ts`),
  con `accion: "crear"` o `"reenviar"`.
- **Quién puede invitar lo decide la base, con la sesión de quien llama**
  (la cookie), no la service role: la ruta llama a `invitacion_crear` o a
  `invitacion_reenviar` como ese usuario. La matriz vive en un solo lugar,
  `invitacion_puede`, que siempre responde `true` o `false`, nunca NULL:

  | Quien invita | Puede invitar a | Dónde |
  |---|---|---|
  | admin | gerente, staff, RP | cualquier antro que exista |
  | dueño | gerente, staff, RP | solo en SUS antros (`club_es_dueno`) |
  | gerente, staff | solo RP | solo en SU antro |
  | RP, cliente, cuenta sin perfil, dado de baja, con contraseña temporal, anónimo | nadie | — |

  Nadie puede invitar a un `dueno` ni a un `admin`: lo rechazan la
  validación de la ruta y la base. El gerente tampoco invita gerentes ni
  staff, porque son de su mismo rango o mayor.
- **El club y el rol quedan fijos en la fila** desde que se invita, y al
  aceptar se toman de ahí. El club que manda el navegador solo dice «a
  dónde»: si no es de quien invita, la base lo rechaza (403).
- Después, con la service role, `invitacion_emitir_token` genera el token:
  - 32 bytes al azar (dos UUID v4 de Postgres pasados por sha256), escritos
    como 64 caracteres hexadecimales;
  - **en la base solo queda su sha256**;
  - quien invita nunca lo ve: la respuesta de la ruta no lo trae;
  - vence a las **72 h**.
- El correo sale por **`lib/correo.ts`** (B7), con la plantilla
  `invitacion` o `invitacion:reenvio`. El enlace va en `ocultar` y con
  `mostrarSiSeArchiva`:
  - si el correo **se manda**, en la bandeja queda «[oculto]»;
  - si **se archiva** (modo `archivo`, el de hoy), queda completo para que
    el admin lo copie desde `/admin/correos`. Para eso hay un botón nuevo,
    **«Copiar enlace de la invitación»**, que solo sale en las invitaciones
    archivadas.
- A quien invita se le dice qué pasó: «Invitación enviada por correo» o
  «quedó en la bandeja y el admin le hará llegar el enlace».

### 2. Aceptar: `/invitacion/[token]` (página pública)

- La página es `app/invitacion/[token]/page.tsx`:
  - usa el tema control, con `referrer: no-referrer` y `noindex`;
  - muestra el antro, el rol, el nombre y el correo de la invitación;
  - pide la contraseña (mínimo 8 caracteres) dos veces;
  - cubre los estados de cargando, formulario, usada, vencida, revocada,
    inexistente o mal copiada (con «Reintentar») y sin conexión;
  - al terminar dice «Tu cuenta está lista» y ofrece «Iniciar sesión».
- La ruta es `POST /api/invitacion` (`consultar` o `aceptar`) y no pide
  sesión. En orden:
  1. Límite por IP (la IP se guarda en hash en `invitacion_intentos`): 30
     consultas y 10 aceptaciones por hora; después responde 429.
  2. Busca la invitación **solo por el hash del token**
     (`invitacion_consultar`, que no devuelve ids).
  3. Crea la cuenta de Auth con **el correo de la invitación** (nunca uno
     que mande el navegador), `email_confirm: true` y
     `app_metadata.invitacion_id`.
  4. Llama a `invitacion_aceptar` (solo service role), en una transacción y
     con la fila bloqueada. Revisa que la invitación siga pendiente y que la
     cuenta sea la recién creada **para esta invitación**: mismo correo,
     marcada con su id, creada hace menos de 10 minutos y sin perfil. Crea
     el perfil con **el rol, el club y el nombre de la invitación** y la
     marca aceptada. **Sirve una sola vez.**
  5. Si la base dice que no, borra la cuenta recién creada.
- Si el navegador manda `rol`, `role`, `club_id`, `correo` o `email`, zod
  los descarta y no se usan.
- **Nunca se liga una cuenta que ya existía.** Si el correo ya tiene cuenta
  (de cliente, de otro antro o de Auth sin perfil), la ruta responde 409
  «Ese correo ya tiene una cuenta…» y no toca esa cuenta ni su contraseña.
- **Corregido hoy**: con dos o tres «Crear mi cuenta» a la vez (doble
  toque, o un reintento con mala señal), una ganaba y las otras recibían un
  **500**. Ahora la ruta vuelve a consultar la invitación y, si ya quedó
  aceptada, responde 410 «Esta invitación ya se usó. Inicia sesión con tu
  correo».

### 3. Reenviar y revocar

- **Reenviar** (`invitacion_reenviar`, con la sesión):
  - borra el hash anterior, así que el enlace viejo deja de existir (404);
  - da otras 72 h y el servidor emite un token nuevo;
  - también sirve para una invitación **vencida**, pero no para una aceptada
    ni para una revocada;
  - entre dos envíos de la misma invitación hay que esperar **2 minutos**.
- **Revocar** (`invitacion_revocar`, desde la pantalla con la sesión y con
  confirmación):
  - cierra la invitación; el enlace responde «Esta invitación fue
    cancelada»;
  - una invitación aceptada no se revoca: a esa persona se le da de baja en
    Equipo.
- Si no hay permiso o la invitación es de otro antro, la respuesta es «No
  encontramos esa invitación», para no revelar si existe.
- **Estados**:
  - `pendiente`;
  - `aceptada`;
  - `vencida` (ya pasó `expira_en`);
  - `revocada`.

  Se calculan igual en la base (`invitacion_estado`) y en la pantalla
  (`lib/domain/invitaciones.ts`).

### 4. Límites de tasa

| Límite | Dónde |
|---|---|
| 30 envíos (crear y reenviar) por persona por hora | base (`invitacion_envios`, con candado por persona). **Desde el SQL 24** hay además topes que suman sueltas y lotes, el cupo de antro sin verificar y el límite de revocar: ver «Correcciones de la revisión», al final |
| 2 minutos entre envíos de la misma invitación | base |
| 400 invitaciones pendientes por antro | base |
| 1 pendiente por correo y antro (candado por antro y correo) | base |
| 30 consultas y 10 aceptaciones por IP por hora | ruta pública (`invitacion_intentos`) |

La tarea diaria (`/api/cron/mensualidad`) llama a `invitaciones_limpiar`,
que borra los intentos de más de 7 días y los envíos de más de 30. Las
invitaciones se conservan, porque son la bitácora de quién invitó a quién.

### 5. Pantalla «Equipo»

Está en `/dueno/equipo` y, para el gerente, en `/staff/equipo`. Reusa
`components/equipo/*` (`PantallaEquipo`, `EquipoPersonal` y
`RegistroActividad`) y agrega dos secciones:

- **Invitar por correo** (`components/equipo/invitar-personal.tsx`):
  - pide nombre, correo y rol. El dueño elige Gerente, Staff o RP; el
    gerente solo ve «Puedes invitar RPs»;
  - lista las últimas 50 invitaciones con estado, fecha, «Reenviar» y
    «Revocar» (con confirmación);
  - tiene estados de cargando, vacío y error con «Reintentar»;
  - la lista la filtra la base: el gerente solo ve las de RP.
- **Permisos de caja** (`components/equipo/permisos-caja.tsx`):
  - muestra la matriz de 9 permisos para staff y gerente, con el valor que
    aplica: el de la casilla guardada o, si no hay, el valor por defecto,
    igual que `caja_tiene_permiso`;
  - muestra también las excepciones por persona;
  - **el dueño la edita** con `caja_configurar_permiso`, que solo deja al
    dueño y al admin;
  - **el gerente la ve en solo lectura**, con el aviso «Solo el dueño
    cambia estos permisos».

Para entrar: en `/dueno/panel`, el botón «Invitar por correo, permisos y
actividad»; en `/staff/panel` (solo el gerente), «Equipo e invitaciones».

### 6. Hueco menor cerrado en `create-staff`

`/api/admin/create-staff` leía `profiles.role` directo y no revisaba
`app_metadata.debe_cambiar`. Así, una cuenta con contraseña temporal (que
en la base todavía no tiene rol) podía crear personal por esa ruta. Ahora
responde 403 «Primero cambia tu contraseña temporal». Probado: 403 y 0
cuentas creadas.

## SQL, en orden

1. `sql/post-junta-2/20-correos-salida.sql` (de la etapa 1, descrito
   arriba).
2. `sql/post-junta-2/21-invitaciones.sql`, que requiere el 20.

   Rollback: `sql/post-junta-2/21-invitaciones-rollback.sql`. Borra 8
   funciones, las 3 tablas (`invitaciones`, `invitacion_envios` e
   `invitacion_intentos`) con su historial y, al final, la novena,
   `invitacion_puede`, porque la usa la política. **No toca** las cuentas ni los perfiles que ya
   se crearon al aceptar invitaciones: son personal normal del antro.

Qué crea el 21:
- **Tablas con RLS y GRANT explícitos**:
  - `revoke all from public, anon, authenticated`;
  - `authenticated` solo tiene `select`, y **por columnas**: sin
    `token_hash`;
  - `service_role` tiene todo;
  - `invitacion_envios` e `invitacion_intentos` son solo de la service
    role.
- **Políticas**: `invitaciones_select` (cada quien ve las invitaciones que
  podría gestionar, con `coalesce`) y restrictivas en `false` para insert,
  update y delete.
- **Funciones** `SECURITY DEFINER` con `search_path = ''` y `revoke … from
  public, anon`:
  - para `authenticated`: `invitacion_puede`, `invitacion_crear`,
    `invitacion_reenviar` e `invitacion_revocar`;
  - solo para la service role: `invitacion_emitir_token`,
    `invitacion_consultar`, `invitacion_aceptar` e `invitaciones_limpiar`;
  - `invitacion_estado` es una función `sql` simple, sin definer.

En producción (pase 2) van el 20 y después el 21, **antes** del merge del
código. Si el código llega primero:
- invitar responde «No se pudo guardar la invitación» (500, con el error en
  el log);
- la página pública dice «No pudimos revisar la invitación»;
- no se rompe nada más, y `create-staff` sigue igual.

### Ciclo en dev (25/11, mañana)

| Paso | Tablas | Funciones `invitaci*` | Políticas |
|---|---|---|---|
| Antes (21 aplicado desde la noche) | 3 | 9 | 4 |
| Después del rollback | 0 | 0 | 0 |
| Después de volver a aplicar | 3 | 9 | 4 |

Los dos archivos están en LF. Antes del rollback esperé a que terminara una
prueba de otro carril (`t_rls_…`) que estaba usando la tabla
`invitaciones`, para no romperla.

## Pruebas automáticas (resultados reales)

`node scripts/dev/probar-invitaciones.mjs [--base=URL] [--pantalla]`, con
Playwright por `PLAYWRIGHT_DESDE`. El servidor corre con `CORREO_MODO` sin
definir (`archivo`), porque el enlace se toma de la bandeja.

| Corrida | Resultado |
|---|---|
| Solo base (reglas puras, matriz por rol, RLS, escritura directa, límites, aceptar por la función) | **87/87** |
| + rutas y pantallas, antes de las correcciones de hoy | **167/167** |
| + rutas y pantallas, después del rollback y la reaplicación, con las correcciones de hoy | **183/183** |

Qué cubren las pruebas que pidió la tarea:

- **Token reutilizado**: 410 «ya se usó» y sigue habiendo UNA cuenta con ese
  correo; consultarlo dice «aceptada».
- **Token vencido**: 410 «venció» y no se crea cuenta. Al reenviar sale un
  token nuevo, el anterior da 404 y con el nuevo sí se entra.
- **Token revocado**: 410 «cancelada» y no se crea cuenta.
- **Rol manipulado**:
  - si el cuerpo de aceptar trae `rol: gerente`, `role: admin`, `club_id` de
    Club Demo Dev y otro correo, nace un RP en el antro de la invitación y
    no se crea cuenta con el otro correo;
  - `rol: admin` al invitar da 400;
  - invitar a un dueño o admin se rechaza en la base;
  - `UPDATE` directo del rol se rechaza y el rol sigue igual.
- **Club ajeno**:
  - un dueño en Club Demo Dev, un gerente con `club_id` ajeno (403) y el
    gerente de Club Demo Dev en el antro de prueba: rechazados;
  - un dueño ajeno no revoca ni cambia la matriz de caja.
- **Cuenta sin perfil**:
  - no invita, ni por la base ni por la ruta (403);
  - `invitacion_puede` le responde `false`, no NULL;
  - no ve invitaciones y no reenvía;
  - aceptar con una cuenta sin perfil que ya existía se rechaza («no
    corresponde»), y si el correo de la invitación es el suyo, la ruta da
    409, la cuenta conserva su contraseña y sigue sin perfil.

Además:
- la matriz completa por rol (dueño, gerente, staff, RP, cliente, dado de
  baja, contraseña temporal de gerente y de dueño, admin y anónimo);
- club o rol nulos, antro inexistente, correo inválido y duplicado
  pendiente; ninguna invitación rechazada queda guardada;
- quién ve qué por RLS; nadie lee `token_hash` desde el navegador;
  `INSERT`, `UPDATE` y `DELETE` directos rechazados;
- las funciones de solo servidor no las ejecuta ni el dueño ni el anónimo;
- en la base solo queda el sha256 del token, y no se emite un segundo token
  sin reenviar;
- límites: 30 por hora por persona, 400 pendientes por antro, 2 minutos
  entre reenvíos y 429 por IP al consultar (31.ª) y al aceptar (11.ª);
- 3 aceptaciones a la vez: gana 1, las otras dicen «ya se usó» (antes,
  500) y queda una sola cuenta;
- invitaciones de **gerente** y de **staff** aceptadas de punta a punta: el
  perfil nace con ese rol en su antro y la persona entra por
  `/api/auth/login`;
- `create-staff` con contraseña temporal da 403;
- la matriz de caja: el dueño la cambia; el gerente la ve pero no la cambia;
  el staff y un dueño ajeno no la cambian;
- en la bandeja, «archivado» conserva el enlace y «enviado» guarda
  «[oculto]»; «Copiar enlace» encuentra el enlace completo y nada más.

**Pantallas** a 390×844 y 360×740:
- `/dueno/equipo`: 3 roles para invitar y la matriz editable (18 botones);
- `/staff/equipo` (gerente): solo RP y la matriz en solo lectura;
- la lista muestra 5 invitaciones y «Ver todas (N)»;
- `/invitacion/<token>` en formulario, aceptada desde la pantalla,
  inexistente y usada; la página no manda Referer;
- `/admin/correos`: «Copiar enlace de la invitación» copia el enlace;
- en todas: sin scroll horizontal, todos los controles de 40 px o más y 0
  errores de página.

Capturas en `screenshots-b-equipo/b12-*.png` (ignorada por git). Las
revisé:
- la página de invitación se ve limpia en el tema claro de control;
- en la de Equipo, **la lista larga de invitaciones empujaba todo lo demás**
  (más de 15 tarjetas antes de «Staff y gerentes»). Lo arreglé: ahora salen
  primero las pendientes y vencidas, solo 5, con «Ver todas (N)».

**Limpieza**: cada corrida borra sus cuentas `t_equipo_*`, sus antros, sus
invitaciones, sus correos y sus intentos, aunque falle. Una corrida que se
cortó a la mitad (25/11, 09:34) dejó 11 cuentas, 2 antros y 407
invitaciones de prueba: las borré a mano por su sufijo, sin tocar las
`t_rls_…` de otro carril.

`npx tsc --noEmit` y `npx eslint` de los archivos tocados: limpios.
`NEXT_DIST_DIR=.next-build npx next build` con las llaves de dev: bien;
`tsconfig.json` no cambió.

**Servidor**: `npx next dev -p 3022` sin Turbopack, con las variables de
`.env.dev` (en el worktree, Turbopack rechaza el `node_modules` enlazado).

## Prueba manual, clic a clic (dev)

Antes: levanta la app contra dev. En la carpeta principal usa
`node scripts/dev/servidor-dev.mjs`; en un worktree, `set -a; . ./.env.dev;
set +a; npx next dev -p 3022`. Deja `CORREO_MODO` sin definir. Las
contraseñas de `dev_*` están en `backups/dev-credenciales.json`.

1. **Dueño invita.** Entra en `/cliente/login` como
   **`dev_dueno@example.com`**. En el panel toca **«Invitar por correo,
   permisos y actividad»**.
   - Arriba ves «Invitar por correo» con Gerente, Staff y RP.
   - Escribe tu nombre y un correo tuyo que **no** tenga cuenta en dev,
     elige **RP** y toca **«Invitar como RP»**.
   - Debe decir «Invitación creada. Por ahora los correos no salen: quedó en
     la bandeja…», y la invitación aparece en la lista como **Pendiente**,
     con «vence el …» (72 h).
2. **Admin copia el enlace.** En otra ventana privada entra como
   **`dev_admin@example.com`** → **«Bandeja de correos»** →
   **«Archivados»**. Toca «Te invitaron a Club Demo Dev en AntroApp (RP)» y
   luego **«Copiar enlace de la invitación»**: debe decir «Copiado.».
3. **Aceptar.** Pega el enlace en una tercera ventana privada.
   - Debe decir «Únete a Club Demo Dev · Te invitaron como RP», con tu
     nombre y correo.
   - Pon una contraseña de 8 o más, repítela y toca **«Crear mi cuenta»**.
     Debe salir «Tu cuenta está lista».
   - Toca **«Iniciar sesión»** y entra con ese correo: te lleva a
     `/rp/panel` de Club Demo Dev.
4. **Reutilizar.** Vuelve a abrir el mismo enlace: «Esta invitación ya se
   usó». En `/dueno/equipo`, la invitación sale **Aceptada**.
5. **Reenviar y revocar.**
   - Invita otro correo como **Staff**.
   - Toca **«Reenviar»** enseguida: «Acabas de enviarla. Espera un par de
     minutos…».
   - Después de 2 minutos, **«Reenviar»** otra vez: «Invitación reenviada
     (el enlace anterior ya no sirve)…». En la bandeja hay dos correos: el
     enlace del primero da «No pudimos abrir la invitación» y el del segundo
     sirve.
   - Toca **«Revocar»** → **«Sí, revocar»**: la invitación pasa a
     **Revocada** y su enlace dice «Esta invitación se canceló».
6. **Gerente.** Entra como **`dev_gerente@example.com`** →
   **«Equipo e invitaciones»**.
   - Solo puede invitar RPs («Puedes invitar RPs. A staff y gerentes los
     invita el dueño»).
   - En la lista solo ve las invitaciones de RP, no la de Staff del paso 5.
   - En «Permisos de caja» ve la tabla con etiquetas **Sí/No** (sin
     botones) y el aviso «Solo el dueño cambia estos permisos».
7. **Matriz de caja (dueño).**
   - En `/dueno/equipo`, en «Permisos de caja», toca **«No»** en «Anular
     consumos y pagos» para Staff: pasa a **«Sí»** y dice «Guardado».
     Vuelve a tocarlo para dejarlo en «No».
   - En «Excepciones por persona», elige a alguien de **Staff**, el
     permiso «Anular consumos y pagos» y **«Permitir»** → **«Guardar
     excepción»**: aparece en la lista con «Sí». Tócalo para dejarlo en
     «No». Ojo: las excepciones no se borran; con «No» en «Anular» queda
     igual que el valor por defecto del staff, así que Club Demo Dev se
     comporta como antes.
8. **Correo con cuenta.** Invita como RP el correo de
   **`dev_cliente@example.com`**, copia el enlace (paso 2) y acéptalo:
   «Ese correo ya tiene una cuenta en AntroApp…». El cliente sigue
   entrando con su contraseña de siempre.
9. **Limpieza.** Revoca lo que quedó pendiente. La cuenta de los pasos 3 y 4
   es una RP real en dev: dala de baja en «Equipo» o bórrala con la service
   role.

## Decisiones pendientes para Diego

1. **¿El gerente invita staff?** Hoy el gerente y el staff solo invitan RPs
   (la misma matriz de `create-staff`, como pidió la tarea). La petición
   original decía «dueño o gerente invitan staff y RPs». Si dices que sí, es
   una línea en `invitacion_puede` y otra en `rolesQuePuedeInvitar`.
2. **El staff puede invitar RPs por la ruta, pero no tiene pantalla.** Hoy
   da de alta RPs desde su panel con `create-staff` (contraseña puesta por
   él). ¿Le agrego «Invitar por correo» en `/staff/panel` o se queda así?
3. **El token va en la ruta** (`/invitacion/<token>`), como pidió la tarea.
   La página no manda Referer y no se indexa, pero la ruta queda en los logs
   de Vercel. Alternativa: `/invitacion#<token>` (el fragmento no llega al
   servidor). ¿La cambio?
4. **Invitaciones de alguien dado de baja**: siguen vivas hasta que venzan
   (72 h) o el dueño las revoque. ¿Las revoco solas al dar de baja a quien
   invitó?
5. **«Correo ya tiene cuenta»**: hoy solo se sabe al aceptar (409). Avisar
   al invitar revelaría a quien invita que ese correo existe en AntroApp; por
   eso no lo hice. ¿Así está bien?
6. **Actividad**: la aceptación no aparece en «Actividad»
   (`personal_movimientos` solo admite `baja` y `reactivacion`). La bitácora
   está en la propia tabla (`invitado_por`, `aceptada_por`). ¿La agrego ahí,
   aunque eso cambie el check de otra tabla?
7. **Admin sin pantalla de invitar**: el admin puede invitar por la ruta en
   cualquier antro, pero no tiene botón. ¿Hace falta?
8. **Las excepciones de caja no se pueden quitar, solo cambiar entre Sí y
   No**: `caja_configurar_permiso` no borra filas. ¿Agrego en la base un
   «volver a lo del rol»?

## Riesgos

- **Enlaces completos en la bandeja**: en modo `archivo` (el de hoy), el
  enlace con token queda en `correos_salida`. Solo el admin lo lee (RLS),
  sirve una vez, vence en 72 h y la bandeja se purga a los 30 días. Si el
  correo se manda de verdad, queda «[oculto]».
- **Cuenta huérfana**: si `invitacion_aceptar` falla y además falla el
  borrado de la cuenta recién creada, queda una cuenta de Auth sin perfil
  con ese correo (se registra el error). La persona vería después «Ese
  correo ya tiene una cuenta»: hay que borrarla a mano.
- **IP para el límite**: sale de `x-forwarded-for`, igual que en el login.
  En Vercel ese valor lo pone el proxy; en local se puede falsear (las
  pruebas lo usan para no toparse).
- **Base compartida**: la prueba crea 400 invitaciones de un antro propio
  para probar el límite; las borra al final. Otro carril (`t_rls_…`) también
  prueba sobre estas tablas: si se cruzan los tiempos, ninguna toca filas de
  la otra.
- **Para el coordinador**: `ensayo-pase2.mjs` y `pase-produccion.md` no
  conocen el SQL 21 (no los edité). Agrega su paso al pase 2, después del 20
  y antes del merge, con su rollback.

## Archivos de la etapa 2

Nuevos:
- `sql/post-junta-2/21-invitaciones.sql`
- `sql/post-junta-2/21-invitaciones-rollback.sql`
- `lib/domain/invitaciones.ts`
- `lib/domain/permisos-caja.ts`
- `app/api/equipo/invitar/route.ts`
- `app/api/invitacion/route.ts`
- `app/invitacion/layout.tsx`
- `app/invitacion/[token]/page.tsx`
- `components/equipo/invitar-personal.tsx`
- `components/equipo/permisos-caja.tsx`
- `scripts/dev/probar-invitaciones.mjs`

Modificados:
- `components/equipo/pantalla-equipo.tsx`
- `components/admin/bandeja-correos.tsx` (botón «Copiar enlace»)
- `app/api/admin/create-staff/route.ts` (contraseña temporal → 403)
- `app/api/cron/mensualidad/route.ts` (`invitaciones_limpiar`)
- `app/dueno/panel/page.tsx` y `app/staff/panel/page.tsx` (texto del botón)
- `lib/domain/correo.ts` (`mostrarSiSeArchiva`)
- este documento

En el working tree, sin commit (25/11 en la mañana):
- `app/api/invitacion/route.ts`: aceptaciones a la vez dan 410 y no 500;
- `components/admin/bandeja-correos.tsx` y `lib/domain/invitaciones.ts`:
  «Copiar enlace»;
- `components/equipo/invitar-personal.tsx`: lista corta con «Ver todas»;
- `app/staff/panel/page.tsx`: «Equipo e invitaciones»;
- `scripts/dev/probar-invitaciones.mjs`: pruebas nuevas;
- este documento.

# Etapa 3 — B1, importadores CSV (mesas y personal)

25/11/2026. Todo en antroapp-dev; producción no se tocó. Sin commit: quedó
en el working tree para el coordinador (junto con lo de la etapa 2 que
tampoco tiene commit).

## Decisión: el personal en lote son INVITACIONES de B12, no contraseñas temporales

Se pedía elegir entre crear cuentas con contraseña temporal (como el alta de
antros de post-junta) o generar invitaciones de B12 en lote. Elegí
**invitaciones**, por esto:

| | Contraseñas temporales | Invitaciones en lote (elegido) |
|---|---|---|
| Todo o nada | No del todo: las cuentas de Auth se crean fuera de la transacción; si algo falla hay que borrarlas, y si el proceso muere quedan huérfanas | **Sí**: una sola transacción de Postgres; no se crea ninguna cuenta hasta que la persona acepta |
| Contraseñas | Quien importa ve y reparte 130 contraseñas | Nadie ve contraseñas ajenas: cada quien elige la suya |
| Abuso | Un staff podría crear 400 cuentas de Auth por llamada | Solo filas de invitación, con límites (400 por lote, 5 lotes por hora, 400 pendientes por antro y, desde el SQL 24, los cupos por persona y por antro que suman sueltas y lotes) |
| Después | Hay que cambiar la contraseña al entrar | Revocar, reenviar y la lista de Equipo ya existen |
| Sin correo | Funciona | Funciona igual: si el correo no sale (hoy se archiva), la pantalla muestra el enlace de cada persona, con botón de WhatsApp (si trae teléfono) y «Copiar todo»; si se pierden, «Volver a sacar los enlaces» (SQL 24) |
| Velocidad | 130 en ~9 s | **130 en 2.8 s** (dev, con el correo en modo archivo) |

**El punto delicado**: en B12, quien invita nunca ve el enlace (solo la
persona o, si el correo se archiva, el admin en la bandeja). En el lote, si
el correo NO sale, el enlace se le muestra a quien importa para que lo haga
llegar. No da un permiso nuevo: ese mismo rol ya podía crear esas cuentas
con `create-staff` y una contraseña que él conocía. Con el enlace, la persona
elige su contraseña, y el enlace sirve una vez y vence a las 72 h. Si el
correo sí sale (modo `enviar` en producción), su enlace NO se muestra.
**Decisión pendiente para Diego** (abajo): si prefiere que nunca se muestren.

## Qué se hizo, por función

### 0. Lector CSV compartido (`lib/domain/lector-csv.ts`)

- Se movieron `separadorDe` y `partirLinea` de `lib/domain/catalogo-csv.ts`
  (más `quitarAcentos` y un `lineasCsv` que quita el BOM, salta líneas vacías
  y conserva el número de línea). `catalogo-csv.ts` los importa y los
  reexporta: **mismo comportamiento**. Comprobado comparando la versión
  anterior (la de `HEAD`) con la nueva en 20,000 textos al azar
  (separadores, comillas, BOM, CRLF, encabezados): 20,000 iguales, 0
  distintos. Y `probar-catalogo-csv.mjs` sigue en 16/16.
- Node exige la extensión en las importaciones entre `.ts`, y Next no la
  acepta. Para que las pruebas carguen módulos que se importan entre sí
  agregué `scripts/dev/cargar-ts.mjs` (un gancho de `module.registerHooks`
  que prueba con `.ts`); `probar-catalogo-csv.mjs` ahora carga el catálogo
  con él (una línea). No se tocó `tsconfig.json`.

### 1. Mesas desde CSV (B1a)

- **Dónde**: panel del dueño, sección «Mis mesas», botón «Importar mesas
  desde CSV» (`components/mesas/importar-mesas.tsx`).
- **Formato**: `nombre, capacidad` por línea; encabezado opcional; coma,
  punto y coma o tabulador; botón «Elegir archivo (.csv)» (500 KB máximo) o
  pegar.
- **Revisar** muestra los errores por línea («Línea 3: la capacidad es un
  número entero de 1 a 100») y, si no hay, la vista previa contra las mesas
  del antro: **Nueva**, **8 → 12 pers.** (cambia la capacidad) o **Sin
  cambio**, y cuántas mesas quedarían. No deja importar con errores, sin
  cambios o si el antro pasaría de 300.
- **Importar** llama `mesas_importar` (todo o nada). Si la mesa ya existe
  (mismo nombre sin importar mayúsculas ni espacios de las orillas) solo
  cambia la capacidad; el nombre se queda como estaba. **Nunca borra ni
  renombra** (reservas, caja y consumos apuntan a las mesas).
- **Quién**: el dueño de ese antro y el admin, igual que la RLS de
  `club_tables`. El gerente **no** (decisión pendiente si se quiere).
- **Índice único** `club_tables_numero_unico` en
  `(club_id, lower(btrim(numero)))`: ya no se pueden repetir mesas en un
  antro, ni por el panel, ni por la API, ni con service role. El alta de una
  sola mesa en el panel ahora dice «Ya tienes una mesa con ese nombre» en
  vez de un error genérico.
- Límites: 300 filas por archivo y 300 mesas por antro (el mismo tope del
  alta de antros).
- El admin no tiene pantalla de mesas para un antro existente; la función sí
  lo deja (probado). Si hace falta, es montar el mismo componente en /admin.

### 2. RPs y staff en lote (B1b)

- **Dónde**: pantalla «Equipo» (`/dueno/equipo` y `/staff/equipo` del
  gerente), sección «Invitar en lote»
  (`components/equipo/importar-personal.tsx`).
- **Formato**: `nombre, correo, teléfono` (teléfono opcional, 10 dígitos;
  acepta espacios, guiones, paréntesis y +52 / 52 / 521). Con encabezado,
  las columnas pueden ir en cualquier orden. Hasta 400 por archivo. **Todos
  con el mismo rol**, que se elige arriba (el dueño: gerente, staff o RP; el
  gerente: solo RP).
- **Revisar**: errores por línea (nombre, correo, teléfono, correo repetido
  en el archivo, columnas de más, «el correo va en la segunda columna») o la
  vista previa. Con un error no deja invitar a nadie.
- **Invitar** → `POST /api/equipo/importar`:
  1. Sesión por cookie; con contraseña temporal → 403.
  2. Vuelve a validar las filas con las mismas reglas.
  3. `invitacion_puede` con la sesión de quien llama (la matriz de
     create-staff, en la base, con coalesce) → 403 si no puede. El club del
     cuerpo solo dice a dónde.
  4. `invitaciones_importar` con la sesión: **todo o nada**, con la clave de
     idempotencia `lote_id` (una por lista revisada; si se pierde la
     respuesta y se reintenta, responde «repetido» y no duplica).
  5. Con service role, `invitaciones_emitir_tokens_lote` (todos los tokens
     en una llamada; la base guarda solo su sha256) y un correo por persona
     por `lib/correo.ts` (plantilla `invitacion:lote`): de 8 en 8 si solo se
     archiva, de 2 en 2 en modo `enviar` (Resend acepta pocas por segundo).
     A los 40 s deja de mandar y el resto se entrega a mano.
  6. Responde (sin caché) cuántas se crearon, cuántos correos salieron y los
     enlaces de los que no salieron, en el orden del archivo.
- **Resultado en pantalla**: «Listo: N invitaciones creadas», el aviso de
  que los correos todavía no salen (y de que se pueden volver a sacar desde
  «Tus importaciones de las últimas 24 horas»), «Copiar los N enlaces (para
  una hoja de cálculo)» (nombre, correo, teléfono y enlace por línea, sin
  fórmulas: ver correcciones) y, por persona,
  «WhatsApp» (si trae teléfono; abre el chat con el mensaje y el enlace) y
  «Copiar». La lista de invitaciones de arriba se recarga sola.
- **Al aceptar**, el teléfono de la invitación pasa al perfil
  (`invitacion_aceptar` cambió solo en eso).
- **Rechazos en la base** (con su línea): un correo con invitación pendiente
  en ese antro y un correo que ya es del equipo de **ese** antro (o de su
  dueño). Un correo con cuenta en **otro** antro no se distingue de uno
  nuevo (no sirve para averiguar quién tiene cuenta); esa persona recibe la
  invitación y al aceptarla ve «ya tienes cuenta» (409, de B12).
- **Límites**: 400 por lote; 5 lotes por persona por hora; 400 pendientes
  por antro contando las del lote; candado por antro + correo (el mismo de
  la invitación suelta, para que una suelta y un lote al mismo correo no
  pasen los dos). Los lotes no cuentan en el límite de 30 invitaciones
  sueltas por hora, pero **desde el SQL 24 sí cuentan** en los topes por
  persona (400 por hora, 1,000 por día) y por antro (800 por día; 20 si no
  está verificado).
- `invitacion_lotes` es la bitácora (quién, cuándo, cuántas, sin correos);
  la leen quienes pueden invitar ese rol en ese antro.

### 3. Clientes (B1c): NO implementado — propuesta y preguntas

No se implementó: toca datos personales y requiere la decisión de Diego y
del abogado. Hoy no existe una lista de clientes por antro: los clientes son
perfiles globales (rol `cliente`, sin antro) y los datos del cliente de una
reserva viven en `reservations.cliente_nombre` y `cliente_telefono`.

**Propuesta mínima** (si se aprueba):
- Tabla `club_clientes` (`id`, `club_id`, `nombre`, `telefono` a 10 dígitos,
  `notas`, `origen` csv|manual, `fuente_consentimiento` **obligatoria**,
  `importado_por`, `creado_en`, único por `(club_id, telefono)`).
- RLS: lectura solo del dueño y el gerente de ese antro (y el admin); sin
  escritura directa (restrictivas en false); se escribe con
  `clientes_importar(p_club, p_filas)` (todo o nada, el mismo lector CSV,
  tope por archivo) y se borra con `clientes_borrar` (derecho ARCO de
  cancelación). GRANT explícitos.
- **Nunca** se cruza con `profiles` ni con `auth.users` por teléfono o
  correo; no crea cuentas ni dice si alguien ya está registrado (no permite
  enumerar ni mezclar clientes de antros distintos).
- Actualizar `docs/legal/inventario-datos.md`, el aviso de privacidad y el
  contrato con el antro (el antro como responsable, AntroApp como
  encargado).

**Preguntas para Diego y el abogado**:
1. ¿Para qué es la lista? (que el RP o el staff reserven a nombre del
   cliente sin teclear, ver a los frecuentes, mandar mensajes o
   promociones). Cada uso cambia la base legal y lo que hay que avisar.
2. ¿Quién la sube y quién la ve? ¿Los RPs ven a «sus» clientes o a todos?
3. ¿Qué constancia de consentimiento se exige al importar (casilla «tengo
   su consentimiento», origen de la lista, fecha)? ¿Se guarda por fila?
4. ¿Plazo de conservación y cómo se ejerce el borrado (ARCO)?
5. ¿Se permite mandar mensajes (WhatsApp o SMS) desde AntroApp? Si sí, hace
   falta la baja voluntaria y un registro de envíos.
6. ¿Correo además del teléfono? (más datos personales; ¿hace falta?)

## SQL, en orden (después del 20 y del 21)

| # | Archivo | Rollback | Qué hace |
|---|---|---|---|
| 22 (antes) | `sql/post-junta-2/22-importar-mesas-diagnostico.sql` | — (solo lectura) | Lista mesas repetidas por antro. En producción se corre ANTES del 22 en el SQL Editor; si devuelve filas, renombrar (no borrar) las repetidas. |
| 22 | `sql/post-junta-2/22-importar-mesas.sql` | `22-importar-mesas-rollback.sql` | Índice único `club_tables_numero_unico` y `mesas_importar`. Si hay repetidas, se detiene con un aviso claro sin cambiar nada (probado en dev dentro de una transacción deshecha). |
| 23 | `sql/post-junta-2/23-importar-personal.sql` | `23-importar-personal-rollback.sql` | `invitacion_lotes` (RLS y GRANT explícitos), `invitaciones.telefono` y `lote_id`, `telefono_mx_10`, `invitaciones_importar`, `invitaciones_emitir_tokens_lote` (solo service role) e `invitacion_aceptar` con teléfono. Requiere el 21. |
| 24 | `sql/post-junta-2/24-invitaciones-cupos.sql` | `24-invitaciones-cupos-rollback.sql` | Correcciones de la revisión (ver al final): cupos comunes, antro sin verificar, revocar con límite, candado de reenviar, `invitaciones_reemitir_lote`. Requiere el 21 y el 23. |

- Los rollbacks van en orden inverso: el 23 y luego el 22 (y los dos antes
  del 21 si se deshace B12 completo: el rollback del 21 no conoce
  `invitacion_lotes`).
- El rollback del 23 deja `invitacion_aceptar` exactamente como en el 21;
  las invitaciones creadas por lote se quedan (pierden el teléfono y la
  marca de lote). El rollback del 22 no toca ninguna mesa.
- Funciones `SECURITY DEFINER` con `set search_path = ''` y `revoke … from
  public, anon`; autorización con `coalesce(…, false)`.
- **Ciclo en dev (25/11)**: aplicado → índice 1, 4 funciones nuevas, tabla
  1, 2 columnas, 4 políticas y aceptar con teléfono; rollback del 23 y del
  22 → 0/0/0/0/0 y aceptar como en el 21; reaplicado → igual que al
  principio. El ciclo se hizo dos veces. **Dev queda CON el 22 y el 23
  aplicados.** Los cinco archivos están en LF.
- En el pase 2: el diagnóstico, luego el 22 y el 23, antes del merge del
  código (el código nuevo llama `mesas_importar` e `invitaciones_importar`;
  el viejo no las usa, así que aplicarlos antes no rompe nada). **No edité**
  `ensayo-pase2.mjs` ni `pase-produccion.md`: los integra el coordinador.

## Pruebas automáticas (resultados reales, dev, 25/11)

- `node scripts/dev/probar-importar-mesas.mjs` → **30/30** (dos corridas,
  una después del ciclo de rollback). Lector (BOM, CRLF, comillas,
  separadores, errores por línea, tope de 300, vista previa). Rechazados:
  dueño de otro antro, gerente, staff, RP, cliente, cuenta sin perfil, dueño
  dado de baja, dueño con contraseña temporal y anónimo; dueño y admin sí.
  Alta, cambio de capacidad sin renombrar, no borra las que no vienen; una
  fila mala y no entra nada; la base revalida (decimales, texto, nombre
  largo, repetidas, más de 300 filas, vacío); tope de 300 por antro (justo
  300 sí); índice único aun con service role; tres importaciones a la vez →
  40 mesas, ninguna doble; grants.
- `node scripts/dev/probar-importar-personal.mjs --base=http://localhost:3022 --pantalla`
  (con `PLAYWRIGHT_DESDE`) → **95/95**; sin `--pantalla`, después del ciclo
  de rollback → **63/63**. Lector y reglas (el teléfono se normaliza igual
  en pantalla y en la base en 11 casos). Matriz en la base: 11 rechazos
  (dueño de otro antro, gerente pidiendo staff o gerente, staff pidiendo
  staff, gerente de otro antro, RP, cliente, sin perfil, dado de baja,
  contraseña temporal y anónimo) y 6 permitidos (dueño con los 3 roles,
  gerente, staff y admin). Todo o nada; choques con una pendiente y con el
  equipo del antro; un correo de otro antro no se distingue; idempotencia (y
  la clave de otro usuario no sirve); límites (400 filas, 5 lotes por hora,
  400 pendientes); tokens solo por el servidor y una sola vez; RLS y grants.
  Ruta: 401; 403 (RP, contraseña temporal, gerente pidiendo staff, club_id
  de otro antro, sin guardar nada); 400 con la línea; **130 RPs en 2.8 s**
  con 130 tokens y 130 correos en la bandeja; reintento sin duplicar;
  aceptar uno → perfil RP del antro con el teléfono del CSV, e inicia
  sesión. Pantallas a 390×844 y 360×740: dueño y gerente (error por línea,
  vista previa, invitar a 3, WhatsApp solo para los 2 con teléfono, «Copiar
  los 3 enlaces», la lista se recarga) y mesas del dueño (archivo con
  error, vista previa, importar, cambio de capacidad); sin scroll
  horizontal, controles de 40 px o más y sin errores de página.
- `node scripts/dev/probar-invitaciones.mjs --base=http://localhost:3022`
  (regresión de B12 porque cambió `invitacion_aceptar`) → **140/140**. No
  corrí su `--pantalla` en esta etapa (en la etapa 2 dio 183/183).
- `node scripts/dev/probar-catalogo-csv.mjs` → **16/16** (antes y después de
  mover el lector).
- `npx tsc --noEmit` y `npx eslint` de los archivos tocados: limpios.
- Capturas: `screenshots-b-equipo/b1-*.png` (carpeta ignorada por git). Las
  revisé: bien a 390 y a 360. La burbuja «N» que aparece es el indicador de
  Next en modo desarrollo (no existe en producción).

## Prueba manual, clic a clic (dev)

Usuarios de dev (contraseña en `backups/dev-credenciales.json`). **Ojo**:
esto crea mesas e invitaciones en Club Demo Dev; al final de cada parte dice
cómo deshacerlo.

**Mesas (dueño)**
1. Entra a `/dueno/login` con `dev_dueno@example.com` → panel.
2. Baja a «Mis mesas» → «Importar mesas desde CSV».
3. Pega:
   ```
   mesa,capacidad
   Prueba 1,8
   Prueba 2,0
   ```
   → «Revisar». Debe decir «Línea 3: la capacidad es un número entero de 1
   a 100» y no mostrar el botón de importar.
4. Cambia el 0 por 10 → «Revisar» → «2 nuevas · 0 cambian…» → «Importar 2
   cambios» → «Listo: 2 mesas nuevas…». Aparecen en la lista.
5. Pega `prueba 1,12` → «Revisar» → «8 → 12 pers.» → importar → la mesa
   «Prueba 1» (con su nombre original) ahora dice 12 pers.
6. Arriba, en «Crear mesa», escribe `PRUEBA 2` → «Ya tienes una mesa con ese
   nombre».
7. Para deshacer: borra «Prueba 1» y «Prueba 2» con la ×.

**Personal en lote (dueño y gerente)**
1. Con `dev_dueno` toca «Invitar por correo, permisos y actividad»
   (`/dueno/equipo`) → «Invitar en lote».
2. Elige «Staff». Pega:
   ```
   nombre,correo,teléfono
   Ana Prueba,ana.prueba.b1@example.com,55 1234 5678
   Beto,beto@
   ```
   → «Revisar» → «Línea 3: revisa el correo…» y el botón deshabilitado.
3. Cambia `beto@` por `beto.prueba.b1@example.com` → «Revisar» → «2
   personas listas para invitar como Staff» → «Invitar a 2 como Staff».
4. Debe decir «Listo: 2 invitaciones creadas», el aviso amarillo de que los
   correos todavía no salen, «Copiar los 2 enlaces», «WhatsApp» solo para
   Ana y «Copiar» para los dos. Arriba, en la lista, aparecen «Pendiente».
5. Abre el enlace de Ana en una ventana de incógnito → elige contraseña →
   entra como staff de Club Demo Dev. En `/admin/correos` (con
   `dev_admin`) se ven los 2 correos «Te invitaron a Club Demo Dev…»
   archivados.
6. Entra con `dev_gerente@example.com` → «Equipo e invitaciones» → «Invitar
   en lote»: solo dice «Todos entran como RP».
7. Para deshacer: revoca la de Beto en la lista; a Ana (si aceptó) dala de
   baja en «Staff y gerentes».

## Decisiones pendientes para Diego

1. **Enlaces a quien importa** cuando el correo no sale (explicado arriba).
   La alternativa es no mostrarlos nunca y depender del correo (o del admin
   y su bandeja); con los correos en modo archivo, las invitaciones de un
   lote quedarían sin entregar.
2. **¿El gerente importa mesas?** Hoy no (la misma regla que la RLS de
   `club_tables`: solo el dueño y el admin).
3. **¿El staff (no gerente) importa RPs?** La base lo deja (matriz de
   create-staff), pero la pantalla Equipo es solo del gerente y el dueño. Si
   se quiere, es montar el componente en `/staff/panel`.
4. **Pantallas para el admin** (mesas e importación de personal en un antro
   existente): las funciones lo dejan; no hay pantalla.
5. **Tope de 300 mesas por antro**: es el del alta. ¿Hay antros con más?
6. **Clientes (B1c)**: las preguntas de arriba.
7. ¿Cuánto tiempo se guardan `invitaciones` (nombre, correo y teléfono)? Lo
   agregué al inventario de datos con «plazo pendiente».

## Riesgos

- **El índice único falla en producción si ya hay mesas repetidas**: el 22
  se detiene sin cambiar nada; correr antes el diagnóstico.
- **Otros scripts que crean mesas repetidas** fallarán ahora con 23505 (en
  el repo no encontré ninguno: `mesas-extra` y `sembrar-dev` usan nombres
  distintos). Si otro carril prueba con mesas de nombre repetido en el mismo
  antro, ahora le falla.
- **Correos en modo `enviar` con listas grandes**: van de 2 en 2 y con tope
  de 40 s; si Resend tarda, el resto se entrega a mano (sus enlaces vuelven
  en la respuesta). No se probó con Resend real (no hay llaves en dev).
- ~~**Lotes y el límite de 30 por hora**~~ y ~~**reenviar justo después de
  un lote**~~: resueltos con el SQL 24 (el lote escribe una fila por
  invitación en `invitacion_envios`, cuenta en los topes y activa la espera
  de 2 minutos). Ver «Correcciones de la revisión».
- **Base compartida**: las pruebas crean y borran sus propios antros,
  cuentas, invitaciones y correos (`t_equipo_…`) y al final verifican que
  no quede nada (0 cuentas, 0 invitaciones, 0 correos).

## Archivos de la etapa 3

Nuevos:
- `lib/domain/lector-csv.ts`, `lib/domain/importar-mesas.ts`,
  `lib/domain/importar-personal.ts`
- `app/api/equipo/importar/route.ts`
- `components/mesas/importar-mesas.tsx`,
  `components/equipo/importar-personal.tsx`
- `sql/post-junta-2/22-importar-mesas-diagnostico.sql`,
  `22-importar-mesas.sql`, `22-importar-mesas-rollback.sql`,
  `23-importar-personal.sql`, `23-importar-personal-rollback.sql`
- `scripts/dev/cargar-ts.mjs`, `scripts/dev/probar-importar-mesas.mjs`,
  `scripts/dev/probar-importar-personal.mjs`

Modificados:
- `lib/domain/catalogo-csv.ts` (usa el lector compartido; mismo
  comportamiento)
- `scripts/dev/probar-catalogo-csv.mjs` (carga con `cargar-ts.mjs`)
- `app/dueno/panel/page.tsx` (botón para importar mesas; «Ya tienes una
  mesa con ese nombre»)
- `components/equipo/pantalla-equipo.tsx` (sección «Invitar en lote»)
- `components/equipo/invitar-personal.tsx` (prop `recargar`)
- `docs/legal/inventario-datos.md` (invitaciones e `invitacion_lotes`)
- este documento

# Correcciones de la revisión (25/11/2026, tarde)

Un revisor del carril encontró 6 defectos (3 medios, 3 bajos). Los verifiqué
uno por uno contra el código y la base de dev: **los 6 son reales**. Cinco
quedaron arreglados y probados; el sexto (commits) no lo puede arreglar un
subagente. Todo en antroapp-dev; producción no se tocó. Sin commit.

## Qué se corrigió, defecto por defecto

### 1. (medio) Los lotes se saltaban el límite por persona; revocar sin límite; antro sin verificar

**Confirmado**: `invitaciones_importar` no escribía en `invitacion_envios`
(lo único que contaba el límite de 30 por hora), `invitacion_revocar` no
tenía límite e `invitacion_puede` no mira la verificación. Un dueño recién
registrado en `/dueno/signup`, con su antro en borrador, podía generar 5 × 400
invitaciones por hora a correos cualquiera (con el nombre del antro en el
asunto), y revocando o con un segundo antro esquivaba el tope de 400
pendientes. Hoy no sale ningún correo (modo archivo), pero el hueco se abría
el día de `CORREO_MODO=enviar`.

**Arreglo (SQL 24)**: todo envío deja una fila en `invitacion_envios`
(`crear`, `reenviar`, `lote` —una por invitación del lote—, `relote` y
`revocar`), y un solo punto, `invitacion_revisar_cupo` (interna: nadie la
llama desde la API), aplica:

| Tope | Cuenta | Valor |
|---|---|---|
| Sueltas por persona por hora | crear + reenviar | 30 (como antes) |
| Todo por persona por hora | sueltas + lote + volver a sacar | 400 |
| Todo por persona por día | lo mismo | 1,000 |
| Por antro por día (de quien sea) | lo mismo | 800 |
| Antro **sin verificar** (salvo el admin) | por antro por día **y** por persona por día sumando todos sus antros sin verificar | 20 |
| Revocar por persona por hora | revocar | 150 |

- Revocar **no devuelve cupo**: el cupo cuenta lo enviado, no lo pendiente.
  Ya no sirve revocar en masa para volver a invitar.
- Un segundo antro en borrador del mismo dueño no da cupo nuevo (el tope de
  20 es por persona, sumando sus antros sin verificar).
- El admin no tiene el cupo de «sin verificar» (los antros que él da de
  alta nacen verificados, y puede necesitar invitar en un borrador como
  Panic Room), pero sí los topes por persona y los 800 por antro.
- No cambié `invitacion_puede`: también la usa la RLS de lectura, y un
  dueño en borrador debe poder ver y revocar sus invitaciones.
- El aviso para el antro sin verificar: «Mientras el antro no esté
  verificado se pueden mandar hasta 20 invitaciones al día. Termina la
  verificación en el panel del dueño.»

### 2. (medio) La lista de Equipo mostraba solo 50

**Confirmado**: `.limit(50)` y «Ver todas (N)» con N de 50 como máximo; de un
lote de 130, 80 no se veían ni se podían reenviar o revocar.

**Arreglo** (`components/equipo/invitar-personal.tsx`): la lista se lee por
páginas de 100 con el total (`count: "exact"`): «Ver todas (total real)» y
luego «Ver más (faltan N)». Orden en la base: primero las abiertas
(pendientes y vencidas), luego revocadas y al final aceptadas; dentro, la
más nueva primero, con `id` como desempate (todas las de un lote tienen la
misma hora) para que las páginas no se encimen; en pantalla, las de un mismo
lote van por nombre. Al recargar (reenviar, revocar, otro lote) se vuelven a
leer las mismas que había a la vista, no solo la primera página.

### 3. (medio) Respuesta perdida: los enlaces del lote no se podían recuperar

**Confirmado**: el reintento responde «repetido» sin enlaces, igual que si
fallaban los tokens, y recuperar 130 con «Reenviar» (30 por hora) tardaba más
de 4 horas.

**Arreglo**: «Volver a sacar los enlaces».
- Base: `invitaciones_reemitir_lote(p_lote_id)`, con la sesión. Solo quien
  importó el lote y si todavía puede invitar ese rol en ese antro (mismo
  mensaje «No encontramos esa importación» para inexistente, ajeno o sin
  permiso), dentro de 24 h, hasta 3 veces por lote. Bloquea el lote y sus
  pendientes, revisa el cupo (cuenta como envíos de lote, **no** contra las
  30 sueltas), limpia el token de las pendientes (los enlaces anteriores
  dejan de servir) y deja sus filas `relote`. No alarga el vencimiento.
- Ruta nueva `POST /api/equipo/importar/reemitir` (`{ lote_id }`; el antro y
  el rol salen del lote en la base): con la service role emite los tokens y
  vuelve a mandar los correos. El paso común de emitir y mandar se sacó a
  `app/api/equipo/importar/enviar-lote.ts` (lo usan las dos rutas).
- `POST /api/equipo/importar` ahora devuelve `lote_id` siempre, y si fallan
  los tokens, `guardado: true` y el mensaje «…Toca «Volver a sacar los
  enlaces» en unos minutos».
- Pantalla (`components/equipo/importar-personal.tsx`): el botón aparece
  cuando la respuesta fue «repetido» o falló la emisión, y además en una
  sección nueva, «Tus importaciones de las últimas 24 horas» (los lotes de
  quien mira, del más nuevo al más viejo, con cuántas personas, rol y hora).
  Pide confirmación: «Los enlaces que ya entregaste de esta lista dejan de
  servir». Después de 3 veces dice que use «Reenviar».

### 4. (bajo) «Copiar todo» podía pegar fórmulas en Excel o Sheets

**Confirmado**: `textoEnlaces` juntaba nombre, correo y teléfono sin
neutralizar.

**Arreglo** (`lib/domain/importar-personal.ts`): `celdaSegura` aplica la
regla de `campoCsv` de `lib/domain/nomina.ts` (apóstrofo al principio si
empieza con `=`, `+`, `-` o `@`) y además cambia tabuladores y saltos de
línea dentro de un campo por un espacio (romperían las columnas). Cada campo
de cada línea pasa por ahí. No reusé `campoCsv` porque arma CSV con comas y
comillas; aquí la salida es con tabuladores.

### 5. (bajo) Carrera entre reenviar y crear al mismo correo

**Confirmado**: `invitacion_reenviar` no tomaba el candado
`invitacion:<antro>:<correo>`.

**Arreglo (SQL 24)**: lo toma después del `select … for update`, y todas las
funciones toman los candados en el mismo orden: persona → (lote) → antro →
antro + correo. Probado con dos conexiones reales: con el reenvío abierto,
la creación al mismo correo **espera** el candado y, al soltarlo, responde
«Ya hay una invitación pendiente»; queda 1 pendiente.

### 6. (bajo) Trabajo sin commit

**Confirmado** (`git status`: B12 final, toda la etapa 3 y ahora esto, sin
commit; dev tiene los SQL 22, 23 y 24). **No lo puedo arreglar**: el sistema
de permisos le bloquea `git commit` a los subagentes, y la instrucción de
esta corrección fue dejarlo en el working tree. Lo tiene que commitear el
coordinador. Propuesta de commits (en este orden):
1. B12 final (rutas, `invitar-personal`, `pantalla-equipo`, `bandeja-correos`, pruebas de invitaciones).
2. B1a mesas (SQL 22 y diagnóstico, `lector-csv`, `importar-mesas`, `components/mesas/`, panel del dueño, `cargar-ts`, `probar-importar-mesas`, `catalogo-csv`).
3. B1b personal en lote (SQL 23, `importar-personal`, `app/api/equipo/importar/`, `probar-importar-personal`, inventario de datos).
4. Correcciones de la revisión (SQL 24, `reemitir`, `enviar-lote`, paginación, `celdaSegura`, pruebas y este documento).

## SQL (después del 23)

| # | Archivo | Rollback |
|---|---|---|
| 24 | `sql/post-junta-2/24-invitaciones-cupos.sql` | `sql/post-junta-2/24-invitaciones-cupos-rollback.sql` |

- Cambia la restricción de tipos de `invitacion_envios` (agrega `lote`,
  `relote`, `revocar`), agrega `invitacion_lotes.reemisiones` (0 a 3) y
  `reemitido_en`, crea `invitacion_revisar_cupo` (sin execute para nadie:
  ni anon, ni authenticated, ni service_role) e
  `invitaciones_reemitir_lote` (authenticated y service_role), y reemplaza
  `invitacion_crear`, `invitacion_reenviar`, `invitacion_revocar` e
  `invitaciones_importar`. Todas `SECURITY DEFINER`, `set search_path = ''`,
  `revoke … from public, anon`, autorización con `coalesce(…, false)`.
- El rollback deja las cuatro funciones **exactamente** como en el 21 y el
  23 (copiadas de esos archivos), quita las dos funciones y las dos
  columnas, **borra** de `invitacion_envios` las filas `lote`, `relote` y
  `revocar` (solo sirven para contar cupos; las invitaciones no se tocan) y
  devuelve la restricción de tipos del 21.
- Ciclo en dev: aplicado → rollback → aplicado, sin errores. Con el rollback
  puesto, la prueba nueva falla donde debe («un lote de 400 cuenta», «cada
  invitación del lote deja su fila» y la restricción de tipos); con el 24,
  pasa completa. **Dev queda CON el 24 aplicado.** Los dos archivos en LF.
- Pase 2: después del 23 y **antes** del merge del código (la pantalla nueva
  lee `invitacion_lotes.reemisiones` y llama `invitaciones_reemitir_lote`; el
  código viejo no las usa, así que aplicarlo antes no rompe nada). No edité
  `ensayo-pase2.mjs` ni `pase-produccion.md`.

## Pruebas (resultados reales, dev, 25/11 en la tarde)

Servidor: `next dev` **sin turbopack** con las llaves de `.env.dev`, puerto
3022 (`servidor-dev.mjs` no arranca en los worktrees), con `CORREO_MODO` sin
definir (archivo).

| Prueba | Resultado |
|---|---|
| `node scripts/dev/probar-importar-personal.mjs` (lector y base, sin servidor) | **72/72** (antes 49): 23 nuevas de cupos, antro sin verificar, revocar, volver a sacar, carrera, fórmulas y permisos |
| la misma, con el SQL 24 **deshecho** (para comprobar que la prueba detecta los defectos) | 52 pasan, **3 fallan** (las esperadas; se cortó en la restricción de tipos) |
| `… --base=http://localhost:3022 --pantalla` (con `PLAYWRIGHT_DESDE`) | **126/126** (antes 95). Lote de 130 en 3.1 s; volver a sacar sus 130 enlaces en 3.0 s, con los anteriores ya sin servir y 260 correos en la bandeja; 401/403/400 de la ruta nueva; en pantalla, «Volver a sacar los enlaces» con confirmación (dueño y gerente, 390 y 360) y la lista por páginas con las 130 del lote |
| `node scripts/dev/probar-invitaciones.mjs --base=… --pantalla` | **183/183**. La primera corrida dio 177/183: 6 fallas de la prueba, no de la app (contaba también los botones de rol de «Invitar en lote», de la etapa 3, y no excluía el input de archivo oculto `sr-only`); corregida la prueba, 183/183. Sus antros de prueba ahora nacen verificados |
| `node scripts/dev/probar-importar-mesas.mjs` | **30/30** |
| `node scripts/dev/probar-catalogo-csv.mjs` | **16/16** |

**Una corrida que falló y dejó datos**: la primera vez corrí mesas y catálogo
encadenados con otra prueba larga (salida filtrada), y una de las dos
terminó con «error inesperado: Cannot read properties of null (reading
'id')» al crear sus datos de prueba y **dejó 10 cuentas `t_equipo_…` y 5
antros «T equipo …»** (por la forma, de `probar-importar-mesas`; no pude
confirmar cuál fue ni reproducirlo: las dos, corridas solas, pasaron
completas). Los borré a mano con la service role (solo los de ese sufijo) y
comprobé que en dev quedan **0 cuentas `t_equipo_` y 0 antros «T equipo»**.
Posible causa: un `insert … .single()` que regresó nulo por el límite de la
base compartida; la limpieza de esa prueba no corrió completa.
| `node scripts/dev/probar-correos.mjs --base=… --pantalla` | **66/66**. Dos corridas anteriores fallaron por el límite de Auth de dev compartido (401 al iniciar sesión) y por el botón de Next en modo desarrollo (32 px, sin texto; con `next dev` sin turbopack queda fuera del shadow DOM). Excluí ese botón en la prueba (`data-nextjs-dev-tools-button`, no existe en producción) |
| `node scripts/dev/probar-monitoreo.mjs --base=…` | **8/8** (una corrida dio 7/8: contó una fila de `alertas_enviadas` que dejó otro carril; un momento después la tabla estaba en 0 y dio 8/8) |
| `npx tsc --noEmit` y `npx eslint` de lo tocado | limpios |
| `NEXT_DIST_DIR=.next-build npx next build` con las variables de `.env.dev` | **compila** (incluye `/api/equipo/importar/reemitir`); `tsconfig.json` sin cambios |

Capturas nuevas (carpeta `screenshots-b-equipo/`, ignorada por git; las
revisé): `b1-lote-reemitir-confirmar-{dueno,gerente}-{390,360}.png` y
`b1-lista-paginas-390.png`. Bien a 390 y a 360, sin scroll horizontal; la
burbuja «N» es el indicador de Next en desarrollo.

## Prueba manual, clic a clic (dev)

Usuarios de dev (contraseña en `backups/dev-credenciales.json`). Crea
invitaciones en Club Demo Dev; al final dice cómo deshacerlo.

**Volver a sacar los enlaces**
1. Entra con `dev_dueno@example.com` → «Invitar por correo, permisos y
   actividad» (`/dueno/equipo`) → «Invitar en lote».
2. Elige «RP» y pega:
   ```
   Uno Prueba,uno.prueba.b1r@example.com,55 1111 2222
   =1+1,dos.prueba.b1r@example.com
   ```
   → «Revisar» → «Invitar a 2 como RP».
3. Toca «Copiar los 2 enlaces» y pégalo en una hoja de cálculo: la segunda
   línea debe verse como texto `=1+1` (con el apóstrofo), no como `2`.
4. Abajo, en «Tus importaciones de las últimas 24 horas», aparece «2
   personas como RP · hora». Toca «Volver a sacar los enlaces» → lee el
   aviso → «Sí, sacar enlaces nuevos» → «Enlaces nuevos para 2 invitaciones
   pendientes», con sus botones.
5. Abre en incógnito el enlace del paso 2 (el viejo): debe decir que la
   invitación no existe o ya no sirve. El nuevo sí abre.
6. Repite el paso 4 dos veces más; a la cuarta, en lugar del botón dice «Ya
   sacaste sus enlaces 3 veces…».
7. Deshacer: revoca las dos en la lista de arriba.

**Lista por páginas**: con más de 100 invitaciones en el antro (por ejemplo,
después de `node scripts/dev/probar-importar-personal.mjs --base=…`, que lo
hace solo y lo borra), «Ver todas (N)» muestra el total real y «Ver más
(faltan N)» trae el resto.

**Antro sin verificar** (con un dueño propio, no con `dev_dueno`):
1. Regístrate en `/dueno/signup` con un correo `…@example.com` (el antro
   nace en borrador).
2. En Equipo → «Invitar en lote», pega 21 personas → «Invitar a 21» →
   «Mientras el antro no esté verificado se pueden mandar hasta 20
   invitaciones al día…». Con 20 sí pasa; la 21 suelta, no.
3. Deshacer: borra ese dueño y su antro con la service role (o pídeselo al
   coordinador).

## Decisiones pendientes para Diego (nuevas)

1. **Los números de los cupos** (30 sueltas por hora; 400 por hora y 1,000
   por día por persona; 800 por antro por día; 20 al día sin verificar; 150
   revocaciones por hora). Son constantes en `invitacion_revisar_cupo`;
   alcanzan para el caso pedido (130 RPs, o 400 de una vez). Si se quieren
   por antro, es una columna en `clubs` (configurable, no personalizable).
2. **Antro sin verificar**: elegí «cupo muy chico» (20 al día) en vez de
   prohibir invitar, porque un dueño que apenas se registró puede querer
   armar a su equipo mientras lo verifican. La alternativa más estricta es
   0 (nada hasta verificar).
3. **Ventana de «Volver a sacar los enlaces»**: 24 horas y 3 veces por lote.
   La revisión sugería «una ventana corta»; la dejé en 24 h porque el caso
   real es «salí de la pantalla y no los entregué», y cada vez cuenta para
   los cupos (no multiplica correos sin freno).

## Riesgos (nuevos)

- **Volver a sacar los enlaces invalida los ya entregados** de ese lote
  (pendientes). La pantalla lo avisa y pide confirmación.
- **Los cupos cuentan filas de `invitacion_envios`**: la limpieza diaria
  borra las de más de 30 días; los cupos miran 1 hora y 24 horas, así que no
  se afectan.
- **La prueba de cupos inserta filas sintéticas** en `invitacion_envios` (las
  1,000 del día, las 29 sueltas, las 145 revocaciones) ligadas a sus propias
  invitaciones `t_equipo_…`; se van con ellas (on delete cascade). La
  limpieza verifica 0 cuentas, 0 invitaciones y 0 correos.
- **Base compartida y límites de Supabase Auth**: con 6 carriles probando a
  la vez, los inicios de sesión de las pruebas chocan con el límite de Auth
  de dev («Request rate limit reached» o 401). Las pruebas esperan y
  reintentan, pero alguna corrida falla por eso (ver resultados).

## Archivos de las correcciones

Nuevos:
- `sql/post-junta-2/24-invitaciones-cupos.sql`,
  `sql/post-junta-2/24-invitaciones-cupos-rollback.sql`
- `app/api/equipo/importar/enviar-lote.ts`,
  `app/api/equipo/importar/reemitir/route.ts`

Modificados:
- `app/api/equipo/importar/route.ts` (usa `enviar-lote.ts`; `lote_id` y
  `guardado` en la respuesta)
- `lib/domain/importar-personal.ts` (`celdaSegura`, `esquemaReemitirLote`,
  `lote_id` y `reemitido` en el resultado)
- `components/equipo/importar-personal.tsx` («Volver a sacar los enlaces»,
  «Tus importaciones de las últimas 24 horas»)
- `components/equipo/invitar-personal.tsx` (lista por páginas)
- `scripts/dev/probar-importar-personal.mjs` (cupos, reemisión, carrera,
  fórmulas, ruta de reemitir, pantallas; antros de prueba verificados)
- `scripts/dev/probar-invitaciones.mjs` (sus antros de prueba nacen
  verificados: si no, el cupo de 20 rompe su prueba del límite de 30; y
  dos ajustes de su `--pantalla` por la sección «Invitar en lote»)
- `scripts/dev/probar-correos.mjs` (excluye el botón de Next en modo
  desarrollo al medir controles)
- este documento
