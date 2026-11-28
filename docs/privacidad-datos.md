# Revisión de privacidad de datos de AntroApp

> **Revisión técnica, no asesoría legal.** Revisé lo que guarda la app sobre
> personas: dónde vive, quién lo ve, cuánto dura y a qué terceros llega.
> La hice el 27/11/2026 en la rama `post-junta-4`, que es igual a
> `post-junta-3` (`4862ff2`).
>
> **Cómo se verificó:**
> - Se leyó el código y el SQL del repo.
> - Catálogo de **producción** en solo lectura (`scripts/db/conexion.mjs`):
>   27 tablas, buckets, políticas, columnas de `auth` y región. No se leyó
>   ninguna fila de datos.
> - Catálogo de **dev**: 80 tablas, con el pase 2, el pase 3 y la fase 2.
> - Matriz de `docs/auditoria-rls.md` (corrida del 27/11).
> - Código de `master` (`git show master:…`) para saber qué está publicado.
>
> No se redacta texto legal. Lo que no se pudo confirmar dice
> **(por confirmar con Diego)**.

## Etiquetas de estado

| Etiqueta | Significa |
|---|---|
| **[prod]** | En producción hoy (pase 1 + arreglo del perfil, `master`) |
| **[pase 2]** | `sql/post-junta/`, `sql/post-junta-2/` y `sql/post-junta-3/02`. Ensayado en dev, **no** está en producción |
| **[pase 3]** | `sql/post-junta-3/` (resto). Ensayado en dev, **no** está en producción |
| **[fase 2]** | `sql/fase2/` (base de inventario y propinas). Sin pase programado **(por confirmar con Diego)** |
| **[bandera X]** | Además, solo funciona con esa bandera encendida. Todas están apagadas por defecto |

Banderas:

- **De Vercel:** `NEXT_PUBLIC_LEGALES`, `NEXT_PUBLIC_CAPTCHA_TURNSTILE`,
  `NEXT_PUBLIC_MENSUALIDAD`, `NEXT_PUBLIC_FASE2` y `ALERTAS_CORREO`.
- **`CORREO_MODO`:** por defecto `archivo`.
- **Por antro** (`club_funciones`, `sql/post-junta-3/00`): `pos_ventas`,
  `escaner_respaldo`, `antifraude`, `lista_negra`, `whatsapp`,
  `reportes_pdf`, `inventario` y `propinas`.
- **De plataforma:** `para_clubes`.

---

## 1. Resumen

- **Hoy en producción no hay aviso de privacidad publicado.**
  - Ni `/privacidad`, ni una liga, ni una casilla: `git grep -i privacidad
    master -- app components` no encuentra nada.
  - Aun así, producción ya guarda nombre, teléfono y correo de clientes,
    RPs y personal, y documentos de identidad de dueños.
  - El borrador (`docs/legal/privacidad.md`) está detrás de
    `NEXT_PUBLIC_LEGALES`, y esa bandera solo existe desde el pase 2.
- **Los datos de producción están fuera de México.**
  - La base de producción está en **AWS `ca-central-1` (Canadá)**. Lo dice
    el host del pooler de `DATABASE_URL_PROD`; dev está en `us-east-1`.
  - Vercel tiene su propia región **(por confirmar con Diego en el panel)**.
  - Es una transferencia internacional: el aviso debe decirlo.
- **En producción nada se borra solo.**
  - Hoy existen `login_intentos` y `app_errores`, y no hay función ni tarea
    que las limpie. `antiabuso_limpiar()` llega con el pase 2, y aun así
    **a mano** (`docs/operacion.md`, «Cada semana»).
  - Después de los pases 2 y 3 sí habrá borrados automáticos, pero solo de
    tablas técnicas (§4). Reservas, caja, nómina, lista negra,
    invitaciones, documentos y bitácoras **no tienen plazo**.
- **Los «hashes» no son irreversibles**, aunque el borrador dice
  «cifrados de forma irreversible».
  - Correos, IPs y teléfonos se guardan con **SHA-256 sin sal**
    (`hashTexto` en `lib/supabase/servicio.ts`; `reserva_intentos` en
    `sql/post-junta-3/02`). Una IPv4 o un teléfono de 10 dígitos se
    revierten probando todos los valores posibles.
  - `sql/post-junta-2/32-salud.sql` ya lo reconoce: «sin sal se revierten».
  - Solo `/para-clubes` (sal secreta) y antifraude (HMAC con clave) lo
    hacen bien.
- **Los derechos ARCO hoy solo se atienden a mano.**
  - No hay pantalla para descargar, corregir ni borrar datos.
  - Borrar a un cliente con reservas o a un RP con comisiones falla por
    llaves foráneas, y la caja no se borra por diseño. Lo único posible es
    **anonimizar**, y no hay procedimiento escrito.
- Lo que viene en los pases 2 y 3 agrega datos que el borrador **no
  menciona**:
  - lista negra y no-shows, con bloqueo automático;
  - revisión antifraude de RPs;
  - invitaciones con datos que escribe un tercero;
  - bandeja de correos (Resend);
  - contactos de `/para-clubes`;
  - ventas del POS con nombre del mesero;
  - propinas por persona;
  - exportes CSV y PDF con teléfonos completos;
  - datos guardados en el teléfono (boletos, cola de caja, copia de la
    puerta);
  - enlaces `wa.me`.

---

## 2. Inventario

**Columnas de la tabla:**

- **Para qué:** la finalidad.
- **Quién lo ve:** según RLS y funciones; detalle en §3.
- **Retención:** el borrado **real** que existe hoy en el código.
- **Tercero:** a qué proveedor llega, además de Supabase, que lo aloja todo.

### 2.1 Clientes (quien reserva, con o sin cuenta)

