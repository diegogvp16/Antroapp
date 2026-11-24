# Avance del trabajo post-junta (rama `post-junta`)

Bitácora viva: se actualiza al terminar **cada** bloque. Si el trabajo se
detiene a la mitad, aquí queda exactamente qué está hecho, qué falta, cómo
probarlo y con qué usuario de dev.

- **Rama**: `post-junta`, creada el 24/11/2026 desde `candidato-pase`
  (`d7b2e7f`) porque el pase todavía **no** está en `master`
  (`master` = `dc61d91`).
- **Etiqueta**: `checkpoint-post-pase` en `d7b2e7f` (subida a GitHub).
- **Base**: solo antroapp-dev. A producción no se escribió nada.
- **SQL nuevo**: `sql/post-junta/NN-*.sql`, cada uno con su
  `NN-*-rollback.sql`, aplicado solo en dev.
- **Usuarios de dev**: `dev_<rol>@example.com` (admin, dueno, gerente,
  staff, rp, cliente…); contraseña en `backups/dev-credenciales.json`.
- **Servidor local contra dev**: `node scripts/dev/servidor-dev.mjs`
  (puerto 3001). Build sin pisarlo: `NEXT_DIST_DIR=.next-build npx next build`.

Orden pedido: 1 → 5 → 4 → 3 → 2 → 8 → 7 → 6 → 9 → 10.

> **⚠ Hallazgo ALTO en el SQL del pase 1** (encontrado en el bloque 7,
> arreglado en `sql/post-junta/10-autorizacion-sin-nulos.sql`, solo dev):
> varias funciones autorizan con `if not (rol = admin or …) then raise`, y
> en plpgsql eso **no rechaza** cuando la condición da NULL. Una cuenta de
> Auth **sin perfil** (cualquiera la crea con `signUp` directo a Supabase)
> leía en dev la **nómina** y el **rendimiento por RP de cualquier antro** y
> la actividad. Con perfiles dados de baja o con contraseña temporal,
> también podía configurar permisos de caja. **Aplicar el 10 en el mismo pase**, justo
> después del SQL del pase 1. Prueba: `node scripts/dev/probar-autorizacion-nulos.mjs`
> (sin el arreglo fallan 12 o más; con él 32/32).

| Bloque | Estado |
|---|---|
| 1. Alta de antro desde /admin | ✅ Hecho y probado en dev |
| 5. Puerta y equipo | ✅ Hecho y probado en dev |
| 4. CAPTCHA y antiabuso | ✅ Hecho (bandera apagada); falta probar el registro completo |
| 3. Legales | ✅ Borradores + páginas y casillas (bandera apagada) |
| 2. Mensualidad con Stripe (prueba) | ✅ Hecho sin llaves reales (bandera apagada); falta probar con tus llaves de prueba |
| 8. Qué ve el RP, por antro | ✅ Hecho y probado en dev |
| 7. Fase 2 | ✅ Integrada (bandera apagada) + CSV y alerta |
| 6. Monitoreo y operación | ✅ Hecho y probado en dev |
| 9. Tema oscuro y pulido | ✅ Hecho |
| 10. Cierre | ⏳ Siguiente |

---

## Bloque 1 — Alta de un antro nuevo desde /admin ✅

**Qué quedó**

- `/admin` → tarjeta «Dar de alta un antro» → `/admin/alta-antro`
  (reemplaza el formulario corto anterior, que creaba el antro sin equipo).
- Asistente en 6 pasos: **Datos** (nombre, dirección, ciudad, zona horaria,
  horario) · **Cover y políticas** (cover informativo, depósito informativo,
  edad mínima ≥ 18, vestimenta, música, ambiente, hora límite de llegada) ·
  **Mesas** (generador «N mesas con prefijo y capacidad», más edición fila
  por fila) · **Equipo** (dueño opcional; gerentes, staff y RPs uno por uno o
  pegando una lista «Nombre, correo») · **Grupo** (independiente, grupo
  nuevo o grupo existente; dueño del grupo = el dueño del antro, una cuenta
  nueva o nadie más) · **Resumen** con «En borrador» / «Publicado».
