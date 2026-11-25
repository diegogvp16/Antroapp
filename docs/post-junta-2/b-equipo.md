# Carril b-equipo — etapa 1: B7, correos en modo «archivo»

24/11/2026. Rama `b-equipo` (desde `post-junta-2`). Todo se hizo en
**antroapp-dev**; producción no se tocó (ni lectura ni escritura).

> **Sin commits.** La tarea pedía commits chicos en la rama, pero el
> clasificador de permisos los bloqueó, y `CLAUDE.md` (sección 8) dice que
> no se hace commit sin que Diego lo pida. Todo quedó **en el working tree**
> del worktree para revisarlo (lista de archivos abajo).

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
