# Stripe en modo prueba en dev: lo que faltaba probar

27/11/2026, rama `post-junta-4`. Sin CLI de Stripe, sin cuenta y sin llaves
reales: los eventos se arman con la forma de la API `2026-10-28.endive` (la de
`stripe@23.1.0`: el periodo va en los items de la suscripción y la suscripción
de la factura va en `parent.subscription_details`) y se firman con un secreto
de webhook inventado, igual que la prueba existente. Todo contra antroapp-dev.

- Prueba nueva: `scripts/dev/probar-mensualidad-recorridos.mjs`.
- Prueba existente: `scripts/dev/probar-mensualidad.mjs`.
- Configuración y pasos en Stripe: `docs/stripe-mensualidad.md`.

## Cómo se corre

Con `STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY` (una `sk_test_…` **falsa**) y
`CRON_SECRET` inventados en el entorno del servidor y de la prueba:

```bash
NEXT_DIST_DIR=.next-stripe PUERTO=3043 NEXT_PUBLIC_MENSUALIDAD=1 node scripts/dev/servidor-dev.mjs
node scripts/dev/probar-mensualidad-recorridos.mjs --con=http://localhost:3043
```

La prueba se niega a correr si `.env.dev` apunta a producción o si `--con` no
es un servidor local. Crea sus propios antros, cuentas (dueño, staff, RP,
cliente), planes, eventos, documentos de verificación y reservas, y los borra
al terminar (revisa que no quede nada). No toca `mensualidad_real` ni ninguna
bandera.

La existente necesita además el servidor apagado en 3001 (sin
`CRON_SECRET`):
`node scripts/dev/probar-mensualidad.mjs --con=http://localhost:3043`.

## Qué cubría ya y qué se agregó

| Tema | Ya lo cubría `probar-mensualidad.mjs` | Agregado en `probar-mensualidad-recorridos.mjs` |
|---|---|---|
| Firma del webhook | Sin firma, otro secreto, `livemode`, bandera apagada (404) | — |
| Reglas puras | `estadoDesdeStripe`, `finDeGracia` (CDMX y Tijuana), lectura de las dos formas de la API | — |
| Alta y pago | Un club insertado a mano: `checkout.session.completed`, `subscription.created` active, `invoice.paid` | **Alta de punta a punta por la ruta real** (`/api/admin/alta-club`), contraseña temporal (403 en el pago) → cambio por `/api/auth/cambiar-contrasena`, verificación (documentos → revisión → aprobación del admin), planes visibles, portal sin suscripción (400), plan desactivado (400), checkout hasta Stripe, eventos **en el orden real de Checkout** (`incomplete` → `invoice.paid` + `invoice.payment_succeeded` → `active` → `checkout.session.completed` al final), público y reservas sin cuenta, segundo checkout (409), vista de `/admin/mensualidad` |
| Cobro fallido | Un `invoice.payment_failed` y un `past_due`, gracia de 7 días a las 08:00, reintento que no recorre la gracia | **Smart Retries completos**: intentos 1–5 de la misma factura (`attempt_count`, `next_payment_attempt`), una sola fila en el historial; gracia en la **zona del antro calculada en la base** (Tijuana); tres finales: **se recupera**, **se agota → `unpaid`** (dentro y fuera de la gracia), **se agota → `canceled`** y vuelve a suscribirse |
| Efecto en el acceso | Solo `suscripcion_activa` | En cada estado: **catálogo público** (anónimo, la consulta de `/cliente`), **reserva de cliente con sesión y sin cuenta**, **reserva de RP**, **caja y puerta del staff** (`caja_puede_ver`, `caja_mis_permisos`, reserva por QR), **panel del dueño** (RLS), **boleto** de una reserva previa |
| «Nunca en plena noche» | Cancelada no se despublica antes del corte | Gracia vencida + webhook (`payment_failed`, `unpaid`) **no** despublica; solo la tarea diaria |
| Paso de plan | — | **Nuevo**: `subscription.updated` con otro precio, prorrateo, gracia del plan nuevo, precio que no es de ningún plan, plan desactivado, dos items |
| Cancelación | `subscription.deleted` directo | **Nuevo**: `cancel_at_period_end` → reactivación → `deleted` al fin del periodo, `updated` tardío del mismo segundo, lo que ve el dueño, volver a suscribirse, cancelación solo con `cancel_at` |
| Desorden y duplicados | Evento viejo, mismo segundo, misma entrega dos veces a la vez, otra suscripción del mismo antro | — |
| Tarea diaria | Sin secreto (401), vence, despublica, republica | — |
| RLS y candado | Quién ve suscripciones, pagos y eventos; candado de `suscripcion_activa` | — |

