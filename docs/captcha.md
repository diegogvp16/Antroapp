# CAPTCHA (Cloudflare Turnstile) y antiabuso

Escrito el 24/11/2026 (rama `post-junta`). El CAPTCHA está **apagado por
defecto**: mientras no pongas las variables de abajo, la app se comporta
exactamente como hoy.

## Qué hace

| Pantalla | Con la bandera apagada | Con la bandera encendida |
|---|---|---|
| `/cliente/login`, `/dueno/login`, `/admin/login` | Igual que hoy | Casilla de Turnstile; el servidor (`/api/auth/login`) verifica el token |
| `/cliente/signup`, `/dueno/signup` | Igual que hoy (directo a Supabase) | Casilla + registro por el servidor (`/api/auth/registro`): CAPTCHA, máximo 5 registros por IP por hora y sin cuentas a medias |
| `/recuperar-contrasena` | Igual que hoy | Casilla (solo la exige el modo `supabase`) |

**Falla segura (modo `app`, el recomendado):**

- Si **Cloudflare no responde a nuestro servidor** (caído o lento, lo
  comprueba el servidor, no el navegador), **se deja entrar** en «modo
  degradado», con límites más estrictos:

  | Límite | Normal | Degradado |
  |---|---|---|
  | Fallos del mismo correo desde la misma IP | 5 | 3 |
  | Fallos desde la misma IP | 20 | 8 |
  | Registros por IP por hora | 5 | 2 |

- Un token **inválido** (falso, vencido o repetido) se rechaza con
  «No pudimos confirmar que eres una persona…».
- **Sin token** y con Cloudflare sano (un bot que no lo manda, o un
  bloqueador de anuncios en el teléfono) se rechaza con «Marca la casilla de
  verificación…». Quien llama no puede elegir el modo degradado solo con no
  mandar el token (arreglo de la revisión de seguridad).
- Si la llave secreta está mal puesta, la app no deja fuera a nadie: trabaja
  en modo degradado y lo registra en los logs de Vercel («captcha: error de
  configuración»).

**Modo `supabase` (opcional, más estricto).** Supabase Auth verifica el token
en **todas** sus llamadas, incluso las de quien use la anon key sin pasar por
la app. A cambio, si Cloudflare cae, **nadie** puede entrar ni registrarse
hasta que apagues el CAPTCHA en Supabase. Recomendación: empezar con `app` y
pasar a `supabase` solo si se ve abuso directo contra la API.

## Pasos en Cloudflare (crear las llaves)

1. Entra a **dash.cloudflare.com** (crea una cuenta gratuita si no tienes; no
   hace falta mover el dominio a Cloudflare).
2. Menú izquierdo → **Turnstile** → **Add widget** (o «Add site»).
3. **Widget name**: `AntroApp producción`.
4. **Hostnames**: agrega `antroapp.vercel.app` (y tu dominio propio si lo hay).
   Para las vistas previas de Vercel crea **otro** widget (`AntroApp
   previews`) con `vercel.app`. No mezcles los de producción y previews.
5. **Widget mode**: **Managed** (Cloudflare decide si muestra la casilla).
6. **Pre-clearance**: No.
7. **Create**.

**Qué deberías ver**: dos valores, **Site Key** (pública, empieza con `0x…`)
y **Secret Key** (secreta). Copia la Secret Key a tu gestor de contraseñas;
**no la pegues en ningún archivo del repositorio** ni en el chat.

## Pasos en Vercel (encender la bandera)

1. vercel.com → proyecto `antroapp` → **Settings** → **Environment Variables**.
2. Agrega, primero solo para **Preview** (para probar):

   | Nombre | Valor | Tipo |
   |---|---|---|
   | `NEXT_PUBLIC_CAPTCHA_TURNSTILE` | `1` | Plain |
   | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | la Site Key del widget de previews | Plain |
   | `TURNSTILE_SECRET_KEY` | la Secret Key del widget de previews | **Sensitive** |
   | `NEXT_PUBLIC_CAPTCHA_MODO` | `app` (opcional; es el valor por defecto) | Plain |

