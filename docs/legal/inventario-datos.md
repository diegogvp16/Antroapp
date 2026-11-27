# Inventario de datos personales que guarda AntroApp

> **BORRADOR: requiere revisión de un abogado.** Inventario técnico sacado
> del esquema de la base de antroapp-dev (rama `post-junta`, 24/11/2026),
> que es el de producción después del pase. Sirve de base al aviso de
> privacidad. No incluye datos de prueba.

## Dónde viven

- **Supabase** (Postgres, Auth y Storage): todo lo de abajo. Región: `[por
  confirmar en el panel de Supabase]`.
- **Vercel**: aloja la app; sus registros guardan IP, ruta y navegador de
  cada petición `[plazo de retención por confirmar en el plan de Vercel]`.
- **Cloudflare Turnstile** (solo con la bandera del CAPTCHA): recibe la IP y
  señales del navegador para decidir si es una persona.
- **Stripe** (solo con la bandera de la mensualidad): datos de cobro **del
  antro**, no de clientes.
- **WhatsApp**: solo si el usuario comparte su boleto; la app no envía nada.

## Por titular

### Clientes (quien reserva)

| Tabla.columna | Dato | Para qué | Quién lo ve |
|---|---|---|---|
| `auth.users.email` | Correo | Iniciar sesión, recuperar contraseña | El propio cliente; admin |
| `auth.users` (contraseña) | Contraseña cifrada (hash) | Iniciar sesión | Nadie (ni el admin la puede leer) |
| `auth.users.last_sign_in_at`, registros de Auth | Fecha de acceso e IP | Seguridad | Supabase; admin del proyecto |
| `profiles.nombre`, `profiles.telefono` | Nombre y teléfono | Identificar la cuenta | El cliente; admin |
| `reservations.cliente_nombre`, `cliente_telefono` | Nombre y teléfono de la reserva (también sin cuenta) | Recibir al cliente en la puerta | El antro (staff, gerente, dueño), el RP que la creó, admin |
| `reservations.fecha`, `personas`, `qr_code`, `status`, `entrada_en`, `llegada_tarde`, `puerta_estado` | Datos de la visita | Reserva, entrada y estadísticas | El antro, el RP, admin; el boleto público (`/r/<código>`) muestra solo nombre, fecha, antro y personas, sin teléfono |
| `reservations.consumo_monto`, `consumption_entries.monto`, `caja_consumos.monto_centavos`, `caja_pagos` | Cuánto consumió y cómo pagó (efectivo, tarjeta, otro; **sin** datos de la tarjeta) | Caja del antro y comisión del RP | El antro; el RP ve el monto según la regla del antro; admin |
| `mesa_cuentas.cliente_nombre`, `personas` | Nombre en la cuenta de la mesa (también clientes sin reserva) | Caja | El antro; admin |

### RPs (promotores)

| Tabla.columna | Dato | Para qué |
|---|---|---|
| `auth.users.email`, `profiles.nombre`, `profiles.telefono`, `profiles.activo` | Cuenta de trabajo | Acceso y alta/baja |
| `rp_schedule` | Turnos asignados | Operación |
| `rp_attendance` (`scanned_at`, `metodo`, `marcado_por`) | Asistencia | Pago por día |
| `commissions`, `rp_pagos_dia`, `rp_comision_overrides`, `rp_dia_tarifa_overrides` | Comisiones, pagos y tarifas personales | Nómina (**dato patrimonial**) |
| `reservations.rp_id`, `mesa_cuentas.rp_id`, `caja_consumos.rp_id` | Qué reservas y consumos trajo | Rendimiento y comisión |

### Personal del antro (staff, gerente) y dueños

| Tabla.columna | Dato | Para qué |
|---|---|---|
| `auth.users.email`, `profiles.nombre`, `profiles.telefono`, `profiles.role`, `profiles.activo` | Cuenta de trabajo | Acceso |
| `*_por` (`registrado_por`, `anulado_por`, `cuadrada_por`, `entrada_por`, `hecho_por`…) en caja y puerta | Quién hizo cada movimiento | Auditoría de caja |
| `caja_consumos.motivo_anulacion`, `caja_pagos.motivo_anulacion`, `caja_cuadres.notas`, `caja_eventos.detalle` | Motivos escritos a mano | Auditoría (pueden contener nombres) |
| `personal_movimientos` (`motivo`, `hecho_por`) | Bajas y reactivaciones con motivo | Auditoría (**puede contener datos sensibles** si el motivo los menciona) |
| `clubs.dueno_id`, `grupo_miembros` | Qué antros y grupos le pertenecen | Acceso |
| Bucket privado `verificacion-docs` + `verificacion_documentos` | Comprobante fiscal o licencia, foto del local e identificación (opcional) del dueño | Verificar que el antro existe |
| `club_altas.creado_por` | Qué admin dio de alta el antro | Auditoría |

### Técnicos (cualquier persona)