## Resultados (27/11/2026)

| Prueba | Resultado |
|---|---|
| 1. Falla de pago con reintentos y acceso | **35/35** |
| 2. Alta de un antro de punta a punta | **24/24** |
| 3. Paso de plan | **6/6** |
| 4. Cancelación al final del periodo | **15/15** |
| Total, prueba nueva | **80/80**, limpieza sin restos (corrido tres veces) |
| `probar-mensualidad.mjs` (existente) | **60/60** (59/60 antes del ajuste de abajo) |

**Ajuste a la prueba existente**: el caso «con cobro real, un antro nuevo del
dueño nace sin suscripción aunque la mande» fallaba desde
`sql/post-junta-2/68-un-antro-por-dueno-candado.sql`: el dueño de la prueba ya
tenía un antro y la base ahora le impide crear un segundo («Ya tienes un
antro registrado»), así que el INSERT fallaba antes de llegar al candado. No
es un error de la app: la prueba ahora usa un dueño sin antro. El candado
sigue funcionando.

Además de N/N, la prueba nueva imprime como `INFO` el comportamiento real
que es riesgo o decisión (no cuenta como falla). Está abajo.

## Efecto en el acceso, por estado

Medido con sesiones reales de cada rol (RLS de dev), no leyendo políticas.

| Estado | Catálogo público | Reserva de cliente / sin cuenta | Reserva de RP | Caja y puerta (staff) | Panel del dueño | Boleto de una reserva previa |
|---|---|---|---|---|---|---|
| Activa | Sí | Sí | Sí | Sí | Sí | Completo |
| En gracia (`past_due`, o `unpaid` con gracia vigente) | Sí, hasta las 08:00 del día en que termina la gracia | Sí | Sí | Sí | Sí, con la fecha y hora del corte | Completo |
| Vencida, **antes** de la tarea diaria | Sí (el webhook no despublica) | Sí | Sí | Sí | Sí, «Vencida» | Completo |
| Vencida, después de la tarea diaria | **No** | **No** («Este antro no está recibiendo reservas por ahora») | **Sí** | Sí | Sí | Abre, sin dirección ni políticas del antro |
| Cancelada, antes del corte de las 08:00 | Sí | Sí | Sí | Sí | Sí, «Cancelada» (con el texto «ya no se muestra», ver hallazgo 4) | Completo |
| Cancelada, después del corte y de la tarea | **No** | **No** | **Sí** | Sí | Sí, con los planes para volver | Abre, sin dirección |
| Sin suscripción (nunca pagó) | Solo si el admin lo publicó (cortesía) | Igual que el catálogo | Sí | Sí | Sí | Según publicación |

Quién mueve cada cosa: el webhook **publica** (activa o en gracia) y la tarea
diaria (`/api/cron/mensualidad`, 16:00 UTC) **vence y despublica**. Un antro
pagado vuelve al catálogo en el momento en que llega el pago, aunque sea de
noche (publicar a media noche no es un bloqueo).

## Recorrido 1: Smart Retries