3. **Redeploy** de la última vista previa (las `NEXT_PUBLIC_*` se fijan al
   compilar: sin redeploy no cambia nada).
4. Prueba en la vista previa: `/cliente/login` debe mostrar la casilla y
   dejarte entrar; con un bloqueador que impida cargar Cloudflare, también
   debe dejarte entrar (modo degradado).
5. Cuando funcione, repite con las llaves del widget de producción en
   **Production** y haz el deploy.

**Apagarlo de emergencia**: borra `NEXT_PUBLIC_CAPTCHA_TURNSTILE` (o ponla en
`0`) en Production y haz redeploy. La app vuelve exactamente a como está hoy.

### Solo si eliges el modo `supabase`

1. Supabase → proyecto → **Authentication** → **Attack Protection** →
   **Enable Captcha protection** → proveedor **Turnstile** → pega la **misma
   Secret Key** → Save.
2. En Vercel, `NEXT_PUBLIC_CAPTCHA_MODO` = `supabase` y redeploy.
3. **Orden importa**: primero el deploy con la bandera, después el interruptor
   de Supabase. Al revés, nadie entra entre un paso y otro.

## Antes de encender: el registro y la confirmación por correo

En **antroapp-dev** la confirmación por correo está **encendida**, así que
`signUp` no da sesión y el registro de siempre (sin bandera) no puede crear el
perfil. El registro nuevo por el servidor sí lo resuelve (crea el perfil con
la service role). **Por confirmar con Diego**: cómo está en producción
(Supabase → Authentication → Providers → Email → «Confirm email»).
Supabase limita los correos de confirmación por hora (en dev se agotó durante
las pruebas); con muchos registros hace falta un SMTP propio (Resend u otro).

## Límites de intentos: lo que hay y propuestas

**Hoy (sin bandera):**

- Login, por `/api/auth/login`: 5 fallos del correo desde una IP, 30 del
  correo desde cualquier IP o 20 de una IP en 15 min. Solo cubre los
  formularios.
- Registro: **ninguno** en la app, solo el de Supabase Auth (por IP, en su
  panel).
- Supabase Auth: sus propios límites (ver `docs/seguridad-manual.md`, punto 2).

**Con la bandera:** además, el CAPTCHA, el modo degradado y el límite de
registros por IP (`registro_intentos`, `sql/post-junta/04-antiabuso.sql`).

**Propuestas (no hechas):**

1. **Encender el CAPTCHA en modo `app` en producción** en cuanto tengas las
   llaves: es lo que más reduce el abuso de formularios, sin riesgo de dejar
   a nadie fuera.
2. **Reservas sin cuenta** (`/cliente/reservar`, INSERT anónimo): hoy no
   tienen límite en la app. Propuesta: pasarlas por una ruta con CAPTCHA y
   límite por IP (por ejemplo, 10 por hora), detrás de la misma bandera.
3. **Recuperar contraseña**: limitar en la app a 3 solicitudes por correo por
   hora (hoy lo limita solo Supabase).
4. **Limpieza**: correr `antiabuso_limpiar()` cada semana (borra intentos de
   más de 30 días; `docs/operacion.md`).
5. Si aparece abuso directo contra Supabase Auth (con la anon key), pasar al
   modo `supabase`.

## Cómo se probó (dev)

`node scripts/dev/probar-captcha.mjs` (29 pasan; una saltada por el límite
de correos de Supabase en dev). Usa las **llaves de prueba públicas** de
Cloudflare (sitio `1x00000000000000000000AA`; secretas `1x…AA` que siempre
pasa y `2x…AA` que siempre falla), que no sirven para producción:

- reglas de decisión y respuestas reales de Cloudflare;
- bandera apagada: login igual que hoy, ruta de registro inexistente, ninguna
  petición a Cloudflare;
- bandera encendida: login con token, modo degradado con límites estrictos,
  registro con límite por IP, la casilla carga y el cliente entra;
- cambio de contraseña obligatorio de las cuentas creadas por el alta.