- Validación con el mismo esquema (zod) en el navegador y en el servidor:
  `lib/domain/alta-club.ts`.
- `POST /api/admin/alta-club`: exige sesión de **admin** (rol leído de la
  base), valida, crea las cuentas de Auth con contraseña temporal generada en
  el servidor y llama a `admin_alta_club()` **con la sesión del admin**. Si
  una cuenta o la base fallan, borra las cuentas que había creado: **no queda
  nada a medias**.
- `sql/post-junta/01-alta-club.sql`: función `admin_alta_club(jsonb)`
  (`security definer`, `search_path` vacío; vuelve a exigir admin y toma
  quién lo creó de `auth.uid()`) que hace antro + mesas + perfiles + grupo +
  bitácora en **una transacción**; tabla `club_altas` (bitácora: quién, cuándo,
  publicado o no, conteos; sin correos ni contraseñas), con RLS: solo el
  admin la lee; nadie la escribe directo. GRANT explícitos.
- Las contraseñas temporales se muestran **una vez** al final (con «Copiar
  todo») y no se guardan en ningún lado.

**Decisiones tomadas (cámbialas si no te late)**

- Contraseñas temporales generadas por el servidor en vez de pedirlas una por
  una (con 130 RPs no es práctico). Cada quien la cambia con «¿Olvidaste tu
  contraseña?».
- El dueño del antro se liga por `clubs.dueno_id` (como `/dueno/signup`), con
  `profiles.club_id` nulo. Un dueño de grupo «cuenta nueva» es un perfil
  `dueno` sin antro propio que ve el grupo en `/grupo` (su `/dueno/panel`
  dice que no tiene antro: pendiente decidir si se le manda directo a
  `/grupo`).
- Las reglas de pago de RPs no van en el alta: el dueño/gerente las pone
  en su panel (bloque 8).

**Cómo probarlo**

```bash
node scripts/dev/probar-alta-club-dominio.mjs        # 44/44, sin base
node scripts/dev/servidor-dev.mjs                    # en otra terminal
node scripts/dev/probar-alta-club.mjs [--masivo]     # 48/48 (49/49 con --masivo)
```

A mano: entra como `dev_admin@example.com` a `/admin` → «Empezar el alta».

**Resultados (24/11/2026, dev)**

- Seguridad: sin sesión → 401; cliente, RP, staff, gerente y dueño → 403 en
  la ruta **y** rechazados por la función de la base; ninguno (ni el anónimo)
  lee `club_altas`.
- Alta en borrador con 5 cuentas en 1.1 s; alta masiva de 130 RPs en 9.1 s
  (la función de Vercel tiene 60 s).
- Transacción: correo ya existente → 400 «Ya existe una cuenta con el correo
  …», sin antro ni cuentas nuevas; falla a la mitad dentro de la base → no
  queda antro, mesas ni perfiles; zona horaria inválida → no queda nada.
- Capturas a 390 y 360 px en `screenshots-post-junta/alta/` (sin scroll
  horizontal ni errores de página).

**Revisión de seguridad (subagente, solo lectura)**: sin hallazgos críticos
ni altos. Arreglado después (commit `97868dd`):
- **Idempotencia**: la ruta genera `alta_id`; si la respuesta de la base se
  pierde, revisa si sí se guardó antes de borrar cuentas, y la misma clave
  dos veces no crea dos antros.
- La función solo liga cuentas **recién creadas por el alta**
  (`app_metadata.alta_club`, de menos de 30 min, sin borrar ni bloquear).
- Rangos de edad, depósito y textos también en la base.
- `club_altas` sobrevive si se borra el antro (`on delete set null`).
- Tope real de 400 cuentas contando dueños.
- Respuesta con `Cache-Control: no-store`.
- Errores al deshacer cuentas se registran (sin correos) y
  `scripts/limpiar-altas-huerfanas.mjs` lista o borra las huérfanas (dev por
  defecto; producción solo con `--produccion`).