Secuencia simulada (la que manda Stripe): renovación falla →
`invoice.payment_failed` (intento 1, con `next_payment_attempt`) +
`customer.subscription.updated` a `past_due` (con `previous_attributes`) →
reintentos: más `invoice.payment_failed` de **la misma factura** con
`attempt_count` 2, 3, 4… (Stripe no manda otro `subscription.updated`
mientras siga en `past_due`).

- La gracia se fija **una vez**, con el primer `past_due`, y los reintentos no
  la recorren. Un episodio nuevo (después de volver a «activa») da una gracia
  nueva completa.
- Con los reintentos por omisión de Stripe (hasta ~2 semanas) la gracia de 7
  días termina **antes** que los intentos: el antro sale del público mientras
  Stripe sigue intentando, y vuelve solo si un reintento cobra.
- Intentos agotados con «Mark as unpaid»: `unpaid` dentro de la gracia sigue
  publicado hasta el corte; fuera de ella queda «Vencida» y la tarea diaria lo
  saca. Si el dueño paga la factura después, vuelve a «Activa» y se publica.
- Intentos agotados con «Cancel subscription»: llega `subscription.deleted` →
  «Cancelada», publicada hasta el **siguiente** 08:00. Eso **acorta** la gracia
  que se le había avisado al dueño (en la corrida: del 5/12 al 28/11). Es lo
  que dice la doc; por eso `docs/stripe-mensualidad.md` recomienda «unpaid».
- La gracia se cuenta desde que la app **procesa** el primer `past_due`
  (`now()` de la base), no desde la hora del cobro fallido. Si el webhook se
  atrasa (Stripe reintenta entregas hasta 3 días), la gracia empieza tarde.

## Recorrido 3: paso de plan (comportamiento real)

Hoy la app no tiene una función de «cambiar de plan»: el cambio se hace en
Stripe (portal con «Switch plans» o Dashboard) y la app solo lee lo que llega.

- `customer.subscription.updated` con un precio que **es** de un plan de
  `/admin/mensualidad`: la base liga la suscripción a ese plan (`plan_id`),
  sigue «Activa», con el mismo periodo. El dueño ve el plan nuevo. El
  siguiente cobro fallido usa los **días de gracia del plan nuevo**.
- La factura de prorrateo (`billing_reason: subscription_update`) entra al
  historial con lo cobrado (`amount_paid`), como cualquier factura.
- **Riesgo**: un precio que **no** es de ningún plan no se guarda. `plan_id`
  se queda en el plan anterior y el dueño y el admin ven ese nombre y ese
  monto aunque Stripe cobre otro. El `price_…` no se guarda en ningún lado.
- **Riesgo menor**: si el plan está desactivado, el webhook lo liga igual,
  pero `/dueno/mensualidad` solo carga planes activos y el dueño deja de ver
  el nombre de su plan.
- **Riesgo menor**: solo se lee el primer item de la suscripción
  (`items.data[0]`). Con un complemento en otro item, el plan puede no
  reconocerse.

**Decisión de Diego** (no se construyó nada): mientras haya un solo plan,
dejar «Switch plans» apagado en el portal (como ya dice la doc). Si se
enciende, cada precio que ofrezca el portal tiene que estar dado de alta como
plan, y conviene guardar el `price_…` en `suscripciones` y avisar al admin
cuando llegue uno desconocido.

## Recorrido 4: cancelación al final del periodo (comportamiento real)

- `cancel_at_period_end: true`: sigue «Activa», publicada y recibiendo
  reservas; la base guarda `cancelar_al_final` y `/dueno/mensualidad` muestra
  «Se cancela el <fin del periodo>» en vez de «Próximo cobro».
- Reactivar antes del fin (`cancel_at_period_end: false`) regresa a «Próximo
  cobro».
- Al fin del periodo, `customer.subscription.deleted` → «Cancelada»,
  publicada hasta el siguiente 08:00; la tarea diaria la saca después. Un
  `updated` del mismo segundo que llega tarde no la revive. Caja y puerta
  siguen. El dueño puede volver a suscribirse (el checkout llega a Stripe) y
  la suscripción nueva reemplaza a la cancelada.
