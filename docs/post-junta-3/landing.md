# Bloque 5 — /para-clubes: página para dueños de antro y contacto

Rama `n4-landing` (sobre `post-junta-3`), 27/11/2026. Todo probado en
antroapp-dev. **Nada en producción.** La página nace **apagada**.
Corregido el mismo día tras la revisión independiente del carril (11
hallazgos; ver «Correcciones de la revisión» al final).

## Qué se hizo

1. **Página pública `/para-clubes`** (tema noche): qué es AntroApp para un
   dueño, cómo funciona una noche (5 pasos), qué ve cada rol, cómo se les paga
   a los RPs, el antro de demostración con sus datos públicos, precio
   «[por definir]», 8 preguntas frecuentes (solo respuestas verdaderas) y el
   formulario de contacto. Se pinta en el servidor en cada visita
   (`force-dynamic`). Título, descripción, canonical y Open Graph (`es_MX`)
   salen de `generateMetadata` **solo con la bandera encendida**: el 404 no
   deja ver nada de la página.
2. **Banderas de plataforma** en la base (tabla propia `plataforma_banderas`,
   no `config_plataforma`, para no tocar el check de `06-mensualidad.sql` ni
   chocar con otros carriles), las dos **apagadas**:
   - `para_clubes`: apagada, `/para-clubes` responde 404 y la base rechaza
     los envíos. Sin el SQL 50 (producción hoy) también da 404, y la app anota
     el código del error en los registros (no lo esconde).
   - `contacto_requiere_captcha`: encendida, la base **solo** acepta el
     formulario de la service role (la ruta de la app que ya revisó el
     token de Turnstile); el anónimo o una sesión que llame directo a
     `/rest/v1/rpc/para_clubes_contacto_enviar` se rechaza.
   El admin las cambia en `/admin/funciones` (componente nuevo, una línea de
   montaje). «Exigir CAPTCHA» solo se puede encender si la app tiene
   `NEXT_PUBLIC_CAPTCHA_TURNSTILE`; si quedara exigido sin ella, la pantalla
   lo avisa en rojo. Cada cambio queda en `para_clubes_bitacora`.
3. **Contacto**: se guarda en `contactos_clubes`; **no se manda ningún
   correo**. El anónimo solo escribe por `para_clubes_contacto_enviar()`
   (SECURITY DEFINER) con validación (largos, correo, teléfono opcional de
   10–15 dígitos, sin enlaces ni `< >` en nombre/antro/ciudad, mensaje
   ≤ 1,000 y ≤ 2 enlaces) y casilla trampa (`p_sitio_web`: responde
   «recibido», **no guarda nada ni cuenta para ningún límite**).
   Límites en la base: 3/hora y 10/día por conexión, 3/día por correo,
   60/hora en total; candado por conexión y por correo
   (`pg_advisory_xact_lock`) para que dos envíos simultáneos no se salten el
   límite. Los avisos de límite son **neutros** («Ya recibimos varios
   mensajes. Intenta de nuevo más tarde.»): no confirman si un correo ya se
   usó. El tope total dice «Estamos recibiendo muchos mensajes. Intenta de
   nuevo en una hora.» (no hay otro canal de contacto real en el código que
   se pueda ofrecer).
4. **IP**: `public.ip_cliente()` de `sql/post-junta-3/02-ip-cliente.sql`
   (`cf-connecting-ip`; el primer valor de `x-forwarded-for` lo inventa quien
   llama). Solo cuando llama la service role se usa la IP que manda la ruta
   (`p_ip`, validada como IP; si no lo es, se ignora). La ruta la toma de
   `ipDe()` (`lib/supabase/servicio.ts`, la misma del login): en Vercel ese
   encabezado lo pone Vercel.
5. **Huellas**: IP y correo se guardan como sha256 con una **sal secreta**
   (`contacto_sal`, generada al aplicar el SQL, no se lee por la API).
   Se borran las de más de 7 días en cada envío, al abrir la bandeja del
   admin y en la tarea diaria (`app/api/cron/mensualidad/route.ts` llama a
   `contacto_intentos_limpiar()`, solo service role).
6. **CAPTCHA**: con `NEXT_PUBLIC_CAPTCHA_TURNSTILE` el formulario muestra la
   casilla existente (`components/turnstile.tsx`) y envía a
   `POST /api/para-clubes/contacto`, que verifica el token con
   `lib/captcha-servidor.ts` / `decidirCaptcha` (mismas reglas que el login)
   y llama a la función con la service role y la IP real. Sin la bandera, esa
   ruta da 404 y el formulario va directo a la base con la anon key.
