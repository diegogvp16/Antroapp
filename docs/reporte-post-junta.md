# Reporte del trabajo post-junta (rama `post-junta`)

24/11/2026. Base: `candidato-pase` (`d7b2e7f`), porque el pase todavía **no**
está en `master`. Etiqueta `checkpoint-post-pase` en ese commit (en GitHub).
Todo se hizo en **antroapp-dev**. Detalle por bloque, cómo probar y con qué
usuario: `docs/avance-post-junta.md`.

- **Vista previa**: https://antroapp-git-post-junta-antroapp.vercel.app
  (pide iniciar sesión en Vercel). Usa las llaves de dev; las banderas están
  apagadas, así que se ve como producción después del pase 2.
- **Último commit**: el de este reporte (ver `git log -1 origin/post-junta`).

## ⚠ Lo primero: hueco ALTO en el SQL del pase 1

Lo encontré en el bloque 7. Varias funciones del pase 1 (`nomina_semana`,
`grupo_rendimiento_rp`, `caja_configurar_permiso` y los ayudantes
`es_gerente_o_dueno`, `caja_puede_ver`, `puede_ver_club`) autorizan con
`if not (rol = 'admin' or …) then raise`. En plpgsql eso **no rechaza** si la
condición da NULL, y da NULL para una cuenta de Auth **sin perfil**, que
cualquiera puede crear llamando a `signUp` directo a Supabase con la anon key.

**Probado en dev**: una cuenta sin perfil leyó la **nómina** y el
**rendimiento por RP** de Club Demo Dev, y la actividad. Además, un perfil
dado de baja podía configurar permisos de caja; eso solo pasó al combinarse
con el bloque 5.

- Arreglo: `sql/post-junta/10a-pase1-autorizacion-sin-nulos.sql`. Cambia
  solo las líneas de autorización (`coalesce(…, false)`) y tiene su rollback.
- **Si el pase 1 aún no se hace**: agrégalo al pase 1 justo después del 7b.
- **Si ya se hizo**: aplícalo cuanto antes.
- Prueba: `node scripts/dev/probar-autorizacion-nulos.mjs`. Sin el arreglo
  fallan 12 casos; con él pasan los 32.
- Hasta que se aplique, **no** está en producción: el pase 1 no se ha hecho.

## Qué quedó, por bloque

| Bloque | Estado | Pruebas (dev) |
|---|---|---|
| 1. Alta de antro desde /admin | ✅ Asistente en 6 pasos, transaccional, solo admin, bitácora `club_altas` | dominio 47/47, punta a punta 54/54 (130 RPs en 9 s) |
| 5a. Linterna del escáner | ✅ Solo si la cámara la soporta; si falla, el escáner sigue | 13/13 (cámara simulada); **falta celular real** |
| 5b. Baja de staff y gerentes | ✅ Con motivo y bitácora; pierde acceso al momento aunque tenga la sesión abierta; su cookie vieja da 401 | 39/39 |
| 5c. Registro de actividad | ✅ Quién cuadró, anuló, reabrió o cerró, con hora y motivo | (en 39/39) |
| 4. CAPTCHA y antiabuso | ✅ Turnstile detrás de bandera, verificado en el servidor, falla segura; límite de registros por IP; cambio de contraseña obligatorio en el primer inicio | 28 pasan, 0 fallan, 3 saltadas (ver pendientes) |
| 3. Legales | ✅ Borradores (requieren abogado), `/terminos` y `/privacidad`, casillas del cliente y del RP detrás de bandera, inventario de datos personales | 23/23 |
| 2. Mensualidad con Stripe | ✅ Planes, estados, webhook firmado e idempotente, gracia sin bloqueo en plena noche, pantallas de dueño y admin, detrás de bandera, solo llaves de prueba | 60/60 sin llaves reales |
| 8. Qué ve el RP y regla de comisión | ✅ Por antro, editable por dueño y gerente, bitácora, vale desde el lunes siguiente | 28/28, dos antros |
| 7. Fase 2 | ✅ Integrada (bandera apagada), más CSV y alerta en el panel | 51/51, CSV 16/16, pantalla 12/12 |
| 6. Monitoreo y operación | ✅ `/api/salud`, errores y logs sin datos personales, alertas por correo (bandera), restaurar respaldos en dev, `docs/operacion.md` | 8/8; restauración: 42 tablas idénticas en 14 s |
| 9. Tema oscuro y pulido | ✅ Dueño y admin en oscuro desde el punto único; 0 textos bajo AA y 0 controles menores de 40 px en 32 pantallas | capturas en `screenshots-post-junta/` |
| 10. Cierre | ✅ Ver abajo | — |