- `/admin/mensualidad` **no** muestra que un antro tiene la cancelación
  programada (no lee `cancelar_al_final`).
- **Por verificar con llaves reales**: si Stripe programa la cancelación solo
  con `cancel_at` (una fecha) y deja `cancel_at_period_end: false`, la app no
  la marca y el dueño ve «Próximo cobro». La API actual tiene los dos campos;
  hay que ver qué manda el portal al cancelar (paso 4 de abajo). Si manda
  `cancel_at`, el arreglo es leer también `cancel_at` en `leerSuscripcion`.

## Lo que falla o falta (hallazgos)

No se encontró un error de la app que contradiga su código o su doc al grado
de arreglarlo esta noche; sí estos puntos, por gravedad:

1. **Antro de cortesía que intenta pagar** (medio): un antro publicado por el
   admin sin suscripción, cuyo dueño empieza un pago que nunca se completa
   (`incomplete` → `incomplete_expired`), queda «Cancelada» y la tarea diaria
   **lo despublica**, aunque nunca debió pagar. Decisión: ¿la cortesía se
   respeta mientras no haya un pago completado?
2. **Vencida con la suscripción `unpaid` o `past_due` en Stripe** (medio,
   por verificar con llaves reales): `/dueno/mensualidad` le ofrece
   «Suscribirme», pero el checkout ve la suscripción viva en Stripe y responde
   409 («Usa “Administrar pago”»). El camino real es pagar la factura
   (enlace «Factura» del historial) o el portal. Conviene que la pantalla
   diga eso en vez de mostrar los planes.
3. **RPs en un antro vencido o cancelado** (bajo): siguen creando reservas
   (la base deja a la gente del antro). La doc decía «deja de recibir
   reservas nuevas»; ya dice «del público».
4. **Texto de «Cancelada» antes del corte** (bajo): el dueño lee «Tu antro ya
   no se muestra a los clientes», pero se muestra hasta las 08:00. Arreglo
   propuesto: si `gracia_hasta` está en el futuro, «deja de mostrarse el
   <fecha y hora>».
5. Paso de plan con precio desconocido, plan desactivado y dos items (arriba).
6. Cancelación solo con `cancel_at` (arriba).
7. La alerta de cobro fallido dice «Entró en periodo de gracia» en cada
   reintento (una por hora como máximo), aunque la gracia ya haya terminado.

## Lo que solo se prueba con llaves de prueba reales

Necesita: cuenta de Stripe en **modo de prueba**, la CLI (`stripe login`, lo
haces tú; aquí no se instaló nada) y las llaves solo en el entorno del
proceso (nunca en un archivo del repo). Servidor local contra dev con la
bandera:

```bash
# Terminal 1: reenvía los eventos a la app local y te da el whsec_ de esta sesión.
stripe listen --forward-to localhost:3043/api/stripe/webhook \
  --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed,invoice.voided

# Terminal 2: la app, con la sk_test_ (o rk_test_) real y el whsec_ que imprimió stripe listen.
STRIPE_SECRET_KEY=sk_test_… STRIPE_WEBHOOK_SECRET=whsec_… CRON_SECRET=<inventado> \
NEXT_DIST_DIR=.next-stripe PUERTO=3043 NEXT_PUBLIC_MENSUALIDAD=1 node scripts/dev/servidor-dev.mjs
```

Tarjetas de prueba: `4242 4242 4242 4242` (paga), `4000 0000 0000 0341` (se
guarda bien y **falla al cobrar**: para renovaciones), `4000 0000 0000 9995`
(rechazada en el Checkout: fondos insuficientes), `4000 0025 0000 3155`
(pide 3D Secure). Fecha futura y cualquier CVC.

**Relojes de prueba (test clocks)**: un cliente solo se puede poner en un
reloj **al crearlo**, y el checkout de la app crea su propio cliente. Para
usar un reloj, crea el cliente en el reloj y dáselo al antro de prueba en
**dev** antes de pagar (el checkout reutiliza `suscripciones.stripe_customer_id`):

