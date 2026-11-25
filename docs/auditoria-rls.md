# Auditoría de RLS (carril c-rls, 25/11/2026)

Auditoría con **sesiones reales** contra antroapp-dev de todas las tablas de
`public`, los dos buckets de Storage, las funciones que se llaman por RPC, los
candados (triggers) y las rutas de servidor que leen el rol con la service
role. Más un escaneo estático de **todas** las funciones del catálogo de dev
buscando autorizaciones que fallan abiertas con NULL.

- Script: `scripts/dev/auditoria-rls.mjs` (reutilizable; sale con 0 si todo
  lo esperado coincide con lo obtenido).
- SQL de arreglo: `sql/post-junta-2/60` a `68` (cada uno con su rollback;
  65 y 66 son de concurrencia, 67 y 68 de la revisión del carril).
- Detalle del carril, pasos manuales y decisiones: `docs/post-junta-2/c-rls.md`.

```bash
# con el servidor de la app en 3026 para la parte de rutas (sin él se saltan):
node scripts/dev/auditoria-rls.mjs --base=http://localhost:3026 --estricto --markdown=matriz.md
```

`--estricto` además cuenta como falla una función con patrón sospechoso sin
veredicto, un ayudante boolean sin veredicto o una tabla expuesta a la API sin
especificación. La base de dev es compartida: cada corrida crea sus propios
datos con el prefijo `t_rls_<6 hex>` (antros "T rls A/B/C …", correos
`t_rls_…@example.com`) y los borra al final aunque falle (try/finally). No
toca Club Demo Dev ni los usuarios `dev_*`.

## Escenario

- **Antro A** publicado (verificado + suscripción), **antro B** en borrador,
  **antro C** en borrador con un dueño con contraseña temporal.
- Por antro A y B: dueño, gerente, staff, RP, un segundo RP sin sesión
  (destino de tarifas) y un staff dado de baja con `personal_cambiar_estado`.
- Además: anónimo, cuenta de Auth sin perfil, cliente, admin, dueño de
  grupo (grupo G = {A}; grupo H = {B} sin miembros), RP dado de baja,
  gerente y RP con contraseña temporal sin cambiar, dueño con contraseña
  temporal (antro C) y un gerente sin antro (perfil anómalo).
- Datos en A y B: mesas, fotos, reservas (orgánica, de RP, en puerta y
  sentada en caja), consumos viejos, comisiones (incluida la que nace al
  cuadrar), turnos, asistencias, pagos por día, tarifas (del antro y por RP),
  documentos de verificación, suscripción y pago de mensualidad, caja real
  por el camino del gerente (mesa cuadrada con comisión y otra abierta con
  walk-in), productos y movimientos, regla de comisión, visibilidad, permisos
  de caja, invitaciones (y lotes, si existen), correos de salida, alta,
  error de la app, planes, aceptaciones legales, y archivos en
  `club-photos` y `verificacion-docs`.
- Para cada tabla: SELECT, INSERT, UPDATE (con el mismo valor: mide el
  permiso sin cambiar datos) y DELETE (filas de sacrificio que se restauran
  si alguien las borra) de cada sesión, contra A y contra B.

## Resultado

Última corrida (25/11/2026, tarde, dev con 60–68 aplicados, `--estricto`,
servidor `next dev` en 3026): **9,113 de 9,113 coinciden, 0 diferencias, sale
con 0.**

| Grupo | Coinciden |
|---|---|
| Tablas (52 de `public`: RLS activado + S/I/U/D por sesión y antro) | 8,165 / 8,165 |
| Funciones por RPC (23 funciones, incluidas las de nómina, caja, invitaciones y grupo) | 494 / 494 |
| Candados (escalar rol o antro, reactivarse, perfil con club ajeno, autoverificarse, bono, crear antros, RP de otro antro, grupo, legales, NULL) | 30 / 30 |
| Storage: en `club-photos` subir, borrar, listar la raíz, listar la carpeta, `list-v2` sin carpeta y leer por ruta exacta; en `verificacion-docs` subir, leer, listar y borrar; HTML y 11 MB | 420 / 420 |
| Rutas con service role (`create-staff`, mensualidad) | 4 / 4 |

Con los cinco rollbacks aplicados (60–64 quitados) la misma auditoría da
**28 diferencias**: son exactamente los hallazgos 1–7 de abajo. Volviendo a
aplicarlos, 0. Con el rollback del 67 (y del 68) da **42 diferencias**, todas
del hallazgo 9: las 14 sesiones que no deben ver el antro B (anónimo, sin
perfil, cliente, personal y dueño de A, dueño de grupo, bajas, contraseñas
temporales, gerente sin antro) listan su carpeta en la raíz, dentro de ella
y con `list-v2`. Volviendo a aplicar el 67, 0.

**Límite conocido de `club-photos` (bucket público):** por **ruta exacta**
Storage sirve el archivo a cualquiera sin pasar por RLS, también por
`/object/authenticated/` y `download()` (lo comprobé con una foto de Panic
Room como anónimo: 200 por las cuatro rutas). La matriz lo deja escrito
(«leer de B por ruta exacta (bucket público)»: sí para todos) para que la
auditoría avise si cambia. Lo que protege a un antro no publicado es que la
ruta (con un uuid) ya no se descubre: ni por `club_photos` (RLS desde el
12/11) ni listando el bucket (67).

Tres tablas nuevas de b-alta (`club_config_propia`, `grupo_config`,
`grupo_config_cambios`) no tienen GRANT para `anon` ni `authenticated`: el
script comprueba que ninguna sesión las lee ni las escribe (solo funciones).
Cuando su carril les dé acceso por la API, la auditoría en `--estricto`
fallará hasta que se les escriba la matriz en `SPEC`.

La matriz completa (generada por el script) está al final.

## Hallazgos por gravedad

Columna **Prod**: si el hueco existe hoy en producción. Se comparó con
`sql/esquema/esquema-prod.sql` (19/11) más el SQL del pase 1 que se aplicó
(pasos 2b–9 de `docs/pase-produccion.md`) y con el código de `master`. No
se conectó a producción (regla de este carril).

