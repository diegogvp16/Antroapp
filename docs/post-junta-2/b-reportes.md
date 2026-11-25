# Carril b-reportes

Rama `b-reportes` (worktree `AntroApp-wt/b-reportes`, desde `post-junta-2`).
Solo antroapp-dev; **nada en producción**.

- **Etapa 1 (24/11/2026): B11 «Cierre de la noche»**, abajo.
- **Etapa 2 (25/11/2026): B4 exportables CSV**, en la sección
  [«Etapa 2: B4»](#etapa-2-b4--exportables-csv-de-reservas-consumo-y-comisiones).
- **Etapa 3 (25/11/2026): B8 panel de salud del admin** (`/admin/salud`), en
  la sección «Etapa 3: B8».
- **Etapa 4 (25/11/2026): correcciones de la revisión del carril** (7
  defectos: 6 corregidos y 1 que no se puede corregir desde aquí), en la
  sección «Etapa 4», al final.

**SQL del carril, en orden** (cada uno con su rollback):

1. `sql/post-junta-2/30-cierre-noche.sql` → `30-cierre-noche-rollback.sql`
2. `sql/post-junta-2/31-exportes.sql` → `31-exportes-rollback.sql`
3. `sql/post-junta-2/32-salud.sql` → `32-salud-rollback.sql`

Los tres son independientes entre sí. El 31 no llama al 30 (sus pruebas
comparan contra el 30) y el 32 no usa ninguno de los dos. Los rollbacks van
en orden inverso: 32, 31 y 30. Dev queda **con los tres aplicados**.

> **Commits.** Los subagentes no pueden hacer `git commit` (lo bloquea el
> sistema de permisos); el coordinador hizo el commit de la etapa 1 y del
> avance parcial de B4 (`70e04a6`). Todo lo demás está **solo en el
> working tree**: el final de la etapa 2, la etapa 3 (B8) completa y la etapa
> 4. El coordinador tiene que integrarlo desde el working tree, no solo
> desde `HEAD`; si no, el `31` con commit no es el que está aplicado en dev
> (ver la etapa 4, defecto 7).

# Etapa 1: B11 «Cierre de la noche»

## Qué se hizo

Una vista **«Cierre de la noche»** por antro y noche operativa, calculada en
**una sola función SQL de lectura** con la autorización en la base.

| Pieza | Archivo |
|---|---|
| Función SQL | `sql/post-junta-2/30-cierre-noche.sql` (+ `30-cierre-noche-rollback.sql`) |
| Dominio (normalizar, CSV, etiquetas) | `lib/domain/cierre-noche.ts` |
| Reporte (presentación) | `components/reportes/cierre-noche.tsx` |
| Pantalla | `app/grupo/noche/page.tsx` → `/grupo/noche?club=<uuid>&fecha=AAAA-MM-DD` |
| Enlace desde /grupo | `components/grupo/cifras.tsx` (tarjeta de cada antro: «Cierre de la noche →») |
| Enlace desde el cuadre de la caja | `components/caja/cuadre-noche.tsx` (prop `enlaceCierre`) y `app/staff/caja/page.tsx` (solo si es gerente) |
| Vista imprimible | `app/globals.css` (`@media print` sobre `.reporte-imprimible`: papel blanco aunque el tema sea oscuro) |
| Pruebas | `scripts/dev/probar-cierre-noche.mjs`, `probar-cierre-noche-dominio.mjs`, `probar-cierre-noche-pantalla.mjs`; sección 7 nueva en `scripts/verificar-cuadre.mjs` |

### `reporte_cierre_noche(p_club_id uuid, p_fecha date) returns jsonb`

`stable security definer`, `set search_path = ''`, `revoke all from public, anon`,
`grant execute to authenticated, service_role`. Devuelve:

- **noche**: estado de la caja (`abierta | cerrada | sin_caja`), quién la abrió
  y la cerró, y cuándo; `momento` (`pasada | en_curso | futura`) y `termino`
  (la noche ya terminó: su fecha es anterior a la noche en curso del antro o
  el gerente la cerró).
- **reservas**: total, personas, entraron, en puerta, consumieron, entraron
  sin consumo, no llegaron (solo si terminó), por llegar (si no ha terminado);
  y **por origen** (orgánica / RP), con las mismas cifras.
- **consumo**: total en caja sin anulados, con y sin reserva, cuentas con
  consumo, **ticket promedio por cuenta** (misma definición que /grupo).
- **walk_ins**: cuentas sin reserva, personas, con consumo y su consumo.
- **cobros**: efectivo, tarjeta, otro (sin anulados), total y por cobrar.
- **cuadre**: la fila de `caja_cuadres` tipo `noche` (contado por método,
  diferencia, notas, quién y cuándo) o `null` si la noche no se ha cerrado.
- **anulaciones**: consumos y cobros anulados (número y $), mesas reabiertas.
- **mesas**: mesas del antro, mesas usadas, grupos (sesiones) por estado y
  mesas con más de un grupo.
- **comisiones**: comisiones de RP sin anuladas (y cuántas en $0 por la
  cuota), pagos por día, total y cuentas de RP aún sin cuadrar.
- **rps**: `grupo_rendimiento_rp(club, fecha, fecha)` (la misma función de
  /grupo), solo los RPs con reservas o pagos esa noche.

Noche operativa = `fecha_operacion` del antro (corte 08:00 en **su** zona
horaria, `club_fecha_operacion`). Sin datos personales de clientes: ni
nombres, ni teléfonos, ni QR (probado).

**Acceso** (con `coalesce(…, false)`, igual que `grupo_rendimiento_rp`):
admin, dueño del antro, dueño de su grupo y gerente **activo**. Rechazados con
P0001: staff, RP, cliente, cuenta sin perfil, gerente dado de baja, gerente
con contraseña temporal, dueño/gerente de otro antro; el anónimo ni siquiera
tiene `execute`. El **staff no ve el reporte** (trae comisiones); en la caja,
el enlace solo aparece para el gerente.

### Pantalla `/grupo/noche`

Mismo candado de rol que /grupo (dueño, gerente, admin; el resto ve «El
cierre de la noche es para gerentes y dueños»). Selector de antro (los que
devuelve `grupo_resumen`, si son varios), noche con ← / → y campo de fecha,
«Actualizar», **«CSV»** y **«Imprimir»** (`window.print()`; en impresión se
ocultan los controles y todo queda en blanco y negro). Noche por defecto: la
de la URL o la noche en curso del antro (`club_fecha_operacion`). Si la
noche en curso aún no tiene caja, ofrece «Ver la noche anterior». Estados de
cargando, error (con «Reintentar», errores vía `mensajeParaUsuario`) y vacío.
Avisos: «Cifras parciales: la noche sigue», «nadie la cerró en caja», «N
cuentas de RP siguen sin cuadrar: su comisión todavía no nace».

**CSV** (UTF-8 con BOM, CRLF): bloque «Sección, Concepto, Valor» con todo el
resumen (montos en pesos con 2 decimales; los negativos sin apóstrofo) y
luego la tabla de RPs. Un nombre que empiece con `=` no se ejecuta como fórmula.
Las horas («Abierta en», «Cerrada en», «Hecho en» del cuadre) salen en la
hora del antro, en formato «AAAA-MM-DD HH:MM» (etapa 4).

Mientras carga otra noche, el reporte anterior sigue en pantalla atenuado
con el aviso «Cargando la noche del …. Abajo sigue la del …»; CSV e
Imprimir quedan deshabilitados hasta que llega la noche elegida (etapa 4).

## SQL en orden (con rollback)

1. `sql/post-junta-2/30-cierre-noche.sql` — requiere el pase 1 y
   `grupo_rendimiento_rp` con la autorización sin NULL (`sql/post-junta/10a`).
   Puede ir antes o después del código: sin la función, la pantalla dice «El
   cierre de la noche todavía no está disponible» y nada más se rompe.
   Rollback: `sql/post-junta-2/30-cierre-noche-rollback.sql` (solo `drop
   function`; no hay datos que perder).

En dev: aplicado → probado → rollback (la función desaparece, sin grants
sueltos; verificar-cuadre sigue sin diferencias) → aplicado otra vez. **Dev
queda CON el 30 aplicado.** Catálogo después: `prosecdef = true`,
`search_path=""`, EXECUTE solo para `authenticated`, `service_role` (y el
dueño `postgres`).

## Pruebas automáticas (resultados reales, 24/11/2026, contra dev)

| Prueba | Resultado |
|---|---|
| `node scripts/dev/probar-cierre-noche.mjs` | **287/287** (corrido 4 veces; limpieza en 0 cada vez) |
| `node scripts/dev/probar-cierre-noche-dominio.mjs` | **24/24** |
| `PLAYWRIGHT_DESDE=… node scripts/dev/probar-cierre-noche-pantalla.mjs http://localhost:3023` | **51/51** |
| `node scripts/verificar-cuadre.mjs` (con la sección 7 nueva) | 1,183 revisiones, 12 noches, `cierres: 12`, **sin diferencias** |
| `node scripts/verificar-cuadre.mjs --club=<Club Demo Dev> --desde=2026-11-25 --hasta=2026-11-25` | 164 revisiones, sin diferencias |
| Regresión: `recorrido-roles.mjs` (contra 3023) | 35/35 |
| Regresión: `probar-dashboards.mjs` | 28/28 |
| Regresión: `probar-autorizacion-nulos.mjs` | 32/32 |
| `npx tsc --noEmit`, `npx eslint <archivos tocados>` | limpios |
| `NEXT_DIST_DIR=.next-build npx next build` (variables de .env.dev) | compila; `/grupo/noche` 9.7 kB; `tsconfig.json` sin cambios |

Qué cubre `probar-cierre-noche.mjs`:
- Escenario propio `t_rep_<6>` (dos antros, México y Tijuana, grupo, una
  persona por rol): una noche completa en caja con 3 grupos (2 en la mesa 1,
  uno reabierto), 2 walk-ins, un consumo y un cobro anulados, una reserva que
  no llega y una que entra sin consumir, cuadre con faltante de $50 y cierre.
  El reporte se compara cifra por cifra con lo esperado **antes de abrir la
  caja, con la noche abierta y ya cerrada**, contra `grupo_resumen(f, f)`,
  `grupo_rendimiento_rp` y la fila de `caja_cuadres`, además de identidades
  internas (entraron + no llegaron + por llegar = reservas, con + sin reserva
  = consumo, cobrado + por cobrar = consumo, suma de RPs = total…).
- Acceso: 4 aceptados, 9 rechazados, dueño de grupo fuera de su grupo,
  gerente de Tijuana con su noche en su zona, fecha fuera de rango, nula y
  antro inexistente.
- **Club Demo Dev, solo lectura** (transacción READ ONLY): para las 4 noches
  de caja (19, 20, 21 y 25/11), el reporte = caja, cuadres, /grupo y
  rendimiento por RP al centavo, y ningún teléfono, nombre de cliente ni QR
  de esa noche aparece en el JSON.

**Noche demo del 25/11 de Club Demo Dev** (coincide con verificar-cuadre y
con /grupo): 40 reservas (4 orgánicas, 36 de RP), 27 entraron, 24
consumieron, 13 por llegar; consumo $161,550 ($160,700 con reserva, $850 de
1 walk-in); ticket por cuenta $6,462 (25 cuentas); cobrado $119,425
(efectivo $47,770, tarjeta $71,655), $42,125 por cobrar; 1 consumo anulado
($950); 8 de 12 mesas, 11 grupos (5 cuadrados); comisiones $1,550 (13, 4 en
$0 por la cuota; 12 cuentas de RP sin cuadrar). Sin cuadre general: la noche
sigue abierta en la demo.

Capturas (390×844 y 360×740, revisadas a ojo) en `screenshots-b-reportes/`
(ignorada por Git): gerente 25/11 a 390 y 360, impresión, noche cerrada
21/11, dueño, admin, staff sin acceso, enlace en /grupo y en el cuadre de la
caja. A 360 px la tabla por origen desbordaba: se arregló con guiones suaves
en los encabezados (la prueba lo revisa).

## Pasos de prueba manual (clic a clic)

Servidor local contra dev. Usuarios `dev_<rol>@example.com`, contraseña en
`backups/dev-credenciales.json` (campo `password`).

1. **Gerente desde /grupo.** Entra como `dev_gerente@example.com` en
   `/cliente/login` → en `/staff/panel` abre el resumen del antro (/grupo) →
   en la tarjeta de «Club Demo Dev», toca «Cierre de la noche →».
2. En «Noche», escribe 25/11/2026 (o usa ← / →). Debe decir «Abierta (noche
   en curso)», «Cifras parciales», consumo **$161,550**, cobrado **$119,425**,
   13 por llegar y los 5 RPs (Mariana Ruiz $53,250 arriba).
3. Toca **CSV**: baja `cierre-club-demo-dev-2026-11-25.csv`; ábrelo en Excel
   o Sheets: acentos bien, «Consumo,Total en caja,161550.00» y una fila por RP.
   «Abierta en (hora del antro)» dice `2026-11-25 21:30` o similar (hora de
   Guadalajara), nunca algo con «T» y «+00:00».
4. Toca **Imprimir**: la vista previa sale en blanco y negro, sin botones.
5. Cambia a **21/11/2026**: «Cerrada en caja», quién la cerró, columna
   «Contado» llena, «Diferencia del cuadre: Cuadra», «No llegaron» en vez de
   «Por llegar».
6. **Gerente desde la caja.** `/staff/panel` → «Caja» → «Cuadre de la noche»
   → «Ver el reporte de la noche (en curso)» (o «Ver el cierre de la noche»
   si ya se cerró) → «← Volver» regresa a la caja.
7. **Dueño.** `dev_dueno@example.com` → /grupo → «Cierre de la noche →» en
   cualquiera de sus antros; con el selector «Antro» cambia a Club Demo Dev
   Tijuana (lo ve por ser dueña del grupo).
8. **Admin.** `dev_admin@example.com` → en `/admin` pulsa **«Cierre de la
   noche»** → elige Club Demo Dev en «Antro» y la noche 25/11/2026.
9. **Staff y RP no.** `dev_staff@example.com` → abre la misma URL: «El cierre
   de la noche es para gerentes y dueños». En su caja no aparece el enlace.
   `demo_mariana@example.com` (RP) → mismo aviso.

## Decisiones pendientes para Diego

1. **¿El staff ve una versión sin dinero de RPs?** Hoy no ve nada del
   reporte. Se podría dar al staff un cierre sin comisiones ni rendimiento
   por RP (estado, asistencia, consumo, cobros, cuadre).
2. **Ticket promedio**: por **cuenta** (como /grupo, incluye walk-ins). El
   del RP es por reserva que consumió. ¿Se quiere también por persona?
3. **«Asistencia» por reserva, no por persona.** Las personas se muestran
   (205 personas en 40 reservas) pero entraron/no llegaron cuentan reservas.
4. **Noche por defecto**: la noche en curso del antro. Al mediodía eso es la
   noche que todavía no empieza: la pantalla ofrece «Ver la noche anterior».
   ¿Preferirías que de 08:00 a 20:00 abra la noche anterior directamente?
5. **Propinas (fase 2)** no entran en el reporte (cobros = `monto_centavos`).
   Si se enciende la fase 2, ¿se agregan como renglón aparte (un 30b)?
6. El reporte no distingue «sin cobrar» por mesa ni lista anulaciones una por
   una (eso vive en «Equipo y actividad»). ¿Hace falta el detalle aquí?

## Riesgos y notas

- **Depende de `grupo_rendimiento_rp`**: si su firma o columnas cambian, el
  reporte falla (a propósito: misma definición que /grupo). Su rollback debe
  ir antes del de grupo-conversión.
- **Comisiones parciales con la noche abierta**: nacen al cuadrar cada mesa;
  la pantalla lo dice y muestra cuántas cuentas de RP faltan.
- **Datos demo del futuro**: la noche del 25/11 está «abierta» aunque su
  fecha es posterior a la noche en curso; el reporte la marca como «futura»
  y muestra «Abierta (noche en curso)». Es un efecto de la demo.
- **Turbopack no arranca en este worktree** (`node_modules` es un enlace que
  apunta fuera de la raíz: «Symlink node_modules is invalid»). Para las
  pantallas se levantó `next dev` **sin** `--turbopack` en el puerto 3023 con
  las mismas variables de `.env.dev` (lanzador en el scratchpad, no en el
  repo). `scripts/dev/servidor-dev.mjs` no se tocó.
- `scripts/verificar-cuadre.mjs` es compartido: se le agregó solo la sección
  7 (se salta si la función no existe) y que use primero `dev_admin` como
  admin (antes tomaba el primer admin, que podía ser uno temporal de otra
  prueba y borrarse a media revisión: pasó una vez en esta sesión).
- La primera vez que se compara con /grupo en una base compartida puede
  aparecer un antro de otra prueba que se borra a media revisión: la sección
  7 lo salta con un savepoint.

## Commit propuesto de la etapa 1 (ya lo integró el coordinador en `70e04a6`)

```
Cierre de la noche (B11): función reporte_cierre_noche, pantalla /grupo/noche con CSV e impresión, enlaces desde /grupo y el cuadre, y pruebas

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

# Etapa 2: B4 — Exportables CSV de reservas, consumo y comisiones

25/11/2026. El trabajo empezó la noche del 24 y se cortó por el límite de uso; el
coordinador hizo commit del avance (`70e04a6`, «PARCIAL»). Esta mañana se
revisó todo contra la base y el código, se corrigió y se probó.

## Qué se hizo

| Pieza | Archivo |
|---|---|
| Funciones SQL de lectura | `sql/post-junta-2/31-exportes.sql` (+ `31-exportes-rollback.sql`) |
| Dominio (normalizar, paginar, CSV, nombres de archivo) | `lib/domain/exportes.ts` |
| Pantalla (una sola, montada en tres rutas) | `components/reportes/exportar.tsx` |
| Rutas | `/dueno/exportar`, `/staff/exportar` (solo gerente), `/grupo/exportar` (dueño, gerente, admin) |
| Enlaces | `/dueno/panel` «Descargar reportes (CSV)», `/staff/panel` «Descargar reportes» (solo gerente), `/grupo` «Descargar CSV» |
| Descarga en el navegador | `lib/descargar-archivo.ts` |
| Pruebas | `scripts/dev/probar-exportes.mjs` (base), `scripts/dev/probar-exportes-pantalla.mjs` (Playwright) |

### Funciones (`31-exportes.sql`)

Públicas (EXECUTE para `authenticated` y `service_role`; nada para `anon` ni
`public`), todas `stable security definer`, `set search_path = ''`:

- `reporte_exportes_info(club) → jsonb`: nivel de acceso, qué teléfono verá
  (`completo | enmascarado | sin_telefono`), nombre y zona del antro, su
  noche en curso, `max_dias` 93 y `limite_pagina` 1000.
- `reporte_reservas(club, desde, hasta, despues, limite)`: una fila por
  reserva (folio = 8 primeros caracteres del id, noche, creada en hora del antro,
  cliente, teléfono según nivel, personas, origen, RP, estado, entrada, llegó
  tarde, mesa, consumo de su cuenta sin anulados).
- `reporte_consumos(…)`: una fila por renglón de caja **con los anulados
  marcados** (noche, hora, mesa, número de grupo de la mesa en la noche,
  cuenta, con/sin reserva, folio, RP, concepto, monto, anulado, motivo, quién
  lo registró y quién lo anuló).
- `reporte_comisiones(…)`: comisiones de RP por reserva y pagos por día, con
  estado (las anuladas marcadas), consumo base de la cuenta, día de
  asistencia de la semana, fecha de pago. El bono de plataforma no entra.

Internas (sin EXECUTE para `authenticated`): `reporte_nivel_exportes`,
`reporte_exportes_autorizar`, `reporte_telefono`.

**Autorización en la base**, con `coalesce(…, false)` en cada condición y
`current_role_name()` (que ya descarta dados de baja y contraseña temporal):

| Quién | Nivel | Teléfono del cliente |
|---|---|---|
| Dueño del antro | `completo` | completo |
| Gerente **activo** del antro | `completo` | completo |
| Admin | `admin` | solo los últimos 4 (`***1234`) |
| Dueño de grupo (antro de su grupo que no es suyo) | `grupo` | ninguno (la columna no sale en el CSV) |
| Staff, RP, cliente, cuenta sin perfil, dado de baja, contraseña temporal, dueño o gerente de otro antro | — | rechazado con P0001 |
| Anónimo | — | sin EXECUTE |

El teléfono se recorta **dentro de la base**: el completo nunca viaja a quien
no le toca. Ningún exporte trae QR, `cliente_id`, correos ni ids completos de
clientes (solo el folio de 8 caracteres). Los nombres de clientes sí salen
para los tres niveles (decisión pendiente abajo).

**Rango**: una noche o varias, máximo 93 días de diferencia entre inicio y
fin (el mismo límite y la misma cuenta que `grupo_resumen`), entre 2020 y la
noche en curso del antro + 92. Noche = `reservations.fecha` (reservas y
comisiones), `caja_noches.fecha_operacion` (consumo) y `rp_pagos_dia.fecha`.
Horas como «AAAA-MM-DD HH:MM» en la **zona del antro** (`clubs.zona_horaria`).

**Paginación por llave** (la API corta en 1000): cada fila trae `orden`
(`noche|hora UTC con microsegundos|id`, único y estable). La pantalla pide
páginas de 1000 con `p_despues` = el `orden` de la última fila hasta que llega
una incompleta. No usa OFFSET: nada se repite ni se salta aunque entren
renglones a media descarga. `p_limite` se recorta a 1–1000. Un cursor mal
formado (o con fecha imposible) da «Página inválida: vuelve a empezar la
descarga». La pantalla para si una página no avanza o pasa de 300 páginas.

**Sumas** (mismas definiciones que `/grupo` y el cierre, probadas al centavo):
consumo sin anulados = `grupo_resumen.consumo_centavos` = suma de
`reporte_cierre_noche.consumo.total_centavos`; comisiones y pagos no anulados
= `grupo_resumen.comisiones_centavos` = `cierre.comisiones.total_centavos`;
estado «consumió» = `reservas_con_consumo` / `cierre.reservas.consumieron`.

### Pantalla «Descargar reportes»

Selector de antro (si hay varios: los de `grupo_resumen`), «Una noche» (con
← / → y fecha; por defecto la noche en curso del antro) o «Varias noches»
(Esta semana, Semana anterior, Este mes, Personalizado), y cuatro tarjetas:
**Reservas**, **Consumo en caja**, **Comisiones y pagos a RPs** y
**Rendimiento por RP** (este último sale de `grupo_rendimiento_rp`, el mismo
de /grupo: el agregado por RP). Cada una dice qué trae, descarga con
progreso («N renglones hasta ahora...») y al terminar muestra renglones,
suma y anulados (para cotejar con /grupo o el cierre). Estados: cargando,
revisando acceso, sin antros, vacío («No hay renglones en ese periodo; no se
descargó nada»), error con «Reintentar» (mensajes de la base P0001 tal cual;
el resto por `mensajeParaUsuario`) y «todavía no está disponible» si el SQL
no está aplicado (PGRST202). Staff, RP y cliente ven «Descargar reportes es
para gerentes y dueños» con enlace a su panel.

**CSV**: UTF-8 **con BOM**, separador **coma**, fin de línea CRLF (Excel en
español de México y Google Sheets lo abren con acentos bien), montos en pesos
con 2 decimales y punto, sin símbolo; textos protegidos contra fórmulas
(`=`, `+`, `-`, `@` llevan apóstrofo) y comillas escapadas; el folio va como
`#1A2B3C4D` para que Excel no lo convierta en número (un folio «12345678»
perdía ceros y «1234e567» se volvía notación científica). Archivos:
`reservas-<antro>-<noche>.csv` o `consumo-<antro>-<desde>_<hasta>.csv`.