```bash
stripe test_helpers test_clocks create -d frozen_time=$(date +%s) -d name="AntroApp dev"
stripe customers create -d test_clock=clock_… -d name="Antro de prueba"
```

```sql
-- SOLO en antroapp-dev (SQL Editor de dev o scripts/db/aplicar-dev.mjs):
insert into public.suscripciones (club_id, stripe_customer_id) values ('<club_id>', 'cus_…')
on conflict (club_id) do update set stripe_customer_id = excluded.stripe_customer_id;
```

Para avanzar el tiempo:
`stripe test_helpers test_clocks advance clock_… -d frozen_time=<unix>`.

1. **Alta y primer pago**: como dueño en `/dueno/mensualidad` → Suscribirme
   → `4242…`. Esperado: «Activa», plan, próximo cobro y un pago (uno solo
   aunque lleguen `invoice.paid` y `invoice.payment_succeeded`). Anota el
   orden real de los eventos en la terminal de `stripe listen`.
2. **Smart Retries**: en el portal cambia la tarjeta por `…0341`. Para ver
   el final rápido, en **Settings → Billing → Subscriptions and emails →
   Manage failed payments** pon un calendario propio (por ejemplo 3 intentos
   en 1, 3 y 5 días) y «Mark the subscription as unpaid». Avanza el reloj al
   fin del periodo: «En periodo de gracia» con su hora de corte (08:00).
   Avanza a cada intento: el historial sigue con **una** fila «Falló». Avanza
   más allá de la gracia y corre la tarea:
   `curl -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3043/api/cron/mensualidad`
   → «Vencida» y fuera del catálogo. Revisa el hallazgo 2: «Suscribirme» debe
   responder 409; paga desde «Factura» o el portal con `4242…` → «Activa».
3. **Paso de plan**: crea un segundo precio, dalo de alta en
   `/admin/mensualidad`, enciende «Switch plans» en el portal (solo para la
   prueba) y cambia de plan. Esperado: el nombre del plan cambia y aparece la
   factura del prorrateo. Prueba también con un precio que **no** esté dado de
   alta: verás el plan anterior (riesgo de arriba). Por CLI:
   `stripe subscriptions update sub_… -d "items[0][id]=si_…" -d "items[0][price]=price_…" -d proration_behavior=always_invoice`.
4. **Cancelación al final del periodo**: cancela desde el portal. En la
   terminal de `stripe listen` revisa el `customer.subscription.updated`:
   ¿trae `cancel_at_period_end: true` o solo `cancel_at`? (riesgo de arriba).
   Esperado: «Se cancela el <fecha>». Reactiva («Renovar» / «No cancelar») →
   «Próximo cobro». Cancela otra vez y avanza el reloj al fin del periodo →
   `customer.subscription.deleted` → «Cancelada»; antes de las 08:00 sigue en
   el catálogo, después de la tarea ya no.
5. **Intentos agotados con cancelación**: repite el 2 con «Cancel the
   subscription» en vez de «unpaid» → «Cancelada» al agotarse, publicada
   hasta el siguiente 08:00 (acorta la gracia).
6. **3D Secure**: suscríbete con `…3155` y abandona el reto → la suscripción
   queda `incomplete` y, a las 23 horas (avanza el reloj), `incomplete_expired`.
   Con un antro de cortesía verás el hallazgo 1.
7. `stripe trigger invoice.payment_failed` (y similares) crean su propio
   cliente y suscripción, **sin** `club_id`: la app responde 200 con
   «ignorado». Sirven para revisar firma y forma, no los recorridos.

Lo que esta prueba no puede ver sin Stripe real: que Checkout y el portal
abran de verdad, el orden y la forma exactos de los eventos de esta cuenta,
el calendario real de Smart Retries, el 409 del checkout con una
suscripción viva en Stripe y qué campo usa el portal al cancelar.