7. **Bandeja del admin** `/admin/contactos` (enlazada desde `/admin`): filtros
   con conteo (Nuevos/Atendidos/Descartados/Todos), **50 por página con «Ver
   más» y «Mostrando N de M»**, marcar atendido/descartado/volver a nuevo
   (quién y cuándo), borrar datos (si la persona lo pide). Marcar y borrar
   quedan en la bitácora, sin los datos del contacto. Solo el admin: lo exige
   la base.
8. **Humo** (`scripts/humo-produccion.mjs`): saca la URL de Supabase y la
   llave **pública** del JavaScript de `/cliente/login`, pregunta
   `para_clubes_activa` por GET y exige **200 si está encendida y 404 si está
   apagada** (o si la base no tiene el SQL 50). Una página rota con la
   bandera encendida ya no pasa por «apagada».

## Cada afirmación de la página y su respaldo

Todas existen en producción hoy (pase 1, rama `master`).

| Afirmación en la página | Respaldo |
|---|---|
| Tus clientes no pagan nada por reservar; «Sin cobro»; el cover solo se informa **en la ficha** y lo cobra el antro | `app/cliente/reservar/page.tsx` (inserta sin pago), `app/cliente/[clubId]/page.tsx` (`textoCover`), `lib/cover.ts`, CLAUDE.md §4 |
| Reserva de 1 a 20 personas con nombre y teléfono, sin cuenta | `app/cliente/reservar/page.tsx` (`MIN_PERSONAS`/`MAX_PERSONAS`, flujo anónimo), política `reservations_insert_anonimo` |
| Recibe un QR que puede compartir por WhatsApp | `app/cliente/reservar/page.tsx` («Compartir por WhatsApp»), `app/r/[codigo]/page.tsx` |
| El staff escanea el QR, ve la reserva y confirma la entrada; si no pasa, no se confirma; el QR no garantiza el acceso | `app/staff/panel/page.tsx` («Escanear QR», «Confirmar entrada», «El QR no garantiza la entrada») |
| Caja por mesa con uno o varios grupos, consumos y cobros, se anula con motivo y no se borra, se cuadra la mesa | `app/staff/caja/page.tsx`, `components/caja/*`, `sql/2026-11-20-caja-por-mesa.sql` (`mesa_sesiones`, `mesa_cuentas`, `caja_sin_borrar`) |
| El RP crea reservas y ve en qué quedó cada una: consumió, llegó sin consumo, no llegó, por llegar | `app/rp/panel/page.tsx`, `lib/domain/rp-reservas.ts`, `sql/2026-11-21-rp-panel.sql` (`rp_mis_reservas`) |
| El RP registra su asistencia mostrando su QR | `app/rp/panel/page.tsx` (`rp-attendance-{id}`), `app/staff/panel/page.tsx` («Escanear asistencia de RP») |
| Por reserva, la comisión nace al cuadrar la mesa con lo que consumió esa cuenta; por día, con la asistencia confirmada | `sql/2026-11-20-caja-por-mesa.sql` (`caja_liquidar_cuenta`), `registrar_pago_dia`, CLAUDE.md §5 |
| Tú pagas en tu nómina; AntroApp la calcula | CLAUDE.md §4, `app/staff/nomina/page.tsx`, `app/dueno/nomina/page.tsx`, `components/nomina/*` |
| Dueño: ficha y fotos, mesas, cuentas del equipo, reglas de pago, resumen de las noches | `app/dueno/panel/page.tsx`, `components/reglas-pago-rp.tsx`, `app/grupo/page.tsx` |
| Gerente: lo del staff más reglas de pago, nómina de RPs y resumen | `app/staff/panel/page.tsx` (reglas solo gerente), `app/staff/nomina/page.tsx` (al staff le dice «solo gerente»), `app/grupo/page.tsx` (`dueno`/`gerente`/`admin`) |
| Staff: puerta, caja, alta y baja de RPs, turnos y asistencia; no ve sueldos | `app/staff/panel/page.tsx`, `app/staff/caja/page.tsx`, `lib/turnos.ts`, CLAUDE.md §3 |
| RP: sus reservas, su cuota de la semana, lo que va ganando, su QR | `app/rp/panel/page.tsx`, `components/rp/tarjeta-cuota.tsx` (`rp_progreso_cuota`) |
| Pago por reserva fijo o %, con cuota semanal | `clubs.comision_*`, `docs/reglas-comision.md`, `components/reglas-pago-rp.tsx` |
| Pago por día con tarifa distinta para 1.º, 2.º, 3.º día | `club_dia_tarifas`, `components/reglas-pago-rp.tsx` |
| Tarifas individuales por RP | `rp_comision_overrides`, `rp_dia_tarifa_overrides` |
| Con noches cerradas ves cuántas reservas terminaron en consumo y cómo le fue a cada RP | `app/grupo/page.tsx`, `components/grupo/rendimiento-rp.tsx`, `lib/domain/grupo.ts` |
| La caja avisa sin conexión y cada cobro lleva una clave única (no se duplica) | `components/caja/detalle-mesa.tsx`, `components/caja/hojas-mesa.tsx`, `sql/2026-11-21-caja-idempotencia.sql` |
| Staff, RPs y dueño pueden instalarla en la pantalla de inicio | `public/staff.webmanifest`, `public/rp.webmanifest`, `public/dueno.webmanifest`, `lib/app-instalable.ts` |
| Das de alta el antro, subes comprobante fiscal o licencia y foto del local; hasta que está verificado no se muestra | `app/dueno/signup/page.tsx`, `components/verificacion-antro.tsx`, política `clubs_select_anon_verificados` |
| Con cuenta, el cliente ve su historial | `app/cliente/perfil/page.tsx` |
| «Antro de demostración, con datos y fotos de ejemplo»; así muestra la app un antro (fotos, horario, ambiente, música, vestimenta, edad mínima) | `lib/para-clubes.ts` (anon key: solo antros publicados), `app/cliente/[clubId]/page.tsx` |
| Precio de la mensualidad «[por definir]» | Decisión de Diego (no hay monto en la página) |

