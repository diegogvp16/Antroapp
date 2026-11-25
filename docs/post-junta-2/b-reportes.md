# Carril b-reportes — etapa 1: B11 «Cierre de la noche»

Rama `b-reportes` (worktree `AntroApp-wt/b-reportes`, desde `post-junta-2`).
Solo antroapp-dev; **nada en producción**. 24/11/2026.

> **Sin commits.** El trabajo quedó en el working tree, sin commit. El
> sistema de permisos rechazó el `git commit` porque CLAUDE.md dice «Nada
> de git commit, git push ni deploy sin que Diego lo pida explícitamente».
> Para subirlo: revisar el diff y hacer el commit (mensaje propuesto al final).

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
8. **Admin.** `dev_admin@example.com` → abre
   `/grupo/noche?club=0de70000-0000-4000-8000-000000000001&fecha=2026-11-25`.
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

## Commit propuesto (no hecho)

```
Cierre de la noche (B11): función reporte_cierre_noche, pantalla /grupo/noche con CSV e impresión, enlaces desde /grupo y el cuadre, y pruebas

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```