| # | Gravedad | Hallazgo | Prod | Arreglo | Probado |
|---|---|---|---|---|---|
| 0 | **CRÍTICO** | Una cuenta recién registrada creaba su perfil `dueno`/`cliente` con el `club_id` de un antro ajeno y le leía reservas con teléfono, personal, sueldos y comisiones (auditoría C2). | **SÍ** (SQL listo, pendiente de pasar) | `sql/2026-11-25-perfil-sin-club-ajeno.sql` (ya en dev) | 4 candados de la matriz («cuenta sin perfil crea perfil … con club ajeno», «… a nombre de otro», «… staff» → no; «registro legítimo» → sí) y `probar-perfil-club-ajeno.mjs` (4/4 el 25/11) |
| 1 | MEDIO | `club-photos` (bucket **público**) sin límite de tamaño ni de tipo: un dueño sube HTML o 11 MB. Como `/dueno/signup` es público (deuda 3) y, sin el 62, cualquier cliente se crea un antro por la API, **cualquiera con cuenta** usa el bucket como hosting con la URL de AntroApp. (El HTML se sirve como `text/plain`, no ejecuta.) | **SÍ** (bucket `null, null`) | `63-bucket-fotos-limites.sql`: 10 MB, solo jpeg/png/webp/heic/heif/avif/gif | «club-photos acepta HTML» y «acepta 11 MB»: sí sin el 63, no con él |
| 2 | MEDIO-BAJO | Un **cliente o un RP** (y por la misma regla un staff) crean un antro a su nombre directo contra la API (`clubs insert dueno o admin` solo pide `dueno_id = auth.uid()`); con eso pasan a ser «dueños» de un borrador: suben fotos y documentos, lo mandan a revisión. Un dueño con antro crea un **segundo** antro y rompe su `/dueno/panel` y `current_club_id()` (deuda 6). | **SÍ** (misma política) | `62-clubs-dueno-valido.sql`: INSERT solo admin o rol `dueno` (activo, sin contraseña temporal) y sin otro antro | 4 candados: sí sin el 62, no con él; el auto-registro de un dueño sin antro sigue pasando |
| 3 | BAJO | **RP dado de baja** (su sesión sigue viva: la baja de RPs no cierra sesiones) sigue leyendo sus pagos por día, turnos, asistencias y su tarifa propia: esas políticas comparan `rp_id = auth.uid()` sin pasar por el rol. Contradice «un RP dado de baja no ve su nómina». | **SÍ** (la restrictiva del pase 1 solo cubre `reservations` y `commissions`) | `61-sesion-sin-acceso.sql`: restrictiva de SELECT con `sesion_sin_acceso()` en 7 tablas | 4 filas: sí sin el 61, no con él |
| 4 | BAJO | **Contraseña temporal sin cambiar** (alta de antros): un RP leía sus comisiones, turnos, asistencias, pagos y tarifa (y sus reservas con nombre y teléfono de sus clientes mientras exista `reservations_select_rp_own`, que b-cliente 41 quita); un dueño editaba su antro, subía fotos y documentos y creaba otro antro; un gerente creaba RPs por `/api/admin/create-staff`; un dueño abría el checkout de la mensualidad. | NO (en prod no hay contraseñas temporales) | 61 y 62 en la base; en código `lib/contrasena-temporal.ts` en `create-staff`, `alta-club`, `rechazar-verificacion` y `lib/mensualidad/autorizar.ts` | 11 filas/candados en la base (sí sin 61/62, no con ellos); las 2 rutas responden 403 (antes del arreglo de código no se re-midió en esta sesión: ver nota) |
| 5 | BAJO | Staff de A asigna **turnos y asistencias a un RP de B** en A, y el gerente de A le pone **tarifa propia** (por reserva y por día): las políticas revisan `club_id = current_club_id()` pero no que el RP sea de ese antro. El RP de B lo ve en su panel y la asistencia puede generar pago por día en A. | **SÍ** (mismas políticas) | `64-rp-del-club.sql`: restrictivas con `rp_es_del_club()` en INSERT/UPDATE de 4 tablas | 4 candados: sí sin el 64, no con él |
| 6 | BAJO | `personal_cambiar_estado`: un gerente con `club_id` nulo (perfil anómalo) pasaba el `if not (…)` por NULL y daba de baja o reactivaba staff de **cualquier** antro. Solo lo crea el admin a mano. | NO (es de post-junta 02) | `60-autorizacion-nulos-c.sql` (coalesce) | 3 pruebas: el gerente sin antro dio de baja a staff de A y de B sin el 60; con él, «No tienes permiso» |
| 7 | INFORMATIVO | `nomina_transicion_valida(NULL, …)` devolvía NULL y `nomina_cambiar_estado` no rechazaba. Inocuo: el UPDATE con estado NULL no toca filas. | SÍ (inocuo) | 60 (coalesce) | «nomina_cambiar_estado con transición NULL»: pasaba sin el 60, rechaza con él |
| 8 | NO ES HUECO | Reservar sin cuenta o como cliente en un antro **no publicado**: ya lo niega la política de INSERT (su subconsulta de `clubs.zona_horaria` corre con el RLS de quien llama y sale NULL) y, para el anónimo, el trigger del 72. | — | 64 deja la regla explícita (`puede_ver_club`) como defensa en profundidad | sin el 64: anónimo y cliente no pudieron reservar en B |
| 9 | MEDIO | **Listar el bucket `club-photos`**: el anónimo (y cualquier sesión) listaba la raíz (las carpetas son el id de cada antro) y dentro de cada carpeta los nombres de archivo, que llevan el nombre original de la foto, **también de antros no publicados** (borradores como Panic Room). Lo encontró el revisor del carril; la auditoría solo probaba subir y borrar en este bucket. | **SÍ** (`club_photos_storage_select_public`, `using (bucket_id = 'club-photos')` para public, en `sql/esquema/esquema-prod.sql`) | `67-club-photos-listar.sql`: restrictiva de SELECT; pasa el admin o la carpeta de un antro que `puede_ver_club()` acepta | 42 filas de la matriz: sí sin el 67, no con él; el dueño sigue subiendo y borrando (las URL públicas no pasan por RLS) |
| 10 | BAJO | **«Un dueño, un antro» sin candado**: el 62 lo revisaba con una lectura en el WITH CHECK; dos altas del mismo dueño a la vez no se veían y entraban las dos (deuda 6 otra vez). Lo encontró el revisor del carril. | Existirá al pasar el 62 (sin el 62 un dueño crea los antros que quiera) | `68-un-antro-por-dueno-candado.sql`: trigger con `pg_advisory_xact_lock` por dueño que vuelve a contar | `probar-concurrencia-noche3.mjs` caso 6: sin el 68 la carrera forzada pasaba y 3 altas a la vez por la API dejaban **3 antros**; con el 68, 1 y las demás «Ya tienes un antro registrado…» (P0001) |

**Nota sobre el hallazgo 4 (rutas):** la ruta vieja `create-staff` leía el
rol con la service role (`gerente`, activo) y no miraba
`app_metadata.debe_cambiar`, así que creaba la cuenta; lo vi en el código y
la prueba de la matriz confirma el 403 de hoy. No volví a medir el 200 de
antes porque habría que revertir el código en el servidor.

**Abierto, sin arreglo en este carril (decisión o deuda conocida):**
- Deuda 9 de CLAUDE.md: el staff lee la configuración de comisión del antro
  en `clubs` (no hay RLS por columna).
- Deuda 3: `/dueno/signup` abierto. Con el 62 ya no basta una cuenta de
  cliente para hacerse dueño por la API, pero el registro de dueño sigue
  siendo público por diseño; el 63 es lo que acota el abuso del bucket.
- Cualquier sesión edita el `nombre` de su propio perfil aunque esté dada
  de baja o con contraseña temporal (el trigger cuida rol, antro y
  `activo`). Inocuo.
- `components/reglas-pago-rp.tsx` (lo usa el gerente en `/staff/panel`)
  hace `update clubs set pago_rp_modo`, pero la política de UPDATE de
  `clubs` nunca dejó al gerente (ni antes ni después del 62): ese cambio no
  se guarda para el gerente. No es de seguridad; lo dejo anotado.

## Funciones que fallan abiertas con NULL