**Fuera a propósito**: POS, antifraude, lista negra, WhatsApp automático,
reportes PDF, inventario, propinas (banderas por antro, apagadas), Stripe,
exportes CSV, cierre de la noche, invitaciones, alta de antros desde /admin,
el cover en el boleto (solo en ramas sin pase). Tampoco hay enlace para
reservar en el antro de demostración (crearía reservas reales que
`demo-datos` no limpia). La prueba de pantalla revisa que no aparezcan
«inventario», «propina», «lista negra», «antifraude», «punto de venta»,
«PDF», «Stripe», montos en pesos, «boleto» en las preguntas ni enlaces a
`/cliente/reservar`.

## Archivos

Nuevos:
- `sql/post-junta-3/50-para-clubes.sql` y `50-para-clubes-rollback.sql`
- `app/para-clubes/page.tsx`, `components/para-clubes/formulario-contacto.tsx`
- `lib/para-clubes.ts` (bandera y antro de ejemplo, solo servidor), `lib/domain/contacto-club.ts`
- `app/api/para-clubes/contacto/route.ts` (solo con CAPTCHA)
- `app/admin/contactos/page.tsx`, `components/admin/contactos-clubes.tsx`, `components/admin/bandera-para-clubes.tsx`
- `scripts/dev/probar-para-clubes.mjs` (base y gateway), `probar-para-clubes-pantalla.mjs` (Playwright), `probar-para-clubes-captcha.mjs` (ruta con CAPTCHA)

Modificados (mínimo):
- `app/admin/funciones/page.tsx` (import + `<BanderaParaClubes />`)
- `app/admin/page.tsx` (botón «Contactos de antros»)
- `app/api/cron/mensualidad/route.ts` (3 líneas: `contacto_intentos_limpiar`)
- `scripts/humo-produccion.mjs` (`/para-clubes` contra la bandera real)
- `docs/legal/inventario-datos.md`

## SQL: orden y rollback

`sql/post-junta-3/50-para-clubes.sql`. **Requiere** `current_role_name()`
(producción) y `sql/post-junta-3/02-ip-cliente.sql` (`public.ip_cliente()`):
en el pase, **02 antes que 50**. Crea `plataforma_banderas` (2 filas en
false), `para_clubes_bitacora`, `contactos_clubes`, `contacto_sal` (sal
aleatoria), `contacto_intentos` (RLS encendido, `revoke all` a
public/anon/authenticated, también las secuencias) y 11 funciones con
`search_path = ''`, `coalesce(…, false)` y avisos P0001:
`para_clubes_activa` (anon), `plataforma_bandera_cambiar`,
`plataforma_banderas_estado`, `contacto_huella` y
`contacto_intentos_limpiar` (solo service role),
`para_clubes_contacto_enviar` (anon), `contactos_clubes_admin` (paginada),
`contactos_clubes_conteo`, `contacto_club_marcar`, `contacto_club_borrar`.
Rollback: `50-para-clubes-rollback.sql` (no toca `ip_cliente`; exportar
antes `contactos_clubes` y la bitácora si ya tienen datos reales).