| Dato (tabla.columna) | Estado | Para qué | Quién lo ve | Retención | Tercero |
|---|---|---|---|---|---|
| `auth.users.email`, `encrypted_password`, `last_sign_in_at`, `confirmed_at`; `auth.identities.email` | [prod] | Cuenta, inicio de sesión, recuperar contraseña | El titular; admin (por service role / dashboard) | Sin borrado | Supabase Auth manda los correos de confirmación y recuperación con su SMTP (`lib/correo.ts`, comentario) **(por confirmar con Diego: SMTP propio o el de Supabase)** |
| `auth.sessions.ip`, `user_agent`; `auth.audit_log_entries.ip_address` | [prod] (columnas confirmadas en el catálogo) | Sesiones y bitácora de Auth de Supabase | Quien entra al dashboard de Supabase | La define Supabase **(por confirmar con Diego)** | Supabase |
| `profiles.nombre`, `telefono`, `created_at` | [prod] | Identificar la cuenta | Titular, admin. El personal del antro **no** ve el perfil del cliente: `profiles_select_mismo_club` solo cubre perfiles con `club_id`, y el cliente no tiene | Sin borrado | — |
| `reservations.cliente_nombre`, `cliente_telefono`, `fecha`, `personas`, `qr_code`, `status`, `source`, `rp_id`, `cliente_id`, `created_at` | [prod] | Apartar lugar y recibir en la puerta | Cliente (las suyas); staff, gerente y dueño del antro; RP (las que él creó); admin. Sin sesión, solo por `/r/<código>` (ver abajo) | Sin borrado | WhatsApp, si alguien comparte el enlace |
| `reservations.puerta_estado`, `en_puerta_en`/`_por`, `entrada_en`/`_por`, `llegada_tarde`, `se_retiro_sin_consumir`, `mesa_id` | [prod] | Entrada y estadísticas | Igual que arriba | Sin borrado | — |
| `reservations.consumo_monto`, `consumption_entries.monto`, `caja_consumos.monto_centavos`/`concepto`, `caja_pagos.metodo`/`monto_centavos` | [prod] | Caja y comisión del RP | Personal del antro y dueño del grupo (caja); RP según `rp_nivel_visibilidad`; cliente (lo suyo, `select *` en `/cliente/perfil`); admin | Sin borrado (la caja **no se puede borrar**: trigger `caja_sin_borrar`) | — |
| `caja_pagos.referencia` | [prod] | El staff escribe «Últimos 4 dígitos o folio» (`components/caja/hojas-mesa.tsx:399`) | Personal del antro, admin | Sin borrado | — |
| `mesa_cuentas.cliente_nombre`, `personas` (también walk-ins sin reserva) | [prod] | Caja por mesa | Staff, gerente, dueño, dueño del grupo, admin | Sin borrado | — |
| `club_bloqueos` (`telefono` en claro, `cliente_id`, `nombre`, **`motivo` escrito a mano**, `vence_en`, `motivo_desbloqueo`) y `lista_negra_eventos` (incluye quién vio un teléfono completo) | [pase 3] [bandera `lista_negra`] | Negar reservas en ese antro | Solo por funciones: gerente, dueño, dueño del grupo, admin. Staff ve el aviso; el RP, el de sus reservas. El cliente no sabe que está bloqueado | **Nunca se borra** (trigger `lista_negra_sin_borrar`); el admin puede tachar motivos (`lista_negra_tachar`) | — |
| No-shows (calculados, no se guardan) y **bloqueo automático** | [pase 3] [bandera `lista_negra`] + `club_noshow_politica.bloquear_desde` | Avisar o bloquear a quien no llega | Igual que arriba | — | — |
| `fraude_alertas.evidencia`/`resumen`, `fraude_alertas_cambios.nota` | [pase 3] [bandera `antifraude`] | Revisión de RPs | Gerente, dueño, dueño del grupo, admin | Sin borrado | — |
| `reserva_intentos.telefono_hash` (SHA-256 **sin sal** del teléfono) e `ip_hash` (SHA-256 sin sal con prefijo fijo `reserva:`) | [pase 2] | Topes de reservas sin cuenta | Nadie por la API | 7 días, pero solo se borra cuando entra otra reserva sin cuenta (`sql/post-junta-3/02`, línea 144) | — |
| `aceptaciones_legales` (`documento`, `version`, `aceptado_en`) | [pase 2] [bandera `NEXT_PUBLIC_LEGALES`] | Constancia de aceptación | Titular, admin | Sin borrado | — |
| Boleto público `/r/<código>` (`obtener_reserva_por_qr`) | [prod]; versión ampliada en [pase 2] (`40-boleto-estado.sql`) | Mostrar el QR en la puerta y compartirlo | **Cualquiera con el enlace**: nombre completo del cliente, antro, fecha, personas, estado. Sin teléfono, consumo ni ids | Mientras exista la reserva | WhatsApp/Meta cuando se comparte; el código va en la **ruta** de la URL (registros de Vercel) |
| Ubicación del navegador (`app/cliente/page.tsx:157`) | [prod] | Ordenar por cercanía | Nadie: no sale del teléfono | — | — |

### 2.2 RPs