Se revisaron con `pg_get_functiondef` todas las funciones de `public` en dev
(el número exacto sale en la tabla de abajo). Patrones buscados: `if not (`
sin coalesce, `if not f(`, `v_rol not in (` y `<> 'admin'`. Cada coincidencia
tiene veredicto; las explotables cuentan como falla del script.

Además, la tabla de **ayudantes boolean**: en una **política** un NULL ya
niega (permisiva o restrictiva, también bajo `not`), así que el riesgo real
es un `if not f(…)` en plpgsql. Por eso se anota, para cada ayudante, si
puede devolver NULL y en qué `if not` se usa.

Hallazgos previos de C2, verificados con sesión real:
- `personal_cambiar_estado` sin coalesce (`sql/post-junta/02-baja-personal.sql:112-118`):
  **explotable** con un gerente sin antro → arreglado (hallazgo 6).
- `nomina_semana` sin coalesce: **seguro**. `es_gerente_o_dueno()` y
  `club_es_dueno_grupo()` nunca devuelven NULL; con sesión real, la cuenta
  sin perfil, las dadas de baja y las de contraseña temporal reciben «No
  tienes acceso» (fila `RPC nomina_semana` de la matriz).
- `admin_alta_club` «`v_rol not in`» sin `is null`: **seguro**. La puerta es
  `current_role_name() is distinct from 'admin'`; un rol NULL en el payload
  se salta el if pero el INSERT en `profiles.role` (not null) truena y
  revierte todo. Desde b-alta 12 el cuerpo vive en `_admin_alta_club_base`,
  que solo ejecuta `service_role`.
- Rutas que leen el rol con la service role sin respetar `debe_cambiar`:
  **reales** → arreglado en código (hallazgo 4).

Funciones `security definer` ejecutables por `anon` en dev: solo
`current_role_name`, `current_club_id`, `puede_ver_club` (las usan las
políticas del anónimo), `obtener_reserva_por_qr` (boleto público) y
funciones de trigger (`clubs_candado_*`, `profiles_bloquear_cambio_privilegios`,
`rls_auto_enable`), que no se pueden llamar directo. Todas con
`search_path` fijo.

## Concurrencia (C5, 25/11/2026)

Script: `node scripts/dev/probar-concurrencia-noche3.mjs` (solo dev; crea y
borra sus propios antros «T rls conc …» y cuentas `t_rls_…`). Cada caso
manda las peticiones **a la vez** con sesiones reales (PostgREST + RLS) y,
donde la red no basta para provocar la carrera, la **fuerza**: dos
conexiones directas con el rol y el JWT de quien llama; la primera deja su
transacción abierta y se mide si la segunda espera el candado y qué
responde. Resultado con `sql/post-junta-2/65` a `68` aplicados y el arreglo
de `/cliente/reservar`: **52/52** (dos corridas). Sin 65/66 daba 40/46; sin
el 68 y sin el arreglo de pantalla, 47/52 (fallaban 2e' y 6a–6d).

| # | Caso | Antes (sin 65/66) | Ahora | Arreglo |
|---|---|---|---|---|
| 1 | **Dos staff escanean el mismo QR** y confirman la entrada a la vez (y entrada manual de 3 a la vez) | La entrada ya se registraba **una sola vez** (`puerta_reserva_para_escribir` bloquea la reserva con `for update`): 1 escaneo, 1 entrada, 1 evento. Pero el perdedor recibía **«Primero escanea el QR»**, que es falso. | Igual de serializado; el perdedor recibe **«Esta reserva ya entró a las HH:MM.»** (P0001, la pantalla lo muestra tal cual). | 65 |
| 2 | **Dos reservas del mismo cliente**, mismo antro y noche, a la vez (y 5 más) | Pasa exactamente una; las demás 23505 (`reservations_una_por_cliente_dia`). `/cliente/reservar` ya traduce el 23505 a «Ya tienes una reserva en este antro para esa noche.» (código revisado). | Igual. | — |
| 2' | Reservas **sin cuenta** del mismo teléfono (tope de 3 del 72) | Con 6 a la vez por la red pasaron 3 (suerte), pero en la carrera forzada la «4a» **pasaba sin esperar**: el trigger contaba sin candado. | La segunda espera a la primera y la **base** la rechaza con «Ya hay varias reservas con este teléfono…» (P0001). La **pantalla** `/cliente/reservar` solo traducía el 23505 y mostraba «No pudimos crear tu reserva. Intenta de nuevo…»; desde la revisión muestra el aviso de la base tal cual, sin «Intenta de nuevo» (2e' revisa el código; `probar-fotos-y-avisos.mjs` 2a lo ve en pantalla a 390 y 360 px). | 66 (va después del 72) y `app/cliente/reservar/page.tsx` |
| 3 | **Doble cobro, misma clave** (2 y 5 envíos a la vez, con saldo esperado) | Un solo cobro guardado (nunca se cobró doble), pero los reintentos que llegaban mientras el primero tenía la mesa bloqueada tronaban con **«El saldo de la mesa cambió»** por un cobro que sí entró (5 envíos: 4 errores; carrera forzada: error). El staff podía volver a cobrar con otra clave. | Todos responden bien con el **mismo** cobro; 1 fila. | 65 (la clave se busca otra vez con la mesa bloqueada) |
| 3' | Misma clave 3 veces **sin** saldo esperado | Un solo cobro (lo resolvía el índice único y el `exception when unique_violation`). | Igual. | — |
| 3'' | **Claves distintas, mismo saldo esperado**, 3 staff a la vez | Entra exactamente uno; los otros «El saldo de la mesa cambió… (ahora es $0.00)». Mesa pagada exacta. | Igual. | — |
| 4 | **Cuadrar la misma mesa** a la vez (gerente, otro gerente, dueño) | Pasa uno; los otros «La mesa está cuadrada…». 1 cuadre, **1 comisión por cuenta** (2 cuentas → 2), cuota 2 bien aplicada ($0 y $100), cuentas liquidadas. | Igual. | — |
| 4' | **Dos mesas del mismo RP** cuadradas a la vez con cuota semanal | La cuota se cuenta bien en paralelo ($0 y $100): `caja_liquidar_cuenta` toma `pg_advisory_xact_lock` por RP y semana. | Igual. | — |
| 5 | **Dos gerentes (y el dueño) cierran la misma noche** a la vez | Pasa uno (`for update` sobre la noche); los otros «La noche ya está cerrada». 1 cuadre de noche, 1 evento, cuadra al centavo; con la noche cerrada ya no se abre mesa. | Igual. | — |
| 5' | **Cerrar la noche mientras otro staff y el dueño abren mesa** | Nunca queda una noche cerrada con mesas sin cuadrar (`caja_noche_actual` toma la noche `for share`); el que pierde recibe «La noche del … ya está cerrada» o «Faltan N mesas por cuadrar». | Igual. | — |
| 6 | **Un dueño sin antro da de alta dos antros a la vez** (carrera forzada) y **tres a la vez por la API** | Entraban **todos**: en la carrera forzada la segunda alta no esperó y pasó; por la API pasaron las 3 (el dueño quedó con 3 antros). | La segunda espera el candado y recibe «Ya tienes un antro registrado. Para sumar otro, pídelo al equipo de AntroApp.» (P0001); por la API pasa una y las otras dos reciben el aviso. | 68 |