## Cambios de esta mañana sobre el avance parcial

- **SQL**: un cursor con fecha imposible («2026-13-45|…») pasaba el patrón y
  fallaba con un error 22008 genérico; ahora da el aviso P0001. El tope de
  fechas ya no puede quedar en NULL si `club_fecha_operacion` regresara NULL.
- **CSV**: folio con `#` en los tres archivos (ver arriba).
- **Prueba de la base** (`probar-exportes.mjs`): tres expectativas estaban
  mal escritas: contaba 6 consumos de hoy cuando el escenario registra 5; la
  revisión de «sin teléfono» buscaba 10 dígitos también dentro de `orden`,
  que es la llave de paginación con la hora; y la comparación con el cierre
  de Club Demo Dev comparaba una fecha `Date` contra texto. La revisión de
  «cuentas con consumo = /grupo» era una tautología: ahora compara de verdad.
  Se agregaron: cursor con fecha imposible y folio con `#`.
- **Prueba de pantalla nueva** (`probar-exportes-pantalla.mjs`).

## SQL en orden (con rollback)

`sql/post-junta-2/31-exportes.sql` — requiere el pase 1 (caja por mesa,
nómina y /grupo: `club_es_dueno`, `club_es_dueno_grupo`,
`club_fecha_operacion`, `clubs.zona_horaria`, `commissions.pagada_en` y
`motivo_anulacion`). No usa columnas de la fase 2 ni `regla_id`. Puede ir
antes o después del código: sin las funciones, la pantalla dice «todavía no
están disponibles». Rollback: `31-exportes-rollback.sql` (solo `drop
function`; no hay datos).