- El dueño de grupo sin antro propio va directo a `/grupo`.

Queda abierto (decisión tuya, en el reporte): las contraseñas temporales no
expiran y las cuentas nacen confirmadas; un correo mal escrito del dueño
queda ligado al antro. Mitigado en el bloque 4: el primer inicio obliga a
elegir contraseña propia (la temporal deja de servir).

**Para producción (pase 2)**: aplicar `sql/post-junta/01-alta-club.sql`
**antes** de publicar el código (sin la función, el asistente responde «No se
pudo dar de alta el antro. No se guardó nada» y borra las cuentas que creó).
Rollback: `sql/post-junta/01-alta-club-rollback.sql` (no borra antros).

---

## Bloque 5 — Puerta y equipo ✅

**a) Linterna en el escáner** (`components/boton-linterna.tsx`, en los dos
escáneres de `/staff/panel`): el botón «Prender linterna» aparece **solo** si
la cámara la soporta (Chrome en Android sí; Safari en iPhone no). Si falla al
prenderla, avisa y la cámara sigue leyendo. Prueba: `probar-escaner.mjs`
13/13 (con linterna simulada: aparece, pide `torch=true` y el QR se lee en
1.9 s con la linterna prendida; sin linterna: no aparece y lee igual).
Falta probarla en un celular real.

**b) Baja y reactivación de staff y gerentes** (`sql/post-junta/02-baja-personal.sql`):
- `current_role_name()` y `current_club_id()` devuelven nulo para un perfil
  con `activo = false`: **pierde todo al momento aunque tenga la sesión
  abierta** (todas las políticas pasan por ahí). Además la baja borra sus
  sesiones de Auth: su cookie vieja da 401 y no puede renovar el token.
- `personal_cambiar_estado(perfil, activo, motivo)`: motivo obligatorio y
  bitácora `personal_movimientos` (quién, cuándo, motivo). Admin y dueño:
  staff y gerentes; gerente: solo staff; nadie a sí mismo. El UPDATE directo
  de `activo` sobre staff o gerentes queda bloqueado (siempre con motivo). La
  baja de RPs **sigue igual que hoy**.
- El login (`/api/auth/login`) y `create-staff` rechazan staff y gerentes
  dados de baja (antes solo RPs); `/staff/*` y `/rp/panel` cierran la sesión
  y el login muestra «Tu cuenta ha sido desactivada».
- Pantallas: en `/dueno/panel` («Mi personal») y en `/staff/equipo` y
  `/dueno/equipo` («Equipo y actividad»), con confirmación y motivo.

**c) Registro de actividad** (`sql/post-junta/03-actividad.sql`,
`actividad_club`): quién cuadró, anuló, reabrió o cerró (mesa, monto, motivo,
hora) y las bajas de personal, por noche operativa; filtros «Anulaciones y
reaperturas», «Cuadres y cierres», «Personal». Solo gerente, dueño y admin.
El gerente entra con el botón «Equipo y actividad» de `/staff/panel`; el
dueño con «Ver actividad del antro».

**Cómo probarlo**

```bash
node scripts/dev/probar-baja-personal.mjs      # 39/39 (con servidor-dev)
PLAYWRIGHT_DESDE=<carpeta> node scripts/dev/probar-escaner.mjs   # 13/13
```
A mano: `dev_gerente` → «Equipo y actividad»; `dev_dueno` → «Mi personal».

**Regresión** tras cambiar `current_role_name()`: visibilidad 68/68, caja
167/167, dashboards 28/28, concurrencia 29/29, login 15/15 (dos chequeos
ajustados: el RP dado de baja ahora recibe «Solo para RPs» en vez de «Tu
cuenta está desactivada»; sigue rechazado y el panel lo saca con el aviso).