| Dato | Estado | Para qué | Quién lo ve | Retención |
|---|---|---|---|---|
| `auth.users.email`, `profiles.nombre`/`telefono`/`activo`/`club_id` | [prod] | Cuenta de trabajo | Titular; staff, gerente y dueño de su antro; admin | Sin borrado |
| `rp_schedule`, `rp_attendance` (`scanned_at`, `metodo`, `marcado_por`) | [prod] | Turnos y asistencia | RP (lo suyo), staff, gerente, dueño, admin | Sin borrado |
| `commissions`, `rp_pagos_dia`, `rp_comision_overrides`, `rp_dia_tarifa_overrides` (**patrimoniales**) | [prod] | Nómina | RP (lo suyo, salvo `rp_dia_tarifa_overrides`); gerente, dueño, admin; **staff no** | Sin borrado |
| `fraude_alertas` (`rp_id`, `rp_ids`, evidencia de patrones) | [pase 3] [bandera `antifraude`] | Detectar fraude de RPs (perfilado de su conducta) | Gerente, dueño, dueño del grupo, admin; **el RP no sabe que existe** | Sin borrado |
| `propinas_reparto_lineas.monto_centavos` por `profile_id` | [pase 3] [fase 2] [bandera `propinas`] | Reparto de propinas | Gerente, dueño, admin | Sin borrado |
| `invitaciones` (`nombre`, `correo`, `telefono`), si lo invitaron | [pase 2] | Mandar la invitación | Quien puede invitar ese rol en ese antro; admin | **Sin borrado** (solo se borran `invitacion_intentos` a 7 días y `invitacion_envios` a 30) |

### 2.3 Personal (staff, gerente) y dueños

| Dato | Estado | Para qué | Quién lo ve | Retención |
|---|---|---|---|---|
| Cuenta (`auth.users`, `profiles`) | [prod] | Acceso | Personal y dueño del mismo antro, admin | Sin borrado |
| `*_por` en caja y puerta, `caja_eventos.detalle`, `caja_cuadres.notas`, `motivo_anulacion` | [prod] | Auditoría | Personal del antro, dueño del grupo, admin | Sin borrado (no se puede, por diseño) |
| `personal_movimientos.motivo` (bajas, escrito a mano) | [pase 2] | Auditoría de bajas | Gerente, dueño, admin | Sin borrado |
| `pos_ventas.mesero`, `cuenta_texto`, `ticket`, `producto`; `pos_importaciones.archivo_nombre` | [pase 3] [bandera `pos_ventas`] | Conciliar con el POS del antro | Gerente, dueño, dueño del grupo, admin | Sin borrado |
| **Bucket privado `verificacion-docs`** + `verificacion_documentos`: comprobante fiscal o licencia, foto del local, **identificación oficial** (opcional) | [prod] | Verificar el antro | Dueño de la carpeta y admin (restrictiva `verificacion_docs_restrictiva`, confirmada en el catálogo de prod) | **Se borra solo al rechazar** (`app/api/admin/rechazar-verificacion/route.ts`). **Aprobado, se queda para siempre** |
| Stripe: `suscripciones.stripe_customer_id`/`_subscription_id`, `pagos_mensualidad.url_factura` | [pase 2] [bandera `NEXT_PUBLIC_MENSUALIDAD`] | Mensualidad | Dueño, admin | Sin borrado |
| `club_altas.creado_por`, `config_rp_cambios`, `grupo_config_cambios`, `funciones_cambios`, `fraude_reglas_cambios`, `whatsapp_plantillas_cambios` (`hecho_por`) | [pase 2]/[pase 3] | Bitácoras de configuración | Según la tabla (§3) | Sin borrado |

### 2.4 Terceros que no son usuarios

| Dato | Estado | Para qué | Quién lo ve | Retención |
|---|---|---|---|---|
| `contactos_clubes` (`nombre`, `club_nombre`, `ciudad`, `correo`, `telefono`, `mensaje`) | [pase 3] [bandera `para_clubes`] | Contacto comercial | Solo admin | Sin borrado automático; el admin borra a mano (`contacto_club_borrar`) |
| `contacto_intentos` (`ip_hash`, `correo_hash`, **con sal secreta**) | [pase 3] | Antispam | Nadie por la API | 7 días (en cada envío, al abrir `/admin/contactos` y en el cron) |
| `correos_salida` (`destinatario`, `asunto`, `cuerpo`) | [pase 2] | Bandeja de lo enviado | Solo admin | **30 días** (cron diario `correos_purgar`, solo si existe `CRON_SECRET`) |
| Personas que alguien reserva **a su nombre** (RP o anónimo con teléfono ajeno) | [prod] | — | Como cualquier reserva | Sin borrado |

### 2.5 Datos técnicos

| Dato | Estado | Para qué | Quién lo ve | Retención |
|---|---|---|---|---|
| `login_intentos.email_hash`, `ip_hash` (SHA-256 **sin sal**) | [prod] | Bloqueo tras fallos de login | Nadie por la API | **Prod: sin borrado.** Pase 2: 30 días con `antiabuso_limpiar()` **a mano** |
| `registro_intentos.ip_hash` (sin sal) | [pase 2] | Tope de registros | Nadie | 30 días, a mano (la misma función) |
| `invitacion_intentos.ip_hash` | [pase 2] | Tope de la página de invitación | Nadie | 7 días (cron `invitaciones_limpiar`) |
| `app_errores` (`mensaje`, `ruta`, `navegador`, `usuario_id`, `ip_hash` sin sal) | [prod] | Depurar fallas | Solo admin | **Sin borrado** (el borrador propone 90 días; no existe). En **prod** el mensaje **no** se limpia de datos personales: `sinDatosPersonales` llega con el pase 2 (C8) |
| `alertas_enviadas`, `stripe_eventos`, `para_clubes_bitacora` | [pase 2]/[pase 3] | Operación | Nadie por la API | Sin borrado (no traen datos personales) |
| Registros de Vercel (IP, ruta, navegador) | [prod] | Hosting | Quien tenga acceso al proyecto de Vercel | Según el plan de Vercel **(por confirmar con Diego)**. Las rutas llevan el código del boleto (`/r/antro-<uuid>`) y el token de invitación (`/invitacion/<token>`) |
| `pg_stat_statements` (extensión activa en prod) | [prod] | Estadísticas de consultas | Dashboard de Supabase | Supabase. Las consultas de la app van parametrizadas; no encontré filtros con datos personales en la URL |