En dev (25/11): aplicado → pruebas → **rollback** (las 7 funciones
desaparecen, sin permisos sueltos) → **aplicado otra vez**. Catálogo final:
`prosecdef = true` en todas salvo `reporte_telefono` (que es `immutable` sin
definer y solo la llaman las otras), todas con `search_path=""`; EXECUTE de
las 4 públicas: `authenticated` y `service_role` (y el dueño, `postgres`); de las 3
internas: solo `service_role` y `postgres`. **Dev queda CON el 31 aplicado.**

## Pruebas automáticas (resultados reales, 25/11/2026, contra dev)

| Prueba | Resultado |
|---|---|
| `node scripts/dev/probar-exportes.mjs` | **196/196** (limpieza sin restos). La primera corrida de la mañana dio 187/194 por las expectativas mal escritas de arriba; otra se cayó por «Request rate limit reached» de Supabase Auth (base compartida) y se repitió. |
| `PLAYWRIGHT_DESDE=… node scripts/dev/probar-exportes-pantalla.mjs http://localhost:3023` | **48/48** |
| Regresión: `recorrido-roles.mjs` (contra 3023) | 35/35 |
| Regresión: `probar-cierre-noche-dominio.mjs` | 24/24 |
| `npx tsc --noEmit`, `npx eslint <archivos tocados>` | limpios |
| `NEXT_DIST_DIR=.next-build npx next build` (variables de .env.dev) | compila; `/dueno/exportar`, `/staff/exportar`, `/grupo/exportar` estáticas; `tsconfig.json` sin cambios |

