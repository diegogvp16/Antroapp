# Pase 2 — `post-junta` + `post-junta-2` a producción

> **NO EJECUTADO.** Escrito el 25/11/2026 (noche 3). El pase lo pide Diego de
> forma explícita. Complementa la sección «Pase 2» de `docs/pase-produccion.md`
> (pasos P0–P14 de `sql/post-junta/`): aquí se agrega todo lo de
> `sql/post-junta-2/` y se fija el orden completo.

## Qué cambió en producción el 25/11 (antes de este pase)

| Hora | Qué | Estado |
|---|---|---|
| 10:00 | `node scripts/demo-datos.mjs --fecha=2026-11-25 --si` (autorizado) | Hecho y verificado (cuadre sin diferencias, solo Club Demo) |
| — | `sql/2026-11-25-perfil-sin-club-ajeno.sql` (hueco CRÍTICO de `profiles_insert_propio`) | **Pendiente de que Diego lo corra** y de verificarlo. Si no se corrió para el día del pase, va **primero**, antes que todo |

## La cadena completa

Probada en dev el 25/11 con `node scripts/dev/ensayo-pase2.mjs completo
--comparar-prod` (38 pasos):

- Revertir todo en orden inverso deja dev **igual a producción**. Solo quedan dos diferencias, que no vienen de ningún archivo de la cadena:
  - la política del perfil, pendiente de correr;
  - GRANT a `service_role`, que vienen de los privilegios por defecto de cada proyecto.
- Volver a aplicar todo deja el esquema **idéntico** al de antes, sin restos.
- Cada archivo tardó de 2 a 5 s en dev.

Además, `node scripts/dev/simular-privilegios-prod.mjs` reprodujo en dev los
privilegios por defecto de producción. En producción, lo que crea `postgres`
nace ejecutable y legible por `anon`; en dev, no. Con esos privilegios, la
cadena **no deja ninguna función ni tabla abierta** que no se haya probado en
dev. La simulación incluye un control que confirma que reproduce producción.

### Antes del merge (SQL compatible con el código de hoy)

| Paso | Archivo | Qué hace | Notas |
|---|---|---|---|
| P0 | — | Respaldo del día, `extraer-esquema --origen=prod` y comparar | |
| P1–P12 | `sql/post-junta/01` … `12` | Lo de `docs/pase-produccion.md`, «Pase 2» | La fase 2 (P11) es opcional |
| Q1 | `post-junta-2/60-autorizacion-nulos-c.sql` | Dos autorizaciones más que no quedan en NULL | |
| Q2 | `61-sesion-sin-acceso.sql` | Un RP dado de baja o con contraseña temporal ya no lee su nómina, turnos ni clientes | El hueco del RP dado de baja **existe hoy en producción** |
| Q3 | `62-clubs-dueno-valido.sql` | Solo un dueño (o el admin) crea antros; un dueño, un antro | **También en producción**: hoy un cliente o un RP crea un antro directo contra la API. Decisión de Diego: «un dueño, un antro» |
| Q4 | `63-bucket-fotos-limites.sql` | Tamaño y tipos del bucket `club-photos` | **También en producción** (hoy no tiene límite) |
| Q5 | `64-rp-del-club.sql` | Turnos, asistencias y tarifas solo de RPs del mismo antro | **También en producción** |
| Q6 | `65-concurrencia-puerta-cobro.sql` | Puerta y cobro idempotentes con peticiones a la vez | **Después de la fase 2** si se pasa (redefine `caja_registrar_pago`) |
| Q7 | `67-club-photos-listar.sql` | El anónimo ya no lista las carpetas de antros no publicados | **También en producción** (Panic Room) |
| Q8 | `68-un-antro-por-dueno-candado.sql` | Lo del 62, también con dos altas a la vez | **Después del 62**: se aplica sin él, pero truena al usarse |
| Q9 | `72-reservas-antiabuso.sql` | Reservas sin cuenta: 3 por teléfono, antro y noche; 20 por IP y hora; solo antros publicados; hasta 60 días | Diego decidió que va en este pase, no antes |
| Q10 | `66-reservas-antiabuso-concurrencia.sql` | Los topes del 72 también con reservas a la vez | **Después del 72** (si falta el 72, se detiene sin cambiar nada) |
| Q11 | `10-alta-club-reglas.sql` | Reglas de comisión y RPs en el alta | |
| Q12 | `11-clonar-club.sql` | Clonar antro | Después del 10 |
| Q13 | `12-config-grupo.sql` | Configuración por grupo | Después del 11 |
| Q14 | `20-correos-salida.sql` | Bandeja de salida de correos | |
| Q15 | `21-invitaciones.sql` | Invitaciones de personal | |
| Q16 | `22-importar-mesas.sql` | Mesas por CSV | **Antes, en producción**: `22-importar-mesas-diagnostico.sql` (solo lectura). Si devuelve filas, hay mesas repetidas: resolverlas primero |
| Q17 | `23-importar-personal.sql` | RPs y staff por CSV (invitaciones en lote) | |
| Q18 | `24-invitaciones-cupos.sql` | Límites de envío de invitaciones | Después del 23 |
| Q19 | `30-cierre-noche.sql` | Cierre de la noche | |
| Q20 | `31-exportes.sql` | Exportables CSV | |
| Q21 | `32-salud.sql` | Panel de salud del admin | Necesita P4 y P10 |
| Q22 | `40-boleto-estado.sql` | Estado del boleto público | Compatible con el código viejo |
| Q23 | `70-indices-prod.sql` | 16 índices | **Versión de producción**: `CONCURRENTLY`, **una sentencia a la vez** y fuera de horario de operación. No va en transacción. Si una falla, deja un índice INVALID: borrarlo con su línea del rollback y repetirla |
| Q24 | `71-caja-politicas-rapidas.sql` | Políticas de caja calculadas una vez por consulta (consumos de la noche: de 31.8 ms a 0.31 ms) | Mismas filas para las 9 identidades probadas |