### 2.6 En el teléfono del usuario

| Dónde | Qué | Estado | Cuándo se borra |
|---|---|---|---|
| `localStorage` `CLAVE_BOLETOS` (`lib/boletos-guardados.ts`) | Código QR, antro, zona, fecha y personas de reservas **sin cuenta** (sin nombre ni teléfono) | [pase 2] | Con la noche operativa (08:00) y al cerrar sesión en `/cliente/perfil` |
| IndexedDB `antroapp-caja` (`lib/caja-cola.ts`) | Movimientos de caja por enviar: ids, montos, concepto y la `referencia` de tarjeta, separados por usuario | [pase 2] | Al enviarse. Si no se envían, se marcan vencidos (`lib/domain/caja-cola.ts`) |
| IndexedDB `antroapp-puerta` (`lib/puerta-respaldo.ts`) | Copia de la noche: **nombre completo del cliente y nombre del RP** de quien falta por entrar, personas, huella del QR y 6 caracteres. Sin teléfono | [pase 3] [bandera `escaner_respaldo`] | A las 08:00, al cerrar sesión o si entra otra cuenta; entradas enviadas, a las 24 h |
| `localStorage` caché de banderas (`lib/funciones.ts`) | Qué funciones tiene el antro | [pase 3] | Se reemplaza |
| Caché del service worker (`public/sw.js`) | Solo `/offline.html` | [prod] (v2) / [pase 3] (v5) | Por versión |
| Cookies de sesión de Supabase (`@supabase/ssr`) | Token de sesión | [prod] | Al cerrar sesión o al vencer |
| **CSV y PDF descargados** (`reporte_reservas`, `reporte_consumos`, `reporte_comisiones`, `reporte_pdf_*`) | Nombres y **teléfonos completos** para dueño y gerente; enmascarados para el admin; sin teléfono para el dueño del grupo | [pase 2] (CSV) / [pase 3] (PDF) [bandera `reportes_pdf`] | **Fuera de control de AntroApp** desde que se descargan |

### 2.7 Archivos públicos

- **Bucket `club-photos`**: público, rutas `{club_id}/{uuid}-{nombre original}`.
- Puede haber **personas reconocibles** en las fotos del local
  **(por confirmar con Diego)**.
- En **prod** cualquiera lista el bucket y ve los nombres de archivo, también
  de antros no publicados (Panic Room). Es el hallazgo 9 de
  `docs/auditoria-rls.md`; lo cierra el 67 [pase 2].
- Por ruta exacta, el archivo se sirve a cualquiera siempre, por diseño del
  bucket público.

### 2.8 Respaldos locales (`backups/`, solo en la laptop de Diego)

- Son JSON **en claro**, sin cifrar. Entre ellos:
  - `prod-2026-11-24-17-27-antes-del-pase/` con `auth-usuarios.json`;
  - `prod-2026-11-25-antes-demo-datos/` con `reservations.json` y
    `mesa_cuentas.json`;
  - `prod-2026-11-25-antes-perfil/profiles.json`;
  - `2026-11-11-antros-de-prueba.json`, con nombres y teléfonos;
  - archivos de credenciales.
- `.gitignore` y `.vercelignore` los excluyen, así que no salen a Git ni a
  Vercel.
- **No tienen plazo de borrado.** Solo vi los nombres de archivo, no el
  contenido.

---

## 3. Quién ve qué (matriz por rol)

Fuentes:

- Matriz de `docs/auditoria-rls.md` (dev con los pases 2 y 3, 27/11);
- políticas de producción leídas del catálogo;
- funciones `security definer`.

**«Su antro»** = solo filas de su `club_id`. Todo es **dentro de un antro**:
ningún rol, salvo el admin, ve datos de otro antro. La excepción es el
**dueño del grupo**, que ve los antros de su grupo.

| Dato | Anónimo | Cliente | RP | Staff | Gerente | Dueño | Dueño del grupo | Admin |
|---|---|---|---|---|---|---|---|---|
| Reserva: nombre y teléfono | Solo nombre, con el enlace `/r/` | Las suyas | Las que él creó [prod: tabla directa; pase 2: solo `rp_mis_reservas`] | Su antro | Su antro | Su antro | Sin teléfono (exportes nivel `grupo`) | Todo |
| Consumo de una reserva | — | Lo suyo | Según el nivel del antro (hoy fijo en «estado + monto») | Su antro | Su antro | Su antro | Su grupo (caja) | Todo |
| Nombre en la cuenta de mesa | — | — | — | Su antro | Su antro | Su antro | Su grupo | Todo |
| Perfil del personal (nombre, teléfono) | — | — | El suyo | Su antro | Su antro | Su antro | El suyo | Todo |
| Comisiones, pagos por día, tarifas | — | — | Lo suyo | **No** | Su antro | Su antro | Su grupo (`/grupo`, reportes) | Todo |
| Turnos y asistencia | — | — | Lo suyo | Su antro | Su antro | Su antro | — | Todo |
| Lista negra con motivo [pase 3] | — | — (ni sabe) | Aviso en sus reservas | Aviso, sin motivo | Su antro | Su antro | Su grupo | Todo |
| Alertas antifraude [pase 3] | — | — | — (ni sobre sí) | — | Su antro | Su antro | Su grupo | Todo |
| Bajas con motivo [pase 2] | — | — | — | — | Su antro | Su antro | — | Todo |
| Invitaciones (nombre, correo, teléfono) [pase 2] | Su propia invitación, con el token | — | — | Su antro | Su antro | Su antro | — | Todo |
| Documentos de verificación | — | — | — | — | — | Los suyos | — | Todo (URL firmada) |
| Exportes CSV/PDF [pase 2/3] | — | — | — | — | Teléfono completo | Teléfono completo | Sin teléfono | Teléfono enmascarado |
| Contactos `/para-clubes` [pase 3] | — | — | — | — | — | — | — | Solo admin |
| Bandeja de correos, errores de la app [pase 2] | — | — | — | — | — | — | — | Solo admin |
| Hashes de intentos (login, registro, reserva, contacto) | — | — | — | — | — | — | — | Nadie por la API (solo service role) |