**Recorrido de los 6 roles sobre un build de producción contra dev:**
- con las banderas **apagadas**: 35/35;
- con **todas encendidas** (CAPTCHA con llaves de prueba de Cloudflare,
  legales, mensualidad y fase 2): 41/41.

**Con las banderas apagadas:**
- Humo: 73/74. La única falla es HSTS, que en local no existe porque la
  agrega Vercel.
- Panel del RP 38/40. Las 2 fallas no son del código: son dos reservas
  «MIKE» que alguien creó **a mano** en dev el 23/11 a las 18:48–18:52, con
  un teléfono de 11 dígitos. No las toqué.
- Dashboards 24/24, instalable 34/34, escáner 13/13, caja en 3 sesiones
  17/17.

**Regresión completa** contra dev:
- caja 167/167, concurrencia 29/29, dashboards 28/28;
- visibilidad 68/68, login 15/15;
- `verificar-cuadre` sin diferencias al centavo.

**Pase 2 ensayado en dev** (`node scripts/dev/ensayo-pase2.mjs completo`):
- 13 rollbacks en orden inverso: sin restos de post-junta.
- 13 aplicaciones en orden, ~1.6 s cada una.
- El esquema queda **idéntico** al de antes del ensayo.

Orden, rollbacks y banderas: `docs/pase-produccion.md`, «Pase 2».

## Revisiones de seguridad

Tres revisiones con subagentes de solo lectura, más la auditoría final.
Ninguna encontró hallazgos críticos ni altos en el código nuevo; el alto
salió en el SQL del pase 1 (arriba). Lo que se arregló:

- **Alta de antros:**
  - clave de idempotencia: si se pierde la respuesta, no se borran las
    cuentas de un antro que sí se guardó;
  - solo se ligan cuentas recién creadas por el alta;
  - rangos también en la base;
  - la bitácora sobrevive si se borra el antro;
  - tope real de 400 cuentas;
  - respuesta sin caché;
  - script de cuentas huérfanas.
- **Registro por servidor:** un correo existente ya no puede hacer que se
  borre la cuenta de otra persona; el límite por IP aguanta peticiones en
  paralelo.
- **CAPTCHA:** sin token solo hay modo degradado si el **servidor** comprueba
  que Cloudflare no responde. Antes bastaba con no mandar el token.
- **Mensualidad:**
  - el checkout no abre un segundo cobro si ya hay una suscripción viva;
  - los eventos de otra suscripción no pisan la vigente;
  - el estado se aplica en la base con candado y desempate del mismo
    segundo;
  - cada evento se reclama antes de procesarlo;
  - la tarea diaria no tiene carreras y vuelve a publicar a quien pagó.
- **Contraseña temporal:** sin rol en la base hasta cambiarla.
- **Legales:** solo se aceptan versiones publicadas.
- **Auditoría final (en dev):**
  - todas las tablas con RLS;
  - todas las funciones `security definer` con `search_path` fijo;
  - quité al anónimo la ejecución de 5 funciones nuevas (`12-higiene-permisos.sql`);
  - ningún secreto en el repositorio ni en la historia de la rama.

**Abierto (bajo):**
- Algunas políticas viejas de `clubs` y fotos comparan `dueno_id =
  auth.uid()` directo. Un dueño con contraseña temporal todavía podría leer
  o editar **su propio** antro por ahí antes de cambiarla. No toca nada
  ajeno.
- La tabla `app_errores` guarda `usuario_id` y `navegador` para poder ayudar
  a quien tuvo el error.

## Decisiones que necesito de ti

1. **El hueco del pase 1** (arriba): confirmar que el 10a va en el pase 1.
2. **Contraseñas temporales del alta:** se generan y se ven una vez; el
   primer inicio obliga a cambiarlas. ¿Prefieres invitación por correo?
   Requiere SMTP (Resend).
3. **Dueño de grupo sin antro propio:** hoy va directo a `/grupo`. ¿Te late?
4. **Reglas de comisión por RP:** siguen con el formulario de antes, que
   cambia al momento. ¿Las paso al modelo con vigencia desde el lunes?
5. **Mensualidad:** las 9 preguntas de `docs/stripe-mensualidad.md`
   (precio con o sin IVA, planes, prueba gratis, días de gracia, cortesía a
   los antros actuales, CFDI, OXXO o SPEI, cancelación, grupos).
6. **Legales:** las 6 preguntas para el abogado de `docs/legal/README.md`
   (ley vigente tras la reforma de 2025, responsable o encargado, menores,
   transferencias, datos de RPs, plazos).
7. **Fase 2:** las decisiones de `docs/fase2.md` (propinas en el conteo de
   caja, vender sin existencias, concepto libre, quién edita el catálogo, de
   quién son las propinas).
