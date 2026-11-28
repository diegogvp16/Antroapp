# Lista de lanzamiento — antes de recibir un club real y antes de cobrar

> Estado al **28/11/2026** (noche 5, rama `post-junta-4`). Cada renglón dice
> dónde está la evidencia. Se marca contra lo que hay **en producción**, no
> contra lo que está listo en dev.
>
> ✔ listo · ⚠ a medias (ver nota) · ✘ falta · ❓ por confirmar con Diego

## Resumen

| Momento | Listo | A medias | Falta / por confirmar |
|---|---|---|---|
| **A. Recibir un club real (piloto, sin cobro)** | 7 | 8 | 13 faltan · 6 por confirmar |
| **B. Cobrar la mensualidad** (además de A) | 0 | 2 | 9 faltan |

**Lo que más bloquea:**

1. El pase 2 en producción (con el Q10b).
2. El aviso de privacidad publicado.
3. La prueba en teléfonos reales.
4. La primera exportación de Storage de producción.

Para cobrar, además: Stripe con llaves de prueba, de punta a punta, y las
decisiones de precio, IVA y factura.

## A. Antes de recibir un club real

### A1. Producto y base en producción

| Estado | Qué | Evidencia / siguiente paso |
|---|---|---|
| ✔ | Pase 1 en producción: caja por mesa, nómina, `/grupo`, panel del RP, permisos de caja | `docs/reporte-pase.md`: humo 84/84, recorrido 49/49 |
| ✔ | Hueco crítico del perfil cerrado (`profiles_insert_propio` sin club ajeno) | Catálogo de producción del 28/11: la política exige `club_id IS NULL` |
| ✘ | **Pase 2 en producción** (39 pasos con el Q10b, más el merge): cierre de la noche, invitaciones, importar mesas y RPs, baja de personal, topes de reservas sin cuenta, huecos que **existen hoy en producción** (Q2–Q5, Q7) | `docs/pase-2.md`: ensayado 39/39 en dev el 27/11. Lo pide Diego |
| ✘ | El `02` (IP real en los topes) **con** el pase 2, como Q10b | `docs/pase-2.md`, «Q10b». Sin él, el tope por IP se esquiva |
| ⚠ | Pase 3 (banderas por antro): opcional para el piloto | `docs/pase-3.md`: ensayado 11/11. Todo nace apagado |
| ✔ | Ensayos y rollbacks probados | Pase 2: 39/39; pase 3: 11/11; simulación de privilegios de producción: 0 abiertos |
| ⚠ | Prueba de carga de un club grande (500 reservas, 60 mesas, 7 operando a la vez) | `docs/prueba-carga.md` (bloque 1 de la noche 5). Los índices que propone **no** están aplicados |

### A2. Teléfonos y operación en la noche

| Estado | Qué | Evidencia / siguiente paso |
|---|---|---|
| ✘ | **Prueba en teléfonos reales** (Android e iPhone, poca luz, linterna, 3G, cambio de red, pantalla apagada) | `docs/prueba-telefonos.md`: 27 pruebas. Nada se ha probado en un teléfono físico |
| ⚠ | Caja sin señal y escáner de respaldo | Probado solo con Playwright (`probar-caja-sin-red.mjs` 41/41). La caja sin señal llega con el pase 2; el escáner de respaldo es del pase 3, con bandera |
| ✔ | Manuales de staff/gerente y de RP | `docs/manual-staff.md`, `docs/manual-rp.md` (27/11). Describen lo de las ramas: revisar contra lo que esté en producción el día del piloto |
| ✘ | Manual o guía corta del **dueño** | No existe. Hoy el dueño se apoya en la capacitación (`docs/piloto-playbook.md`, día −2) |
| ✔ | Plan del piloto (cronograma, tareas por noche, métricas, criterios) | `docs/piloto-playbook.md`. Los criterios son una propuesta por acordar |
| ❓ | Acuerdo escrito con el antro del piloto (alcance, duración, quién paga a los RPs, datos al terminar) | `docs/legal/contrato-antro.md` es un borrador |

### A3. Datos personales y legal

| Estado | Qué | Evidencia / siguiente paso |
|---|---|---|
| ✘ | **Aviso de privacidad publicado** (`NEXT_PUBLIC_LEGALES`) y revisado por un abogado | `docs/privacidad-datos.md`, hallazgo 1: producción no tiene aviso y ya guarda nombres, teléfonos, correos e identificaciones |
| ✘ | El aviso cubre los 20 puntos de la revisión: transferencia a Canadá (Supabase `ca-central-1`) y EE. UU., plazos, lista negra, antifraude… | `docs/privacidad-datos.md`, lista de cambios |
| ✘ | Aceptación del aviso en todos los puntos de entrada (reserva sin cuenta, registro de dueño, alta de personal) | Hoy, con la bandera, solo se pide en el registro de cliente y en la primera entrada del RP |
| ✘ | Plazos de conservación y borrado (hoy en producción nada se borra solo) | `docs/privacidad-datos.md`, decisiones 4 y 7 |
| ❓ | Rol de AntroApp (responsable o encargado) y contrato de encargo con cada antro | Decisión de Diego con el abogado |
| ⚠ | «Hashes» de correo, IP y teléfono: SHA-256 sin sal, se pueden revertir | Agregar sal o quitar «irreversible» del borrador del aviso |
| ⚠ | Campo de referencia del cobro con tarjeta: pide «Últimos 4 dígitos» | Contradice «no se guardan datos de tarjeta»: cambiar el texto o el aviso |
| ⚠ | Términos y reglas de reservas y QR | Borradores en `docs/legal/` (`terminos.md`, `reservas-y-qr.md`), sin publicar |