Qué cubre `probar-exportes.mjs` (escenario propio `t_rep_<6>`, que se borra en
`finally`):
- Dos antros (México y Tijuana), un grupo y una persona por rol. La noche de
  ayer se carga en bloque: **1,045 reservas, 1,070 renglones de caja (10
  anulados), 1,040 comisiones (5 anuladas) y un pago por día**, para pasar de
  1000. La noche de hoy va por el camino real de la caja (puerta, mesa, 4
  cuentas con un walk-in, consumo con fórmula en el concepto, anulación,
  cobro, cierre y cuadre de la mesa).
- Acceso: info y las 3 descargas para dueño, gerente, admin y dueño de grupo
  (nivel y teléfono correctos); rechazo (P0001 y sin filas) para anónimo,
  cliente, RP, staff, dueño y gerente de otro antro, cuenta sin perfil,
  contraseña temporal y gerente dado de baja; dueño de grupo fuera de su
  grupo; las internas no se pueden llamar desde la API.
- Teléfonos: completo para dueño y gerente; `***0777` para el admin; nada para
  el dueño de grupo; ningún teléfono completo, QR ni id de cliente en los
  exportes del admin y del grupo.
- Los 4 perfiles reciben exactamente los mismos renglones; orden estricto, sin
  repetidos; páginas de 97 = páginas de 1000; `p_limite` 5000 → 1000.
- Sumas = `grupo_resumen` (reservas, consumieron, consumo, consumo con
  reserva, cuentas con consumo, comisiones) y = `reporte_cierre_noche`
  **noche por noche** (15 cifras por noche, 3 noches, para el gerente y para
  el dueño de grupo); conteos = conteo directo en la base.
- Rango de 93 días sí, 94 no; al revés, nulo, más de 3 meses al futuro,
  cursor inválido o con fecha imposible, antro inexistente: aviso P0001.
- Zona: una reserva de Tijuana creada a las 07:30 UTC sale «23:30» del día
  anterior; los consumos de México salen en hora de México.
- CSV con renglones reales: BOM, CRLF, columna de teléfono por nivel, fórmula
  neutralizada, comillas escapadas, montos en pesos, folio con `#`, nombre de
  archivo.
- **Club Demo Dev en solo lectura** (transacción READ ONLY como admin): del
  19 al 25/11, 127 reservas, 173 renglones de caja y 66 comisiones = /grupo,
  = conteo directo y = cierre de cada una de las 4 noches de caja.

Qué cubre `probar-exportes-pantalla.mjs` (solo lee; las cifras esperadas se leen
en una transacción READ ONLY con la sesión de cada usuario):
- **Gerente** (`dev_gerente`): llega desde su panel; noche 25/11 de Club Demo
  Dev: reservas, 40 renglones = base = cierre, teléfono completo, consumo de
  las reservas $160,700 = cierre, «Consumió» = cierre, folio `#XXXXXXXX`;
  consumo, 50 renglones, $161,550 sin anulados = cierre, 1 anulado = cierre;
  comisiones $1,550 = cierre; rendimiento, 5 RPs = cierre; la pantalla
  muestra esas sumas. «Este mes»: consumo, reservas y comisiones = /grupo.
  Personalizado de más de 93 días: aviso, y no se aplica. A 390 y 360 px: sin
  scroll horizontal, controles ≥ 40 px, sin errores de consola ni HTTP.
- **Dueño** (`dev_dueno`): llega desde su panel; Club Demo Dev con teléfono
  completo; Club Demo Dev Tijuana (de su grupo, no suyo): «sin teléfono» y el
  CSV sin columna de teléfono (24 reservas del mes).
- **Admin**: `/grupo/exportar`, columna «Teléfono (últimos 4)», ningún número
  de 10 dígitos, «← Volver» a /admin.
- **Staff**: su panel no tiene el enlace y `/staff/exportar` muestra el
  aviso. **RP** (`demo_mariana`) en `/dueno/exportar`: el aviso.

Capturas (390×844 y 360×740, revisadas a ojo) en `screenshots-b-reportes/`
(ignorada por Git): `exportar-gerente-25nov-390/360`, `exportar-gerente-mes-390`,
`exportar-gerente-personalizado-390`, `exportar-dueno-390`,
`exportar-dueno-grupo-tijuana-390`, `exportar-admin-390`,
`exportar-staff-sin-acceso-390`, `exportar-rp-sin-acceso-390`.

**No probado**: la pantalla con el SQL quitado (el mensaje «todavía no está
disponible» lo maneja el código con PGRST202, pero no se vio en pantalla); abrir los
archivos en Excel real (se revisó el texto del CSV: BOM, coma, CRLF); un
rango de 93 días con decenas de miles de renglones en un teléfono (en dev, cada página de
~1,000 renglones tardó 150–450 ms; 110,000 renglones serían ~110 páginas).

## Pasos de prueba manual (clic a clic)

Servidor local contra dev (`next dev` sin Turbopack en el worktree; ver
riesgos de la etapa 1). La contraseña está en `backups/dev-credenciales.json`.

1. **Gerente.** Entra en `/cliente/login` como `dev_gerente@example.com` →
   en `/staff/panel` toca **«Descargar reportes»**.
2. Deja «Una noche» y pon **25/11/2026**. Debe decir «Noche del mié 25 nov ·
   Hora de Ciudad de México», y en «Reservas», «con teléfono completo».
3. En **Reservas** toca «Descargar CSV»: baja
   `reservas-club-demo-dev-2026-11-25.csv` y la tarjeta dice «Listo: 40
   renglones · consumo de las reservas $160,700». Ábrelo en Excel: acentos
   bien, una columna por campo, «Teléfono» con 10 dígitos, folio `#…`.
4. **Consumo en caja** → «Listo: 50 renglones · consumo sin anulados
   $161,550 · 1 anulado». Compáralo con el «Cierre de la noche» de esa noche
   (consumo en caja: $161,550).
5. **Comisiones y pagos a RPs** → $1,550 (igual que el cierre).
   **Rendimiento por RP** → 5 renglones.
6. Cambia a **«Varias noches» → «Este mes»** y descarga «Consumo en caja»: el
   archivo se llama `consumo-club-demo-dev-2026-11-01_2026-11-30.csv` y la
   suma es la de /grupo con «Este mes».