8. **«Confirm email» en producción:** en dev está encendido, y así el
   registro de siempre (sin bandera) no puede crear el perfil. ¿Cómo está en
   producción?

## Lo que tienes que configurar a mano

| Dónde | Qué | Pasos |
|---|---|---|
| Supabase (prod) | SQL del pase 2 por el SQL Editor (y el 10a ya) | `docs/pase-produccion.md` |
| Cloudflare | Widget de Turnstile (producción y previews) | `docs/captcha.md` |
| Stripe | Producto, precio, webhook, portal, reintentos, llaves de prueba y luego de producción | `docs/stripe-mensualidad.md` |
| Resend | Dominio y llave para alertas | `docs/operacion.md` |
| Vercel | Variables de cada bandera (primero Preview), `CRON_SECRET` | los mismos documentos |
| UptimeRobot (o similar) | Monitor de `/api/salud` cada 5 min | `docs/operacion.md` |
| Abogado | Revisar `docs/legal/` antes de encender `NEXT_PUBLIC_LEGALES` | `docs/legal/README.md` |

## Pendiente o a medias

- **Registro por servidor (con bandera del CAPTCHA), el caso feliz completo:**
  - Hasta la creación de la cuenta no se pudo probar: dev tiene la
    confirmación por correo encendida, Supabase rechaza `@example.com` en
    `signUp` y limita los correos por hora.
  - No mandé correos a dominios inventados, porque los rebotes dañan la
    reputación de envío del proyecto.
  - Sí está probado: CAPTCHA, aceptación legal, límite por IP, correo inválido
    con mensaje claro y la ruta inexistente sin bandera.
  - Para cerrarlo: apagar «Confirm email» en dev un momento, o usar un SMTP de
    prueba.
- **Modo degradado del CAPTCHA por HTTP:** saltado en el cierre porque
  necesita un tercer servidor sin llave secreta. La regla pura está probada y
  la prueba lo acepta con `--degradado=`.
- **Checkout y portal de Stripe reales:** necesitan tus llaves de prueba.
- **Envío real de alertas:** necesita tu llave de Resend.
- **Linterna:** probar en un celular real (Android).

## Riesgos

- **El pase 2 redefine `caja_liquidar_cuenta`** (07). Está probado con caja,
  concurrencia y cuadre al centavo, y su rollback regresa la versión del
  pase 1. Aun así, no aplicarlo antes de una noche de operación.
- **`current_role_name()` ahora es nulo para perfiles dados de baja o con
  contraseña temporal.** Toda la regresión pasa, pero cualquier función
  futura debe usar `coalesce` (lección en `CLAUDE.md`).
- **Mensualidad real**: encender `mensualidad_real` solo cuando cobres de
  verdad. Con eso, el dueño ya no puede activar la suscripción a mano.
- **La bandera de legales publica borradores** si se enciende antes de la
  revisión del abogado. Las páginas lo dicen arriba, pero no deberían salir
  así.

## Estado de dev (lo que cambió)

- Aplicado todo el SQL de `sql/post-junta/` (01–12) y el de la fase 2
  (`sql/fase2/`).
- La limpieza de cada prueba borró sus datos. También limpié lo que dejó la
  prueba del hueco corrida **sin** el arreglo: un permiso de caja, la
  visibilidad de RPs y un perfil en Club Demo Dev.
- `demo_mariana` aceptó los legales en el recorrido con banderas: hay una
  constancia suya en `aceptaciones_legales`.
- Respaldos de dev en `backups/dev-2026-11-24-02-46-antes-restauracion/` y
  esquemas del ensayo en `backups/ensayo-pase2/`, ambos solo locales.

## Confirmaciones

- **No se escribió nada en producción**: ni SQL, ni datos, ni deploy, ni
  variables. Lo único contra producción fue un intento del script de
  huérfanas con `.env.local`, que **se negó** porque falta `--produccion`; no
  leyó ni escribió nada.
- **Ramas intactas** (verificado en `origin` al cerrar): `master` `dc61d91`,
  `desarrollo` `a469a5a`, `noche2` `6a5507b`, `candidato-pase` `d7b2e7f`,
  `fase2` `14ce066`. La fase 2 se **fusionó** dentro de `post-junta`; la
  rama `fase2` no se tocó.
- **Repositorio limpio**: sin credenciales, capturas ni respaldos en Git
  (`backups/`, `screenshots-*/`, `.env*` y `.next-*/` ignorados). Las llaves
  de prueba de Cloudflare que aparecen en scripts son las **públicas de
  prueba** que documenta Cloudflare; los secretos de webhook y cron usados en
  pruebas se generaron al azar y viven solo en el scratchpad local.
- Tipos (`tsc`), lint (`eslint`) y build en verde en cada commit.