**Notas de la matriz:**

- **«Ver teléfono» de la lista negra** queda registrado, pero no protege
  nada: el staff, el gerente y el dueño ya leen el teléfono completo de
  todas las reservas de su antro **sin registro**. Ya lo señala
  `docs/legal/inventario-datos.md`.
- **El admin es AntroApp.** Ve todo, incluidos teléfonos y nombres de todos
  los antros, y además la service role y el dashboard de Supabase. El
  borrador del aviso **no** lo dice.
- **Un RP o staff dado de baja** pierde el acceso a su nómina hasta el pase
  2 (`61-sesion-sin-acceso.sql`). En **prod** el RP dado de baja todavía lee
  turnos, asistencias, pagos por día y su tarifa (hallazgo 3 de la
  auditoría, «Prod: SÍ»).

---

## 4. Retención: lo real contra lo sugerido

**Lo que de verdad se borra solo** (después de los pases 2 y 3, y solo si
el cron de Vercel tiene `CRON_SECRET`):

| Tabla | Plazo | Mecanismo |
|---|---|---|
| `correos_salida` | 30 días | Cron diario `/api/cron/mensualidad` → `correos_purgar(30)` |
| `invitacion_intentos` / `invitacion_envios` | 7 / 30 días | El mismo cron → `invitaciones_limpiar()` |
| `contacto_intentos` | 7 días | El mismo cron, en cada envío y al abrir `/admin/contactos` |
| `reserva_intentos` | 7 días | Dentro de cada reserva sin cuenta (si nadie reserva sin cuenta, no se limpia) |
| `login_intentos`, `registro_intentos` | 30 días | `antiabuso_limpiar()` **a mano**, cada lunes (`docs/operacion.md`). **No** es automático |

**En producción hoy no hay ninguna** de estas funciones: `vercel.json` y el
cron no están en `master`, y el catálogo de prod solo tiene `caja_sin_borrar`.

**Sugerencia técnica** (la decisión final es de Diego y el abogado):

| Dato | Hoy | Sugerido |
|---|---|---|
| Intentos de login, registro, reserva y contacto | Ver arriba | 30 días **automático**: meter `antiabuso_limpiar()` en el cron diario |
| `app_errores` | Sin borrado | 90 días automático (como propone el borrador) |
| Reservas y caja (datos fiscales del antro) | Sin borrado | Lo que exija la ley fiscal al **antro** (¿5 años?). Pasado un plazo corto, anonimizar nombre y teléfono y conservar solo los montos |
| Teléfono y nombre de reservas de noches ya cerradas | Sin borrado | Anonimizar a los N meses: la puerta y la comisión ya no los necesitan |
| Nómina de RPs | Sin borrado | El plazo laboral/fiscal que diga el abogado |
| Lista negra y su bitácora | Nunca se borra | Plazo máximo de bloqueo y de historial; hoy el trigger lo impide |
| Alertas antifraude | Sin borrado | Plazo de conservación, sobre todo de las descartadas |
| `invitaciones` aceptadas, vencidas o revocadas | Sin borrado | Borrar o anonimizar a los 30–90 días de vencida |
| `contactos_clubes` | A mano | 12 meses sin respuesta (o lo que decida Diego) |
| Documentos de verificación aprobados (incluye identificación) | Para siempre | Borrar la identificación al aprobar, o a los N meses |
| Cuentas inactivas | Sin borrado | El plazo del borrador: 12 meses tras el último uso |
| `backups/` locales | Sin borrado | Cifrar el disco o los archivos y borrar los de más de N días |

---

## 5. Transferencias a terceros

| Tercero | Qué recibe | Cuándo | Dónde | Estado |
|---|---|---|---|---|
| **Supabase** (base, Auth, Storage) | Todo lo de §2 | Siempre | **AWS `ca-central-1`, Canadá** (prod) | [prod] |
| **Vercel** (hosting, funciones, cron) | IP, ruta (con códigos de boleto y de invitación), navegador; los datos pasan por sus funciones | Siempre | **(por confirmar con Diego: región de funciones)** | [prod] |
| **Meta / WhatsApp** | El texto y el enlace al boleto (`/r/<código>`, que muestra el nombre) y, con `wa.me`, el teléfono del cliente | Solo cuando una persona abre el enlace y manda el mensaje. La app no usa la API | Fuera de México | [prod] compartir boleto; [pase 3] [bandera `whatsapp`] plantillas del antro |
| **Cloudflare Turnstile** | IP y señales del navegador | Login, registro, recuperar contraseña y `/para-clubes`, con el CAPTCHA encendido | Fuera de México | [pase 2] [bandera `NEXT_PUBLIC_CAPTCHA_TURNSTILE`] |
| **Cloudflare** (frente de Supabase) | La base lee `cf-connecting-ip` (`ip_cliente()`); el tráfico a Supabase ya pasa por Cloudflare | Siempre | — | [prod] (infraestructura de Supabase) **(por confirmar con Diego)** |
| **Stripe** | Nombre del antro, **correo de quien abre el checkout** (el dueño o, si lo abre él, el admin: `app/api/mensualidad/checkout/route.ts:32`), `club_id` en metadata. Los datos de la tarjeta los captura Stripe directamente | Mensualidad | Fuera de México | [pase 2] [bandera `NEXT_PUBLIC_MENSUALIDAD`] |
| **Resend** | Destinatario, asunto y cuerpo de los correos de la app (invitaciones, alertas) | Solo con `CORREO_MODO=enviar`; por defecto `archivo`, que no envía | Fuera de México | [pase 2] |
| **Proveedor del POS del antro** | Nada sale hacia él. Entra un archivo que exporta el antro | Importar ventas | — | [pase 3] [bandera `pos_ventas`] |