Notas:
- La pantalla de cuadre y la de cierre de noche ya tratan «ya cuadrada» /
  «ya cerrada» como éxito (releen el estado en la base). En el cierre de
  noche eso significa que el **segundo gerente no se entera** de que su
  conteo no se usó (decisión pendiente en `docs/post-junta-2/c-rls.md`).
- Dos cobros con claves distintas y **sin** saldo esperado entran los dos;
  es el comportamiento de siempre del código viejo (el actual siempre manda
  saldo esperado).
- En producción: el 65 y el 66 no se han pasado y no me conecté a
  producción. Lo de los casos 1 (aviso falso) y 3 (error falso tras un
  cobro bueno) viene de la puerta y la caja de noche2 (`2026-11-20-…` y
  `2026-11-21-caja-idempotencia.sql`): existe en producción si esa parte
  ya se pasó (por confirmar con el coordinador). Lo del 2' existirá cuando
  se pase el 72.

## Matriz completa (salida de la última corrida)

<!-- generado por scripts/dev/auditoria-rls.mjs 2026-11-25T18:50:46.154Z -->
Celdas: **S** = filas de prueba que ve (A, B, C, «todo» o —), **I/U/D** = en qué antro pudo insertar, actualizar o borrar. ⚠ = distinto de lo esperado.

#### aceptaciones_legales

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | ✓ | — | — |
| cliente | · | ✓ | — | — |
| rpA | · | ✓ | — | — |
| staffA | — | ✓ | — | — |
| gerenteA | — | ✓ | — | — |
| duenoA | — | ✓ | — | — |
| rpB | — | ✓ | — | — |
| staffB | — | ✓ | — | — |
| gerenteB | — | ✓ | — | — |
| duenoB | — | ✓ | — | — |
| duenoGrupo | — | ✓ | — | — |
| admin | todo | ✓ | — | — |
| staffBajaA | — | ✓ | — | — |
| rpBaja | — | ✓ | — | — |
| gerenteTemp | — | ✓ | — | — |
| rpTemp | — | ✓ | — | — |
| duenoTemp | — | ✓ | — | — |
| gerenteSinClub | — | ✓ | — | — |

#### alertas_enviadas

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | — | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | — | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | — | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### app_errores

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | — | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | — | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### caja_consumos

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | A | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | — | — | — |
| rpB | — | — | — | — |
| staffB | B | — | — | — |
| gerenteB | B | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | A | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### caja_cuadres

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | A | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | — | — | — |
| rpB | — | — | — | — |
| staffB | B | — | — | — |
| gerenteB | B | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | A | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### caja_eventos

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | A | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | — | — | — |
| rpB | — | — | — | — |
| staffB | B | — | — | — |
| gerenteB | B | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | A | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### caja_noches

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | A | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | — | — | — |
| rpB | — | — | — | — |
| staffB | B | — | — | — |
| gerenteB | B | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | A | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### caja_pagos

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | A | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | — | — | — |
| rpB | — | — | — | — |
| staffB | B | — | — | — |
| gerenteB | B | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | A | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### caja_permisos

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | A | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | — | — | — |
| rpB | — | — | — | — |
| staffB | B | — | — | — |
| gerenteB | B | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | A | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### club_altas

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | — | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | — | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### club_config_propia

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | — | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | — | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | — | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### club_config_rp

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | B | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### club_dia_tarifas

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | A | A | A | A |
| duenoA | A | A | A | A |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | B | B | B | B |
| duenoB | B | B | B | B |
| duenoGrupo | — | — | — | — |
| admin | todo | AB | AB | AB |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### club_photos

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | A | — | — | — |
| sinperfil | A | — | — | — |
| cliente | A | — | — | — |
| rpA | A | — | — | — |
| staffA | A | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | A | — | A |
| rpB | AB | — | — | — |
| staffB | AB | — | — | — |
| gerenteB | AB | — | — | — |
| duenoB | AB | B | — | B |
| duenoGrupo | A | — | — | — |
| admin | todo | ABC | — | AB |
| staffBajaA | A | — | — | — |
| rpBaja | A | — | — | — |
| gerenteTemp | A | — | — | — |
| rpTemp | A | — | — | — |
| duenoTemp | AC | — | — | — |
| gerenteSinClub | A | — | — | — |

#### club_tables

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | A | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | A | — | A |
| rpB | — | — | — | — |
| staffB | B | — | — | — |
| gerenteB | B | — | — | — |
| duenoB | B | B | — | B |
| duenoGrupo | — | — | — | — |
| admin | todo | AB | — | AB |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### clubs

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | A | — | — | — |
| sinperfil | A | — | — | — |
| cliente | A | — | — | — |
| rpA | A | — | — | — |
| staffA | A | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | — | A | — |
| rpB | AB | — | — | — |
| staffB | AB | — | — | — |
| gerenteB | AB | — | — | — |
| duenoB | AB | — | B | — |
| duenoGrupo | A | — | — | — |
| admin | todo | — | ABC | — |
| staffBajaA | A | — | — | — |
| rpBaja | A | — | — | — |
| gerenteTemp | A | — | — | — |
| rpTemp | A | — | — | — |
| duenoTemp | AC | — | — | — |
| gerenteSinClub | A | — | — | — |

#### commissions

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | A | — | — | — |
| staffA | — | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | — | — | — |
| rpB | B | — | — | — |
| staffB | — | — | — | — |
| gerenteB | B | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | todo | AB | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### config_plataforma

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | — | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | — | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### config_rp_cambios

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | B | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### consumption_entries

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | A | A | — | — |
| gerenteA | A | A | — | — |
| duenoA | A | A | — | — |
| rpB | — | — | — | — |
| staffB | B | B | — | — |
| gerenteB | B | B | — | — |
| duenoB | B | B | — | — |
| duenoGrupo | — | — | — | — |
| admin | todo | AB | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### correos_salida

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | — | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | — | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### grupo_clubs

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | — | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | — | — | — | — |
| duenoGrupo | A | — | — | — |
| admin | todo | AB | AB | AB |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### grupo_config

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | — | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | — | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | — | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### grupo_config_cambios

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | — | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | — | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | — | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### grupo_miembros

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | — | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | — | — | — | — |
| duenoGrupo | todo | — | — | — |
| admin | todo | ✓ | A | A |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### grupos

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | — | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | — | — | — | — |
| duenoGrupo | A | — | — | — |
| admin | todo | ✓ | AB | ✓ |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### invitacion_envios

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | — | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | — | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | — | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### invitacion_intentos

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | — | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | — | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | — | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### invitacion_lotes

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | A | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | — | — | — |
| rpB | — | — | — | — |
| staffB | B | — | — | — |
| gerenteB | B | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### invitaciones

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | A | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | — | — | — |
| rpB | — | — | — | — |
| staffB | B | — | — | — |
| gerenteB | B | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### login_intentos

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | — | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | — | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | — | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### mesa_cuentas

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | A | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | — | — | — |
| rpB | — | — | — | — |
| staffB | B | — | — | — |
| gerenteB | B | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | A | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### mesa_sesiones

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | A | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | — | — | — |
| rpB | — | — | — | — |
| staffB | B | — | — | — |
| gerenteB | B | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | A | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### pagos_mensualidad

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | A | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### personal_movimientos

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | B | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### planes

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | todo | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | todo | — | — | — |
| duenoGrupo | todo | — | — | — |
| admin | todo | ✓ | ✓ | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### producto_movimientos

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | B | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### productos

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | A | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | — | — | — |
| rpB | — | — | — | — |
| staffB | B | — | — | — |
| gerenteB | B | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | A | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### profiles

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | · | — | — | — |
| rpA | A | — | A | — |
| staffA | A | — | A | — |
| gerenteA | A | — | A | — |
| duenoA | ·A | — | A | — |
| rpB | B | — | B | — |
| staffB | B | — | B | — |
| gerenteB | B | — | B | — |
| duenoB | ·B | — | B | — |
| duenoGrupo | · | — | — | — |
| admin | todo | — | AB | — |
| staffBajaA | A | — | — | — |
| rpBaja | A | — | — | — |
| gerenteTemp | A | — | — | — |
| rpTemp | A | — | — | — |
| duenoTemp | · | — | — | — |
| gerenteSinClub | · | — | — | — |