### A4. Respaldos, recuperación y monitoreo

| Estado | Qué | Evidencia / siguiente paso |
|---|---|---|
| ❓ | Respaldo diario de Supabase visible, y PITR o «Restore to new project» según el plan | `docs/recuperacion.md`, «Por confirmar» |
| ✘ | **Primera exportación de Storage de producción** (fotos y documentos de verificación; el respaldo de Supabase no los incluye) | `node scripts/exportar-storage.mjs --env=<llaves de prod> --produccion` (solo lee; baja documentos privados a la laptop). La corre Diego |
| ✘ | Copia de la base **fuera** de Supabase y de la laptop (cifrada) | `docs/recuperacion.md`: hoy, si se pierde la cuenta, se pierde todo salvo el código |
| ✘ | Primer ensayo completo de restauración en un proyecto nuevo | `docs/recuperacion.md`: unas 4 h; RPO de la base ≤ 24 h |
| ❓ | Monitor externo de `/api/salud` (UptimeRobot o similar) | `docs/operacion.md`, «Monitoreo automático» |
| ✔ | Revisión diaria y qué hacer si algo se cae | `docs/operacion.md` |

### A5. Seguridad y configuración

| Estado | Qué | Evidencia / siguiente paso |
|---|---|---|
| ✔ | RLS por club y rol auditada (C1, 23 sesiones reales) | `docs/auditoria-rls.md`: 14,116/14,116 en dev con pase 2 + 3 |
| ⚠ | Staff puede leer la configuración de comisiones del antro (deuda 9) | CLAUDE.md §7. Arreglarlo exige mover campos a otra tabla |
| ❓ | Supabase Auth: contraseñas filtradas, longitud mínima, límites, Site URL y Redirect URLs | `docs/pase-2.md`, «Revisar, por si acaso». Lo revisa Diego en el dashboard |
| ✘ | CAPTCHA (Turnstile) en login y registros | Bandera `NEXT_PUBLIC_CAPTCHA_TURNSTILE` apagada (`docs/captcha.md`) |
| ✘ | `CRON_SECRET` en Vercel (Production) | `docs/pase-2.md`: va en el pase 2, antes del merge |
| ❓ | Cuentas de prueba en producción (2 de Auth sin perfil, «Landing Test», clientes de Diego) | CLAUDE.md §7: borrarlas es decisión de Diego |
| ⚠ | Club Demo usa fotos de SIX GDL; Panic Room está en borrador sin autorización | No mostrar Club Demo en público ni encender `/para-clubes` hasta cambiar las fotos |

## B. Antes de cobrar la mensualidad (además de A)

| Estado | Qué | Evidencia / siguiente paso |
|---|---|---|
| ✘ | Respuestas del negocio: precio con IVA, prueba gratis, días de gracia, CFDI | `docs/stripe-mensualidad.md`, «Preguntas abiertas». El precio decidido con el socio ($2,500 MXN, CLAUDE.md §4) no está en el código |
| ✘ | Cuenta de Stripe en modo prueba, producto y precio, llave restringida y webhook con los 7 eventos | `docs/stripe-mensualidad.md`, pasos 1 a 6 |
| ⚠ | Flujos de la mensualidad probados en dev con eventos simulados | `docs/stripe-prueba-dev.md`: 60/60 y 80/80, sin Stripe real |
| ✘ | Prueba de punta a punta con llaves de prueba **reales**: Checkout y portal reales, calendario de Smart Retries, campo que manda el portal al cancelar, 409 con una suscripción viva | `docs/stripe-prueba-dev.md`, «Pendiente con llaves de prueba reales» |
| ✘ | Decidir los hallazgos de Stripe: antro de cortesía que se despublica, «Suscribirme» con 409 en «Vencida», RPs que siguen reservando en un antro vencido, alerta de gracia repetida | `docs/stripe-prueba-dev.md`, hallazgos 1 a 7 |
| ⚠ | Cambio de plan: la app solo liga precios de planes dados de alta; con un precio desconocido se queda el plan anterior en silencio | Mientras haya un solo plan, dejar «Switch plans» apagado en el portal |
| ✘ | Candado de `suscripcion_activa` con cobro real (`mensualidad_real = true`) | Existe en el pase 2 (`sql/post-junta/06`) y se prueba en `probar-mensualidad.mjs`; se enciende al cobrar de verdad |
| ✘ | Modo live: llaves live en Vercel, `STRIPE_PERMITIR_PRODUCCION=1` y el `update` de `mensualidad_real` | `docs/stripe-mensualidad.md`, «Pasar a producción» |
| ✘ | Facturación (CFDI): Stripe no la emite | Decisión: otro proveedor, o factura a mano |
| ✘ | Correos reales (avisos de cobro y de gracia): Resend con dominio verificado y `CORREO_MODO=enviar` | `docs/pase-2.md`, «Variables nuevas» |
| ✘ | Términos de servicio publicados, con la mensualidad y la cancelación | `docs/legal/terminos.md` (borrador) |

## Cómo se actualiza esta lista

Al cerrar cada paso: cambiar la marca, poner la evidencia (commit, documento,
fecha del pase) y recontar el resumen. Una marca ✔ solo con evidencia de
**producción** (catálogo, humo o recorrido), no de dev.