No se encontraron analíticas, píxeles, mapas ni fuentes externas en las
dependencias (`package.json`). `html5-qrcode` usa la cámara en el
teléfono; las imágenes no se suben.

---

## 6. Derechos ARCO hoy

| Derecho | Qué se puede hacer hoy | Cómo | Qué no se puede |
|---|---|---|---|
| **Acceso** | El cliente con cuenta ve su perfil y sus reservas con consumo (`/cliente/perfil`). El RP ve su nómina y reservas | Pantallas propias | Sin cuenta (la mayoría de las reservas) no hay forma de ver nada salvo el boleto. Lista negra, antifraude, bitácoras, intentos e IPs: solo el admin con SQL. Ninguna descarga de «mis datos» |
| **Rectificación** | Contraseña (`/actualizar-contrasena`). La política deja editar el `nombre` propio por la API, pero **no hay pantalla** | El admin, con SQL Editor o service role | El cliente no corrige su nombre ni su teléfono. Las reservas pasadas no se corrigen solas |
| **Cancelación** | Contactos de `/para-clubes` (`contacto_club_borrar`); documentos rechazados (se borran al rechazar); motivos de la lista negra (`lista_negra_tachar`, solo motivos) | Admin | Borrar el usuario de Auth **falla** si tiene reservas (`reservations_cliente_id_fkey`, sin cascade) o comisiones/pagos (`commissions_rp_id_fkey`, `rp_pagos_dia_rp_id_fkey`). La caja no se borra (`caja_sin_borrar`) ni la lista negra (`lista_negra_sin_borrar`; el inventario dice que hace falta `antroapp.borrado_pruebas` como postgres). Falta un **procedimiento de anonimización** que diga qué columnas se cambian a qué valor en cada tabla |
| **Oposición / revocación** | No hay finalidades secundarias activas (no se manda publicidad). Bloqueo: el gerente puede desbloquear con motivo | A mano, por el antro | Ningún medio para que el cliente pida revisar un bloqueo automático ni para revocar el consentimiento |
| **Identificar al titular** | — | — | Las reservas sin cuenta no están ligadas a nadie verificable: cualquiera reserva con el teléfono de otro. Hay que definir cómo se acredita la titularidad de un teléfono antes de entregar o borrar sus datos |

---

## 7. Riesgos y huecos, por gravedad

| # | Gravedad | Hallazgo | Dónde | Estado |
|---|---|---|---|---|
| 1 | **ALTO** | **Sin aviso de privacidad en producción**, aunque ya se recaban nombre, teléfono, correo e identificación. Aun con `NEXT_PUBLIC_LEGALES`, la aceptación solo se pide en el registro del **cliente** (`/api/auth/registro` la exige solo con `tipo === "cliente"`) y en la primera entrada del RP; `/para-clubes` solo lo enlaza. **No** se pide ni se enlaza en el registro de dueño, en la reserva sin cuenta (`/cliente/reservar`), en el boleto, para staff y gerentes, ni a quien reserva un RP | `master` (sin `/privacidad`); `app/cliente/reservar` | [prod] |
| 2 | **ALTO** | **Datos en Canadá** (Supabase `ca-central-1`) sin que ningún aviso lo diga | Host de `DATABASE_URL_PROD` | [prod] |
| 3 | **ALTO** | **Lista negra con motivo libre, sin plazo y con bloqueo automático por no-show**: decisión automatizada, datos posiblemente sensibles en el motivo, ningún medio de impugnación, el titular no se entera. El borrador del aviso no lo menciona | `sql/post-junta-3/40-lista-negra.sql` | [pase 3] [bandera] |
| 4 | **MEDIO** | **Hashes sin sal** (correo e IP en `login_intentos`, IP en `registro_intentos` y `app_errores`, teléfono e IP en `reserva_intentos`): reversibles por fuerza bruta. El borrador del aviso dice «irreversible» | `lib/supabase/servicio.ts:17`; `sql/post-junta-3/02` líneas 111 y 131 | [prod] + [pase 2] |
| 5 | **MEDIO** | **Nada se borra en producción**: `login_intentos` y `app_errores` crecen sin límite. Con el pase 2, los intentos dependen de una tarea **manual** | Catálogo de prod; `docs/operacion.md` | [prod] |
| 6 | **MEDIO** | **`app_errores` en prod guarda el mensaje sin limpiar** (ni correos ni teléfonos), y el `console.error` de esa ruta manda el error completo a los registros de Vercel. Lo arregla C8 del pase 2 | `git show master:app/api/errores/route.ts` | [prod] |
| 7 | **MEDIO** | **Identificación oficial del dueño guardada para siempre** después de aprobar. Una INE trae CURP, fecha de nacimiento, domicilio, foto y firma | `components/verificacion-antro.tsx`; `rechazar-verificacion` solo borra al rechazar | [prod] |
| 8 | **MEDIO** | **Cancelación imposible sin anonimizar a mano**: llaves foráneas sin cascade, triggers de «nada se borra» y ningún procedimiento escrito | §6 | [prod] |
| 9 | **MEDIO** | **Exportes con teléfonos completos** para dueño y gerente, hasta 93 días por descarga. Una vez descargados, AntroApp pierde el control (y queda la duda de quién es responsable) | `sql/post-junta-2/31-exportes.sql` (`reporte_nivel_exportes`) | [pase 2] |
| 10 | **MEDIO** | **Revisión antifraude = perfilado de RPs** sin que el RP lo sepa. El aviso para RPs no lo menciona | `sql/post-junta-3/30-antifraude-rps.sql` | [pase 3] [bandera] |
| 11 | **MEDIO** | **Datos de terceros sin su consentimiento**: reservas hechas por un RP o con teléfono ajeno; invitaciones con nombre, correo y teléfono que escribe quien invita; el nombre del mesero desde el POS. Ninguno de ellos ve el aviso | `reservations`, `invitaciones`, `pos_ventas.mesero` | [prod] / [pase 2] / [pase 3] |
| 12 | **BAJO-MEDIO** | **Listado público del bucket `club-photos`** con nombres originales de archivo, también de antros no publicados (Panic Room, con fotos de su Instagram). Lo cierra el 67 | `docs/auditoria-rls.md`, hallazgo 9 | [prod] |
| 13 | **BAJO** | **Motivos escritos a mano** en bajas, anulaciones, cuadres, alertas y bloqueos: pueden terminar con datos sensibles. Antifraude enmascara teléfonos; los demás no | `personal_movimientos.motivo`, `caja_*.motivo_anulacion`, `club_bloqueos.motivo` | [prod]/[pase 2]/[pase 3] |
| 14 | **BAJO** | **`caja_pagos.referencia`** pide «Últimos 4 dígitos o folio»: el aviso dice «no guardamos datos de tarjetas» | `components/caja/hojas-mesa.tsx:399` | [prod] |
| 15 | **BAJO** | **Boleto público con nombre completo**: quien tenga el enlace (reenviado por WhatsApp) ve el nombre. El código también llega a los registros de Vercel por ir en la ruta | `obtener_reserva_por_qr` | [prod] |
| 16 | **BAJO** | **Copia de la noche en el teléfono del staff** (nombres de clientes y RPs) hasta las 08:00. Si el teléfono se pierde con la sesión abierta, se pierde la lista | `lib/puerta-respaldo.ts` | [pase 3] [bandera] |
| 17 | **BAJO** | **Respaldos de producción en claro** en la laptop, sin plazo | `backups/prod-*` | Local |
| 18 | **BAJO** | **RP dado de baja** sigue leyendo su nómina, turnos y tarifa en prod | Hallazgo 3 de la auditoría | [prod]; lo arregla el 61 [pase 2] |
| 19 | **INFO** | **Cuentas reales mezcladas con prueba en prod**: «RP Demo» es Gmail real de Diego, y hay «varios clientes de Diego» y 2 usuarios de Auth sin perfil (CLAUDE.md §7) | — | [prod] |

