# Mensualidad del antro con Stripe

Escrito el 24/11/2026 (rama `post-junta`). **Apagado por defecto**: sin la
bandera `NEXT_PUBLIC_MENSUALIDAD=1`, la app queda como hoy (la suscripción es
el botón simulado del panel del dueño). **Primero todo en modo de prueba de
Stripe.** El código rechaza llaves de producción (`sk_live_…`) y eventos de
producción salvo que pongas a propósito `STRIPE_PERMITIR_PRODUCCION=1`.

## Cómo funciona

1. El admin da de alta los **planes** en `/admin/mensualidad`. Cada plan
   apunta a un **precio de Stripe** (`price_…`): el monto se define en Stripe,
   no en la app.
2. El dueño entra a **`/dueno/mensualidad`** (botón «Mi mensualidad» en su
   panel), elige un plan y paga en **Stripe Checkout**. Desde ahí también abre
   el **portal de Stripe** para cambiar tarjeta, ver facturas o cancelar.
3. Stripe avisa a la app por **webhook** (`/api/stripe/webhook`, con firma
   verificada e idempotente). La app guarda el estado en `suscripciones` y el
   historial en `pagos_mensualidad`.
4. Estados:

   | Estado | Cuándo | El antro se muestra al público |
   |---|---|---|
   | Activa | Pagó | Sí |
   | En periodo de gracia | Falló un cobro | Sí, hasta que termina la gracia |
   | Vencida | Terminó la gracia sin pago | No |
   | Cancelada | Canceló | No (desde el siguiente corte) |
   | Sin suscripción | Nunca pagó | Como hoy (no cambia nada) |

5. **Nunca un bloqueo repentino en plena noche:**
   - La gracia (días configurables por plan) siempre termina a las **08:00**
     en la zona del antro, el corte de la noche operativa.
   - Una cancelación sigue publicada hasta el siguiente corte.
   - El webhook nunca despublica. Lo hace la **tarea diaria**
     (`/api/cron/mensualidad`, 16:00 UTC = 10:00 CDMX), después del corte.
   - Aun vencido, **la puerta, la caja, la nómina y los reportes siguen
     funcionando**. Solo deja de mostrarse al público y de recibir reservas
     nuevas **del público** (clientes y sin cuenta). Los RPs del antro sí
     pueden seguir apartando, y el boleto de una reserva previa sigue
     abriendo (sin la dirección del antro). Tabla completa por estado en
     `docs/stripe-prueba-dev.md`.
6. Los antros que ya existen **sin** suscripción no se tocan: la tarea
   diaria solo despublica a los que tienen suscripción vencida o cancelada.
   Ojo: si el dueño de un antro de cortesía empieza a pagar y ese primer pago
   nunca se completa (`incomplete_expired`), queda «Cancelada» y la tarea
   diaria **sí** lo despublica (hallazgo 1 de `docs/stripe-prueba-dev.md`).
7. Con el cobro real (`config_plataforma.mensualidad_real = true`) el dueño ya
   no puede activar la suscripción con el botón ni mandarla al crear un antro:
   solo el webhook y el admin la cambian (resuelve la deuda 2 de `CLAUDE.md`).

## Preguntas abiertas (decisiones tuyas, sin cifras inventadas)

1. **Precio**: el modelo de negocio dice $2,500 MXN al mes por antro. ¿Con o
   sin IVA? ¿Es el único plan, o habrá varios (por ejemplo, por número de
   mesas o de RPs, o un plan para grupos con varios antros)?
2. **Prueba gratis**: ¿días de prueba antes del primer cobro? (Stripe lo
   maneja con `trial`; la app ya lo trata como «activa».)
3. **Días de gracia**: la app propone 7 por plan (editable). ¿Cuántos?
4. **Cobro anual** con descuento: ¿sí o no?
5. **Antros actuales** (Club Demo y los publicados hoy): ¿cortesía hasta
   cuándo? Mientras no tengan suscripción, siguen como están.
6. **Facturación (CFDI)**: Stripe no emite CFDI. ¿Quién factura y con qué
   herramienta?
7. **Métodos de pago**: ¿solo tarjeta, o también OXXO o transferencia (SPEI)?
   OXXO no sirve para cobros recurrentes automáticos.
8. **Cancelación**: ¿al final del periodo pagado (recomendado) o inmediata?
   Se configura en el portal de Stripe (paso 5).
9. **Grupos**: ¿un dueño de grupo paga todos sus antros en una sola factura?
   Hoy es una suscripción por antro.

## Pasos en Stripe (modo de prueba)