### Merge (P13)

Igual que en `docs/pase-produccion.md`, pero de **`post-junta-2`**, que ya
incluye `post-junta`. Las banderas quedan apagadas.

### Después del merge

| Paso | Archivo | Por qué después |
|---|---|---|
| R1 | `41-rp-visibilidad.sql` | El panel viejo del RP lee `reservations` directo; con el 41 su resumen «lo que llevas ganado» saldría en ceros |
| R2 | — | Humo (`node scripts/humo-produccion.mjs https://antroapp.vercel.app --navegador`), `/api/salud` y recorrido de los roles |

## Rollback

En orden inverso, cada uno con su `-rollback.sql`. Cuidados:

- **P9 (`post-junta/10`)**: su rollback se **corrigió el 25/11**. Antes regresaba 6 funciones a sus cuerpos de antes del 10a, pero el 10a ya está en producción desde el pase 1, así que revertir el P9 habría reabierto el hueco ALTO. Ahora regresa a exactamente lo que hay hoy en producción.
- **Caja (`b-caja` en adelante)**: si hay que revertir el paso 7b del pase 1, primero el código y después el SQL. La cola del teléfono reintenta con la clave de idempotencia de la base.
- **R1 (41)**: primero el rollback del 41 y después Instant Rollback del código.
- **Q23 (índices)**: el rollback de producción también va una sentencia a la vez (`70-indices-prod-rollback.sql`).
- **Q11–Q13**: el rollback va en cadena (12 → 11 → 10). Cada uno regresa `admin_alta_club` a la versión del anterior.
- **Q14–Q18**: el rollback borra las tablas nuevas (invitaciones, correos, lotes). Exportarlas antes si ya se usaron.

Criterios para parar: los mismos de `docs/pase-produccion.md`. Lo más
delicado es la caja en plena noche: **no** revertir SQL a media noche.

## Variables nuevas (Vercel, después del pase, una por una)

| Variable | Qué hace | Por defecto |
|---|---|---|
| `CORREO_MODO` | `archivo` (los correos se guardan y se ven en `/admin/correos`), `enviar` (Resend) o `apagado` | `archivo`: no sale ningún correo |
| `RESEND_API_KEY`, `CORREO_DE` | Llave y remitente para el modo `enviar` | — |

Antes de poner `CORREO_MODO=enviar` en producción: los cupos del SQL 24 ya
frenan el abuso de invitaciones (30 sueltas por hora por persona, 400 por
hora y 1,000 al día sumando lotes, 800 al día por antro, 20 al día en antros
sin verificar).

## Candidatos a adelantar (decisión de Diego)

Q2, Q3 (con Q8), Q4, Q5 y Q7 cierran huecos que **existen hoy en
producción**. Los cinco se aplican solos sobre el esquema de producción
(probado en dev, en una transacción que se deshizo). Pero «se aplica» no es
«funciona». Antes de adelantar cualquiera, falta:

- Probar su comportamiento sobre el esquema de producción. Las pruebas de hoy corrieron con todo el pase 2 aplicado.
- Su bloque listo para pegar, con rollback.

## Pruebas en dev del pase 2 (25/11, con todo integrado)

```bash
node scripts/dev/ensayo-pase2.mjs completo --comparar-prod   # 38 pasos, idéntico; base = producción
node scripts/dev/simular-privilegios-prod.mjs                # 0 abiertos sin probar
node scripts/dev/probar-caja.mjs                             # 168/168
node scripts/dev/probar-caja-concurrencia.mjs                # 29/29
node scripts/dev/probar-caja-politicas-rapidas.mjs           # 28/28 (o --aplicado: 9/9)
PLAYWRIGHT_DESDE=<carpeta> node scripts/dev/e2e/correr.mjs --base=http://localhost:3031   # 57/57, 9/9 flujos
```

Cada carril tiene sus propias pruebas; los resultados están en
`docs/post-junta-2/<carril>.md`.