---

## 8. Cambios necesarios en el aviso de privacidad

Puntos a **cubrir**, sin redactar el texto. Referencia: `docs/legal/privacidad.md`.

1. **Publicarlo en producción** y enlazarlo donde se recaban datos:
   - la reserva sin cuenta;
   - el boleto `/r/`;
   - el mensaje que manda el RP (o al menos el boleto);
   - el registro de dueño (`/dueno/signup`) y el alta de staff, gerentes
     y dueños que crea el admin;
   - las invitaciones;
   - `/para-clubes`.
2. **Responsable y encargado**: separar lo que trata AntroApp por su cuenta
   (cuentas, seguridad, contactos comerciales) de lo que trata **por cuenta
   del antro** (reservas, caja, lista negra, nómina, antifraude).
3. **Transferencia internacional**: Supabase en Canadá, Vercel (región por
   confirmar), Stripe, Resend, Cloudflare y Meta (WhatsApp).
4. **Quitar «cifrados de forma irreversible»**, o salar los hashes antes de
   publicarlo (§9, decisión 6).
5. **Lista negra y no-show**:
   - que existe y que es por antro;
   - el bloqueo automático como decisión automatizada;
   - plazo;
   - cómo pedir revisión;
   - que el motivo lo escribe el antro.
6. **Antifraude de RPs**, en la parte de RPs y personal: revisión de
   patrones de reservas y consumo.
7. **Datos de RPs y personal** que faltan:
   - propinas repartidas por persona;
   - bajas con motivo;
   - registro de actividad;
   - nombre del mesero desde el POS.
8. **Dueños**: la identificación oficial (qué trae, para qué y cuánto se
   guarda después de aprobar) y los datos que van a Stripe.
9. **Terceros reservados o invitados**: qué pasa cuando otra persona
   (RP, conocido, gerente) da tu nombre y teléfono.
10. **El dueño del grupo** y **el admin de AntroApp** como quienes ven los
    datos (hoy solo se nombra al antro y al RP).
11. **Exportes CSV/PDF**: el antro descarga reservas con teléfono; desde
    ahí el antro es responsable de esa copia.
12. **WhatsApp por enlace**: el antro o el RP pueden escribirte desde su
    WhatsApp con plantillas (confirmación, recordatorio, no-show), y el
    boleto que se comparte muestra tu nombre a quien lo reciba.
13. **Sección 7 (cookies y almacenamiento)**: además de la sesión, hay que
    nombrar:
    - el boleto guardado en el teléfono sin cuenta;
    - la cola de caja y la copia de la puerta en los teléfonos del personal;
    - la caché de `/offline.html`.
14. **Datos técnicos**, tal cual: registros de Supabase Auth (IP y
    navegador de cada sesión), registros de Vercel, errores con el
    navegador y la cuenta.
15. **Tarjeta**: matizar «no guardamos datos de tarjetas» (el staff puede
    anotar los últimos 4 dígitos o un folio), o quitar ese campo.
16. **Plazos reales** (§4), no solo propuestos. Hoy el borrador promete 30
    días para los intentos y 90 para los errores, y ninguno se cumple solo.
17. **ARCO**:
    - medio concreto;
    - cómo se acredita la titularidad de un teléfono sin cuenta;
    - que la cancelación puede ser anonimización (caja y obligaciones
      fiscales del antro);
    - plazos de la ley vigente.