**Prueba de rollback exacto** (dev, después de las correcciones): esquema
antes → aplicar → rollback → esquema → reaplicar → esquema, comparando solo
mis objetos (más `ip_cliente` y quien la usa): antes = después del rollback
(5 líneas, todas de 02) y aplicado = reaplicado (119 líneas). Los archivos
completos difieren porque otros carriles aplican SQL en dev al mismo tiempo.
Dev queda **con el SQL aplicado y las dos banderas apagadas**.

En producción: pegar 02 y luego 50 en el SQL Editor cuando Diego lo pida;
verificar por introspección las 5 tablas, las 11 funciones y las 2 filas en
false. La página sigue en 404 hasta que el admin la enciende.

## Pruebas (dev, 27/11/2026, después de las correcciones)

| Prueba | Resultado |
|---|---|
| `node scripts/dev/probar-para-clubes.mjs` (base + API real + gateway real) | **101/101** |
| `PLAYWRIGHT_DESDE=… node scripts/dev/probar-para-clubes-pantalla.mjs --base=http://localhost:3046` | **66/66** (una corrida de cuatro se cayó al apagar la bandera desde la pantalla, por la recarga del esquema de otro carril; se agregó un reintento) |
| `node scripts/dev/probar-para-clubes-captcha.mjs --base=http://localhost:3047` (servidor con las llaves de prueba de Turnstile) | **12/12** |
| Navegador con Turnstile y CAPTCHA exigido: la casilla carga, hay token y el envío llega por la ruta | OK (prueba suelta, no quedó como script) |
| `scripts/humo-produccion.mjs` contra el build de producción local | `/para-clubes` 200 con la bandera encendida y 404 apagada, ambos contra la bandera leída de la base; sin textos técnicos; el 404 sin `og:title` |
| `npx tsc --noEmit`, `npx eslint` (archivos tocados), `NEXT_DIST_DIR=.next-build npx next build` | Limpios |

Nuevas pruebas por cada corrección:
- **CAPTCHA exigido**: anónimo directo y sesión directa rechazados, service
  role sí guarda, ni la trampa responde «recibido»; por la API real, el
  anónimo sin token se rechaza; con la ruta, la llamada directa por REST se
  rechaza y la ruta con token sí guarda.
- **IP**: en SQL, X-Forwarded-For inventado distinto en cada envío → el 4.º
  igual se rechaza; **por el gateway real**, 4 envíos con X-Forwarded-For
  inventado (`198.18.x.x`) → 3 pasan, el 4.º se rechaza, y los 3 cuentan para
  la IP real. Se borran después las huellas de la IP real.
- **Trampa y tope total**: 6 envíos con trampa no gastan el límite de la
  conexión; con 59 en la hora, 5 trampas no impiden el bueno; la trampa no
  deja huella.
- **Bandeja**: 2 + 1 por páginas con total 3, conteos por estado; en
  pantalla, 55 contactos más → «Mostrando 50 de 56», «Ver 6 más» →
  «Mostrando 56 de 56».
- **Metadatos**: apagada, el HTML del 404 no tiene `og:*`, canonical, título
  ni descripción de la página.
- **Texto**: sin enlace a `/cliente/reservar`, el ejemplo dice
  «demostración» y «de ejemplo» (no «real» ni «lo llenó su dueño»), las
  preguntas no hablan del boleto, el aviso de datos dice «hasta 7 días» y
  «clave secreta».
- **Huellas**: la huella guardada no es el sha256 que se calcula desde fuera;
  ni anon ni admin con sesión leen la sal ni llaman a `contacto_huella` o
  `contacto_intentos_limpiar`; abrir la bandeja borra las de 8 días y deja
  las de 6; la service role (tarea diaria) limpia.
- **Bitácora**: marcar, regresar, borrar y cambiar la bandera quedan con
  quién; sin nombre, correo ni ciudad.
- **Aviso neutro**: el límite por correo da el mismo texto que el de la
  conexión y no dice «correo».