#### registro_intentos

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | — | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | — | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | — | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### reglas_comision

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | B | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### reserva_intentos

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | — | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | — | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | — | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### reservations

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | A | — | — |
| sinperfil | — | — | — | — |
| cliente | A | A | — | — |
| rpA | — | A | — | — |
| staffA | A | — | A | — |
| gerenteA | A | — | A | — |
| duenoA | A | — | A | — |
| rpB | — | B | — | — |
| staffB | B | — | B | — |
| gerenteB | B | — | B | — |
| duenoB | B | — | B | — |
| duenoGrupo | — | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### rp_attendance

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | A | — | — | — |
| staffA | A | A | — | — |
| gerenteA | A | A | — | — |
| duenoA | A | A | — | — |
| rpB | B | — | — | — |
| staffB | B | B | — | — |
| gerenteB | B | B | — | — |
| duenoB | B | B | — | — |
| duenoGrupo | — | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### rp_comision_overrides

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | A | — | — | — |
| staffA | — | — | — | — |
| gerenteA | A | A | A | A |
| duenoA | A | A | A | A |
| rpB | B | — | — | — |
| staffB | — | — | — | — |
| gerenteB | B | B | B | B |
| duenoB | B | B | B | B |
| duenoGrupo | — | — | — | — |
| admin | todo | AB | AB | AB |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### rp_dia_tarifa_overrides

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | A | A | A | A |
| duenoA | A | A | A | A |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | B | B | B | B |
| duenoB | B | B | B | B |
| duenoGrupo | — | — | — | — |
| admin | todo | AB | AB | AB |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### rp_pagos_dia

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | A | — | — | — |
| staffA | — | — | — | — |
| gerenteA | A | — | — | — |
| duenoA | A | — | — | — |
| rpB | B | — | — | — |
| staffB | — | — | — | — |
| gerenteB | B | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | todo | AB | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### rp_schedule

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | A | — | — | — |
| staffA | A | A | — | A |
| gerenteA | A | A | — | A |
| duenoA | A | A | — | A |
| rpB | B | — | — | — |
| staffB | B | B | — | B |
| gerenteB | B | B | — | B |
| duenoB | B | B | — | B |
| duenoGrupo | — | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### stripe_eventos

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | — | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | — | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | — | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### suscripciones

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | A | — | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | B | — | — | — |
| duenoGrupo | — | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### verificacion_documentos

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | — | — | — | — |
| cliente | — | — | — | — |
| rpA | — | — | — | — |
| staffA | — | — | — | — |
| gerenteA | — | — | — | — |
| duenoA | A | A | — | — |
| rpB | — | — | — | — |
| staffB | — | — | — | — |
| gerenteB | — | — | — | — |
| duenoB | B | B | — | — |
| duenoGrupo | — | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | — | — | — | — |
| rpBaja | — | — | — | — |
| gerenteTemp | — | — | — | — |
| rpTemp | — | — | — | — |
| duenoTemp | — | — | — | — |
| gerenteSinClub | — | — | — | — |

#### versiones_legales

| Sesión | S | I | U | D |
|---|---|---|---|---|
| anon | — | — | — | — |
| sinperfil | todo | — | — | — |
| cliente | todo | — | — | — |
| rpA | todo | — | — | — |
| staffA | todo | — | — | — |
| gerenteA | todo | — | — | — |
| duenoA | todo | — | — | — |
| rpB | todo | — | — | — |
| staffB | todo | — | — | — |
| gerenteB | todo | — | — | — |
| duenoB | todo | — | — | — |
| duenoGrupo | todo | — | — | — |
| admin | todo | — | — | — |
| staffBajaA | todo | — | — | — |
| rpBaja | todo | — | — | — |
| gerenteTemp | todo | — | — | — |
| rpTemp | todo | — | — | — |
| duenoTemp | todo | — | — | — |
| gerenteSinClub | todo | — | — | — |

#### Funciones, candados, storage y rutas