**Para producción (pase 2)**: 02 y 03 **antes** del código (sin 02, las
pantallas de equipo fallan con «No se pudo guardar»). Rollback en orden
inverso: `03-actividad-rollback.sql`, `02-baja-personal-rollback.sql`
(regresa los ayudantes y el trigger; no reactiva a nadie).

---

## Bloque 4 — CAPTCHA y antiabuso ✅ (bandera apagada)

**Qué quedó** (detalle y pasos clic a clic: `docs/captcha.md`)

- Turnstile en `/cliente/login`, `/dueno/login`, `/admin/login`, registros y
  recuperar contraseña, **solo** con `NEXT_PUBLIC_CAPTCHA_TURNSTILE=1` +
  `NEXT_PUBLIC_TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`. Apagada: no se
  carga nada de Cloudflare y todo funciona como antes (probado).
- Verificación en el servidor (`lib/captcha-servidor.ts`). **Falla segura**:
  si la casilla no carga o Cloudflare no responde, se entra en «modo
  degradado» con límites más estrictos (3 fallos por correo+IP, 8 por IP, 2
  registros por IP por hora); un token inválido sí se rechaza.
- Con la bandera, los registros pasan por `POST /api/auth/registro`: CAPTCHA,
  máximo 5 registros por IP por hora (`sql/post-junta/04-antiabuso.sql`) y
  sin cuentas a medias (si falla el perfil o el antro, se borra la cuenta).
- Modo opcional `supabase` (Supabase Auth verifica el token; más estricto,
  pero si Cloudflare cae nadie entra).
- **Contraseña temporal del alta**: el primer inicio manda a
  `/cambiar-contrasena`; la ruta cambia la contraseña y quita la marca en un
  paso. (Fuera de la bandera: solo afecta a cuentas creadas por el alta.)
- `lib/supabase/servicio.ts` ahora es `server-only`.

**Cómo probarlo**: `node scripts/dev/probar-captcha.mjs` con los dos
servidores que indica su cabecera (3001 sin bandera, 3003 con las llaves de
prueba públicas de Cloudflare). Resultado: 29 pasan, 0 fallan, 1 saltada.

**Pendiente**
- El registro completo por el servidor (cliente y dueño) quedó **sin
  probar**: dev tiene la confirmación por correo encendida y se agotó el
  límite de correos de Supabase. Se repite en el bloque 10.
- **Por confirmar con Diego**: si producción tiene «Confirm email» encendido,
  el registro de siempre (sin bandera) no puede crear el perfil.
- Propuestas de límites (reservas sin cuenta, recuperar contraseña) en
  `docs/captcha.md`.

**Para producción (pase 2)**: `04-antiabuso.sql` antes del código (sin la
tabla, el registro por servidor responde «No pudimos crear tu cuenta»; con
la bandera apagada no se usa). Rollback: `04-antiabuso-rollback.sql`.

---

## Bloque 3 — Legales ✅ (borradores; bandera apagada)

**Qué quedó**

- `docs/legal/` (todos marcados **«BORRADOR: requiere revisión de un
  abogado»**, no son asesoría legal): `terminos.md`, `privacidad.md` (aviso
  integral: datos, finalidades, con quién se comparten, ARCO, contacto,
  conservación), `reservas-y-qr.md` (el QR no garantiza la entrada; derecho
  de admisión sin discriminación; no se cobra al cliente),
  `contrato-antro.md` (mensualidad sin cifras, gracia sin bloqueo en plena
  noche, responsabilidades, datos) e `inventario-datos.md` (tablas y
  columnas con datos personales, verificado contra el esquema de dev).
  Preguntas abiertas para el abogado en `docs/legal/README.md`.
- Bandera `NEXT_PUBLIC_LEGALES=1` (apagada): `/terminos` (incluye la política
  de reservas) y `/privacidad`, con aviso de «Borrador en revisión»; casilla
  obligatoria en `/cliente/signup`; en la primera entrada del RP a su panel,
  pantalla «Antes de empezar» para aceptar. Apagada: 404 y formularios
  iguales.
