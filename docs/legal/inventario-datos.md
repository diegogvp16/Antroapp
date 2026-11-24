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