7. «Personalizado» del 01/01/2026 al 25/11/2026 → «Consultar»: aviso de 93
   días.
8. **Dueño.** `dev_dueno@example.com` → `/dueno/panel` → **«Descargar
   reportes (CSV)»** → antro «Club Demo Dev»: teléfono completo. Cambia a
   «Club Demo Dev Tijuana»: la tarjeta dice «(sin teléfono)» y abajo, «Como
   dueño del grupo no ves teléfonos de clientes»; con «Este mes», el CSV de
   reservas no trae columna de teléfono.
9. **Admin.** `dev_admin@example.com` → en `/admin` pulsa **«Descargar
   reportes (CSV)»** (lleva a `/grupo/exportar`) → elige Club
   Demo Dev, noche 25/11 → Reservas: columna «Teléfono (últimos 4)» con
   `***1234`.
10. **Desde /grupo.** Con el gerente o el dueño, en `/grupo` toca «Descargar
    CSV» (junto a «Actualizar»).
11. **Staff y RP no.** `dev_staff@example.com`: en su panel no está
    «Descargar reportes»; abre `/staff/exportar` → «Descargar reportes es
    para gerentes y dueños». Lo mismo con `demo_mariana@example.com` en
    `/dueno/exportar`.

## Decisiones pendientes para Diego

1. **Teléfonos** (se decidió así; confírmalo): completo solo para el dueño y el
   gerente del antro; el admin ve los últimos 4; el dueño de grupo, ninguno.
   ¿El admin necesita el completo (soporte)? ¿El dueño de grupo debería ver
   el completo de sus antros?
2. **Nombres de clientes**: salen para los tres niveles (también para el admin y el dueño
   de grupo). ¿Se enmascaran («Juan P.») para el admin y el grupo?
3. **Staff**: no descarga nada (y el gerente dado de baja tampoco). ¿El staff
   necesita un exporte sin dinero (solo reservas y asistencia)?
4. **93 días**: es la diferencia entre fechas (como /grupo), o sea, hasta 94
   noches. ¿Se deja así o se cambia a «máximo 93 noches»?
5. **Bono de plataforma**: no entra en «Comisiones» (hoy no hay bono). Si
   vuelve, ¿va en un archivo aparte?
6. **Cobros (pagos de caja)**: no tienen exporte propio (B4 no lo pedía; el
   cierre de la noche sí los trae). ¿Hace falta un CSV de cobros por método?
7. **Propinas y productos (fase 2)**: no salen en el CSV de consumo.

## Riesgos y notas

- **Personalizado inválido**: si el rango tecleado pasa de 93 días, el
  selector muestra el aviso pero no aplica el rango; los botones siguen
  activos y descargarían el **rango anterior** (la etiqueta lo dice). Es el mismo
  comportamiento que en /grupo (`components/grupo/selector-rango.tsx`, que no se
  tocó para no chocar con otros carriles).
- **El número de grupo de la mesa** (`grupo`) se calcula por orden de
  apertura dentro de la noche; si una sesión se abriera con una hora anterior a
  otra ya existente, cambiaría la numeración (no pasa con la caja actual).
- **Teléfono en Excel**: un teléfono de 10 dígitos se ve como número (sin
  problema); uno con ceros al inicio («0000000123», solo en datos demo) los
  pierde al abrirse con doble clic en Excel. El folio ya está protegido.
- **Separador coma**: Excel en español de **México** usa coma; un Excel
  configurado como España usa punto y coma y mostraría todo en una columna
  (Google Sheets no tiene problema).
- `orden` (la llave de paginación) trae el id interno del renglón (reserva,
  consumo o comisión). No se escribe en el CSV; quien llama a la función ya
  tiene acceso a ese renglón.
- Rendimiento: con la noche demo (50 mesas) la descarga es instantánea;
  las páginas de ~1,000 renglones tardaron 150–450 ms en dev.

## Archivos tocados en la etapa 2 (además del commit `70e04a6`)

- `sql/post-junta-2/31-exportes.sql` (cursor con fecha imposible, tope sin NULL)
- `lib/domain/exportes.ts` (`folioCsv`)
- `scripts/dev/probar-exportes.mjs` (expectativas corregidas, pruebas nuevas)
- `scripts/dev/probar-exportes-pantalla.mjs` (nuevo)
- `docs/post-junta-2/b-reportes.md`

Commit propuesto:

```
B4 exportables CSV: cursor con fecha imposible con aviso, folio a prueba de Excel, pruebas de base (196/196) y de pantalla (48/48)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

# Etapa 3: B8 — Panel de salud del admin (`/admin/salud`)

25/11/2026. Solo en dev; producción no se tocó.

## Qué se hizo

### SQL `32-salud.sql` (con `32-salud-rollback.sql`)

Son dos funciones de **solo lectura y solo para el admin**:

- `stable security definer`, `search_path = ''`.
- Sin execute para public ni anon; sí para authenticated y service_role.
- La primera línea es `if not coalesce(public.current_role_name() = 'admin', false) then raise … P0001`.
  `current_role_name()` ya deja fuera la cuenta sin perfil, el perfil dado de baja y la contraseña temporal (`debe_cambiar`).

**`admin_salud() returns jsonb`**

- `login`: intentos de la última hora y de 24 h. Solo conteos: total, fallidos, correos distintos y conexiones distintas.
- `bloqueos`: cuántos recibirían un 429 de `/api/auth/login` en este momento. Usa la misma lógica y los mismos umbrales que `lib/domain/login.ts`, dentro de la ventana de 15 min:
  - par correo+IP con 5 fallos seguidos desde su último éxito;
  - correo con 30 fallos desde su último éxito, de cualquier IP;
  - IP con 20 fallos.

  Aparte cuenta cuántos estarían bloqueados con los límites del modo degradado (3 y 8). `login_intentos` no guarda si el intento fue degradado.
- `registro`:
  - registros de 1 h y de 24 h, con cuántos fueron en modo degradado y cuántos de cada tipo;
  - «conexiones al límite»: IPs cuya siguiente petición sería rechazada (5 por hora, o 2 si ya hubo alguna en modo degradado);
  - las 10 IPs con más registros en 24 h, **solo con los números**, sin la IP.
- `reservas_sin_cuenta`: sale de `reserva_intentos` (72) **solo si la tabla existe** (`to_regclass`); si no, sale `null`. Da 1 h, 24 h, IPs al límite (20 por hora) y teléfonos al límite (3 por antro y noche).
- `alertas`: la última alerta por correo de cada tipo (`alertas_enviadas`) y cuántas hubo en 7 días.
- `errores`: `app_errores` de 7 días agrupados por mensaje y ruta, con veces, veces en 24 h y la última.
  - Se calcula en la base, sin el tope de 500 filas de `ErroresRecientes`.
  - Devuelve hasta 40 grupos y corta el mensaje a 300 caracteres.
- `umbrales`: los números que usó, para que la prueba los compare con el TS.
- **Nunca** devuelve hashes (`email_hash`, `ip_hash`, `telefono_hash`). No tienen sal y se revierten probando correos o teléfonos conocidos. Tampoco devuelve `usuario_id`, navegador ni digest.

**`admin_salud_reglas() returns table(...)`**: un renglón por antro con:

- si está publicado y su modo de pago;
- la noche operativa de hoy y el lunes de esa semana;
- la regla vigente (`regla_comision_descripcion`: `origen` = `regla` o `anterior`) y la programada;
- RPs activos, RPs con regla propia, RPs con tarifa por día propia y número de tarifas por día. Las reglas y tarifas propias cuentan solo RPs activos de ese antro, igual que «activos» (etapa 4): «M con regla propia» nunca pasa de «N activos»;
- lo de la semana operativa, por la noche de la reserva y sin anuladas: comisiones de RP (número, cuántas en $0 y total en centavos) y pagos por día;
- contadores de inconsistencias;
- códigos de alerta fijos:
  - `legacy`: modo reserva sin regla nueva; sigue con `clubs.comision_*`.
  - `sin_regla`: además de `legacy`, esas columnas dan $0 o están vacías **y** hay RPs activos sin regla propia (o el antro no tiene RPs). Club Demo Dev tiene sus 6 RPs con regla propia, así que solo le sale `legacy`.
  - `dia_sin_tarifas`: modo día sin `club_dia_tarifas`.
  - `regla_id_inconsistente`: comisiones de las últimas 4 semanas sin `regla_id` cuando había regla vigente esa noche y el RP no tiene regla propia, o con un `regla_id` que no era la regla de ese antro esa noche.
  - `noche_sin_cerrar`: `caja_noches` abierta de una noche anterior a la de hoy.
  - `pendientes_viejas`: comisiones o pagos por día en `pendiente` de hace más de 28 días.

**Índices nuevos**: `login_intentos_creado` y `registro_intentos_creado`, por `creado_en desc`. Antes solo había índices por hash, y contar 1 h o 24 h recorría toda la tabla.

### Pantalla `/admin/salud`

- `app/admin/salud/page.tsx`:
  - Revisa sesión y rol igual que `/admin/mensualidad`; si no es admin, manda a `/admin/login`. La que autoriza es la base.
  - Tiene botón «Actualizar», la hora de la foto y «Reintentar» si hay error.
  - Los errores pasan por `mensajeParaUsuario`.
- `components/admin/salud/`:
  - `estado-servicio.tsx`: llama a `/api/salud` y muestra «Base en línea», «Base lenta» (más de 1 s) o «Base sin respuesta», con los ms y la versión.
  - `resumen-accesos.tsx`: inicios de sesión, bloqueos, registros, reservas sin cuenta y alertas.
  - `errores-agrupados.tsx`.
  - `reglas-comision-estado.tsx`: una tarjeta por antro, primero los que tienen alertas rojas.
- `lib/domain/salud.ts`: tipos y reglas puras:
  - `porcentajeFallo`;
  - `tonoFallo`: ámbar arriba de 30 % y rojo arriba de 60 %, desde 10 intentos;
  - `ALERTA_REGLA` (textos), `ordenarAntros` y `describirRegla`.
- `app/admin/page.tsx`: botón «Salud de la plataforma» junto al de mensualidades, que sigue detrás de su bandera.
- Colores solo con los tokens `--status-*` (insignias `ok/warn/err`). Botones de 40 px. Estados de cargando, vacío y error.
- «Errores recientes» sigue igual en `/admin`. La página de salud usa los grupos que calcula la base.

## SQL en orden (con rollback)

3. `sql/post-junta-2/32-salud.sql` → `sql/post-junta-2/32-salud-rollback.sql`. El rollback borra las 2 funciones y los 2 índices; no toca datos.

Lo que necesita antes:

- Del **pase 1**: `app_errores`, `login_intentos`, `caja_noches` y `club_fecha_operacion`.
- Del **pase 2**:
  - `registro_intentos` (post-junta/04);
  - `alertas_enviadas` (11);
  - de 07: `reglas_comision`, `commissions.regla_id`, `regla_comision_descripcion` y `lunes_de`.
- `reserva_intentos` (72) es opcional.

Ciclo hecho en dev: aplicado → pruebas → rollback (0 funciones, 0 índices) → aplicado otra vez (2 y 2) → pruebas otra vez en verde.

## Pruebas automáticas (resultados reales, 25/11/2026, contra dev)

### `node scripts/dev/probar-salud.mjs`: 78/78

Sin restos al limpiar: antros, perfiles, usuarios, intentos, errores y alertas de prueba quedaron en 0.

La primera corrida dio 71/77. Las fallas eran de la prueba (orden de llaves del jsonb y una fecha que llega como `Date`). Después agregué el antro E: está en «anterior» con $0, pero todos sus RPs tienen regla propia, así que solo debe salir `legacy`.

Qué cubre:

- **Acceso por claims** (como PostgREST, en una transacción que se deshace):
  - admin: sí, en las dos funciones;
  - dueño, gerente, staff, RP, cliente, cuenta sin perfil, admin con contraseña temporal y admin dado de baja: P0001 en las dos;
  - anónimo: 42501.
- **Acceso con sesión real**: admin sí en las dos; dueño y admin con contraseña temporal reciben P0001; anónimo rechazado.
- **Catálogo**: security definer, `search_path=""` y stable; anon y public sin execute; los 2 índices existen.
- **Umbrales**: iguales a los de `lib/domain/login.ts` y `lib/domain/captcha.ts`. Los de reservas, iguales a los del trigger `reservations_antiabuso_anon` (la prueba los lee de su definición).
- **Conteos exactos**: en **una** transacción `repeatable read` (misma foto y mismo `now()`) se leen las filas crudas y se llama `admin_salud()` con la sesión del admin.
  - Login de 1 h y de 24 h, registros, reservas sin cuenta y errores coinciden exactos.
  - Los bloqueos se **recalculan en JS con las mismas funciones** que usa `/api/auth/login` (`fallosDesdeUltimoExito`, `minutosDeBloqueo`) y también coinciden exactos.
- **Casos sintéticos**, todos con el resultado esperado:
  - par con 6 fallos: bloqueado;
  - correo con 31 fallos desde 31 IPs: bloqueado;
  - IP con 21 fallos: bloqueada;
  - par con un éxito al final: no bloqueado;
  - par con 3 fallos: bloqueado solo con el límite degradado;
  - fallos de hace 2 h: cuentan en 24 h y no en 1 h;
  - IPs de registro al límite normal y al degradado;
  - IP y teléfono de reservas al límite;
  - grupo de errores con 4 en 7 días y 3 en 24 h;
  - alerta con 1 envío en 7 días.
- **Nada personal**: ninguna cadena de 64 hex y ninguno de los hashes de prueba. Tampoco aparecen `usuario_id`, `navegador`, `digest`, `ip_hash`, `email_hash` ni `telefono_hash`, aunque los errores de prueba sí traían navegador, digest e ip_hash.
- **Reglas** (5 antros de prueba):
  - A (anterior, $0, sin RPs): `legacy` y `sin_regla`.
  - B (por día, sin tarifas): `dia_sin_tarifas`, con 1 pago por día de $300 en la semana.
  - C (regla nueva R1 de $150 vigente, R2 de 10 % programada para el lunes que viene, un RP con regla propia):
    - 4 comisiones en la semana (la anulada no cuenta), 1 en $0, $300 en total;
    - 2 inconsistentes: una sin `regla_id` y otra que apunta a la programada;
    - 1 noche sin cerrar (la de hoy no cuenta);
    - 1 pendiente vieja (40 días);
    - alertas exactas.
  - D (anterior, $100): solo `legacy`.
  - E: solo `legacy`.
  - Club Demo Dev aparece.
- Reglas puras: `describirRegla`, `porcentajeFallo` y `tonoFallo`.

### `PLAYWRIGHT_DESDE=… node scripts/dev/probar-salud-pantalla.mjs http://localhost:3023`: 21/21

Corre contra `next dev` sin Turbopack, con las llaves de dev.

La primera corrida dio 17/20. Las fallas eran de la prueba:

- contaba los `li` anidados de las alertas;
- tomaba como error el `role=alert` con que Next anuncia las rutas;
- la base compartida cambió de antros a media prueba; ahora compara contra la lectura de antes o la de después.

Qué revisa:

- el admin llega por el botón desde `/admin` y ve las 7 secciones;
- el servicio responde;
- hay tantas tarjetas como renglones de `admin_salud_reglas()`;
- el aviso «configuración anterior» sale en los antros `legacy`;
- las alertas de Club Demo Dev son las de la base;
- no hay ningún hash en la página;
- sin scroll horizontal y con controles de 40 px o más, a 390×844 y a 360×740;
- «Actualizar» funciona sin error, sin errores de consola ni HTTP;
- un dueño que abre `/admin/salud` termina en `/admin/login`.

Capturas, revisadas a ojo: `screenshots-b-reportes/salud-admin-390.png`, `salud-admin-390-arriba.png` y `salud-admin-360.png`. Al revisarlas corregí «1 fallido» y «1 activo».

### Verificación de código

`npx tsc --noEmit` y `npx eslint` de los archivos tocados: limpios. `NEXT_DIST_DIR=.next-build npx next build` con `.env.dev`: compila y `/admin/salud` está en el manifiesto. No tocó `tsconfig.json`.

## Pasos de prueba manual (clic a clic)

Usuario: `dev_admin@example.com` (contraseña en `backups/dev-credenciales.json`). Servidor local con llaves de dev.

1. Entra a `/admin/login` con el admin. En `/admin`, arriba, pulsa **«Salud de la plataforma»**. Mientras se revisa la sesión, sale «Cargando…» y no una página en blanco.
2. Revisa que salgan estas secciones:
   - «Servicio», con la insignia verde «Base en línea» y los ms;
   - «Inicios de sesión», con 4 cifras y el desglose de bloqueos;
   - «Registros de cuentas»;
   - «Reservas sin cuenta»;
   - «Errores de la app»;
   - «Reglas de pago de RPs».