- `sql/post-junta/05-legales.sql`: `aceptaciones_legales` (quién, qué
  documento, qué versión; la fecha la pone la base). Cada quien inserta y lee
  lo suyo; el admin lee todo; nadie modifica ni borra.
- Los textos de las páginas salen de los `.md` con
  `node scripts/legal-a-paginas.mjs` (`--revisar` avisa si no coinciden).
  Al cambiar un documento, subir `VERSION_LEGAL` en `lib/legal/version.ts`.

**Cómo probarlo**: `node scripts/dev/probar-legales.mjs` con los servidores
de su cabecera (3001 sin bandera; 3003 con `NEXT_PUBLIC_LEGALES=1`): 22/22.
Capturas en `screenshots-post-junta/legales/`.

**Notas**
- No hay registro público de RPs (los crea el staff): la casilla del RP es
  en su **primera entrada** al panel.
- Si el cliente se registra con confirmación por correo encendida (como en
  dev), no hay sesión para guardar su aceptación en el flujo de siempre; con
  la bandera del CAPTCHA (registro por servidor) sí se guarda.

**Para producción (pase 2)**: `05-legales.sql` antes de encender la bandera.
Rollback: `05-legales-rollback.sql` (borra la constancia: exportarla antes).

---

## Bloque 2 — Mensualidad con Stripe ✅ (bandera apagada, sin llaves reales)

**Qué quedó** (pasos clic a clic y preguntas de precios: `docs/stripe-mensualidad.md`)

- `sql/post-junta/06-mensualidad.sql`: `planes` (apuntan a un precio de
  Stripe; el monto vive en Stripe), `suscripciones` (activa, en_gracia,
  vencida, cancelada, sin_suscripcion), `pagos_mensualidad` (historial),
  `stripe_eventos` (idempotencia), `config_plataforma.mensualidad_real` y
  el trigger `clubs_candado_suscripcion`: con cobro real, el dueño ya no
  activa la suscripción a mano (deuda 2).
- Webhook `/api/stripe/webhook`: firma verificada sobre el cuerpo crudo,
  idempotente, tolerante al desorden (un evento viejo no pisa uno nuevo),
  rechaza eventos de producción sin permiso explícito.
- **Nunca bloqueo en plena noche**: la gracia termina a las 08:00 en la zona
  del antro; el webhook nunca despublica; lo hace la tarea diaria
  (`/api/cron/mensualidad` con `CRON_SECRET`, en `vercel.json` a las 16:00
  UTC). Vencido: deja de verse al público; puerta, caja y reportes siguen.
- `/dueno/mensualidad`: plan, estado, próximo cobro, gracia, historial,
  «Suscribirme» (Checkout) y «Administrar pago» (portal). `/admin/mensualidad`:
  estado de todos los antros y alta de planes.
- Solo llaves de prueba (`sk_test_`/`rk_test_`); `sk_live_` se rechaza salvo
  `STRIPE_PERMITIR_PRODUCCION=1`.

**Cómo probarlo**: `node scripts/dev/probar-mensualidad.mjs` (cabecera con los
dos servidores y las variables). Resultado: **56/56**, con eventos firmados
localmente con un secreto inventado.

**Pendiente (necesita tus llaves de prueba de Stripe)**: Checkout y portal de
verdad. En la prueba llegan hasta Stripe y fallan por la llave falsa (502,
sin detalles). Pasos en `docs/stripe-mensualidad.md`, «Probar en modo de
prueba».

**Para producción (pase 2)**: `06-mensualidad.sql` con
`mensualidad_real = false` (todo igual que hoy). Rollback:
`06-mensualidad-rollback.sql` (exportar antes si ya hubo cobros).

---

## Bloque 8 — Qué ve el RP y regla de comisión, por antro ✅

**Qué quedó** (`sql/post-junta/07-config-rp.sql`)

- **Qué ven los RPs** (`club_config_rp`): solo estado · estado y monto (lo de
  hoy, por defecto) · estado, monto y botellas (renglones de consumo).
  Aplica al momento; `rp_nivel_visibilidad()` ya no está fija.