Limpieza al final: 0 contactos, 0 huellas, 0 filas de bitácora de prueba y
las dos banderas apagadas (verificado).

## Decisiones para Diego

1. **Precio**: «[por definir]» (CLAUDE.md menciona $2,500; no se usó).
2. **Texto**: titular «De la reserva a la nómina, en una sola noche.» y las
   8 preguntas.
3. **Antro de ejemplo — NO encender la página en producción todavía**: Club
   Demo tiene las **fotos de SIX GDL** y datos puestos por script (CLAUDE.md
   §7). Antes de encenderla: fotos propias de Club Demo, o fijar otro antro
   con `NEXT_PUBLIC_CLUB_DEMO_ID`. Sin antro publicado, la sección no sale.
4. **Bandera**: se enciende en `/admin/funciones` después del SQL 02 y 50.
5. **CAPTCHA**: al encender Turnstile en Vercel, encender también «Exigir
   CAPTCHA» en `/admin/funciones`. Al apagar Turnstile, **primero** dejar de
   exigirlo (si no, el formulario rechaza todo; la pantalla lo avisa).
6. **Conservación** de `contactos_clubes` y de la bitácora (hoy no se
   borran solas) y el correo para derechos ARCO: definir con el abogado.

## Riesgos

- **Spam**: con muchas IPs distintas se puede llenar el tope de 60/hora
  (hacen falta ~20 conexiones reales por hora); durante esa hora los
  legítimos ven «Intenta de nuevo en una hora». Hasta ~1,440 contactos
  basura al día en el peor caso; la bandeja los pagina. El CAPTCHA exigido
  es lo que más ayuda.
- **Datos personales**: nombre, correo y teléfono de interesados; solo el
  admin los lee, por funciones. La huella de la IP no se revierte sin la sal,
  pero quien tenga la base completa sí podría. El aviso de privacidad
  borrador no menciona el formulario.
- **IP de la ruta con CAPTCHA**: viene de `x-forwarded-for` de Vercel
  (`ipDe`), igual que el login; fuera de Vercel ese encabezado sería
  inventable.
- **Antro de ejemplo intermitente**: si la lectura anónima falla (p. ej.
  PostgREST recargando su esquema), la sección se oculta en esa visita y se
  anota el código en los registros.

## Lo que NO se hizo

- No se manda correo al admin cuando llega un contacto.
- No hay imagen de Open Graph ni `metadataBase` (URLs de OG relativas).
- `app/layout.tsx` declara `lang="en"`; no se cambió (afecta a todo).
- No se enlazó `/para-clubes` desde la portada ni desde `/acceso-negocios`.
- No hay pantalla para ver la bitácora (se consulta en el SQL Editor).
- La prueba de navegador con Turnstile se corrió suelta.

## Correcciones de la revisión (27/11/2026)

| # | Hallazgo | Arreglo |
|---|---|---|
| 1 ALTO | El CAPTCHA no protegía: el anónimo llamaba directo a la función | Bandera `contacto_requiere_captcha`: exigido, solo la service role (ruta con token) guarda |
| 2 ALTO | IP tomada del primer `x-forwarded-for` (inventable) | `public.ip_cliente()` (SQL 02); prueba por el gateway real |
| 3 MEDIO | Tope total y trampa llenables; bandeja de 500 fijos | La trampa no guarda ni cuenta; aviso claro sin canal inventado; bandeja paginada con total y conteos |
| 4 MEDIO | El 404 filtraba título, descripción y Open Graph | `generateMetadata` revisa la bandera |
| 5 MEDIO | «Un ejemplo real», «lo llenó su dueño» | «Antro de demostración, con datos y fotos de ejemplo»; decisión 3 |
| 6 MEDIO | Enlace que creaba reservas reales en Club Demo | Quitado |
| 7 BAJO | Cover «en el boleto» (no está en producción) | Quitado: solo «en la ficha» |
| 8 BAJO | Huella con sal pública; limpieza solo al enviar | Sal secreta en la base; limpieza al enviar, al abrir la bandeja y en la tarea diaria; texto exacto |
| 9 BAJO | Humo no detectaba página rota con bandera encendida | Humo lee la bandera de la base; `paraClubesActiva` anota el código del error |
| 10 BAJO | Sin bitácora de bandera ni de borrados | `para_clubes_bitacora` (sin datos personales) |
| 11 BAJO | El aviso por correo confirmaba que el correo se usó | Mismo aviso neutro que el de la conexión |