Todo esto con el interruptor **«Test mode» / «Modo de prueba»** encendido,
arriba a la derecha del Dashboard de Stripe.

### 1. Cuenta

1. Entra a **dashboard.stripe.com** y crea la cuenta (o entra a la tuya).
2. Enciende **Test mode**.

**Qué deberías ver**: una franja naranja que dice «Test mode» o «Datos de prueba».

### 2. Producto y precio

1. Menú **Product catalog** (Catálogo de productos) → **+ Add product**.
2. **Name**: `Mensualidad AntroApp` (o el nombre del plan).
3. **Pricing model**: **Standard pricing** → **Recurring** → **Monthly**.
4. **Amount**: el precio que decidas (pregunta 1), moneda **MXN**.
5. **Tax behavior** (si aplica): según lo que decidas del IVA.
6. **Save product**.
7. Abre el producto → en **Pricing**, copia el **Price ID** (empieza con `price_`).

**Qué deberías ver**: el producto con un precio mensual en MXN y su `price_…`.

### 3. Llaves de prueba

1. **Developers** → **API keys**.
2. Copia la **Secret key** de prueba (`sk_test_…`) a tu gestor de
   contraseñas. **No la pegues en ningún archivo del repositorio ni en el chat.**
   (Recomendado: en vez de la secreta completa, crea una **Restricted key**
   con permisos de escritura en Customers, Checkout Sessions y Customer
   portal, y lectura en Prices; la app acepta `rk_test_…`.)

### 4. Webhook

1. **Developers** → **Webhooks** → **+ Add endpoint** (o «Add destination»).
2. **Endpoint URL**: la de tu vista previa primero, por ejemplo
   `https://<tu-vista-previa>.vercel.app/api/stripe/webhook`. Ojo: las
   vistas previas de Vercel están protegidas con login. Para probar hay que
   usar la URL con el *bypass* de protección, o probar en producción con
   llaves de prueba. Recomendado: la **CLI de Stripe** (abajo).
3. **Events to send**: selecciona exactamente estos:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `invoice.voided`
4. **Add endpoint**.
5. En el endpoint → **Signing secret** → **Reveal** → copia el `whsec_…`.

**Qué deberías ver**: el endpoint en estado «Enabled» con 7 eventos.

### 5. Portal de cliente

1. **Settings** (engrane) → **Billing** → **Customer portal**.
2. Activa: **Update payment methods**, **View invoice history** y **Cancel
   subscriptions** → **Cancel at end of billing period** (pregunta 8).
3. Deja **desactivado** «Switch plans» mientras haya un solo plan. Si lo
   activas, **cada** precio que ofrezca el portal tiene que estar dado de alta
   como plan en `/admin/mensualidad`: con un precio que no es de ningún plan,
   la app sigue mostrando el plan anterior.
4. **Business information**: nombre y enlaces a `/terminos` y `/privacidad`
   (cuando estén publicados).
5. **Save**.

### 6. Reintentos de cobro

1. **Settings** → **Billing** → **Subscriptions and emails** → **Manage
   failed payments**.
2. Reintentos: los que Stripe recomienda (Smart Retries).
3. **If all retries fail**: **Mark the subscription as unpaid** (no
   «cancel»). La app trata `unpaid` como gracia o vencida, y si el dueño paga
   después, vuelve sola a «activa». Para pagar, el dueño usa el enlace
   «Factura» de su historial o «Administrar pago»: «Suscribirme» le responde
   que ya tiene una suscripción, porque la `unpaid` sigue viva en Stripe.
   Con «cancel», la cancelación corta la gracia al siguiente 08:00.

## Pasos en Vercel

1. **Settings** → **Environment Variables**. Primero solo en **Preview**:

   | Nombre | Valor | Tipo |
   |---|---|---|
   | `NEXT_PUBLIC_MENSUALIDAD` | `1` | Plain |
   | `STRIPE_SECRET_KEY` | `sk_test_…` o `rk_test_…` (paso 3) | **Sensitive** |
   | `STRIPE_WEBHOOK_SECRET` | `whsec_…` (paso 4) | **Sensitive** |
   | `CRON_SECRET` | un texto largo al azar (por ejemplo, de tu gestor de contraseñas) | **Sensitive** |
   | `NEXT_PUBLIC_SITIO_URL` | opcional: `https://antroapp.vercel.app` (para regresar de Stripe) | Plain |

2. **Redeploy**.
3. La tarea diaria ya está en `vercel.json` (`/api/cron/mensualidad`, todos
   los días a las 16:00 UTC). Vercel manda el `CRON_SECRET` solo. Se ve en
   **Settings → Cron Jobs**. Las tareas programadas corren solo en
   **Production**: en Preview pruébala a mano (abajo).

