# Inventario de datos personales que guarda AntroApp

> **BORRADOR: requiere revisión de un abogado.** Inventario técnico sacado
> del esquema de la base de antroapp-dev (rama `post-junta`, 24/11/2026),
> que es el de producción después del pase. Sirve de base al aviso de
> privacidad. No incluye datos de prueba. Actualizado el 27/11/2026 con
> la lista negra, el no-show y los enlaces de WhatsApp (post-junta-3).

## Dónde viven

- **Supabase** (Postgres, Auth y Storage): todo lo de abajo. Región: `[por
  confirmar en el panel de Supabase]`.
- **Vercel**: aloja la app; sus registros guardan IP, ruta y navegador de
  cada petición `[plazo de retención por confirmar en el plan de Vercel]`.
- **Cloudflare Turnstile** (solo con la bandera del CAPTCHA): recibe la IP y
  señales del navegador para decidir si es una persona.
- **Stripe** (solo con la bandera de la mensualidad): datos de cobro **del
  antro**, no de clientes.
- **WhatsApp**: solo si el usuario comparte su boleto, o (con la bandera
  `whatsapp` del antro) si el staff, el gerente o el RP abren un enlace wa.me
  con el texto ya escrito. La app no envía nada ni usa la API de WhatsApp: el
  teléfono del cliente y el texto salen del navegador hacia WhatsApp solo
  cuando esa persona abre el enlace y decide mandar el mensaje.

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
| `club_bloqueos.telefono`, `cliente_id`, `nombre`, `motivo`, `vence_en`, `motivo_desbloqueo` (con la bandera `lista_negra`) | Teléfono en claro (10 dígitos si es de México; si no, todos sus dígitos), cuenta si la hay, nombre de referencia y **motivo escrito a mano** del bloqueo de un cliente en un antro | Que no pueda apartar lugar en ese antro | Solo gerente, dueño y dueño del grupo de **ese** antro, y admin (por funciones, nunca la tabla directo). En la pantalla de bloqueados el teléfono sale enmascarado (`***1234`) y el completo se ve con «Ver teléfono», que queda registrado. **Ojo:** eso no es una barrera: el staff, el gerente y el dueño ya leen hoy el teléfono completo de cada reserva de su antro (tabla `reservations`, panel de staff y, con la bandera `whatsapp`, la lista de la noche), **sin registro**. El cliente nunca ve que está bloqueado ni el motivo. Ningún otro antro lo ve. Hoy no se borra (historial); el admin puede tachar el motivo (`lista_negra_tachar`) |
| `lista_negra_eventos` (`telefono`, `detalle.motivo`, `hecho_por`) | Bitácora de bloqueos, desbloqueos, quién vio un teléfono completo en la pantalla de bloqueados, cambios de política y tachados | Auditoría | Los mismos que arriba |
| No-shows (calculados, no se guardan aparte) | En cuántas noches un teléfono reservó y no llegó a **ese** antro en la ventana de la política | Avisar al antro y, si el antro lo enciende, bloquear en automático (decisión automatizada; solo cuentan reservas de clientes con cuenta o hechas por un RP) | Gerente, dueño, dueño del grupo y admin (lista); staff y RP solo el número en una reserva que ya ven, sin motivo |

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
4. **Lista negra y no-show** (`sql/post-junta-3/40-lista-negra.sql`, bandera
   `lista_negra`, apagada): el aviso debe decir que el antro puede negar la
   reserva por incidentes o por no llegar varias veces, que esa información
   es solo de ese antro y no se comparte con otros, cuánto tiempo se guarda
   (hoy: sin plazo; el historial no se borra) y cómo pedir que se revise. Si
   el antro enciende el **bloqueo automático**, es una decisión automatizada:
   revisar con el abogado si requiere aviso específico y un medio para
   impugnarla. Los motivos los escribe el gerente a mano y pueden contener
   datos sensibles: la pantalla pide que solo se escriba lo necesario, y el
   admin puede tacharlos (`lista_negra_tachar`, queda registrado). Para una
   cancelación completa (quitar también el teléfono) hoy hay que desbloquear y
   borrar a mano como postgres (`antroapp.borrado_pruebas`): definir el
   procedimiento.
5. **Plantillas de WhatsApp** (`club_whatsapp_plantillas`, bandera
   `whatsapp`): guardan solo el texto del antro, no datos de clientes.