| Grupo | Prueba | Sesión | Esperado | Obtenido |
|---|---|---|---|---|
| RPC | nomina_semana | duenoGrupo | sí | sí |
| RPC | nomina_semana | admin | sí | sí |
| RPC | nomina_semana | gerenteA | sí | sí |
| RPC | nomina_semana | duenoA | sí | sí |
| RPC | grupo_rendimiento_rp | admin | sí | sí |
| RPC | grupo_rendimiento_rp | duenoA | sí | sí |
| RPC | grupo_rendimiento_rp | gerenteA | sí | sí |
| RPC | grupo_rendimiento_rp | duenoGrupo | sí | sí |
| RPC | actividad_club | admin | sí | sí |
| RPC | actividad_club | duenoA | sí | sí |
| RPC | actividad_club | gerenteA | sí | sí |
| RPC | personal_historial | admin | sí | sí |
| RPC | personal_historial | gerenteA | sí | sí |
| RPC | personal_historial | duenoA | sí | sí |
| RPC | config_rp_actual | admin | sí | sí |
| RPC | config_rp_actual | gerenteA | sí | sí |
| RPC | config_rp_actual | duenoA | sí | sí |
| RPC | config_rp_historial | duenoA | sí | sí |
| RPC | config_rp_historial | admin | sí | sí |
| RPC | config_rp_historial | gerenteA | sí | sí |
| RPC | config_rp_cambiar_visibilidad | duenoA | sí | sí |
| RPC | config_rp_cambiar_visibilidad | admin | sí | sí |
| RPC | config_rp_cambiar_visibilidad | gerenteA | sí | sí |
| RPC | caja_configurar_permiso | duenoA | sí | sí |
| RPC | caja_configurar_permiso | admin | sí | sí |
| RPC | producto_guardar | gerenteA | sí | sí |
| RPC | producto_guardar | duenoA | sí | sí |
| RPC | producto_guardar | admin | sí | sí |
| RPC | nomina_cambiar_estado | gerenteA | sí | sí |
| RPC | nomina_cambiar_estado | duenoA | sí | sí |
| RPC | nomina_cambiar_estado | admin | sí | sí |
| RPC | caja_registrar_consumo | staffA | sí | sí |
| RPC | caja_registrar_consumo | admin | sí | sí |
| RPC | caja_registrar_consumo | duenoA | sí | sí |
| RPC | caja_registrar_consumo | gerenteA | sí | sí |
| RPC | puerta_escanear | staffA | sí | sí |
| RPC | puerta_escanear | gerenteA | sí | sí |
| RPC | puerta_escanear | duenoA | sí | sí |
| RPC | puerta_escanear | admin | sí | sí |
| RPC | registrar_pago_dia | duenoA | sí | sí |
| RPC | registrar_pago_dia | admin | sí | sí |
| RPC | registrar_pago_dia | gerenteA | sí | sí |
| RPC | registrar_pago_dia | staffA | sí | sí |
| RPC | registrar_comision_reserva | staffA | sí | sí |
| RPC | registrar_comision_reserva | admin | sí | sí |
| RPC | registrar_comision_reserva | duenoA | sí | sí |
| RPC | registrar_comision_reserva | gerenteA | sí | sí |
| RPC | admin_alta_club | admin | sí | sí |
| RPC | caja_mis_permisos | admin | sí | sí |
| RPC | caja_mis_permisos | gerenteA | sí | sí |
| RPC | caja_mis_permisos | staffA | sí | sí |
| RPC | caja_mis_permisos | duenoA | sí | sí |
| RPC | rp_mis_reservas | rpA | sí | sí |
| RPC | rp_mis_reservas | rpB | sí | sí |
| RPC | rp_progreso_cuota | rpB | sí | sí |
| RPC | rp_progreso_cuota | rpA | sí | sí |
| RPC | nomina_semana_mia | rpA | sí | sí |
| RPC | nomina_semana_mia | rpB | sí | sí |
| RPC | obtener_reserva_por_qr | anon | sí | sí |
| RPC | obtener_reserva_por_qr | cliente | sí | sí |
| RPC | obtener_reserva_por_qr | gerenteA | sí | sí |
| RPC | obtener_reserva_por_qr | rpB | sí | sí |
| RPC | obtener_reserva_por_qr | admin | sí | sí |
| RPC | obtener_reserva_por_qr | gerenteB | sí | sí |
| RPC | obtener_reserva_por_qr | rpBaja | sí | sí |
| RPC | obtener_reserva_por_qr | duenoGrupo | sí | sí |
| RPC | obtener_reserva_por_qr | staffA | sí | sí |
| RPC | obtener_reserva_por_qr | rpA | sí | sí |
| RPC | obtener_reserva_por_qr | duenoA | sí | sí |
| RPC | obtener_reserva_por_qr | rpTemp | sí | sí |
| RPC | obtener_reserva_por_qr | duenoTemp | sí | sí |
| RPC | obtener_reserva_por_qr | duenoB | sí | sí |
| RPC | obtener_reserva_por_qr | staffBajaA | sí | sí |
| RPC | obtener_reserva_por_qr | staffB | sí | sí |
| RPC | obtener_reserva_por_qr | gerenteSinClub | sí | sí |
| RPC | obtener_reserva_por_qr | sinperfil | sí | sí |
| RPC | obtener_reserva_por_qr | gerenteTemp | sí | sí |
| RPC | personal_cambiar_estado (staff de A) | admin | sí | sí |
| RPC | personal_cambiar_estado (staff de A) | duenoA | sí | sí |
| RPC | personal_cambiar_estado (staff de A) | gerenteA | sí | sí |
| RPC | personal_cambiar_estado (staff de B) | duenoB | sí | sí |
| RPC | personal_cambiar_estado (staff de B) | gerenteB | sí | sí |
| RPC | personal_cambiar_estado (staff de B) | admin | sí | sí |
| RPC | invitacion_crear rp en A | staffA | sí | sí |
| RPC | invitacion_crear rp en A | gerenteA | sí | sí |
| RPC | invitacion_crear rp en A | duenoA | sí | sí |
| RPC | invitacion_crear rp en A | admin | sí | sí |
| RPC | invitacion_crear gerente en A | duenoA | sí | sí |
| RPC | invitacion_crear gerente en A | admin | sí | sí |
| RPC | grupo_resumen ve B | duenoB | sí | sí |
| RPC | grupo_resumen ve A | admin | sí | sí |
| RPC | grupo_resumen ve B | admin | sí | sí |
| RPC | grupo_resumen ve A | duenoA | sí | sí |
| RPC | grupo_resumen ve A | duenoGrupo | sí | sí |
| RPC | grupo_resumen ve B | gerenteB | sí | sí |
| RPC | grupo_resumen ve A | gerenteA | sí | sí |
| candados | registro legítimo: perfil cliente propio sin antro | sinperfil2 | sí | sí |
| candados | un dueño sin antro registra el suyo (auto-registro) | duenoGrupo | sí | sí |
| storage | club-photos listar raíz (carpeta de A) | anon | sí | sí |
| storage | club-photos listar A | anon | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de A) | anon | sí | sí |
| storage | club-photos leer de A por ruta exacta (bucket público) | anon | sí | sí |
| storage | club-photos leer de B por ruta exacta (bucket público) | anon | sí | sí |
| storage | club-photos listar raíz (carpeta de A) | sinperfil | sí | sí |
| storage | club-photos listar A | sinperfil | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de A) | sinperfil | sí | sí |
| storage | club-photos leer de A por ruta exacta (bucket público) | sinperfil | sí | sí |
| storage | club-photos leer de B por ruta exacta (bucket público) | sinperfil | sí | sí |
| storage | club-photos listar raíz (carpeta de A) | cliente | sí | sí |
| storage | club-photos listar A | cliente | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de A) | cliente | sí | sí |
| storage | club-photos leer de A por ruta exacta (bucket público) | cliente | sí | sí |
| storage | club-photos leer de B por ruta exacta (bucket público) | cliente | sí | sí |
| storage | club-photos listar raíz (carpeta de A) | rpA | sí | sí |
| storage | club-photos listar A | rpA | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de A) | rpA | sí | sí |
| storage | club-photos leer de A por ruta exacta (bucket público) | rpA | sí | sí |
| storage | club-photos leer de B por ruta exacta (bucket público) | rpA | sí | sí |
| storage | club-photos listar raíz (carpeta de A) | staffA | sí | sí |
| storage | club-photos listar A | staffA | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de A) | staffA | sí | sí |
| storage | club-photos leer de A por ruta exacta (bucket público) | staffA | sí | sí |
| storage | club-photos leer de B por ruta exacta (bucket público) | staffA | sí | sí |
| storage | club-photos listar raíz (carpeta de A) | gerenteA | sí | sí |
| storage | club-photos listar A | gerenteA | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de A) | gerenteA | sí | sí |
| storage | club-photos leer de A por ruta exacta (bucket público) | gerenteA | sí | sí |
| storage | club-photos leer de B por ruta exacta (bucket público) | gerenteA | sí | sí |
| storage | club-photos subir a A | duenoA | sí | sí |
| storage | verificacion-docs subir a A | duenoA | sí | sí |
| storage | club-photos listar raíz (carpeta de A) | duenoA | sí | sí |
| storage | club-photos listar A | duenoA | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de A) | duenoA | sí | sí |
| storage | club-photos leer de A por ruta exacta (bucket público) | duenoA | sí | sí |
| storage | verificacion-docs leer de A | duenoA | sí | sí |
| storage | verificacion-docs listar A | duenoA | sí | sí |
| storage | club-photos borrar en A | duenoA | sí | sí |
| storage | verificacion-docs borrar en A | duenoA | sí | sí |
| storage | club-photos leer de B por ruta exacta (bucket público) | duenoA | sí | sí |
| storage | club-photos listar raíz (carpeta de A) | rpB | sí | sí |
| storage | club-photos listar A | rpB | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de A) | rpB | sí | sí |
| storage | club-photos leer de A por ruta exacta (bucket público) | rpB | sí | sí |
| storage | club-photos listar raíz (carpeta de B) | rpB | sí | sí |
| storage | club-photos listar B | rpB | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de B) | rpB | sí | sí |
| storage | club-photos leer de B por ruta exacta (bucket público) | rpB | sí | sí |
| storage | club-photos listar raíz (carpeta de A) | staffB | sí | sí |
| storage | club-photos listar A | staffB | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de A) | staffB | sí | sí |
| storage | club-photos leer de A por ruta exacta (bucket público) | staffB | sí | sí |
| storage | club-photos listar raíz (carpeta de B) | staffB | sí | sí |
| storage | club-photos listar B | staffB | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de B) | staffB | sí | sí |
| storage | club-photos leer de B por ruta exacta (bucket público) | staffB | sí | sí |
| storage | club-photos listar raíz (carpeta de A) | gerenteB | sí | sí |
| storage | club-photos listar A | gerenteB | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de A) | gerenteB | sí | sí |
| storage | club-photos leer de A por ruta exacta (bucket público) | gerenteB | sí | sí |
| storage | club-photos listar raíz (carpeta de B) | gerenteB | sí | sí |
| storage | club-photos listar B | gerenteB | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de B) | gerenteB | sí | sí |
| storage | club-photos leer de B por ruta exacta (bucket público) | gerenteB | sí | sí |
| storage | club-photos subir a B | duenoB | sí | sí |
| storage | verificacion-docs subir a B | duenoB | sí | sí |
| storage | club-photos listar raíz (carpeta de A) | duenoB | sí | sí |
| storage | club-photos listar A | duenoB | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de A) | duenoB | sí | sí |
| storage | club-photos leer de A por ruta exacta (bucket público) | duenoB | sí | sí |
| storage | club-photos listar raíz (carpeta de B) | duenoB | sí | sí |
| storage | club-photos listar B | duenoB | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de B) | duenoB | sí | sí |
| storage | club-photos leer de B por ruta exacta (bucket público) | duenoB | sí | sí |
| storage | verificacion-docs leer de B | duenoB | sí | sí |
| storage | verificacion-docs listar B | duenoB | sí | sí |
| storage | club-photos borrar en B | duenoB | sí | sí |
| storage | verificacion-docs borrar en B | duenoB | sí | sí |
| storage | club-photos listar raíz (carpeta de A) | duenoGrupo | sí | sí |
| storage | club-photos listar A | duenoGrupo | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de A) | duenoGrupo | sí | sí |
| storage | club-photos leer de A por ruta exacta (bucket público) | duenoGrupo | sí | sí |
| storage | club-photos leer de B por ruta exacta (bucket público) | duenoGrupo | sí | sí |
| storage | club-photos subir a A | admin | sí | sí |
| storage | club-photos subir a B | admin | sí | sí |
| storage | club-photos subir a C | admin | sí | sí |
| storage | club-photos listar raíz (carpeta de A) | admin | sí | sí |
| storage | club-photos listar A | admin | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de A) | admin | sí | sí |
| storage | club-photos leer de A por ruta exacta (bucket público) | admin | sí | sí |
| storage | verificacion-docs leer de A | admin | sí | sí |
| storage | verificacion-docs listar A | admin | sí | sí |
| storage | club-photos borrar en A | admin | sí | sí |
| storage | club-photos listar raíz (carpeta de B) | admin | sí | sí |
| storage | club-photos listar B | admin | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de B) | admin | sí | sí |
| storage | club-photos leer de B por ruta exacta (bucket público) | admin | sí | sí |
| storage | verificacion-docs leer de B | admin | sí | sí |
| storage | verificacion-docs listar B | admin | sí | sí |
| storage | club-photos borrar en B | admin | sí | sí |
| storage | club-photos listar raíz (carpeta de A) | staffBajaA | sí | sí |
| storage | club-photos listar A | staffBajaA | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de A) | staffBajaA | sí | sí |
| storage | club-photos leer de A por ruta exacta (bucket público) | staffBajaA | sí | sí |
| storage | club-photos leer de B por ruta exacta (bucket público) | staffBajaA | sí | sí |
| storage | club-photos listar raíz (carpeta de A) | rpBaja | sí | sí |
| storage | club-photos listar A | rpBaja | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de A) | rpBaja | sí | sí |
| storage | club-photos leer de A por ruta exacta (bucket público) | rpBaja | sí | sí |
| storage | club-photos leer de B por ruta exacta (bucket público) | rpBaja | sí | sí |
| storage | club-photos listar raíz (carpeta de A) | gerenteTemp | sí | sí |
| storage | club-photos listar A | gerenteTemp | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de A) | gerenteTemp | sí | sí |
| storage | club-photos leer de A por ruta exacta (bucket público) | gerenteTemp | sí | sí |
| storage | club-photos leer de B por ruta exacta (bucket público) | gerenteTemp | sí | sí |
| storage | club-photos listar raíz (carpeta de A) | rpTemp | sí | sí |
| storage | club-photos listar A | rpTemp | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de A) | rpTemp | sí | sí |
| storage | club-photos leer de A por ruta exacta (bucket público) | rpTemp | sí | sí |
| storage | club-photos leer de B por ruta exacta (bucket público) | rpTemp | sí | sí |
| storage | club-photos listar raíz (carpeta de A) | duenoTemp | sí | sí |
| storage | club-photos listar A | duenoTemp | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de A) | duenoTemp | sí | sí |
| storage | club-photos leer de A por ruta exacta (bucket público) | duenoTemp | sí | sí |
| storage | club-photos leer de B por ruta exacta (bucket público) | duenoTemp | sí | sí |
| storage | club-photos listar raíz (carpeta de A) | gerenteSinClub | sí | sí |
| storage | club-photos listar A | gerenteSinClub | sí | sí |
| storage | club-photos list-v2 sin carpeta (archivos de A) | gerenteSinClub | sí | sí |
| storage | club-photos leer de A por ruta exacta (bucket público) | gerenteSinClub | sí | sí |
| storage | club-photos leer de B por ruta exacta (bucket público) | gerenteSinClub | sí | sí |
| rutas | create-staff del gerente normal (control) | gerenteA | sí | sí |