3. Deja esa pestaña abierta y abre una ventana privada. En `/cliente/login`, intenta entrar 6 veces con `dev_cliente@example.com` y una contraseña mala; la 6.ª dice «Demasiados intentos».
4. Vuelve a la primera pestaña y pulsa **«Actualizar»**:
   - «Bloqueos ahora» sube a 1 o más;
   - «Correo + conexión» marca 1 o más;
   - suben los fallidos de la última hora.

   Para limpiar, espera 15 min o entra bien con ese correo.
5. En «Reglas de pago de RPs», busca **Club Demo Dev**. Debe decir:
   - «Por reserva»;
   - «$0 por reserva que consume · configuración anterior»;
   - «6 activos · 6 con regla propia»;
   - **solo** el aviso ámbar «Sin regla nueva…». No sale el rojo de $0 porque todos sus RPs tienen regla propia.
6. Entra con el **dueño** (`dev_dueno@example.com`). En `/dueno/panel`, en la configuración de RPs, pon una regla nueva (vale desde el lunes siguiente).
7. Vuelve como admin y pulsa «Actualizar»: Club Demo Dev muestra «Programada: … · desde <lunes>». Si no quieres dejarla, cámbiala de vuelta con el dueño.
8. Cierra sesión, entra como `dev_dueno@example.com` y escribe `/admin/salud` en la barra: te regresa a `/admin/login`.
9. En el teléfono (o DevTools a 360 px), revisa que nada se salga de la pantalla y que los botones se puedan tocar bien.

## Decisiones pendientes para Diego

1. **Cuándo se pinta en color el % de fallo**: hoy, ámbar arriba de 30 % y rojo arriba de 60 %, desde 10 intentos. Es una propuesta.
2. **`sin_regla` / `legacy`**: hoy todos los antros de dev salen `legacy` porque ninguno tiene regla nueva. ¿Dejamos ese aviso ámbar en todos hasta que cada antro configure su regla, o lo ocultamos y dejamos solo el rojo?
3. **Noche sin cerrar**: hoy cuenta cualquier noche abierta anterior a la noche operativa de hoy (corte 08:00). ¿Le damos un día de gracia?
4. **Pendientes viejas**: el corte es de 28 días por la noche de la reserva. Si la nómina todavía no se usa para marcar pagos, esto va a salir en muchos antros.
5. **Antros de prueba en la lista**: el admin también ve los antros «T …» que dejan en dev las pruebas de otros carriles; en producción no deberían existir. ¿Agregamos un filtro «solo publicados»?
6. **`/api/salud` público** (hallazgo informativo de la auditoría A1): sigue mostrando versión y entorno. No lo cambié porque lo usa el monitor.

## Riesgos y notas

- **Umbrales duplicados en SQL y TS**: la prueba los compara y falla si se cambian en un solo lado; así se quiere. El límite de reservas se lee del trigger con una regex: si alguien reescribe el trigger, la prueba puede fallar sin que el límite haya cambiado.
- **Bloqueos aproximados en dos bordes**:
  - `/api/auth/login` lee como máximo 50 intentos por correo y 100 por IP; la función cuenta todos.
  - El modo degradado no queda registrado; por eso sale aparte, como «estarían bloqueados si…».
- **Falsos positivos en `regla_id_inconsistente`**: se compara contra la regla propia del RP **de hoy**. Si a un RP le quitaron su regla propia después de cobrar, sus comisiones viejas salen como inconsistentes.
- **Rendimiento**: `admin_salud_reglas` hace subconsultas por antro. Con decenas de antros es inmediato; con cientos conviene medirla (las comisiones se buscan por `reservations(club_id, fecha)`).
- **`reserva_intentos` opcional**: si el 72 todavía no pasa a producción, ese bloque no aparece y no falla.
- **Mensajes de error**: salen tal como se guardaron en `app_errores`; la limpieza de datos personales es la de C8, al guardar. Un mensaje viejo, de antes de C8, se vería aquí igual que en «Errores recientes».

## Archivos tocados en la etapa 3

- `sql/post-junta-2/32-salud.sql`, `sql/post-junta-2/32-salud-rollback.sql` (nuevos)
- `lib/domain/salud.ts` (nuevo)
- `app/admin/salud/page.tsx` (nuevo)
- `components/admin/salud/estado-servicio.tsx`, `resumen-accesos.tsx`, `errores-agrupados.tsx`, `reglas-comision-estado.tsx` (nuevos)
- `app/admin/page.tsx` (botón)
- `scripts/dev/probar-salud.mjs`, `scripts/dev/probar-salud-pantalla.mjs` (nuevos)
- `docs/post-junta-2/b-reportes.md`

Commit propuesto:

```
B8 panel de salud del admin (/admin/salud): admin_salud y admin_salud_reglas solo admin, sin hashes; login, bloqueos, registros, reservas sin cuenta, errores agrupados y estado de reglas por antro (78/78 base, 21/21 pantalla)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

# Etapa 4: correcciones de la revisión del carril (25/11/2026)

El revisor encontró 7 defectos. Revisé cada uno contra el código y la base
de dev. Los 6 primeros eran reales y quedaron corregidos. El 7.º no se puede
corregir desde el carril. Todo está en el **working tree**, sin commit: el
sistema de permisos bloquea `git commit`.

## Defecto por defecto

1. **(medio) CSV del cierre con horas UTC crudas y sin la hora del cuadre.** Real.
   - `lib/domain/cierre-noche.ts` tiene una función nueva, `fechaHoraCsvEnZona(instante, zona)`. Da «AAAA-MM-DD HH:MM» en la zona del antro, el mismo formato que `to_char(... at time zone zona, 'YYYY-MM-DD HH24:MI')` de los exportes del 31.
   - En el CSV, los renglones ahora son «Noche, Abierta en (hora del antro)», «Noche, Cerrada en (hora del antro)» y uno nuevo, «Cuadre, Hecho en (hora del antro)». `hecho_en` ya venía de la base; solo faltaba escribirlo.
   - El caso del revisor queda cubierto en la prueba de dominio: `abierta_en = 2026-11-22T03:30Z` sale «2026-11-21 21:30» en CDMX. También se prueba Tijuana.
2. **(bajo) «En puerta» de una noche terminada.** Real. El CSV de reservas la marcaba `en_puerta` y el cierre la contaba en «No llegaron». Ahora va igual en los dos lados:
   - **31**: en `reporte_reservas`, la regla de noche terminada (`no_llego`) va **antes** que `en_puerta`. Corregí el comentario («como rp_mis_reservas» era falso).
   - **30**: en `reporte_cierre_noche`, `en_puerta` cuenta solo con la noche sin terminar (`and not v_termino`). Así siempre es parte de «Por llegar», que es como la pinta la pantalla («N en la puerta» bajo «Por llegar»). Antes, en una noche terminada, salía el detalle «N en la puerta» bajo un «Por llegar» en 0, y esas reservas también contaban en «No llegaron».
   - Resultado: CSV `no_llego` = cierre `no_llegaron`; CSV `en_puerta` = cierre `en_puerta`; CSV `en_puerta + por_llegar` = cierre `por_llegar`; los 5 estados suman el total.
3. **(bajo) Salud: `rps_con_regla_propia` contaba bajas y RPs de otro antro.** Real. En el 32, `rps_con_regla_propia` y `rps_con_tarifa_dia_propia` ahora cuentan `distinct rp_id`. Usan join a `profiles` con `p.club_id = antro`, `role = 'rp'` y `activo is not false`, el mismo criterio que `rps_activos`.
4. **(bajo) `/grupo/noche` podía imprimir la fecha nueva con las cifras de la noche anterior.** Real. Arreglo en `app/grupo/noche/page.tsx`:
   - El reporte es «vigente» solo si `reporte.fecha === fecha` y `reporte.club.id === clubId`.
   - CSV e Imprimir se deshabilitan si no es vigente o si está cargando.
   - Aparece el aviso (`role=status`) «Cargando la noche del X. Abajo sigue la del Y».
   - El cuerpo viejo queda atenuado y con `print:hidden`. Si alguien imprime con Ctrl+P en ese momento, la hoja sale sin cifras.
5. **(bajo) El admin no tenía entrada a los reportes.** Real. En `/admin`, junto a «Salud de la plataforma», agregué tres botones:
   - «Resumen por antro» (`/grupo`);
   - «Cierre de la noche» (`/grupo/noche`);
   - «Descargar reportes (CSV)» (`/grupo/exportar`).
6. **(bajo) `/admin/salud` en blanco mientras revisa la sesión.** Real. Ahora muestra «Cargando…» (`role=status`) dentro del mismo contenedor.
7. **(bajo) B8 y lo último de B4 sin commit.** Es cierto, pero no se corrige desde aquí: el permiso rechaza `git commit` (CLAUDE.md: nada de commit sin que Diego lo pida). **El coordinador tiene que integrar desde el working tree.** Archivos de la rama sin commit al terminar esta etapa:
   - modificados: `app/admin/page.tsx`, `app/grupo/noche/page.tsx`, `lib/domain/cierre-noche.ts`, `lib/domain/exportes.ts`, `sql/post-junta-2/30-cierre-noche.sql`, `sql/post-junta-2/31-exportes.sql`, `scripts/dev/probar-cierre-noche-dominio.mjs`, `scripts/dev/probar-cierre-noche-pantalla.mjs`, `scripts/dev/probar-exportes.mjs`, `docs/post-junta-2/b-reportes.md`;
   - nuevos: `app/admin/salud/`, `components/admin/salud/`, `lib/domain/salud.ts`, `sql/post-junta-2/32-salud.sql`, `sql/post-junta-2/32-salud-rollback.sql`, `scripts/dev/probar-salud.mjs`, `scripts/dev/probar-salud-pantalla.mjs`, `scripts/dev/probar-exportes-pantalla.mjs`.

   Dev tiene aplicados los 30, 31 y 32 **del working tree**. Lo comprobé leyendo `pg_proc`:
   - el filtro nuevo de `en_puerta` en `reporte_cierre_noche`;
   - el orden `no_llego` antes de `en_puerta` en `reporte_reservas`;
   - el join a `profiles` en `admin_salud_reglas`.

## SQL (sin archivos nuevos; cambian 30, 31 y 32)

Siguen siendo `create or replace` con los mismos rollbacks (no cambiaron).

1. En dev apliqué 30, 31 y 32 y corrí las pruebas.
2. Apliqué los rollbacks en orden 32 → 31 → 30.
3. Volví a aplicar 30 → 31 → 32. **Dev queda con los tres aplicados.**

**Regresión probada.** Apliqué en dev, a propósito, la lógica vieja del 30 y del 31: orden viejo del CASE y filtro viejo de `en_puerta`. `probar-exportes.mjs` dio **207/215**. Fallaron justo los casos nuevos:
- «no llegaron = cierre: 3 ≠ 5»;
- «en puerta es parte de por llegar: 2 > 0»;
- y los demás de ese grupo.

Después volví a aplicar los archivos corregidos.

## Pruebas automáticas (resultados reales, 25/11/2026, contra dev)

| Prueba | Resultado |
|---|---|
| `node scripts/dev/probar-cierre-noche-dominio.mjs` | **30/30** (antes 24; 6 nuevas de horas en zona) |
| `node scripts/dev/probar-cierre-noche.mjs` | **287/287**, limpieza en 0 |
| `node scripts/dev/probar-exportes.mjs` | **215/215**, limpieza en 0. Ahora 2 reservas de «ayer» se quedan «en puerta» con la noche cerrada; por noche se revisa «en puerta = cierre», «los estados suman el total» y «en puerta ⊂ por llegar» |
| `node scripts/dev/probar-salud.mjs` | **81/81**, limpieza en 0. En C hay un RP dado de baja y un RP de otro antro con regla propia y tarifa por día propia: no cuentan. Tampoco hay ningún antro de dev con «con regla propia» > «activos» |
| `PLAYWRIGHT_DESDE=… node scripts/dev/probar-cierre-noche-pantalla.mjs http://localhost:3023` | **57/57** (antes 51). Nuevas: la hora del CSV descargado está en la zona del antro y no trae ISO; al cambiar de noche (con la base retrasada 5 s), CSV e Imprimir se deshabilitan, sale el aviso y la vista de impresión oculta las cifras viejas; al llegar la noche se vuelven a habilitar. La 1.ª corrida dio 56/57: «staff: no ve el reporte (aviso)» falló por tiempo y en la 2.ª pasó. Ese caso no toca nada de esta etapa |
| `PLAYWRIGHT_DESDE=… node scripts/dev/probar-salud-pantalla.mjs http://localhost:3023` | **27/27** (antes 21). Nuevas: los 3 enlaces de `/admin` con su `href` y ≥ 40 px; «Cierre de la noche» abre el reporte; `/admin/salud` muestra «Cargando…» con la lectura del perfil retrasada |
| `PLAYWRIGHT_DESDE=… node scripts/dev/probar-exportes-pantalla.mjs http://localhost:3023` | **48/48** |
| `npx tsc --noEmit` | limpio |
| `npx eslint` de los archivos tocados | limpio |
| `NEXT_DIST_DIR=.next-build npx next build` con las variables de `.env.dev` | compila; `/admin/salud` y `/grupo/noche` en el manifiesto; `tsconfig.json` sin cambios |

**Servidor.** `servidor-dev.mjs` no arranca en worktrees. Usé `next dev -p 3023` sin Turbopack, con las variables de `.env.dev` cargadas por un lanzador en el scratchpad (se niega si la URL es de producción). Lo detuve al terminar.

**Capturas revisadas a ojo** (`screenshots-b-reportes/`, ignorada por git):
- `cierre-cambio-de-noche-cargando-390.png`: aviso, CSV e Imprimir apagados;
- `admin-enlaces-reportes-390.png` y `admin-enlaces-reportes-360.png`: los 4 botones se acomodan en renglones, 44 px, sin scroll horizontal.

## Pasos de prueba manual de esta etapa (clic a clic)

1. **Horas del CSV.** Entra como `dev_gerente@example.com` y abre `/grupo/noche`. Elige la noche **21/11/2026** y toca **CSV**. En Excel o Sheets:
   - «Noche, Abierta en (hora del antro)» y «Cerrada en» salen como `2026-11-21 21:30`, en hora de México;
   - hay un renglón «Cuadre, Hecho en (hora del antro)»;
   - ninguna celda trae «T…+00:00».
2. **Cambio de noche.** En la misma pantalla, en DevTools pon la red en «Slow 3G» y toca **←**:
   - aparece «Cargando la noche del …. Abajo sigue la del …»;
   - CSV e Imprimir quedan grises;
   - cuando llega la noche nueva, se vuelven a activar y el encabezado y las cifras coinciden.
3. **En puerta.** En dev no hay hoy reservas «en puerta» de noches pasadas. Esto se ve en `probar-exportes.mjs`. Para verlo a mano habría que dejar una reserva en la puerta y cerrar la noche; no lo hice en Club Demo Dev para no cambiar sus datos.
4. **Admin.** Entra como `dev_admin@example.com`. En `/admin` están «Salud de la plataforma», «Resumen por antro», «Cierre de la noche» y «Descargar reportes (CSV)»:
   - cada uno abre su pantalla;
   - «← Volver» del exportador regresa a `/admin`.
5. **Salud.** Con la red en «Slow 3G», pulsa «Salud de la plataforma»: primero sale «Cargando…».
   - En «Reglas de pago de RPs», Club Demo Dev sigue en «6 activos · 6 con regla propia». Hoy en dev no queda ningún override de RP dado de baja; el que vio el revisor («T rls A») ya lo borró su carril.

## Decisiones pendientes para Diego (nuevas)

1. **«En puerta» al cerrar la noche.** Ahora quien se quedó en la puerta de una noche terminada cuenta como «No llegó», en el CSV y en el cierre. Si prefieres verlas aparte («en puerta al cerrar»), hace falta un estado más en los dos reportes.
2. **«Volver» de `/grupo/noche` para el admin.** Lleva a `/grupo`, y `/grupo` lleva a `/admin`: son dos pasos. Si quieres que regrese directo a `/admin`, es un cambio chico.

## Riesgos y notas

- El cambio del 30 cambia un número que se ve: en noches terminadas, «En puerta» del cierre ahora es 0. Las otras cifras no cambian.
- La prueba de pantalla del staff falló una vez por tiempo de espera (la base de dev está compartida y el login a veces tarda). En la segunda corrida pasó.