| Tabla.columna | Dato | Para qué |
|---|---|---|
| `login_intentos.email_hash`, `ip_hash` | Correo e IP **cifrados con hash** (no se guardan en claro) | Límite de intentos de login |
| `registro_intentos.ip_hash` | IP con hash | Límite de registros |
| `app_errores.usuario_id`, `ip_hash`, `navegador`, `ruta`, `mensaje` | Errores de pantalla | Arreglar fallas |
| `aceptaciones_legales` (con la bandera de legales) | Qué versión de términos y aviso aceptó y cuándo | Constancia del consentimiento |
| `correos_salida.destinatario`, `asunto`, `cuerpo` | Correo del destinatario y texto de cada correo que la app mandó o archivó (sin los secretos que el remitente pidió ocultar) | Revisar qué salió (`/admin/correos`); solo el admin la lee; se borra a los 30 días |
| `invitaciones.nombre`, `correo`, `telefono` (el teléfono es opcional y solo llega por la importación en lote) | Datos de la persona invitada a trabajar en un antro, escritos por quien la invita | Mandarle la invitación; al aceptarla pasan a su perfil. Las ven el dueño, el gerente o el staff que pueden invitar ese rol en ese antro, y el admin. Hoy no se borran (son la bitácora de quién invitó a quién): plazo pendiente de definir con el abogado |
| `invitacion_lotes.hecho_por`, `club_id`, `total` | Quién importó una lista de personal, cuándo y cuántas (sin correos ni nombres) | Auditoría y límite de importaciones |

### Antros interesados (formulario de /para-clubes)

Solo con la bandera de plataforma `para_clubes` encendida (`sql/post-junta-3/50-para-clubes.sql`; apagada por defecto). No se manda ningún correo.

| Tabla.columna | Dato | Para qué | Quién lo ve |
|---|---|---|---|
| `contactos_clubes.nombre`, `club_nombre`, `ciudad`, `correo`, `telefono` (opcional), `mensaje` (opcional) | Datos de contacto que escribe quien se interesa por AntroApp | Contactarlo para platicar del servicio | Solo el admin (`/admin/contactos`); nadie más por la API. El admin lo puede borrar si lo piden (`contacto_club_borrar`). Hoy no se borra solo: plazo pendiente de definir con el abogado |
| `contactos_clubes.estado`, `atendido_por`, `atendido_en` | Si ya se atendió, quién y cuándo | Seguimiento | Solo el admin |
| `contacto_intentos.ip_hash`, `correo_hash`, `creado_en` | Huella de la IP y del correo de cada envío guardado: sha256 con una **sal secreta** (`contacto_sal`, no se lee por la API), no la IP ni el correo en claro. Quien tenga acceso directo a la base (sal incluida) podría revertir la de una IPv4 probando todas | Límites contra spam (por conexión, por correo y en total). Los envíos que caen en la casilla trampa no dejan nada | Nadie por la API. Se borran las de más de 7 días en cada envío, al abrir `/admin/contactos` y en la tarea diaria (`/api/cron/mensualidad`) |
| `para_clubes_bitacora.accion`, `detalle`, `contacto_id`, `hecho_por`, `hecho_en` | Quién cambió las banderas de la página o marcó/borró un contacto, y cuándo. **Sin** los datos del contacto (solo su id) | Auditoría | Nadie por la API (solo service role / SQL Editor). Hoy no se borra |

La IP sale de `public.ip_cliente()` (`sql/post-junta-3/02-ip-cliente.sql`: `cf-connecting-ip`, no el primer valor de `x-forwarded-for`, que lo puede inventar quien llama). El formulario dice qué se guarda, para qué y por cuánto tiempo, y enlaza al aviso de privacidad solo si `NEXT_PUBLIC_LEGALES` está encendida. Con el CAPTCHA encendido, Cloudflare Turnstile también recibe la IP de quien lo llena. El aviso de privacidad borrador todavía **no** menciona este formulario.

## Lo que la app NO guarda

- Datos de tarjetas (no hay cobros a clientes; la mensualidad del antro, si
  se activa, la procesa Stripe).
- Fecha de nacimiento, CURP, identificación del cliente.
- Ubicación del cliente: `/cliente` la pide al navegador (si el cliente da
  permiso) solo para ordenar los antros por cercanía; se queda en el
  teléfono, no se envía ni se guarda (verificado en `app/cliente/page.tsx`).

## Pendientes técnicos que el aviso debería reflejar

1. **Conservación**: hoy nada se borra automáticamente salvo los intentos de
   login y registro (30 días, con `antiabuso_limpiar()`). Definir plazos para
   reservas, caja y nómina (obligaciones fiscales del antro) y para cuentas
   inactivas.
2. **Derechos ARCO**: no hay pantalla para descargar o borrar la cuenta; se
   atienden por correo `[definir correo]` y el admin los ejecuta a mano.
   Cancelar una cuenta que tiene caja asociada exige anonimizar (la caja no
   se borra por diseño).
3. Los **motivos escritos a mano** (anulaciones, bajas) pueden terminar con
   datos personales: conviene un aviso en esas pantallas.