#### Escaneo de NULL (133 funciones; 25 con patrón)

| Función | Patrón | Veredicto |
|---|---|---|
| `_admin_alta_club_base(jsonb)` | rol-not-in | seguro: es el cuerpo de admin_alta_club renombrado por b-alta 12; solo service_role lo ejecuta y repite la puerta de admin (is distinct from), con el mismo «v_rol not in» que rechaza el INSERT en profiles.role (not null) |
| `actividad_club(uuid,date,date)` | if-not-funcion | seguro: es_gerente_o_dueno() nunca devuelve NULL (coalesce y ramas booleanas) |
| `caja_abrir_mesa(uuid)` | if-not-funcion | seguro: caja_tiene_permiso() solo es NULL si el permiso es NULL; aquí es una constante |
| `caja_anular_consumo(uuid,text)` | if-not-funcion | seguro: caja_tiene_permiso() con permiso constante |
| `caja_anular_pago(uuid,text)` | if-not-funcion | seguro: caja_tiene_permiso() con permiso constante |
| `caja_cerrar_mesa(uuid)` | if-not-funcion | seguro: caja_tiene_permiso() con permiso constante |
| `caja_cerrar_noche(uuid,bigint,bigint,bigint,text)` | if-not-funcion | seguro: caja_tiene_permiso() con permiso constante |
| `caja_cuadrar_mesa(uuid,text)` | if-not-funcion | seguro: caja_tiene_permiso() con permiso constante |
| `caja_reabrir_mesa(uuid,text)` | if-not-funcion | seguro: caja_tiene_permiso() con permiso constante |
| `caja_registrar_consumo_producto(uuid,uuid,integer,uuid)` | if-not-funcion | seguro: caja_tiene_permiso() con permiso constante; «if not v_prod.activo» sobre columna not null |
| `caja_registrar_consumo(uuid,bigint,text,uuid)` | if-not-funcion | seguro: caja_tiene_permiso() con permiso constante |
| `caja_sentar_cliente(uuid,uuid,text,integer)` | if-not-funcion | seguro: caja_tiene_permiso() con permiso constante |
| `caja_sin_borrar()` | if-not-sin-coalesce | seguro: trigger; compara estados con valores not null y no autoriza por rol |
| `caja_tiene_permiso(uuid,text)` | rol-not-in | seguro: «v_rol is null or v_rol not in (…)» |
| `clubs_candado_verificacion()` | if-not-sin-coalesce | seguro: el «if not (old.estado in … and new.estado = …)» compara columnas not null con check; la puerta de admin es «= 'admin'» (NULL no la abre) |
| `clubs_candado_zona_horaria()` | distinto-admin | seguro: coalesce(current_role_name(), '') <> 'admin' |
| `config_rp_actual(uuid)` | if-not-funcion | seguro: es_gerente_o_dueno() nunca devuelve NULL |
| `config_rp_cambiar_regla(uuid,text,integer,integer,bigint)` | if-not-funcion | seguro: es_gerente_o_dueno() nunca NULL; «p_tipo not in» va después de «p_tipo is null» |
| `config_rp_cambiar_visibilidad(uuid,text)` | if-not-funcion | seguro: es_gerente_o_dueno() nunca NULL; un p_nivel NULL lo rechaza el check de club_config_rp |
| `config_rp_historial(uuid)` | if-not-funcion | seguro: es_gerente_o_dueno() nunca NULL |
| `nomina_cambiar_estado(uuid,uuid,integer,integer,text,text,text)` | if-not-funcion | arreglado en sql/post-junta-2/60: nomina_transicion_valida(NULL, …) daba NULL y pasaba el if; era inocuo (el UPDATE con status = NULL no toca filas) pero ahora rechaza |
| `nomina_semana(uuid,integer,integer)` | if-not-sin-coalesce | seguro: es_gerente_o_dueno() y club_es_dueno_grupo() nunca devuelven NULL (probado con sesión real: sin perfil, baja y temporal) |
| `nomina_transicion_valida(text,text)` | if-not-funcion | arreglado en sql/post-junta-2/60 (coalesce) |
| `producto_guardar(uuid,uuid,text,text,bigint,integer,boolean,integer)` | if-not-funcion | seguro: es_gerente_o_dueno() nunca NULL |
| `producto_importar(uuid,jsonb)` | if-not-funcion | seguro: es_gerente_o_dueno() nunca NULL |