## SQL (por el SQL Editor, en el pase 2)

1. `sql/post-junta/06-mensualidad.sql`, que deja `mensualidad_real = false`.
2. **Solo cuando cobres de verdad**:

   ```sql
   update public.config_plataforma set valor = 'true', actualizado_en = now()
   where clave = 'mensualidad_real';
   ```

   Para regresar al botón simulado: lo mismo con `'false'`.

## Probar en modo de prueba (con tus llaves)

Con la **CLI de Stripe** (`stripe login` una vez) y la app local contra dev
**con la bandera encendida** (el servidor de 3001 la tiene apagada y el
webhook responde 404):

```bash
stripe listen --forward-to localhost:3043/api/stripe/webhook
# Copia el whsec_… que imprime y úsalo como STRIPE_WEBHOOK_SECRET del servidor local:
# STRIPE_SECRET_KEY=sk_test_… STRIPE_WEBHOOK_SECRET=whsec_… CRON_SECRET=<inventado> # NEXT_DIST_DIR=.next-stripe PUERTO=3043 NEXT_PUBLIC_MENSUALIDAD=1 node scripts/dev/servidor-dev.mjs
```

1. Inicia como dueño, ve a `/dueno/mensualidad` → **Suscribirme** → en
   Checkout usa la tarjeta de prueba `4242 4242 4242 4242`, cualquier fecha
   futura y cualquier CVC.
   **Qué deberías ver**: al regresar, el estado es «Activa», con el próximo
   cobro y un pago en el historial.
2. Cobro fallido: en el portal de Stripe cambia la tarjeta por
   `4000 0000 0000 0341` (se acepta al guardarla y falla al cobrar). Luego, en
   el Dashboard de Stripe, abre la suscripción → **Actions → Update
   subscription → reset billing cycle**, o usa un *test clock*. Un cliente
   solo entra a un reloj al crearlo y el checkout crea el suyo: para usar
   un reloj, crea el cliente en él y ponlo en `suscripciones` del antro de
   prueba en dev antes de pagar (pasos en `docs/stripe-prueba-dev.md`).
   **Qué deberías ver**: «En periodo de gracia» con la fecha y hora en que
   termina (08:00).
3. La tarea diaria a mano:
   `curl -H "Authorization: Bearer <CRON_SECRET>" https://<url>/api/cron/mensualidad`
4. Cancelar desde el portal → «Se cancela el <fecha>» y, al llegar la fecha,
   «Cancelada». Revisa en `stripe listen` que el evento traiga
   `cancel_at_period_end: true`: si solo trae `cancel_at`, la app no marca
   la cancelación y el dueño sigue viendo «Próximo cobro».

Pruebas automáticas sin llaves (firma, idempotencia, desorden, gracia, tarea
diaria, RLS, candado): `node scripts/dev/probar-mensualidad.mjs` (60/60 el
27/11/2026; instrucciones en su cabecera). Recorridos completos (reintentos
y acceso por estado, alta de punta a punta, paso de plan, cancelación al
final del periodo): `node scripts/dev/probar-mensualidad-recorridos.mjs`
(80/80). Qué cubre cada una y qué falta probar con llaves reales:
`docs/stripe-prueba-dev.md`.

## Pasar a producción (cuando todo funcione en prueba)

1. En Stripe, **apaga Test mode** y repite los pasos 2, 4, 5 y 6 en modo live
   (los productos y webhooks de prueba **no** se copian solos). Usa la URL de
   producción en el webhook.
2. Copia la **secret key live** (`sk_live_…` o `rk_live_…`) y el **whsec** del
   webhook live.
3. En Vercel, **Production**: las mismas variables con los valores live,
   **más** `STRIPE_PERMITIR_PRODUCCION=1`. Sin esa variable la app rechaza
   las llaves y eventos de producción a propósito.
4. En `/admin/mensualidad` da de alta los planes con los `price_…` **live**
   (los de prueba no sirven en live).
5. SQL: `mensualidad_real = true` (arriba).
6. Haz una suscripción real de un peso o del plan, revisa el historial y la
   cancelas.

## Rollback

- Apagar: quita `NEXT_PUBLIC_MENSUALIDAD` (o `0`) y redeploy. La app vuelve al
  botón simulado. Ponle también `mensualidad_real = false` si estaba en true.
- Base: `sql/post-junta/06-mensualidad-rollback.sql`. **Antes**, exporta
  `suscripciones` y `pagos_mensualidad` si ya hubo cobros reales.