- **Regla de comisión del antro** (`reglas_comision`, con vigencia): % del
  consumo · $X fijo por reserva que consume · cuota (las primeras N de la
  semana no pagan; desde la N+1 se paga $X). Un cambio vale **siempre desde
  el lunes siguiente**; reprogramar antes del lunes reemplaza lo programado.
  Cada comisión guarda `regla_id`.
- Compatibilidad: un antro sin regla nueva calcula **exactamente como hoy**;
  la regla propia de un RP (`rp_comision_overrides`) sigue ganando.
- Bitácora `config_rp_cambios` (antes, después, desde cuándo, quién).
  Editan dueño y gerente (y admin); el staff y el RP no leen nada de esto.
- Pantalla: en «Reglas de pago a RPs» (panel del dueño y del gerente), el
  editor nuevo sustituye al formulario viejo que cambiaba la regla al
  momento (retroactivo para la semana en curso).

**Cómo probarlo**: `node scripts/dev/probar-config-rp.mjs` (28/28, dos antros:
uno con cuota y otro con porcentaje; mesas cuadradas por el camino real).
Simula «ya llegó el lunes» moviendo la regla programada al lunes actual.

**Pendiente**: las reglas **por RP** siguen con el formulario de antes
(cambian al momento). Pasarlas al modelo con vigencia es el siguiente paso
(`docs/reglas-comision.md`).

**Para producción (pase 2)**: `07-config-rp.sql` (redefine
`caja_liquidar_cuenta` y `rp_progreso_cuota`). Rollback probado en dev
(`07-config-rp-rollback.sql` regresa las funciones del pase 1).

---

## Revisión de seguridad de los bloques 2 a 5 (subagente, solo lectura)

Sin hallazgos críticos ni altos. Arreglado (`sql/post-junta/08-revision-seguridad.sql`
y código):
- **Registro por servidor**: con la confirmación por correo encendida, un
  correo existente ya no puede provocar que se borre la cuenta de otra
  persona; solo se deshace lo creado en esa petición.
- **CAPTCHA**: sin token solo hay modo degradado si el servidor comprueba
  que Cloudflare no responde (antes bastaba con no mandar el token).
- **Mensualidad**: un antro no puede terminar con dos suscripciones por pagar
  dos veces (el checkout consulta Stripe). Los eventos de otra suscripción
  no pisan la vigente. El estado se aplica en la base con candado y
  desempate del mismo segundo. Cada evento se reclama antes de procesarlo.
  La tarea diaria no tiene carreras y vuelve a publicar a quien pagó.
- **Límite de registros**: se anota el intento antes de contar (las
  peticiones en paralelo ya no pasan todas).
- **Contraseña temporal**: mientras no la cambie, la base le quita el rol
  (`current_role_name`, `club_es_dueno`, `club_es_dueno_grupo`).
- **Legales**: solo se aceptan versiones publicadas (`versiones_legales`).

Pruebas: mensualidad 60/60, alta 54/54, legales 22/22, baja 39/39,
config RP 28/28, caja 167/167, visibilidad 68/68, login 15/15.

---

## Bloque 7 — Fase 2: catálogo, inventario y propinas ✅ (bandera apagada)

**Qué quedó**

- Rama `fase2` fusionada en `post-junta` **sin conflictos** (la rama `fase2`
  no se tocó) y su SQL (`sql/fase2/2026-11-21-inventario-propinas.sql`)
  vuelto a aplicar en dev. Ya traía: alerta de existencias bajas en el
  catálogo y en la hoja de consumo; venta que **no** se bloquea por
  existencias (queda negativa con aviso); propina aparte del consumo, del
  saldo y de la comisión del RP; propinas por mesa y «Propinas de la noche»
  en el cuadre; hoja «Agregar consumo» con catálogo, categorías y buscador;
  catálogo editable por el gerente.
