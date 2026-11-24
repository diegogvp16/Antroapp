# Seguridad: lo que Diego hace a mano en los paneles

Escrito el 23/11/2026. Claude Code no tiene acceso a los paneles de Supabase,
Vercel ni GitHub para cambiar configuración (y no debe tenerlo): estos pasos
los haces tú. Cada uno dice **dónde hacer clic** y **qué deberías ver**. Los
nombres de los menús pueden cambiar un poco con el tiempo; si un botón no
está donde dice, busca el texto entre comillas en la página.

Producción: Supabase `kigltjvakwuuulvzbyri`; Vercel, proyecto `antroapp`;
GitHub, `diegogvp16/Antroapp`.

---

## Supabase (supabase.com → proyecto de producción)

### 1. Protección contra contraseñas filtradas

1. Menú izquierdo → **Authentication** → **Attack Protection** (en algunas
   versiones: Authentication → **Providers → Email**, sección "Password security").
2. Activa **"Prevent use of leaked passwords"** (usa la base de
   HaveIBeenPwned; requiere plan Pro).
3. En la misma sección, **"Minimum password length"**: 8 o más.
4. Guarda (**Save**).

**Qué deberías ver**: el interruptor en verde y "8" en la longitud mínima.
Una contraseña conocida como `password123` en `/cliente/signup` debe ser
rechazada (el registro dice que la contraseña no es válida).

> Si aparece "Available on Pro plan", el proyecto está en Free: ver el punto 4.

### 2. Límites de intentos (rate limits)

1. **Authentication** → **Rate Limits**.
2. Revisa (y deja así o más estrictos):
   - "Rate limit for sign-ups and sign-ins": **30 por 5 minutos por IP** o menos.
   - "Rate limit for token refreshes": el valor por defecto.
   - "Rate limit for sending emails": el valor por defecto (por SMTP propio, si lo hay).
3. **Save**.

**Qué deberías ver**: los números guardados. La app además bloquea 15
minutos tras 5 fallos del mismo correo desde la misma IP (`/api/auth/login`);
estos límites de Supabase cubren a quien llame a Supabase directo, sin pasar por la app.

### 3. CAPTCHA — **todavía NO activarlo**

En **Authentication → Attack Protection → "Enable Captcha protection"**.

**No lo actives todavía**: el inicio de sesión (`app/api/auth/login`) y los
registros (`/cliente/signup`, `/dueno/signup`) **no mandan el token del
CAPTCHA**, así que al activarlo nadie podría entrar ni registrarse. Primero
hay que agregar Cloudflare Turnstile (o hCaptcha) a esos tres formularios;
es un cambio de código que se puede hacer en una rama aparte. Cuando esté,
aquí se elige el proveedor y se pega su "secret key".

**Qué deberías ver hoy**: el interruptor **apagado**.

### 4. Respaldos

1. **Database** → **Backups**.
2. Revisa:
   - **Scheduled backups**: debe haber uno de cada día de la última semana
     (plan Pro). Si dice que el plan Free no tiene respaldos, **no se hace el
     pase** hasta subir a Pro (Settings → Billing → Upgrade).
   - **Point in Time Recovery**: opcional, de pago; con caja real vale la pena.
3. El día del pase: anota la fecha y hora del último respaldo antes de empezar.

**Qué deberías ver**: una lista con fechas recientes, una por día, en estado
"Completed". Detalle y cómo probar una restauración sin tocar producción:
`docs/respaldos.md`.

### 5. "Automatically expose new tables"

1. **Project Settings** (engrane) → **Data API** (en algunas versiones: Settings → API).
2. Busca **"Automatically expose new tables and functions"** (o "Exposed schemas" con
   esa casilla).

**Qué deberías ver**:
- En **dev** (antroapp-dev): **apagado**. Así se probó todo el SQL nuevo, con
  GRANT explícitos en cada tabla.
- En **producción**: hasta donde sabemos está **encendido** (las tablas nuevas recibían permisos solas; confírmalo aquí). Por eso el SQL del pase revoca
  a `anon` lo que no debe ver. El SQL funciona igual apagado o encendido.
  Apagarlo en producción hace que mañana una tabla nueva sin GRANT no quede
  expuesta por accidente: **recomendado apagarlo antes del pase** (no afecta
  a las tablas que ya existen).

### 6. Restablecer la contraseña de la base de producción (justo antes del pase)

Por qué: la cadena de conexión con contraseña está en la laptop
(`.env.dev`, variable `DATABASE_URL_PROD`, solo para lectura del catálogo)
y conviene rotarla antes de cambios grandes.

1. **Project Settings** → **Database** → **Database password** →
   **"Reset database password"**.
2. Genera una nueva (botón **Generate a password**), **cópiala a tu gestor de
   contraseñas** y confirma.
3. Actualízala en el único lugar donde se usa:
   - En la laptop, archivo **`.env.dev`** (no va a Git): en `DATABASE_URL_PROD`
     reemplaza solo la parte de la contraseña (entre `postgres.kigltjvakwuuulvzbyri:`
     y `@`). Si tiene caracteres especiales, la cadena de **Connect →
     Session pooler** de Supabase ya viene lista para copiar.
   - **Vercel no la usa**: la app habla con Supabase con la URL y las llaves
     del API, no con la contraseña de la base. No hay nada que cambiar en Vercel.