#### Ayudantes boolean (17)

| Función | En políticas | En «if not f(…)» de | Veredicto |
|---|---|---|---|
| `_club_config_puede(uuid,text)` | 0 | — | nunca NULL: cada rama en coalesce(…, false) |
| `_config_aplicar_club(uuid,text,jsonb,uuid,date,boolean)` | 0 | — | SIN REVISAR |
| `caja_puede_ver(uuid)` | 17 | — | nunca NULL: coalesce(…, false) |
| `caja_tiene_permiso(uuid,text)` | 0 | caja_abrir_mesa, caja_anular_consumo, caja_anular_pago, caja_cerrar_mesa, caja_cerrar_noche, caja_cuadrar_mesa, caja_reabrir_mesa, caja_registrar_consumo_producto, caja_registrar_consumo, caja_sentar_cliente | NULL solo si p_permiso es NULL («return p_permiso in (…)»); todos los que llaman pasan una constante y caja_permisos.permitido es not null |
| `club_es_dueno(uuid)` | 8 | — | nunca NULL: «uid is not null and rol is not null and exists(…)» |
| `club_es_dueno_grupo(uuid)` | 1 | — | nunca NULL: «uid is not null and rol is not null and exists(…)» |
| `dueno_tiene_club()` | 1 | — | nunca NULL: exists(…) (sql/post-junta-2/62) |
| `es_dueno_de_grupo(uuid)` | 0 | — | nunca NULL: coalesce(uid is not null and rol = dueno and exists(…), false) |
| `es_gerente_o_dueno(uuid)` | 5 | actividad_club, config_rp_actual, config_rp_cambiar_regla, config_rp_cambiar_visibilidad, config_rp_historial, nomina_cambiar_estado, producto_guardar, producto_importar | nunca NULL: coalesce y ramas booleanas |
| `grupo_puede_editar(uuid)` | 0 | — | nunca NULL: coalesce(… admin, false) or es_dueno_de_grupo() (nunca NULL) |
| `invitacion_puede(uuid,text)` | 2 | — | nunca NULL: returns false / coalesce en cada rama |
| `nomina_transicion_valida(text,text)` | 0 | nomina_cambiar_estado | nunca NULL desde sql/post-junta-2/60 (antes NULL con estados nulos) |
| `puede_ver_club(uuid)` | 3 | — | nunca NULL: coalesce |
| `puerta_es_tarde(uuid,date,timestamp with time zone)` | 0 | — | NULL a propósito (antro sin tolerancia); no autoriza: solo llena reservations.llegada_tarde |
| `rp_es_del_club(uuid,uuid)` | 6 | — | nunca NULL: coalesce(exists(…), false) (sql/post-junta-2/64) |
| `sesion_sin_acceso()` | 7 | — | nunca NULL: «uid is not null and (exists(…) or coalesce(…))» (sql/post-junta-2/61) |
| `soy_rp_dado_de_baja()` | 2 | — | nunca NULL: exists(…) |