18. **«No recabamos datos sensibles»**: revisar a la luz de los motivos
    escritos a mano (lista negra, bajas) y de la identificación.
19. **Contactos de `/para-clubes`**: el borrador no los menciona (ya lo
    anota `inventario-datos.md`).
20. **Edad**: el servicio es para mayores; la app no verifica la edad.

---

## 9. Lo que Diego y el abogado deben decidir

1. **¿Se publica el aviso ya, en producción?** Requiere el pase 2
   (`NEXT_PUBLIC_LEGALES`) o un parche a `master`. Hoy se recaban datos sin
   aviso.
2. **¿Responsable o encargado** en cada dato? Define quién atiende ARCO de
   las reservas: ¿AntroApp o el antro? Hace falta un contrato de encargo
   con cada antro (`docs/legal/contrato-antro.md`).
3. **Región**: ¿basta con informar la transferencia a Canadá y EE. UU., o
   hace falta consentimiento expreso? ¿Mover el proyecto de Supabase?
4. **Plazos de conservación** de cada fila de §4, en especial:
   - reservas y caja (obligación fiscal del antro);
   - lista negra;
   - identificación del dueño;
   - invitaciones;
   - contactos.
5. **Lista negra y bloqueo automático**: ¿se permite el automático? Con
   qué aviso, qué plazo máximo y qué medio de impugnación. ¿Se restringe
   el motivo a categorías fijas en lugar de texto libre?
6. **Hashes**: ¿se agrega sal o HMAC (como `fraude_secreto` o
   `contacto_sal`) a login, registro, errores y reservas? Es un cambio
   técnico chico, pero invalida el historial de topes. Si no, el aviso no
   puede decir «irreversible».
7. **Anonimización**: aprobar un procedimiento (qué columnas, qué valor,
   quién lo corre y con qué bitácora) para cancelar la cuenta de un cliente
   o RP con caja y nómina.
8. **Exportes con teléfono completo**: ¿se mantienen para dueño y gerente,
   o se enmascaran por defecto?
9. **Boleto público**: ¿nombre completo o recortado («Ana G.», como ya hace
   `puerta_escanear_codigo`)?
10. **Antifraude**: ¿se le informa al RP (aviso o contrato) que sus
    patrones se revisan?
11. **Identificación del dueño**: ¿hace falta conservarla después de
    aprobar?
12. **Campo «referencia» de tarjeta**: ¿se deja (y se avisa) o se cambia a
    «folio de la terminal» sin dígitos de la tarjeta?
13. **Respaldos locales**: dónde se guardan, cifrado y plazo.
14. **Cuentas reales en prod** (clientes de Diego, usuarios sin perfil):
    ¿se borran?

---

## 10. Diferencias con `docs/legal/`

### `docs/legal/inventario-datos.md`: desactualizado o inexacto

No se reescribió; se anota aquí.

1. **Retención**:
   - Dice «nada se borra automáticamente salvo los intentos de login y
     registro (30 días, con `antiabuso_limpiar()`)». En realidad
     `antiabuso_limpiar()` es **manual** (`docs/operacion.md`) y **no está
     en producción**.
   - Sí hay borrados automáticos que no lista en esa frase:
     `correos_salida` a 30 días (este sí lo dice en su tabla),
     `invitacion_intentos` a 7, `invitacion_envios` a 30,
     `contacto_intentos` a 7 y `reserva_intentos` a 7.
2. **«Correo e IP cifrados con hash (no se guardan en claro)»**: falta
   decir que es **sin sal** y reversible.
3. **Tablas que no aparecen**:
   - `reserva_intentos` (con `telefono_hash` sin sal);
   - `invitacion_intentos` e `invitacion_envios`;
   - `fraude_alertas` y `fraude_alertas_cambios`;
   - `pos_ventas` (`mesero`, `cuenta_texto`) y `pos_importaciones`
     (`archivo_nombre`);
   - `caja_propinas`, `propinas_repartos` y `propinas_reparto_lineas`;
   - `suscripciones` y `pagos_mensualidad` (ids de Stripe, `url_factura`);
   - `producto_movimientos.referencia`;
   - `auth.sessions` (`ip`, `user_agent`) y `auth.audit_log_entries`
     (`ip_address`).
4. **«Sin datos de la tarjeta»**: `caja_pagos.referencia` pide los últimos
   4 dígitos.
5. **«Lo que la app NO guarda: … identificación»**: es correcto para el
   cliente, pero la identificación del **dueño** sí se guarda, y sin plazo
   al aprobarse.
6. **Región**: decía «por confirmar». Producción está en **`ca-central-1`
   (Canadá)**.
7. **No distingue producción de dev**: está escrito sobre el esquema de
   `post-junta`. Casi todo lo «técnico» y lo de terceros todavía no está en
   producción; la §2 de este documento lo marca.
8. **Faltan secciones** para:
   - lo guardado en el teléfono (`localStorage`, IndexedDB, service
     worker);
   - los exportes CSV/PDF;
   - el boleto público;
   - los respaldos locales.

### `docs/legal/privacidad.md` (borrador del aviso)

Contra lo encontrado, ver §8. Lo más importante:

- dice «irreversible», y no lo es;
- dice «no guardamos datos de tarjetas», con el matiz de la referencia;
- promete plazos (30 y 90 días) que no se cumplen solos;
- no menciona la lista negra, el antifraude, las invitaciones, el POS, las
  propinas, `/para-clubes`, los exportes, WhatsApp, al dueño del grupo ni
  al admin;
- la sección 7 de almacenamiento se queda corta;
- las regiones siguen «por confirmar».

### `docs/legal/README.md`

La pregunta abierta 4 (transferencias) ya tiene un dato: Canadá.