4. Prueba (solo lectura): `node scripts/db/conteos-prod.mjs` debe imprimir
   los conteos de Club Demo.

**Qué deberías ver**: el aviso "Password updated" en Supabase y los conteos
en la terminal. Si dice "password authentication failed", la contraseña de
`.env.dev` no quedó igual.

> Las llaves del API (anon y service role) **no** cambian con esto. Rotarlas
> es otro procedimiento (Settings → API Keys) y obliga a actualizar Vercel;
> no hace falta para el pase.

---

## Vercel (vercel.com → proyecto `antroapp`)

### 7. Rollback instantáneo (si el pase sale mal)

1. **Deployments**.
2. Busca el deploy de **Production** anterior al pase (etiqueta "Production",
   con la fecha de antes; el de arriba es el nuevo).
3. Menú **"⋯"** de ese deploy → **"Instant Rollback"** (o **"Promote to
   Production"**) → confirma.

**Qué deberías ver**: en un minuto, antroapp.vercel.app sirve el deploy
anterior y arriba aparece un aviso de que la producción está "rolled back".
Mientras siga así, **los nuevos push a `master` no se publican solos**: para
volver al flujo normal, en ese aviso → **"Undo Rollback"** o promueve un deploy
nuevo cuando esté corregido.

Ojo: el rollback regresa **el código**, no la base. El SQL del pase es
compatible con el código viejo, salvo lo anotado en `docs/pase-produccion.md`
(paso 5: comisiones del panel de staff viejo).

### 8. Variables de Production que deben existir

1. **Settings** → **Environment Variables** → filtra por **Production**.
2. Deben estar estas tres, y ninguna más hace falta:

| Variable | Tipo | Valor (no lo copies aquí) |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Plain/config | la URL de producción (`https://kigltjvakwuuulvzbyri.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Plain/config | la anon key de **producción** |
| `SUPABASE_SERVICE_ROLE_KEY` | **Sensitive/Secret** | la service role de **producción** |

**Qué deberías ver**:
- las tres con el entorno **Production** marcado;
- en **Preview**, las mismas tres pero con valores de **dev**;
- **ninguna** `NEXT_PUBLIC_FASE2` en Production;
- ninguna variable con "service_role" que empiece con `NEXT_PUBLIC_`.

### 9. Ver los registros

1. **Logs** (menú superior del proyecto).
2. Filtra por **Environment: Production** y, si buscas algo puntual, por
   ruta (`/api/auth/login`, `/api/admin/create-staff`) o por **Level: Error**.

**Qué deberías ver** después del pase: peticiones 200/302 normales y ningún
500 repetido. Además, en Supabase (SQL Editor, solo lectura):
`select count(*) from public.app_errores where creado_en > now() - interval '1 hour';`
(los errores que la app reportó desde las pantallas).

---

## GitHub (github.com/diegogvp16/Antroapp)

### 10. Proteger `master`

1. **Settings** → **Rules** → **Rulesets** → **New ruleset** → **New branch ruleset**.
2. Nombre: `Proteger master`. **Enforcement status**: Active.
3. **Target branches** → **Add target** → **Include by pattern** → `master`.
4. Marca:
   - **Restrict deletions**;
   - **Block force pushes**;
   - **Require status checks to pass** → agrega el check de **Vercel**
     (aparece después del primer PR; si no aparece, déjalo para después).
   - Opcional, más estricto: **Require a pull request before merging** (0
     aprobaciones si trabajas solo). Si lo activas, el paso 8 del pase se
     hace con un PR de `candidato-pase` a `master` y "Merge pull request" en
     GitHub, en lugar del `git push origin master` del runbook.
5. **Create**.

**Qué deberías ver**: el ruleset "Proteger master" en verde (Active). Un
`git push --force origin master` debe ser rechazado con "protected branch".

### 11. Revisar quién tiene acceso

**Settings** → **Collaborators**: solo las personas que deben tener acceso.
**Settings** → **Deploy keys** y **Secrets and variables → Actions**: vacíos
salvo que sepas para qué es cada uno.

---

## Resumen para el día del pase

| # | Qué | Dónde | Antes / después del pase |
|---|---|---|---|
| 1 | Contraseñas filtradas y longitud mínima | Supabase → Authentication | Antes |
| 2 | Rate limits revisados | Supabase → Authentication | Antes |
| 3 | CAPTCHA **apagado** (hasta que la app lo soporte) | Supabase → Authentication | — |
| 4 | Respaldo de hoy visible | Supabase → Database → Backups | Antes (obligatorio) |
| 5 | Exposición automática apagada en dev (y recomendado en prod) | Supabase → Settings → Data API | Antes |
| 6 | Contraseña de la base rotada y probada | Supabase → Settings → Database; `.env.dev` | Justo antes |
| 7 | Saber dónde está Instant Rollback | Vercel → Deployments | Antes (por si acaso) |
| 8 | 3 variables de Production | Vercel → Settings → Environment Variables | Antes |
| 9 | Logs sin errores | Vercel → Logs; `app_errores` | Después |
| 10 | `master` protegida | GitHub → Settings → Rules | Antes |