- Nuevo: **importar el catálogo desde CSV** (`producto_importar`,
  `sql/post-junta/09-catalogo-csv.sql`; todo o nada, error con número de
  fila, no toca existencias de productos que ya existen) y **alerta de
  existencias bajas en el panel del gerente**.

**Cómo probarlo**: `node scripts/dev/probar-fase2.mjs` (51/51) y
`node scripts/dev/probar-catalogo-csv.mjs` (16/16). Pantallas con la bandera
encendida y apagada: en el bloque 10.

**Para producción (pase 2, solo si se decide pasar la fase 2)**:
`sql/fase2/2026-11-21-inventario-propinas.sql` y luego `09-catalogo-csv.sql`.
Rollbacks: `09-catalogo-csv-rollback.sql`, `sql/fase2/…-rollback.sql`.
Decisiones abiertas de la fase 2 en `docs/fase2.md`.

---

## Bloque 6 — Monitoreo y operación ✅

- `GET /api/salud`: 200 con la base (y cuánto tardó), versión y entorno;
  503 si la base no contesta. Sin datos ni caché. Para un monitor externo.
- `/api/errores` guarda los errores **sin correos, teléfonos, tokens ni
  llaves**, y la ruta sin parámetros (`lib/domain/sanitizar.ts`).
- Los `console.error` de servidor con objetos de error pasan por
  `registrarError` (`lib/log.ts`): solo código y tipo.
- «Errores recientes» del admin: últimos 7 días, agrupados, con etiqueta de
  24 h (verde, ámbar, rojo).
- Alertas por correo **detrás de bandera apagada** (`ALERTAS_CORREO` +
  Resend): pico de errores, cobro fallido y antros despublicados; una por
  tipo por hora (`sql/post-junta/11-alertas.sql`). Sin llaves no se probó el
  envío real (pendiente con tu llave de Resend).
- `scripts/dev/restaurar-dev.mjs` (no existía, aunque `respaldar-dev` lo
  mencionaba): prueba hecha en dev, daño a propósito y restauración de
  **42 tablas idénticas al respaldo en 14.2 s**; después cuadre, dashboards y
  caja en verde.
- `docs/operacion.md`: qué revisar cada día y cada semana, monitor externo,
  alertas clic a clic, qué hacer si algo se cae (también en plena noche) y
  cómo restaurar un respaldo en producción paso a paso.

**Cómo probarlo**: `node scripts/dev/probar-monitoreo.mjs` (8/8).

---

## Bloque 9 — Tema oscuro y pulido ✅

- **Un solo punto**: `TEMA_REPORTES` en `lib/tema-reportes.ts` ahora gobierna
  nómina, `/grupo`, **todo `/dueno/*` y todo `/admin/*`** (los layouts los
  envuelven con `TemaReportesContenedor`). Con `"actual"` todo vuelve al
  claro de antes; con `"claro"`, a la paleta clara con dorado. El cliente ya
  tenía su oscuro (`.theme-noche`); la caja y el RP, `.theme-caja`.
- `scripts/dev/capturas-post-junta.mjs`: 16 pantallas de 6 roles a 390 y
  1280 px, y **mide** el contraste de cada texto (WCAG AA), los elementos
  táctiles de menos de 40 px y el desborde horizontal. Antes: 0 textos bajo
  AA y 37 controles chicos en 10 pantallas. Después: **0 y 0 en las 32**.
- Áreas táctiles a 40 px: enlaces «← Volver», selector de rango de
  `/grupo`, pasos del alta, «Ver N RPs sin movimientos», borrar mesa y foto
  (la marca visible sigue igual de chica), «Mi perfil» y «Cerrar sesión» del
  cliente.
- Capturas en `screenshots-post-junta/antes` y `…/despues` (no van a Git).
- De paso se encontró y limpió basura de dev que dejó la prueba del hueco al
  correrla **sin** el arreglo, para confirmar que lo detectaba. Ahora esa
  prueba deshace lo que alcance a cambiar.
