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

> **27/11/2026 (post-junta-3, bloque 9):** con 00–81 aplicados en dev,
> `--estricto`, sin servidor: **13,372 de 13,372 coinciden** (dos corridas;
> detalle en «Post-junta-3» abajo). Con antifraude (30) integrado (parte 3):
> **14,116 de 14,116** (dos corridas). Lo que sigue es la corrida del 25/11.

Corrida del 25/11/2026 (tarde, dev con 60–68 aplicados, `--estricto`,
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

## Post-junta-3 (bloque 9, parte 2, 27/11/2026)

Rama `n4-auditoria` (sobre `post-junta-3`), solo contra antroapp-dev, con los
SQL `sql/post-junta-3/00`–`81` aplicados en dev. **Antifraude (30, tablas
`fraude_*`) quedó fuera en esta parte** (su rama se estaba corrigiendo; se
integró en la parte 3, más abajo). Sus 6
tablas salen como aviso «tabla sin matriz y sin GRANT … — ANTIFRAUDE (30),
pendiente a propósito» (el script sí comprueba que ninguna sesión las toca) y
el lugar para su matriz y sus funciones está marcado `ANTIFRAUDE` en
`SIN_API_PJ3` y en `correrFuncionesPj3`.

### Qué se agregó a C1 (`scripts/dev/auditoria-rls.mjs`)

- **Escenario** (`escenarioPj3`): el admin enciende con `funcion_cambiar`
  las banderas `pos_ventas`, `escaner_respaldo`, `lista_negra`, `whatsapp`,
  `inventario` y `propinas` **solo para los antros de prueba A y B**;
  `reportes_pdf` de A llega por su grupo G (`grupo_funcion_cambiar`, para
  probar la herencia) y B la tiene propia. Las banderas viven en
  `club_funciones`/`grupo_funciones` y se van con los antros y grupos de
  prueba. Datos por el camino real de cada función (gerente de cada antro):
  mapeo e importación del POS ligada sola a la mesa 2, política y un bloqueo
  de la lista negra (teléfono distinto en A y en B), plantilla de WhatsApp,
  entrada de inventario, regla de propinas, propina suelta, cobro con
  propina anulada sola y un reparto (este con la service role, porque el
  reparto pide la noche cerrada y la mesa 2 sigue abierta para otras
  pruebas; el candado `propinas_candado` revisa la coherencia). Contactos,
  intentos y bitácora de /para-clubes, con la service role (no se tocan las
  banderas de plataforma, que son de todos).
- **Matriz de tablas** (las 22 de post-junta-3 sin antifraude):
  - 18 **sin acceso por la API** (`SIN_API_PJ3`): `club_funciones`,
    `grupo_funciones`, `funciones_cambios`, `pos_mapeos`,
    `pos_importaciones`, `pos_importacion_lineas`, `pos_ventas`,
    `club_bloqueos`, `club_noshow_politica`, `lista_negra_eventos`,
    `plataforma_banderas`, `para_clubes_bitacora`, `contactos_clubes`,
    `contacto_sal`, `contacto_intentos`, `club_whatsapp_plantillas`,
    `whatsapp_plantillas_cambios`, `propinas_config`. Esperado: sin GRANT
    para anon ni authenticated y, para las 19 sesiones (también el admin),
    ni SELECT (ninguna fila y tampoco la sembrada), ni INSERT, ni UPDATE con
    el mismo valor, ni DELETE.
  - 4 de **propinas con SELECT** (`SPEC`): `caja_propinas` y
    `propinas_cobro_anuladas` las ve quien ve la caja de **ese** antro
    (`caja_puede_ver`: admin, dueño, dueño de grupo, staff y gerente
    activos); `propinas_repartos` y `propinas_reparto_lineas`, solo gerente y
    dueño (`es_gerente_o_dueno`, sin dueño de grupo). Nadie escribe directo.
    Cruces A↔B incluidos.
- **Funciones** (`correrFuncionesPj3`), las 19 sesiones contra A:
  1. Con las banderas de A **apagadas** (y `reportes_pdf` apagada en el antro
     aunque su grupo la tenga encendida): 15 funciones donde quien tiene
     permiso recibe «no está activa» y quien no, el rechazo de permiso (el
     permiso va antes que la bandera: a quien no tiene acceso no se le dice
     si el antro la tiene); `mis_funciones`, `pos_mis_antros`,
     `boleto_muestra_codigo`, `lista_negra_aviso` y `whatsapp_plantillas` no
     devuelven nada a nadie; y con la lista negra apagada un teléfono
     bloqueado reserva como hoy.
  2. Se vuelven a encender y `reportes_pdf` regresa al grupo (`null`); se
     comprueba que la app las ve así.
  3. Encendidas: las ~60 funciones de 00, 10, 20, 40, 50, 60, 70, 80 y 81
     con quién puede cada una (admin; dueño; dueño de grupo; gerente; staff;
     RP de sus reservas; con sesión; anónimo), con argumentos que no cambian
     datos donde se puede (archivo ya importado, teléfono ya bloqueado,
     bloqueo inexistente, cantidad 0, noche abierta para el reparto…).
     `pos_mapeo_borrar` (no distingue «no existe» de «no es tuyo») se prueba
     una sesión a la vez con un mapeo de sacrificio.
- **Candados** (`candadosPj3`): teléfono bloqueado al reservar como cliente
  (también escrito «+52 1 …»), sin cuenta y como RP, con el aviso P0001 de
  cada rol y sin motivo; un bloqueo de A no afecta a B; el staff no le pone
  a una reserva un teléfono bloqueado; y 13 cruces «pido por A con datos de
  B» (bloquear desde una reserva de B, ver el teléfono o desbloquear un
  bloqueo de B, ligar una venta a una cuenta de B, deshacer una importación
  de B, propina en la noche o con una cuenta de B, anular el reparto de B,
  entrada diferida o código corto de una reserva de B, merma de un producto
  de B, WhatsApp de una reserva de B, aviso de no-shows de la reserva de
  otro RP).
- **Catálogo** (`catalogoPj3`): para cada función de 00–81, que anon y
  authenticated tengan exactamente el EXECUTE esperado (internas solo
  service_role; las de la app, authenticated; `lista_negra_tel`,
  `boleto_muestra_codigo`, `para_clubes_activa` y
  `para_clubes_contacto_enviar` también anon) y que toda SECURITY DEFINER
  tenga `search_path` fijo.
- **Escaneo de NULL**: ya recorre todas las funciones de `public`; las nuevas
  solo tenían un patrón (`if not para_clubes_activa()` en
  `para_clubes_contacto_enviar`) y un ayudante boolean sin veredicto
  (`para_clubes_activa`). Los dos son seguros (`coalesce(…, false)`, nunca
  NULL) y quedaron con veredicto, junto con los 9 ayudantes boolean nuevos
  (`funcion_activa`, `pos_puede_usar`, `_lista_negra_*`, `_whatsapp_trabaja`,
  `boleto_muestra_codigo`, `para_clubes_activa`).
- **`--limpiar=t_rls_xxxxxx`**: borra los restos de una corrida cortada
  (dos corridas de este carril murieron sin llegar al `finally`; ver
  «Inestable»). `AUDITORIA_TRAZA=1` imprime cada tabla y fase.

### Resultado de C1

Dos corridas completas seguidas (`--estricto`, sin servidor), las dos:
**13,372 de 13,372 coinciden, 0 no coinciden, 0 funciones sin veredicto,
sale con 0**; limpieza sin restos (0 antros, 0 cuentas, 0 perfiles, 0 filas
de post-junta-3).

| Grupo | 25/11 | 27/11 |
|---|---|---|
| Tablas | 8,165 | 10,567 (22 tablas nuevas, con RLS; 18 sin GRANT) |
| Funciones por RPC (incluye catálogo) | 494 | 2,331 |
| Candados | 30 | 54 |
| Storage | 420 | 420 |

Avisos que quedan: las 6 tablas `fraude_*` (antifraude, a propósito), las 3
de b-alta 12 sin GRANT (`club_config_propia`, `grupo_config`,
`grupo_config_cambios`, de antes) y las rutas sin servidor. Ninguna tabla de
post-junta-3 queda «sin matriz». **No apareció ningún hueco de seguridad**:
todo lo esperado coincidió (incluido que el dueño de grupo sí ve los reportes
PDF, la lista negra y el POS de su antro pero no opera la puerta ni la caja,
y que los repartos de propinas no los ve).

Lo único «por diseño» que vale la pena saber: `mis_funciones` de un antro
**publicado** responde a cualquier sesión (también cliente o cuenta sin
perfil), porque usa `puede_ver_club`: cualquiera con cuenta puede saber qué
funciones en prueba tiene encendidas un antro publicado. Es lo que dice el
SQL 00; si no se quiere, que exija ser personal del antro.

### Qué se agregó a C5 (`scripts/dev/probar-concurrencia-noche3.mjs`, casos 7–13)

Antro C propio («T rls conc C …»), con sus banderas encendidas por un admin
de prueba (se van con el antro); `--solo-pj3` corre solo estos casos.

| # | Caso (todo a la vez con sesiones reales; «forzada» = dos transacciones abiertas) | Invariante |
|---|---|---|
| 7 | Dos admins cambian la misma bandera (7 rondas, también `null`) y carrera forzada | lo guardado = lo último de la bitácora; 14 entradas; la app ve lo guardado; el segundo espera y queda al final |
| 8 | El mismo archivo del POS 3 veces (2 gerentes y el dueño); dos archivos que se enciman; dos «deshacer»; carrera forzada; dos mapeos nuevos con el mismo nombre (forzada) | una importación vigente por huella; cada línea una vez (3 nuevas + 1 repetida); deshacer una vez («ya se deshizo») y la línea compartida se conserva; avisos P0001 |
| 9 | Dos staff mandan la misma entrada diferida desde dos teléfonos; el mismo envío 3 veces (misma clave); la clave con otra reserva; diferida contra cámara | una «entro» y otra «ya_entro» (sin error, «otra cuenta» y hora); un evento de entrada y uno de envío; reintento «ya_enviada»; clave ajena rechazada |
| 10 | Tres bloqueos del mismo teléfono (y forzada); bloqueo contra 4 reservas del RP con ese teléfono; desbloqueo contra 3; dos desbloqueos | un bloqueo abierto; cada reserva entra o recibe el aviso del RP; después del bloqueo se rechaza y después del desbloqueo entra; un desbloqueo («no está bloqueado») |
| 11 | Dos staff venden la última pieza; la misma venta 3 veces; entrada + merma + venta; la misma merma 2 veces; conteo mientras se vende | ninguna venta perdida (1 − 2 = −1; vender sin existencias es a propósito, decisión 2 de `docs/post-junta-3/fase2.md`); existencias = suma de la bitácora siempre; reintentos una vez; el conteo no absorbe la venta |
| 12 | Anular una propina contra el reparto; el mismo reparto dos veces (doble clic); tres repartos distintos; carrera forzada | pasa exactamente uno y el otro recibe «ya se repartió» o «las propinas cambiaron»; nunca un reparto con una propina anulada; un reparto vigente que cuadra al centavo |
| 13 | /para-clubes: 8 envíos desde la misma IP; el mismo correo desde 5 IP; 5 con la casilla trampa | pasan exactamente 3 y 3; los demás «Ya recibimos varios mensajes…» (P0001); la trampa responde «recibido» y no guarda ni cuenta; 6 contactos; la bandera queda como estaba |

El caso 13 va por el camino de la ruta con CAPTCHA (service role con `p_ip`
de prueba `10.250.x.y`): por la API anónima la IP es la real de la máquina,
que comparten todos los carriles, y 3 envíos la dejarían una hora sin poder
probar el formulario. `para_clubes` (bandera de plataforma) se enciende
**solo durante la ráfaga** y se deja como estaba (también si el script se
corta: lo apaga la limpieza). Se salta si ya hay más de 40 envíos en la
última hora (el tope global de 60 la haría poco fiable). Los intentos se
borran por la huella de las IP y correos de prueba.

### Resultado de C5

Dos corridas completas (casos 1–13): **113/116** cada una (antes, una de
solo 7–13 sin el 8k/8l: 61/62). Las 3 que fallan son los defectos D1 y D2 de
abajo; todo lo demás, incluidos los casos 1–6 de la noche 3, pasa.

### Defectos encontrados (reales; no se tocó código de producto)

Ninguno es de seguridad: en los dos el índice único protege el dato (queda
un solo bloqueo, un solo mapeo). Lo que está mal es la respuesta al segundo.

| # | Gravedad | Defecto | Dónde | Reproducción |
|---|---|---|---|---|
| D1 | BAJA (mensaje) | **Dos bloqueos del mismo teléfono a la vez**: el segundo recibe el error crudo del índice (`23505 duplicate key value violates unique constraint "club_bloqueos_abierto"`) en vez de «Ese teléfono ya está bloqueado en este antro.» (P0001). La pantalla lo pasa por `mensajeParaUsuario` y muestra «Eso ya está registrado.». `lista_negra_bloquear` revisa con `if exists (…)` y luego inserta, sin candado ni `exception when unique_violation`. | `sql/post-junta-3/40-lista-negra.sql:628-635` | C5 10c (carrera forzada, siempre) y 10b (3 sesiones a la vez por la API: falló en 2 de 3 corridas). Arreglo sugerido: `pg_advisory_xact_lock` por antro y teléfono antes del `exists`, o atrapar `unique_violation` y lanzar el aviso. |
| D2 | BAJA (mensaje) | **Dos gerentes guardan a la vez un mapeo NUEVO con el mismo nombre**: el segundo recibe `23505 … "pos_mapeos_nombre"` en vez de reemplazarlo («guarda o reemplaza por nombre»). El `select … for update` no bloquea nada cuando la fila aún no existe. Por la misma razón el tope de 30 mapeos por antro (`count(*)` y luego `insert`) se puede pasar con guardados simultáneos (no medido). | `sql/post-junta-3/10-pos-ventas.sql:617-632` | C5 8l (carrera forzada, siempre). Arreglo sugerido: `pg_advisory_xact_lock` por antro al inicio, o `insert … on conflict` sobre el índice por nombre. |

### Inestable (no son defectos del producto)

- Dos corridas de C1 **murieron sin llegar al `finally`** (una a los 3.5 min
  con salida 127 sin mensaje; otra se quedó colgada media hora en
  `candadosPj3` sin ninguna consulta activa en la base). Fue la red o el
  proceso, no la base: las mismas pruebas pasaron en las corridas
  siguientes. Desde entonces cada petición de los dos scripts lleva un tope
  de 90 s (una petición colgada sale como error y la limpieza corre) y los
  restos se borran con `--limpiar=t_rls_xxxxxx` (se usó tres veces; quedaron
  0 antros, 0 cuentas y 0 filas de post-junta-3).
- 10b depende del orden en que lleguen las peticiones (por eso está la
  carrera forzada 10c, que es determinista).

### Lo que no se cubrió

- Las rutas con service role (`--base`): no había servidor de esta rama en
  3026; la ruta nueva `/api/para-clubes/contacto` (CAPTCHA) no se probó por
  HTTP, solo la función que llama (caso 13 de C5).
- El formulario por la API anónima con la IP real (ver caso 13).
- `pos_importar` con 5,000 líneas a la vez (lo mide `probar-pos-carga.mjs`).
- Validar que lo que muestra la pantalla ante D1/D2 sea «Eso ya está
  registrado.» (se dedujo de `lib/errores-base.ts`, no se vio en pantalla).

## Post-junta-3: antifraude (bloque 9, parte 3, 27/11/2026)

Rama `n4-auditoria2` (sobre `post-junta-3` con `sql/post-junta-3/30-antifraude-rps.sql`
ya integrado), solo contra antroapp-dev, con los arreglos de D1 y D2 del
coordinador ya aplicados en dev.

**C1** (en las marcas `ANTIFRAUDE`):
- **Escenario**: la bandera `antifraude` se enciende para A y B con las
  demás. El gerente de cada antro baja la regla de ráfaga a 3 reservas en
  240 min, la service role crea 3 reservas del RP del antro y el gerente
  busca de verdad (`fraude_detectar`): sale una alerta de ráfaga por antro.
  Luego la descarta y la reabre con nota (2 renglones en la bitácora).
- **Matriz** (`SIN_API_PJ3`): las 6 tablas `fraude_*` sin GRANT para anon ni
  authenticated y, para las 19 sesiones (también el admin), sin SELECT,
  INSERT, UPDATE ni DELETE. `fraude_secreto` (clave del HMAC): además, la
  **service role tampoco la lee** (se comprueba; por eso su fila «original»
  va fija en el script).
- **Funciones**: con la bandera de A apagada, `fraude_reglas_leer`,
  `fraude_detectar`, `fraude_alertas_listar`, `fraude_alerta_detalle` y
  `fraude_alerta_cambiar` dan «no está activa» a quien tiene permiso y el
  rechazo de permiso a los demás; `fraude_mis_antros` muestra A «no activa».
  Encendida: las 11 funciones de la app contra A **y contra B**. Puede el
  admin, el dueño, el gerente activo y el dueño de grupo **solo en A** (su
  grupo es G = {A}; en B, no). El staff puro, los RPs, el cliente, las
  bajas, las contraseñas temporales y el gerente sin antro no ven nada. El
  gerente de B no lee ni cambia nada de A (ni A de B). `fraude_catalogo` lo
  puede leer toda sesión (es el catálogo fijo de umbrales, sin datos).
  Catálogo: las 8 internas, solo service_role; las 11 de la app, solo
  authenticated; todas las SECURITY DEFINER con `search_path` fijo.
- **Escaneo de NULL**: sin patrones (sus dos «if not» van en
  `coalesce(…, false)`); veredicto para `fraude_puede_revisar` y
  `fraude_regla_activa` (nunca NULL).

**C5**, caso 14 (antro C):
- **Tres búsquedas a la vez** (2 gerentes y el dueño): corre una y las
  otras reciben «hace menos de 2 minutos» (P0001). Las alertas no se
  duplican y son las «nuevas» de esa búsqueda. Otra búsqueda enseguida
  también se rechaza.
- **Carrera forzada**, después de mover la última búsqueda 3 minutos atrás
  (solo en el antro de prueba): la segunda espera a la primera y se
  rechaza. Volver a buscar da 0 nuevas.
- **Dos gerentes con la misma alerta**: descartar contra confirmar, dos
  reaperturas, la misma decisión con doble clic (gerente y dueño) y una
  carrera forzada. En cada caso gana uno y el otro recibe «Primero vuelve a
  poner la alerta en revisión» o «ya está en ese estado». La bitácora tiene
  exactamente una transición por cambio, con la nota del que ganó (ninguna
  se pierde ni se mezcla).
- El staff puro y el RP del antro reciben P0001 sin datos.

**Resultados** (dos corridas de cada uno):
- C1 `--estricto`: **14,116 de 14,116 coinciden, 0 no coinciden, 0 sin
  veredicto**, las dos veces. Ya no hay avisos de `fraude_*`; quedan solo
  las 3 tablas de b-alta y las rutas sin servidor.
- C5 completo (casos 1–14): **129/129**, las dos veces (más una de solo
  7–14: 77/77). **D1 y D2 ya pasan** con el arreglo del coordinador en dev
  (8l «lo reemplazó»; 10b y 10c «Ese teléfono ya está bloqueado»).
- Limpieza sin restos en todas.

**Defectos reales de antifraude: ninguno.**

## Matriz completa (salida de la última corrida)

<!-- generado por scripts/dev/auditoria-rls.mjs 2026-11-27T22:52:11.106Z -->
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

#### caja_propinas

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

#### club_bloqueos

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

#### club_funciones

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

#### club_noshow_politica

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

#### club_whatsapp_plantillas

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

#### contacto_intentos

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

#### contacto_sal

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

#### contactos_clubes

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

#### fraude_alertas

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

#### fraude_alertas_cambios

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

#### fraude_detecciones

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

#### fraude_reglas

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

#### fraude_reglas_cambios

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

#### fraude_secreto

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

#### funciones_cambios

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

#### grupo_funciones

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

#### lista_negra_eventos

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

#### para_clubes_bitacora

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

#### plataforma_banderas

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

#### pos_importacion_lineas

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

#### pos_importaciones

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

#### pos_mapeos

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

#### pos_ventas

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

#### propinas_cobro_anuladas

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

#### propinas_config

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

#### propinas_reparto_lineas

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

#### propinas_repartos

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

#### whatsapp_plantillas_cambios

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

#### Funciones, candados, storage y rutas

| Grupo | Prueba | Sesión | Esperado | Obtenido |
|---|---|---|---|---|
| RPC | nomina_semana | gerenteA | sí | sí |
| RPC | nomina_semana | admin | sí | sí |
| RPC | nomina_semana | duenoA | sí | sí |
| RPC | nomina_semana | duenoGrupo | sí | sí |
| RPC | grupo_rendimiento_rp | duenoGrupo | sí | sí |
| RPC | grupo_rendimiento_rp | duenoA | sí | sí |
| RPC | grupo_rendimiento_rp | gerenteA | sí | sí |
| RPC | grupo_rendimiento_rp | admin | sí | sí |
| RPC | actividad_club | duenoA | sí | sí |
| RPC | actividad_club | gerenteA | sí | sí |
| RPC | actividad_club | admin | sí | sí |
| RPC | personal_historial | duenoA | sí | sí |
| RPC | personal_historial | gerenteA | sí | sí |
| RPC | personal_historial | admin | sí | sí |
| RPC | config_rp_actual | gerenteA | sí | sí |
| RPC | config_rp_actual | admin | sí | sí |
| RPC | config_rp_actual | duenoA | sí | sí |
| RPC | config_rp_historial | duenoA | sí | sí |
| RPC | config_rp_historial | gerenteA | sí | sí |
| RPC | config_rp_historial | admin | sí | sí |
| RPC | config_rp_cambiar_visibilidad | gerenteA | sí | sí |
| RPC | config_rp_cambiar_visibilidad | duenoA | sí | sí |
| RPC | config_rp_cambiar_visibilidad | admin | sí | sí |
| RPC | caja_configurar_permiso | admin | sí | sí |
| RPC | caja_configurar_permiso | duenoA | sí | sí |
| RPC | producto_guardar | gerenteA | sí | sí |
| RPC | producto_guardar | duenoA | sí | sí |
| RPC | producto_guardar | admin | sí | sí |
| RPC | nomina_cambiar_estado | admin | sí | sí |
| RPC | nomina_cambiar_estado | duenoA | sí | sí |
| RPC | nomina_cambiar_estado | gerenteA | sí | sí |
| RPC | caja_registrar_consumo | duenoA | sí | sí |
| RPC | caja_registrar_consumo | staffA | sí | sí |
| RPC | caja_registrar_consumo | gerenteA | sí | sí |
| RPC | caja_registrar_consumo | admin | sí | sí |
| RPC | puerta_escanear | admin | sí | sí |
| RPC | puerta_escanear | staffA | sí | sí |
| RPC | puerta_escanear | gerenteA | sí | sí |
| RPC | puerta_escanear | duenoA | sí | sí |
| RPC | registrar_pago_dia | admin | sí | sí |
| RPC | registrar_pago_dia | gerenteA | sí | sí |
| RPC | registrar_pago_dia | staffA | sí | sí |
| RPC | registrar_pago_dia | duenoA | sí | sí |
| RPC | registrar_comision_reserva | staffA | sí | sí |
| RPC | registrar_comision_reserva | duenoA | sí | sí |
| RPC | registrar_comision_reserva | admin | sí | sí |
| RPC | registrar_comision_reserva | gerenteA | sí | sí |
| RPC | admin_alta_club | admin | sí | sí |
| RPC | caja_mis_permisos | duenoA | sí | sí |
| RPC | caja_mis_permisos | staffA | sí | sí |
| RPC | caja_mis_permisos | admin | sí | sí |
| RPC | caja_mis_permisos | gerenteA | sí | sí |
| RPC | rp_mis_reservas | rpB | sí | sí |
| RPC | rp_mis_reservas | rpA | sí | sí |
| RPC | rp_progreso_cuota | rpA | sí | sí |
| RPC | rp_progreso_cuota | rpB | sí | sí |
| RPC | nomina_semana_mia | rpB | sí | sí |
| RPC | nomina_semana_mia | rpA | sí | sí |
| RPC | obtener_reserva_por_qr | rpA | sí | sí |
| RPC | obtener_reserva_por_qr | duenoA | sí | sí |
| RPC | obtener_reserva_por_qr | sinperfil | sí | sí |
| RPC | obtener_reserva_por_qr | anon | sí | sí |
| RPC | obtener_reserva_por_qr | admin | sí | sí |
| RPC | obtener_reserva_por_qr | rpB | sí | sí |
| RPC | obtener_reserva_por_qr | staffBajaA | sí | sí |
| RPC | obtener_reserva_por_qr | rpTemp | sí | sí |
| RPC | obtener_reserva_por_qr | rpBaja | sí | sí |
| RPC | obtener_reserva_por_qr | staffA | sí | sí |
| RPC | obtener_reserva_por_qr | gerenteTemp | sí | sí |
| RPC | obtener_reserva_por_qr | duenoGrupo | sí | sí |
| RPC | obtener_reserva_por_qr | staffB | sí | sí |
| RPC | obtener_reserva_por_qr | duenoTemp | sí | sí |
| RPC | obtener_reserva_por_qr | gerenteSinClub | sí | sí |
| RPC | obtener_reserva_por_qr | gerenteA | sí | sí |
| RPC | obtener_reserva_por_qr | duenoB | sí | sí |
| RPC | obtener_reserva_por_qr | cliente | sí | sí |
| RPC | obtener_reserva_por_qr | gerenteB | sí | sí |
| RPC | personal_cambiar_estado (staff de A) | admin | sí | sí |
| RPC | personal_cambiar_estado (staff de A) | duenoA | sí | sí |
| RPC | personal_cambiar_estado (staff de A) | gerenteA | sí | sí |
| RPC | personal_cambiar_estado (staff de B) | admin | sí | sí |
| RPC | personal_cambiar_estado (staff de B) | duenoB | sí | sí |
| RPC | personal_cambiar_estado (staff de B) | gerenteB | sí | sí |
| RPC | invitacion_crear rp en A | staffA | sí | sí |
| RPC | invitacion_crear rp en A | duenoA | sí | sí |
| RPC | invitacion_crear rp en A | gerenteA | sí | sí |
| RPC | invitacion_crear rp en A | admin | sí | sí |
| RPC | invitacion_crear gerente en A | duenoA | sí | sí |
| RPC | invitacion_crear gerente en A | admin | sí | sí |
| RPC | grupo_resumen ve A | duenoGrupo | sí | sí |
| RPC | grupo_resumen ve B | gerenteB | sí | sí |
| RPC | grupo_resumen ve A | gerenteA | sí | sí |
| RPC | grupo_resumen ve A | duenoA | sí | sí |
| RPC | grupo_resumen ve B | duenoB | sí | sí |
| RPC | grupo_resumen ve A | admin | sí | sí |
| RPC | grupo_resumen ve B | admin | sí | sí |
| RPC | pos_mapeos_lista con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | pos_mapeos_lista con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | pos_mapeos_lista con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | pos_mapeos_lista con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | pos_mapeos_lista con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | pos_mapeos_lista con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | pos_mapeos_lista con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | pos_mapeos_lista con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | pos_mapeos_lista con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | pos_mapeos_lista con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | pos_mapeos_lista con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | pos_mapeos_lista con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | pos_mapeos_lista con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | pos_mapeos_lista con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | pos_mapeos_lista con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | pos_mapeos_lista con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | pos_mapeos_lista con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | pos_mapeos_lista con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | pos_mapeos_lista con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | pos_importar con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | pos_importar con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | pos_importar con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | pos_importar con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | pos_importar con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | pos_importar con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | pos_importar con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | pos_importar con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | pos_importar con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | pos_importar con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | pos_importar con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | pos_importar con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | pos_importar con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | pos_importar con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | pos_importar con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | pos_importar con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | pos_importar con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | pos_importar con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | pos_importar con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | puerta_copia_noche con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | puerta_copia_noche con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | puerta_copia_noche con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | puerta_copia_noche con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | puerta_copia_noche con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | puerta_copia_noche con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | puerta_copia_noche con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | puerta_copia_noche con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | puerta_copia_noche con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | puerta_copia_noche con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | puerta_copia_noche con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | puerta_copia_noche con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | puerta_copia_noche con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | puerta_copia_noche con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | puerta_copia_noche con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | puerta_copia_noche con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | puerta_copia_noche con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | puerta_copia_noche con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | puerta_copia_noche con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | puerta_escanear_codigo con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | puerta_escanear_codigo con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | puerta_escanear_codigo con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | puerta_escanear_codigo con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | puerta_escanear_codigo con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | puerta_escanear_codigo con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | puerta_escanear_codigo con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | puerta_escanear_codigo con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | puerta_escanear_codigo con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | puerta_escanear_codigo con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | puerta_escanear_codigo con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | puerta_escanear_codigo con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | puerta_escanear_codigo con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | puerta_escanear_codigo con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | puerta_escanear_codigo con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | puerta_escanear_codigo con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | puerta_escanear_codigo con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | puerta_escanear_codigo con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | puerta_escanear_codigo con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | puerta_entrada_diferida con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | puerta_entrada_diferida con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | puerta_entrada_diferida con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | puerta_entrada_diferida con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | puerta_entrada_diferida con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | puerta_entrada_diferida con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | puerta_entrada_diferida con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | puerta_entrada_diferida con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | puerta_entrada_diferida con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | puerta_entrada_diferida con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | puerta_entrada_diferida con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | puerta_entrada_diferida con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | puerta_entrada_diferida con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | puerta_entrada_diferida con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | puerta_entrada_diferida con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | puerta_entrada_diferida con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | puerta_entrada_diferida con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | puerta_entrada_diferida con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | puerta_entrada_diferida con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | lista_negra_bloqueos con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | lista_negra_bloqueos con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | lista_negra_bloqueos con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | lista_negra_bloqueos con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | lista_negra_bloqueos con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | lista_negra_bloqueos con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | lista_negra_bloqueos con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | lista_negra_bloqueos con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | lista_negra_bloqueos con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | lista_negra_bloqueos con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | lista_negra_bloqueos con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | lista_negra_bloqueos con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | lista_negra_bloqueos con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | lista_negra_bloqueos con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | lista_negra_bloqueos con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | lista_negra_bloqueos con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | lista_negra_bloqueos con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | lista_negra_bloqueos con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | lista_negra_bloqueos con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | lista_negra_bloquear con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | lista_negra_bloquear con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | lista_negra_bloquear con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | lista_negra_bloquear con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | lista_negra_bloquear con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | lista_negra_bloquear con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | lista_negra_bloquear con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | lista_negra_bloquear con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | lista_negra_bloquear con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | lista_negra_bloquear con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | lista_negra_bloquear con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | lista_negra_bloquear con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | lista_negra_bloquear con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | lista_negra_bloquear con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | lista_negra_bloquear con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | lista_negra_bloquear con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | lista_negra_bloquear con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | lista_negra_bloquear con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | lista_negra_bloquear con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | whatsapp_plantilla_guardar con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | whatsapp_plantilla_guardar con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | whatsapp_plantilla_guardar con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | whatsapp_plantilla_guardar con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | whatsapp_plantilla_guardar con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | whatsapp_plantilla_guardar con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | whatsapp_plantilla_guardar con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | whatsapp_plantilla_guardar con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | whatsapp_plantilla_guardar con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | whatsapp_plantilla_guardar con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | whatsapp_plantilla_guardar con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | whatsapp_plantilla_guardar con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | whatsapp_plantilla_guardar con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | whatsapp_plantilla_guardar con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | whatsapp_plantilla_guardar con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | whatsapp_plantilla_guardar con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | whatsapp_plantilla_guardar con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | whatsapp_plantilla_guardar con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | whatsapp_plantilla_guardar con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | clientes_noche con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | clientes_noche con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | clientes_noche con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | clientes_noche con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | clientes_noche con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | clientes_noche con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | clientes_noche con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | clientes_noche con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | clientes_noche con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | clientes_noche con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | clientes_noche con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | clientes_noche con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | clientes_noche con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | clientes_noche con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | clientes_noche con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | clientes_noche con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | clientes_noche con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | clientes_noche con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | clientes_noche con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | reporte_pdf_noche con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | reporte_pdf_noche con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | reporte_pdf_noche con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | reporte_pdf_noche con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | reporte_pdf_noche con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | reporte_pdf_noche con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | reporte_pdf_noche con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | reporte_pdf_noche con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | reporte_pdf_noche con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | reporte_pdf_noche con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | reporte_pdf_noche con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | reporte_pdf_noche con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | reporte_pdf_noche con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | reporte_pdf_noche con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | reporte_pdf_noche con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | reporte_pdf_noche con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | reporte_pdf_noche con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | reporte_pdf_noche con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | reporte_pdf_noche con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | inventario_historial con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | inventario_historial con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | inventario_historial con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | inventario_historial con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | inventario_historial con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | inventario_historial con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | inventario_historial con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | inventario_historial con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | inventario_historial con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | inventario_historial con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | inventario_historial con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | inventario_historial con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | inventario_historial con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | inventario_historial con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | inventario_historial con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | inventario_historial con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | inventario_historial con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | inventario_historial con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | inventario_historial con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | inventario_entrada con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | inventario_entrada con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | inventario_entrada con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | inventario_entrada con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | inventario_entrada con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | inventario_entrada con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | inventario_entrada con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | inventario_entrada con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | inventario_entrada con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | inventario_entrada con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | inventario_entrada con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | inventario_entrada con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | inventario_entrada con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | inventario_entrada con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | inventario_entrada con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | inventario_entrada con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | inventario_entrada con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | inventario_entrada con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | inventario_entrada con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | caja_registrar_propina con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | caja_registrar_propina con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | caja_registrar_propina con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | caja_registrar_propina con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | caja_registrar_propina con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | caja_registrar_propina con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | caja_registrar_propina con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | caja_registrar_propina con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | caja_registrar_propina con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | caja_registrar_propina con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | caja_registrar_propina con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | caja_registrar_propina con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | caja_registrar_propina con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | caja_registrar_propina con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | caja_registrar_propina con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | caja_registrar_propina con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | caja_registrar_propina con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | caja_registrar_propina con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | caja_registrar_propina con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | propinas_config_leer con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | propinas_config_leer con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | propinas_config_leer con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | propinas_config_leer con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | propinas_config_leer con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | propinas_config_leer con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | propinas_config_leer con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | propinas_config_leer con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | propinas_config_leer con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | propinas_config_leer con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | propinas_config_leer con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | propinas_config_leer con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | propinas_config_leer con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | propinas_config_leer con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | propinas_config_leer con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | propinas_config_leer con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | propinas_config_leer con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | propinas_config_leer con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | propinas_config_leer con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | propinas_reporte_noche con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | propinas_reporte_noche con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | propinas_reporte_noche con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | propinas_reporte_noche con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | propinas_reporte_noche con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | propinas_reporte_noche con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | propinas_reporte_noche con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | propinas_reporte_noche con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | propinas_reporte_noche con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | propinas_reporte_noche con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | propinas_reporte_noche con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | propinas_reporte_noche con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | propinas_reporte_noche con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | propinas_reporte_noche con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | propinas_reporte_noche con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | propinas_reporte_noche con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | propinas_reporte_noche con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | propinas_reporte_noche con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | propinas_reporte_noche con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | fraude_reglas_leer con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | fraude_reglas_leer con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | fraude_reglas_leer con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | fraude_reglas_leer con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | fraude_reglas_leer con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | fraude_reglas_leer con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | fraude_reglas_leer con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | fraude_reglas_leer con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | fraude_reglas_leer con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | fraude_reglas_leer con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | fraude_reglas_leer con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | fraude_reglas_leer con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | fraude_reglas_leer con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | fraude_reglas_leer con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | fraude_reglas_leer con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | fraude_reglas_leer con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | fraude_reglas_leer con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | fraude_reglas_leer con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | fraude_reglas_leer con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | fraude_detectar con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | fraude_detectar con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | fraude_detectar con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | fraude_detectar con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | fraude_detectar con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | fraude_detectar con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | fraude_detectar con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | fraude_detectar con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | fraude_detectar con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | fraude_detectar con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | fraude_detectar con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | fraude_detectar con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | fraude_detectar con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | fraude_detectar con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | fraude_detectar con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | fraude_detectar con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | fraude_detectar con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | fraude_detectar con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | fraude_detectar con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | fraude_alertas_listar con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | fraude_alertas_listar con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | fraude_alertas_listar con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | fraude_alertas_listar con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | fraude_alertas_listar con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | fraude_alertas_listar con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | fraude_alertas_listar con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | fraude_alertas_listar con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | fraude_alertas_listar con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | fraude_alertas_listar con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | fraude_alertas_listar con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | fraude_alertas_listar con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | fraude_alertas_listar con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | fraude_alertas_listar con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | fraude_alertas_listar con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | fraude_alertas_listar con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | fraude_alertas_listar con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | fraude_alertas_listar con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | fraude_alertas_listar con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | fraude_alerta_detalle con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | fraude_alerta_detalle con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | fraude_alerta_detalle con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | fraude_alerta_detalle con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | fraude_alerta_detalle con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | fraude_alerta_detalle con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | fraude_alerta_detalle con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | fraude_alerta_detalle con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | fraude_alerta_detalle con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | fraude_alerta_detalle con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | fraude_alerta_detalle con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | fraude_alerta_detalle con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | fraude_alerta_detalle con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | fraude_alerta_detalle con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | fraude_alerta_detalle con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | fraude_alerta_detalle con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | fraude_alerta_detalle con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | fraude_alerta_detalle con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | fraude_alerta_detalle con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | fraude_alerta_cambiar con la bandera apagada (permiso antes que bandera) | anon | sí | sí |
| RPC | fraude_alerta_cambiar con la bandera apagada (permiso antes que bandera) | duenoTemp | sí | sí |
| RPC | fraude_alerta_cambiar con la bandera apagada (permiso antes que bandera) | cliente | sí | sí |
| RPC | fraude_alerta_cambiar con la bandera apagada (permiso antes que bandera) | rpA | sí | sí |
| RPC | fraude_alerta_cambiar con la bandera apagada (permiso antes que bandera) | staffA | sí | sí |
| RPC | fraude_alerta_cambiar con la bandera apagada (permiso antes que bandera) | rpB | sí | sí |
| RPC | fraude_alerta_cambiar con la bandera apagada (permiso antes que bandera) | staffB | sí | sí |
| RPC | fraude_alerta_cambiar con la bandera apagada (permiso antes que bandera) | rpTemp | sí | sí |
| RPC | fraude_alerta_cambiar con la bandera apagada (permiso antes que bandera) | sinperfil | sí | sí |
| RPC | fraude_alerta_cambiar con la bandera apagada (permiso antes que bandera) | duenoGrupo | sí | sí |
| RPC | fraude_alerta_cambiar con la bandera apagada (permiso antes que bandera) | duenoA | sí | sí |
| RPC | fraude_alerta_cambiar con la bandera apagada (permiso antes que bandera) | gerenteTemp | sí | sí |
| RPC | fraude_alerta_cambiar con la bandera apagada (permiso antes que bandera) | gerenteSinClub | sí | sí |
| RPC | fraude_alerta_cambiar con la bandera apagada (permiso antes que bandera) | duenoB | sí | sí |
| RPC | fraude_alerta_cambiar con la bandera apagada (permiso antes que bandera) | rpBaja | sí | sí |
| RPC | fraude_alerta_cambiar con la bandera apagada (permiso antes que bandera) | gerenteB | sí | sí |
| RPC | fraude_alerta_cambiar con la bandera apagada (permiso antes que bandera) | admin | sí | sí |
| RPC | fraude_alerta_cambiar con la bandera apagada (permiso antes que bandera) | staffBajaA | sí | sí |
| RPC | fraude_alerta_cambiar con la bandera apagada (permiso antes que bandera) | gerenteA | sí | sí |
| RPC | fraude_mis_antros con la bandera apagada: A aparece «no activa» | admin | sí | sí |
| RPC | fraude_mis_antros con la bandera apagada: A aparece «no activa» | duenoGrupo | sí | sí |
| RPC | fraude_mis_antros con la bandera apagada: A aparece «no activa» | duenoA | sí | sí |
| RPC | fraude_mis_antros con la bandera apagada: A aparece «no activa» | gerenteA | sí | sí |
| RPC | mis_funciones de A con todo apagado: vacío | staffA | sí | sí |
| RPC | mis_funciones de A con todo apagado: vacío | rpA | sí | sí |
| RPC | mis_funciones de A con todo apagado: vacío | duenoA | sí | sí |
| RPC | mis_funciones de A con todo apagado: vacío | duenoB | sí | sí |
| RPC | mis_funciones de A con todo apagado: vacío | gerenteA | sí | sí |
| RPC | mis_funciones de A con todo apagado: vacío | rpB | sí | sí |
| RPC | mis_funciones de A con todo apagado: vacío | sinperfil | sí | sí |
| RPC | mis_funciones de A con todo apagado: vacío | duenoGrupo | sí | sí |
| RPC | mis_funciones de A con todo apagado: vacío | cliente | sí | sí |
| RPC | mis_funciones de A con todo apagado: vacío | gerenteTemp | sí | sí |
| RPC | mis_funciones de A con todo apagado: vacío | gerenteB | sí | sí |
| RPC | mis_funciones de A con todo apagado: vacío | gerenteSinClub | sí | sí |
| RPC | mis_funciones de A con todo apagado: vacío | rpTemp | sí | sí |
| RPC | mis_funciones de A con todo apagado: vacío | admin | sí | sí |
| RPC | mis_funciones de A con todo apagado: vacío | duenoTemp | sí | sí |
| RPC | mis_funciones de A con todo apagado: vacío | staffB | sí | sí |
| RPC | mis_funciones de A con todo apagado: vacío | rpBaja | sí | sí |
| RPC | mis_funciones de A con todo apagado: vacío | staffBajaA | sí | sí |
| RPC | pos_mis_antros sin A (bandera apagada) | cliente | sí | sí |
| RPC | pos_mis_antros sin A (bandera apagada) | duenoA | sí | sí |
| RPC | pos_mis_antros sin A (bandera apagada) | duenoTemp | sí | sí |
| RPC | pos_mis_antros sin A (bandera apagada) | duenoGrupo | sí | sí |
| RPC | pos_mis_antros sin A (bandera apagada) | gerenteA | sí | sí |
| RPC | pos_mis_antros sin A (bandera apagada) | sinperfil | sí | sí |
| RPC | pos_mis_antros sin A (bandera apagada) | staffBajaA | sí | sí |
| RPC | pos_mis_antros sin A (bandera apagada) | gerenteTemp | sí | sí |
| RPC | pos_mis_antros sin A (bandera apagada) | rpBaja | sí | sí |
| RPC | pos_mis_antros sin A (bandera apagada) | rpTemp | sí | sí |
| RPC | pos_mis_antros sin A (bandera apagada) | staffA | sí | sí |
| RPC | pos_mis_antros sin A (bandera apagada) | rpB | sí | sí |
| RPC | pos_mis_antros sin A (bandera apagada) | rpA | sí | sí |
| RPC | pos_mis_antros sin A (bandera apagada) | gerenteSinClub | sí | sí |
| RPC | pos_mis_antros sin A (bandera apagada) | staffB | sí | sí |
| RPC | pos_mis_antros sin A (bandera apagada) | admin | sí | sí |
| RPC | pos_mis_antros sin A (bandera apagada) | duenoB | sí | sí |
| RPC | pos_mis_antros sin A (bandera apagada) | gerenteB | sí | sí |
| RPC | boleto_muestra_codigo con la bandera apagada: no | anon | sí | sí |
| RPC | boleto_muestra_codigo con la bandera apagada: no | rpA | sí | sí |
| RPC | boleto_muestra_codigo con la bandera apagada: no | sinperfil | sí | sí |
| RPC | boleto_muestra_codigo con la bandera apagada: no | gerenteA | sí | sí |
| RPC | boleto_muestra_codigo con la bandera apagada: no | duenoTemp | sí | sí |
| RPC | boleto_muestra_codigo con la bandera apagada: no | rpB | sí | sí |
| RPC | boleto_muestra_codigo con la bandera apagada: no | duenoB | sí | sí |
| RPC | boleto_muestra_codigo con la bandera apagada: no | admin | sí | sí |
| RPC | boleto_muestra_codigo con la bandera apagada: no | gerenteB | sí | sí |
| RPC | boleto_muestra_codigo con la bandera apagada: no | staffBajaA | sí | sí |
| RPC | boleto_muestra_codigo con la bandera apagada: no | duenoA | sí | sí |
| RPC | boleto_muestra_codigo con la bandera apagada: no | cliente | sí | sí |
| RPC | boleto_muestra_codigo con la bandera apagada: no | staffB | sí | sí |
| RPC | boleto_muestra_codigo con la bandera apagada: no | rpBaja | sí | sí |
| RPC | boleto_muestra_codigo con la bandera apagada: no | staffA | sí | sí |
| RPC | boleto_muestra_codigo con la bandera apagada: no | rpTemp | sí | sí |
| RPC | boleto_muestra_codigo con la bandera apagada: no | duenoGrupo | sí | sí |
| RPC | boleto_muestra_codigo con la bandera apagada: no | gerenteSinClub | sí | sí |
| RPC | boleto_muestra_codigo con la bandera apagada: no | gerenteTemp | sí | sí |
| RPC | lista_negra_aviso con la bandera apagada: {activa:false} | duenoB | sí | sí |
| RPC | lista_negra_aviso con la bandera apagada: {activa:false} | staffB | sí | sí |
| RPC | lista_negra_aviso con la bandera apagada: {activa:false} | staffBajaA | sí | sí |
| RPC | lista_negra_aviso con la bandera apagada: {activa:false} | rpBaja | sí | sí |
| RPC | lista_negra_aviso con la bandera apagada: {activa:false} | duenoA | sí | sí |
| RPC | lista_negra_aviso con la bandera apagada: {activa:false} | duenoGrupo | sí | sí |
| RPC | lista_negra_aviso con la bandera apagada: {activa:false} | gerenteTemp | sí | sí |
| RPC | lista_negra_aviso con la bandera apagada: {activa:false} | admin | sí | sí |
| RPC | lista_negra_aviso con la bandera apagada: {activa:false} | duenoTemp | sí | sí |
| RPC | lista_negra_aviso con la bandera apagada: {activa:false} | gerenteA | sí | sí |
| RPC | lista_negra_aviso con la bandera apagada: {activa:false} | rpTemp | sí | sí |
| RPC | lista_negra_aviso con la bandera apagada: {activa:false} | cliente | sí | sí |
| RPC | lista_negra_aviso con la bandera apagada: {activa:false} | staffA | sí | sí |
| RPC | lista_negra_aviso con la bandera apagada: {activa:false} | gerenteB | sí | sí |
| RPC | lista_negra_aviso con la bandera apagada: {activa:false} | rpB | sí | sí |
| RPC | lista_negra_aviso con la bandera apagada: {activa:false} | gerenteSinClub | sí | sí |
| RPC | lista_negra_aviso con la bandera apagada: {activa:false} | rpA | sí | sí |
| RPC | lista_negra_aviso con la bandera apagada: {activa:false} | sinperfil | sí | sí |
| RPC | whatsapp_plantillas con la bandera apagada: vacío | gerenteTemp | sí | sí |
| RPC | whatsapp_plantillas con la bandera apagada: vacío | cliente | sí | sí |
| RPC | whatsapp_plantillas con la bandera apagada: vacío | duenoTemp | sí | sí |
| RPC | whatsapp_plantillas con la bandera apagada: vacío | duenoA | sí | sí |
| RPC | whatsapp_plantillas con la bandera apagada: vacío | rpTemp | sí | sí |
| RPC | whatsapp_plantillas con la bandera apagada: vacío | staffBajaA | sí | sí |
| RPC | whatsapp_plantillas con la bandera apagada: vacío | duenoB | sí | sí |
| RPC | whatsapp_plantillas con la bandera apagada: vacío | rpBaja | sí | sí |
| RPC | whatsapp_plantillas con la bandera apagada: vacío | rpA | sí | sí |
| RPC | whatsapp_plantillas con la bandera apagada: vacío | sinperfil | sí | sí |
| RPC | whatsapp_plantillas con la bandera apagada: vacío | duenoGrupo | sí | sí |
| RPC | whatsapp_plantillas con la bandera apagada: vacío | admin | sí | sí |
| RPC | whatsapp_plantillas con la bandera apagada: vacío | gerenteSinClub | sí | sí |
| RPC | whatsapp_plantillas con la bandera apagada: vacío | staffA | sí | sí |
| RPC | whatsapp_plantillas con la bandera apagada: vacío | gerenteB | sí | sí |
| RPC | whatsapp_plantillas con la bandera apagada: vacío | gerenteA | sí | sí |
| RPC | whatsapp_plantillas con la bandera apagada: vacío | staffB | sí | sí |
| RPC | whatsapp_plantillas con la bandera apagada: vacío | rpB | sí | sí |
| candados | lista negra apagada: el RP reserva con un teléfono bloqueado (como hoy) | rpA | sí | sí |
| RPC | banderas de A restauradas (reportes_pdf heredada del grupo G) | gerenteA | sí | sí |
| RPC | funciones_estado | admin | sí | sí |
| RPC | funcion_cambiar | admin | sí | sí |
| RPC | grupo_funcion_cambiar | admin | sí | sí |
| RPC | mis_funciones de A (publicado: toda sesión) | staffA | sí | sí |
| RPC | mis_funciones de A (publicado: toda sesión) | rpA | sí | sí |
| RPC | mis_funciones de A (publicado: toda sesión) | cliente | sí | sí |
| RPC | mis_funciones de A (publicado: toda sesión) | duenoA | sí | sí |
| RPC | mis_funciones de A (publicado: toda sesión) | rpBaja | sí | sí |
| RPC | mis_funciones de A (publicado: toda sesión) | gerenteTemp | sí | sí |
| RPC | mis_funciones de A (publicado: toda sesión) | admin | sí | sí |
| RPC | mis_funciones de A (publicado: toda sesión) | sinperfil | sí | sí |
| RPC | mis_funciones de A (publicado: toda sesión) | rpB | sí | sí |
| RPC | mis_funciones de A (publicado: toda sesión) | duenoGrupo | sí | sí |
| RPC | mis_funciones de A (publicado: toda sesión) | gerenteA | sí | sí |
| RPC | mis_funciones de A (publicado: toda sesión) | staffB | sí | sí |
| RPC | mis_funciones de A (publicado: toda sesión) | rpTemp | sí | sí |
| RPC | mis_funciones de A (publicado: toda sesión) | staffBajaA | sí | sí |
| RPC | mis_funciones de A (publicado: toda sesión) | gerenteSinClub | sí | sí |
| RPC | mis_funciones de A (publicado: toda sesión) | duenoB | sí | sí |
| RPC | mis_funciones de A (publicado: toda sesión) | gerenteB | sí | sí |
| RPC | mis_funciones de A (publicado: toda sesión) | duenoTemp | sí | sí |
| RPC | mis_funciones de B (borrador: su gente y el admin) | gerenteB | sí | sí |
| RPC | mis_funciones de B (borrador: su gente y el admin) | admin | sí | sí |
| RPC | mis_funciones de B (borrador: su gente y el admin) | staffB | sí | sí |
| RPC | mis_funciones de B (borrador: su gente y el admin) | duenoB | sí | sí |
| RPC | mis_funciones de B (borrador: su gente y el admin) | rpB | sí | sí |
| RPC | pos_mis_antros incluye A | admin | sí | sí |
| RPC | pos_mis_antros incluye A | duenoGrupo | sí | sí |
| RPC | pos_mis_antros incluye A | duenoA | sí | sí |
| RPC | pos_mis_antros incluye A | gerenteA | sí | sí |
| RPC | pos_mapeos_lista | duenoA | sí | sí |
| RPC | pos_mapeos_lista | gerenteA | sí | sí |
| RPC | pos_mapeos_lista | admin | sí | sí |
| RPC | pos_mapeos_lista | duenoGrupo | sí | sí |
| RPC | pos_mapeo_guardar | duenoA | sí | sí |
| RPC | pos_mapeo_guardar | duenoGrupo | sí | sí |
| RPC | pos_mapeo_guardar | admin | sí | sí |
| RPC | pos_mapeo_guardar | gerenteA | sí | sí |
| RPC | pos_preparar | gerenteA | sí | sí |
| RPC | pos_preparar | admin | sí | sí |
| RPC | pos_preparar | duenoGrupo | sí | sí |
| RPC | pos_preparar | duenoA | sí | sí |
| RPC | pos_importar (mismo archivo: «ya se importó») | admin | sí | sí |
| RPC | pos_importar (mismo archivo: «ya se importó») | gerenteA | sí | sí |
| RPC | pos_importar (mismo archivo: «ya se importó») | duenoA | sí | sí |
| RPC | pos_importar (mismo archivo: «ya se importó») | duenoGrupo | sí | sí |
| RPC | pos_importaciones_lista | duenoA | sí | sí |
| RPC | pos_importaciones_lista | admin | sí | sí |
| RPC | pos_importaciones_lista | duenoGrupo | sí | sí |
| RPC | pos_importaciones_lista | gerenteA | sí | sí |
| RPC | pos_importacion_deshacer (sin motivo) | admin | sí | sí |
| RPC | pos_importacion_deshacer (sin motivo) | duenoGrupo | sí | sí |
| RPC | pos_importacion_deshacer (sin motivo) | duenoA | sí | sí |
| RPC | pos_importacion_deshacer (sin motivo) | gerenteA | sí | sí |
| RPC | pos_asignar (sin ventas) | gerenteA | sí | sí |
| RPC | pos_asignar (sin ventas) | duenoGrupo | sí | sí |
| RPC | pos_asignar (sin ventas) | duenoA | sí | sí |
| RPC | pos_asignar (sin ventas) | admin | sí | sí |
| RPC | pos_religar | duenoA | sí | sí |
| RPC | pos_religar | gerenteA | sí | sí |
| RPC | pos_religar | admin | sí | sí |
| RPC | pos_religar | duenoGrupo | sí | sí |
| RPC | pos_conciliacion | gerenteA | sí | sí |
| RPC | pos_conciliacion | duenoGrupo | sí | sí |
| RPC | pos_conciliacion | admin | sí | sí |
| RPC | pos_conciliacion | duenoA | sí | sí |
| RPC | pos_tickets | duenoA | sí | sí |
| RPC | pos_tickets | gerenteA | sí | sí |
| RPC | pos_tickets | duenoGrupo | sí | sí |
| RPC | pos_tickets | admin | sí | sí |
| RPC | pos_cuentas_noche | duenoA | sí | sí |
| RPC | pos_cuentas_noche | gerenteA | sí | sí |
| RPC | pos_cuentas_noche | duenoGrupo | sí | sí |
| RPC | pos_cuentas_noche | admin | sí | sí |
| RPC | pos_mapeo_borrar | gerenteA | sí | sí |
| RPC | pos_mapeo_borrar | duenoA | sí | sí |
| RPC | pos_mapeo_borrar | duenoGrupo | sí | sí |
| RPC | pos_mapeo_borrar | admin | sí | sí |
| RPC | puerta_copia_noche | staffA | sí | sí |
| RPC | puerta_copia_noche | duenoA | sí | sí |
| RPC | puerta_copia_noche | admin | sí | sí |
| RPC | puerta_copia_noche | gerenteA | sí | sí |
| RPC | puerta_escanear_codigo (sin coincidencia) | staffA | sí | sí |
| RPC | puerta_escanear_codigo (sin coincidencia) | admin | sí | sí |
| RPC | puerta_escanear_codigo (sin coincidencia) | duenoA | sí | sí |
| RPC | puerta_escanear_codigo (sin coincidencia) | gerenteA | sí | sí |
| RPC | puerta_entrada_diferida (sin clave) | gerenteA | sí | sí |
| RPC | puerta_entrada_diferida (sin clave) | staffA | sí | sí |
| RPC | puerta_entrada_diferida (sin clave) | duenoA | sí | sí |
| RPC | puerta_entrada_diferida (sin clave) | admin | sí | sí |
| RPC | boleto_muestra_codigo con la bandera encendida: sí (también sin sesión) | gerenteB | sí | sí |
| RPC | boleto_muestra_codigo con la bandera encendida: sí (también sin sesión) | rpB | sí | sí |
| RPC | boleto_muestra_codigo con la bandera encendida: sí (también sin sesión) | staffA | sí | sí |
| RPC | boleto_muestra_codigo con la bandera encendida: sí (también sin sesión) | rpA | sí | sí |
| RPC | boleto_muestra_codigo con la bandera encendida: sí (también sin sesión) | gerenteA | sí | sí |
| RPC | boleto_muestra_codigo con la bandera encendida: sí (también sin sesión) | staffB | sí | sí |
| RPC | boleto_muestra_codigo con la bandera encendida: sí (también sin sesión) | cliente | sí | sí |
| RPC | boleto_muestra_codigo con la bandera encendida: sí (también sin sesión) | staffBajaA | sí | sí |
| RPC | boleto_muestra_codigo con la bandera encendida: sí (también sin sesión) | gerenteSinClub | sí | sí |
| RPC | boleto_muestra_codigo con la bandera encendida: sí (también sin sesión) | rpTemp | sí | sí |
| RPC | boleto_muestra_codigo con la bandera encendida: sí (también sin sesión) | duenoTemp | sí | sí |
| RPC | boleto_muestra_codigo con la bandera encendida: sí (también sin sesión) | duenoB | sí | sí |
| RPC | boleto_muestra_codigo con la bandera encendida: sí (también sin sesión) | duenoA | sí | sí |
| RPC | boleto_muestra_codigo con la bandera encendida: sí (también sin sesión) | rpBaja | sí | sí |
| RPC | boleto_muestra_codigo con la bandera encendida: sí (también sin sesión) | admin | sí | sí |
| RPC | boleto_muestra_codigo con la bandera encendida: sí (también sin sesión) | duenoGrupo | sí | sí |
| RPC | boleto_muestra_codigo con la bandera encendida: sí (también sin sesión) | gerenteTemp | sí | sí |
| RPC | boleto_muestra_codigo con la bandera encendida: sí (también sin sesión) | sinperfil | sí | sí |
| RPC | boleto_muestra_codigo con la bandera encendida: sí (también sin sesión) | anon | sí | sí |
| RPC | lista_negra_politica | admin | sí | sí |
| RPC | lista_negra_politica | duenoA | sí | sí |
| RPC | lista_negra_politica | duenoGrupo | sí | sí |
| RPC | lista_negra_politica | gerenteA | sí | sí |
| RPC | lista_negra_politica_guardar | admin | sí | sí |
| RPC | lista_negra_politica_guardar | gerenteA | sí | sí |
| RPC | lista_negra_politica_guardar | duenoGrupo | sí | sí |
| RPC | lista_negra_politica_guardar | duenoA | sí | sí |
| RPC | lista_negra_bloquear (ya bloqueado) | duenoA | sí | sí |
| RPC | lista_negra_bloquear (ya bloqueado) | admin | sí | sí |
| RPC | lista_negra_bloquear (ya bloqueado) | duenoGrupo | sí | sí |
| RPC | lista_negra_bloquear (ya bloqueado) | gerenteA | sí | sí |
| RPC | lista_negra_desbloquear (bloqueo inexistente) | admin | sí | sí |
| RPC | lista_negra_desbloquear (bloqueo inexistente) | duenoA | sí | sí |
| RPC | lista_negra_desbloquear (bloqueo inexistente) | duenoGrupo | sí | sí |
| RPC | lista_negra_desbloquear (bloqueo inexistente) | gerenteA | sí | sí |
| RPC | lista_negra_bloqueos | duenoA | sí | sí |
| RPC | lista_negra_bloqueos | duenoGrupo | sí | sí |
| RPC | lista_negra_bloqueos | admin | sí | sí |
| RPC | lista_negra_bloqueos | gerenteA | sí | sí |
| RPC | lista_negra_ver_telefono | duenoA | sí | sí |
| RPC | lista_negra_ver_telefono | admin | sí | sí |
| RPC | lista_negra_ver_telefono | duenoGrupo | sí | sí |
| RPC | lista_negra_ver_telefono | gerenteA | sí | sí |
| RPC | lista_negra_noshows | admin | sí | sí |
| RPC | lista_negra_noshows | duenoA | sí | sí |
| RPC | lista_negra_noshows | duenoGrupo | sí | sí |
| RPC | lista_negra_noshows | gerenteA | sí | sí |
| RPC | lista_negra_historial | duenoA | sí | sí |
| RPC | lista_negra_historial | admin | sí | sí |
| RPC | lista_negra_historial | duenoGrupo | sí | sí |
| RPC | lista_negra_historial | gerenteA | sí | sí |
| RPC | lista_negra_aviso (reserva del RP de A) | gerenteA | sí | sí |
| RPC | lista_negra_aviso (reserva del RP de A) | staffA | sí | sí |
| RPC | lista_negra_aviso (reserva del RP de A) | rpA | sí | sí |
| RPC | lista_negra_aviso (reserva del RP de A) | duenoGrupo | sí | sí |
| RPC | lista_negra_aviso (reserva del RP de A) | admin | sí | sí |
| RPC | lista_negra_aviso (reserva del RP de A) | duenoA | sí | sí |
| RPC | lista_negra_aviso: «bloqueado» solo para la puerta y los gestores | duenoA | sí | sí |
| RPC | lista_negra_aviso: «bloqueado» solo para la puerta y los gestores | gerenteA | sí | sí |
| RPC | lista_negra_aviso: «bloqueado» solo para la puerta y los gestores | duenoGrupo | sí | sí |
| RPC | lista_negra_aviso: «bloqueado» solo para la puerta y los gestores | admin | sí | sí |
| RPC | lista_negra_aviso: «bloqueado» solo para la puerta y los gestores | staffA | sí | sí |
| RPC | lista_negra_tachar (inexistente) | admin | sí | sí |
| RPC | lista_negra_tel (pura, también sin sesión) | sinperfil | sí | sí |
| RPC | lista_negra_tel (pura, también sin sesión) | cliente | sí | sí |
| RPC | lista_negra_tel (pura, también sin sesión) | staffA | sí | sí |
| RPC | lista_negra_tel (pura, también sin sesión) | rpB | sí | sí |
| RPC | lista_negra_tel (pura, también sin sesión) | duenoA | sí | sí |
| RPC | lista_negra_tel (pura, también sin sesión) | duenoB | sí | sí |
| RPC | lista_negra_tel (pura, también sin sesión) | staffB | sí | sí |
| RPC | lista_negra_tel (pura, también sin sesión) | anon | sí | sí |
| RPC | lista_negra_tel (pura, también sin sesión) | staffBajaA | sí | sí |
| RPC | lista_negra_tel (pura, también sin sesión) | duenoTemp | sí | sí |
| RPC | lista_negra_tel (pura, también sin sesión) | duenoGrupo | sí | sí |
| RPC | lista_negra_tel (pura, también sin sesión) | admin | sí | sí |
| RPC | lista_negra_tel (pura, también sin sesión) | rpTemp | sí | sí |
| RPC | lista_negra_tel (pura, también sin sesión) | gerenteB | sí | sí |
| RPC | lista_negra_tel (pura, también sin sesión) | rpBaja | sí | sí |
| RPC | lista_negra_tel (pura, también sin sesión) | gerenteA | sí | sí |
| RPC | lista_negra_tel (pura, también sin sesión) | gerenteTemp | sí | sí |
| RPC | lista_negra_tel (pura, también sin sesión) | rpA | sí | sí |
| RPC | lista_negra_tel (pura, también sin sesión) | gerenteSinClub | sí | sí |
| RPC | para_clubes_activa | staffA | sí | sí |
| RPC | para_clubes_activa | rpB | sí | sí |
| RPC | para_clubes_activa | rpBaja | sí | sí |
| RPC | para_clubes_activa | duenoB | sí | sí |
| RPC | para_clubes_activa | staffB | sí | sí |
| RPC | para_clubes_activa | anon | sí | sí |
| RPC | para_clubes_activa | cliente | sí | sí |
| RPC | para_clubes_activa | staffBajaA | sí | sí |
| RPC | para_clubes_activa | sinperfil | sí | sí |
| RPC | para_clubes_activa | admin | sí | sí |
| RPC | para_clubes_activa | rpA | sí | sí |
| RPC | para_clubes_activa | duenoA | sí | sí |
| RPC | para_clubes_activa | gerenteTemp | sí | sí |
| RPC | para_clubes_activa | rpTemp | sí | sí |
| RPC | para_clubes_activa | duenoTemp | sí | sí |
| RPC | para_clubes_activa | gerenteB | sí | sí |
| RPC | para_clubes_activa | gerenteA | sí | sí |
| RPC | para_clubes_activa | gerenteSinClub | sí | sí |
| RPC | para_clubes_activa | duenoGrupo | sí | sí |
| RPC | plataforma_banderas_estado | admin | sí | sí |
| RPC | plataforma_bandera_cambiar (clave inexistente: no cambia nada) | admin | sí | sí |
| RPC | contactos_clubes_admin | admin | sí | sí |
| RPC | contactos_clubes_conteo | admin | sí | sí |
| RPC | contacto_club_marcar | admin | sí | sí |
| RPC | contacto_club_borrar (inexistente) | admin | sí | sí |
| RPC | whatsapp_plantillas | gerenteA | sí | sí |
| RPC | whatsapp_plantillas | duenoA | sí | sí |
| RPC | whatsapp_plantillas | admin | sí | sí |
| RPC | whatsapp_plantillas | duenoGrupo | sí | sí |
| RPC | whatsapp_plantillas | rpA | sí | sí |
| RPC | whatsapp_plantillas | staffA | sí | sí |
| RPC | whatsapp_plantilla_guardar | duenoGrupo | sí | sí |
| RPC | whatsapp_plantilla_guardar | duenoA | sí | sí |
| RPC | whatsapp_plantilla_guardar | gerenteA | sí | sí |
| RPC | whatsapp_plantilla_guardar | admin | sí | sí |
| RPC | whatsapp_reserva (reserva del RP de A) | rpA | sí | sí |
| RPC | whatsapp_reserva (reserva del RP de A) | duenoA | sí | sí |
| RPC | whatsapp_reserva (reserva del RP de A) | staffA | sí | sí |
| RPC | whatsapp_reserva (reserva del RP de A) | gerenteA | sí | sí |
| RPC | whatsapp_reserva (reserva del RP de A) | duenoGrupo | sí | sí |
| RPC | whatsapp_reserva (reserva del RP de A) | admin | sí | sí |
| RPC | whatsapp_reserva (orgánica: el RP no) | gerenteA | sí | sí |
| RPC | whatsapp_reserva (orgánica: el RP no) | duenoA | sí | sí |
| RPC | whatsapp_reserva (orgánica: el RP no) | staffA | sí | sí |
| RPC | whatsapp_reserva (orgánica: el RP no) | duenoGrupo | sí | sí |
| RPC | whatsapp_reserva (orgánica: el RP no) | admin | sí | sí |
| RPC | clientes_noche | gerenteA | sí | sí |
| RPC | clientes_noche | duenoGrupo | sí | sí |
| RPC | clientes_noche | duenoA | sí | sí |
| RPC | clientes_noche | staffA | sí | sí |
| RPC | clientes_noche | admin | sí | sí |
| RPC | reporte_pdf_noche | duenoA | sí | sí |
| RPC | reporte_pdf_noche | admin | sí | sí |
| RPC | reporte_pdf_noche | gerenteA | sí | sí |
| RPC | reporte_pdf_noche | duenoGrupo | sí | sí |
| RPC | reporte_pdf_semana | duenoA | sí | sí |
| RPC | reporte_pdf_semana | admin | sí | sí |
| RPC | reporte_pdf_semana | gerenteA | sí | sí |
| RPC | reporte_pdf_semana | duenoGrupo | sí | sí |
| RPC | inventario_entrada (cantidad 0) | gerenteA | sí | sí |
| RPC | inventario_entrada (cantidad 0) | duenoA | sí | sí |
| RPC | inventario_entrada (cantidad 0) | admin | sí | sí |
| RPC | inventario_merma (cantidad 0) | duenoA | sí | sí |
| RPC | inventario_merma (cantidad 0) | gerenteA | sí | sí |
| RPC | inventario_merma (cantidad 0) | admin | sí | sí |
| RPC | inventario_conteo (conteo inválido) | admin | sí | sí |
| RPC | inventario_conteo (conteo inválido) | duenoA | sí | sí |
| RPC | inventario_conteo (conteo inválido) | gerenteA | sí | sí |
| RPC | inventario_historial | gerenteA | sí | sí |
| RPC | inventario_historial | admin | sí | sí |
| RPC | inventario_historial | duenoA | sí | sí |
| RPC | inventario_reporte_noche | duenoA | sí | sí |
| RPC | inventario_reporte_noche | admin | sí | sí |
| RPC | inventario_reporte_noche | gerenteA | sí | sí |
| RPC | caja_registrar_propina (método inválido) | admin | sí | sí |
| RPC | caja_registrar_propina (método inválido) | staffA | sí | sí |
| RPC | caja_registrar_propina (método inválido) | duenoA | sí | sí |
| RPC | caja_registrar_propina (método inválido) | gerenteA | sí | sí |
| RPC | caja_anular_propina (noche ya repartida) | admin | sí | sí |
| RPC | caja_anular_propina (noche ya repartida) | duenoA | sí | sí |
| RPC | caja_anular_propina (noche ya repartida) | gerenteA | sí | sí |
| RPC | propinas_anular_de_cobro (noche ya repartida) | duenoA | sí | sí |
| RPC | propinas_anular_de_cobro (noche ya repartida) | admin | sí | sí |
| RPC | propinas_anular_de_cobro (noche ya repartida) | gerenteA | sí | sí |
| RPC | propinas_config_leer | staffA | sí | sí |
| RPC | propinas_config_leer | admin | sí | sí |
| RPC | propinas_config_leer | duenoA | sí | sí |
| RPC | propinas_config_leer | duenoGrupo | sí | sí |
| RPC | propinas_config_leer | gerenteA | sí | sí |
| RPC | propinas_config_guardar | duenoA | sí | sí |
| RPC | propinas_config_guardar | admin | sí | sí |
| RPC | propinas_config_guardar | gerenteA | sí | sí |
| RPC | propinas_calcular | admin | sí | sí |
| RPC | propinas_calcular | duenoA | sí | sí |
| RPC | propinas_calcular | gerenteA | sí | sí |
| RPC | propinas_repartir (noche abierta) | gerenteA | sí | sí |
| RPC | propinas_repartir (noche abierta) | duenoA | sí | sí |
| RPC | propinas_repartir (noche abierta) | admin | sí | sí |
| RPC | propinas_anular_reparto (sin motivo) | admin | sí | sí |
| RPC | propinas_anular_reparto (sin motivo) | duenoA | sí | sí |
| RPC | propinas_anular_reparto (sin motivo) | gerenteA | sí | sí |
| RPC | propinas_reporte_noche | gerenteA | sí | sí |
| RPC | propinas_reporte_noche | admin | sí | sí |
| RPC | propinas_reporte_noche | duenoA | sí | sí |
| RPC | fraude_catalogo | gerenteA | sí | sí |
| RPC | fraude_catalogo | rpA | sí | sí |
| RPC | fraude_catalogo | cliente | sí | sí |
| RPC | fraude_catalogo | rpB | sí | sí |
| RPC | fraude_catalogo | admin | sí | sí |
| RPC | fraude_catalogo | staffA | sí | sí |
| RPC | fraude_catalogo | duenoA | sí | sí |
| RPC | fraude_catalogo | gerenteB | sí | sí |
| RPC | fraude_catalogo | gerenteSinClub | sí | sí |
| RPC | fraude_catalogo | duenoB | sí | sí |
| RPC | fraude_catalogo | sinperfil | sí | sí |
| RPC | fraude_catalogo | rpTemp | sí | sí |
| RPC | fraude_catalogo | rpBaja | sí | sí |
| RPC | fraude_catalogo | staffBajaA | sí | sí |
| RPC | fraude_catalogo | staffB | sí | sí |
| RPC | fraude_catalogo | duenoGrupo | sí | sí |
| RPC | fraude_catalogo | gerenteTemp | sí | sí |
| RPC | fraude_catalogo | duenoTemp | sí | sí |
| RPC | fraude_mis_antros incluye A (encendida) | admin | sí | sí |
| RPC | fraude_mis_antros incluye A (encendida) | duenoA | sí | sí |
| RPC | fraude_mis_antros incluye A (encendida) | gerenteA | sí | sí |
| RPC | fraude_mis_antros incluye A (encendida) | duenoGrupo | sí | sí |
| RPC | fraude_mis_antros incluye B (el dueño de grupo de G no) | admin | sí | sí |
| RPC | fraude_mis_antros incluye B (el dueño de grupo de G no) | duenoB | sí | sí |
| RPC | fraude_mis_antros incluye B (el dueño de grupo de G no) | gerenteB | sí | sí |
| RPC | fraude_reglas_leer | gerenteA | sí | sí |
| RPC | fraude_reglas_leer | duenoGrupo | sí | sí |
| RPC | fraude_reglas_leer | duenoA | sí | sí |
| RPC | fraude_reglas_leer | admin | sí | sí |
| RPC | fraude_reglas_leer de B | admin | sí | sí |
| RPC | fraude_reglas_leer de B | duenoB | sí | sí |
| RPC | fraude_reglas_leer de B | gerenteB | sí | sí |
| RPC | fraude_regla_guardar (mismos valores: no cambia) | duenoA | sí | sí |
| RPC | fraude_regla_guardar (mismos valores: no cambia) | gerenteA | sí | sí |
| RPC | fraude_regla_guardar (mismos valores: no cambia) | admin | sí | sí |
| RPC | fraude_regla_guardar (mismos valores: no cambia) | duenoGrupo | sí | sí |
| RPC | fraude_regla_guardar de B (mismos valores) | gerenteB | sí | sí |
| RPC | fraude_regla_guardar de B (mismos valores) | admin | sí | sí |
| RPC | fraude_regla_guardar de B (mismos valores) | duenoB | sí | sí |
| RPC | fraude_reglas_cambios_leer | admin | sí | sí |
| RPC | fraude_reglas_cambios_leer | duenoA | sí | sí |
| RPC | fraude_reglas_cambios_leer | duenoGrupo | sí | sí |
| RPC | fraude_reglas_cambios_leer | gerenteA | sí | sí |
| RPC | fraude_detectar (como mucho una búsqueda; las demás «hace menos de 2 minutos») | duenoGrupo | sí | sí |
| RPC | fraude_detectar (como mucho una búsqueda; las demás «hace menos de 2 minutos») | admin | sí | sí |
| RPC | fraude_detectar (como mucho una búsqueda; las demás «hace menos de 2 minutos») | gerenteA | sí | sí |
| RPC | fraude_detectar (como mucho una búsqueda; las demás «hace menos de 2 minutos») | duenoA | sí | sí |
| RPC | fraude_detectar de B (una búsqueda o «hace menos de 2 minutos») | admin | sí | sí |
| RPC | fraude_detectar de B (una búsqueda o «hace menos de 2 minutos») | gerenteB | sí | sí |
| RPC | fraude_detectar de B (una búsqueda o «hace menos de 2 minutos») | duenoB | sí | sí |
| RPC | fraude_ultima_deteccion | gerenteA | sí | sí |
| RPC | fraude_ultima_deteccion | duenoGrupo | sí | sí |
| RPC | fraude_ultima_deteccion | admin | sí | sí |
| RPC | fraude_ultima_deteccion | duenoA | sí | sí |
| RPC | fraude_alertas_listar | duenoA | sí | sí |
| RPC | fraude_alertas_listar | gerenteA | sí | sí |
| RPC | fraude_alertas_listar | admin | sí | sí |
| RPC | fraude_alertas_listar | duenoGrupo | sí | sí |
| RPC | fraude_alertas_listar de B | duenoB | sí | sí |
| RPC | fraude_alertas_listar de B | gerenteB | sí | sí |
| RPC | fraude_alertas_listar de B | admin | sí | sí |
| RPC | fraude_alertas_rps | duenoA | sí | sí |
| RPC | fraude_alertas_rps | duenoGrupo | sí | sí |
| RPC | fraude_alertas_rps | gerenteA | sí | sí |
| RPC | fraude_alertas_rps | admin | sí | sí |
| RPC | fraude_alerta_detalle | admin | sí | sí |
| RPC | fraude_alerta_detalle | duenoA | sí | sí |
| RPC | fraude_alerta_detalle | duenoGrupo | sí | sí |
| RPC | fraude_alerta_detalle | gerenteA | sí | sí |
| RPC | fraude_alerta_detalle de B (el dueño de grupo de G no) | admin | sí | sí |
| RPC | fraude_alerta_detalle de B (el dueño de grupo de G no) | gerenteB | sí | sí |
| RPC | fraude_alerta_detalle de B (el dueño de grupo de G no) | duenoB | sí | sí |
| RPC | fraude_alerta_cambiar (sin nota) | admin | sí | sí |
| RPC | fraude_alerta_cambiar (sin nota) | duenoA | sí | sí |
| RPC | fraude_alerta_cambiar (sin nota) | gerenteA | sí | sí |
| RPC | fraude_alerta_cambiar (sin nota) | duenoGrupo | sí | sí |
| RPC | fraude_alerta_cambiar de B (sin nota) | duenoB | sí | sí |
| RPC | fraude_alerta_cambiar de B (sin nota) | admin | sí | sí |
| RPC | fraude_alerta_cambiar de B (sin nota) | gerenteB | sí | sí |
| candados | registro legítimo: perfil cliente propio sin antro | sinperfil2 | sí | sí |
| candados | un dueño sin antro registra el suyo (auto-registro) | duenoGrupo | sí | sí |
| candados | el cliente reserva con un teléfono bloqueado: aviso P0001 propio de su rol, sin motivo | cliente | sí | sí |
| candados | el cliente reserva con el teléfono bloqueado escrito «+52 1 …»: aviso P0001 propio de su rol, sin motivo | cliente | sí | sí |
| candados | sin cuenta, con un teléfono bloqueado: aviso P0001 propio de su rol, sin motivo | anon | sí | sí |
| candados | el RP reserva con un teléfono bloqueado: aviso P0001 propio de su rol, sin motivo | rpA | sí | sí |
| candados | un bloqueo de A no afecta a B (el RP de B reserva en B con ese teléfono) | rpB | sí | sí |
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
| RPC | catálogo: _clientes_estado(uuid,uuid,date,text,text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: _lista_negra_auto(uuid,text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: _lista_negra_exigir(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: _lista_negra_gestiona(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: _lista_negra_manual(uuid,text,uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: _lista_negra_noshows(uuid,date,text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: _lista_negra_politica(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: _lista_negra_ve_avisos(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: _whatsapp_trabaja(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: anon ejecuta boleto_muestra_codigo(text) | anon | sí | sí |
| RPC | catálogo: authenticated ejecuta boleto_muestra_codigo(text) | authenticated | sí | sí |
| RPC | catálogo: boleto_muestra_codigo(text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta caja_anular_propina(uuid,text) | authenticated | sí | sí |
| RPC | catálogo: caja_anular_propina(uuid,text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta caja_registrar_propina(uuid,uuid,uuid,text,bigint,text,uuid) | authenticated | sí | sí |
| RPC | catálogo: caja_registrar_propina(uuid,uuid,uuid,text,bigint,text,uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta clientes_noche(uuid,integer) | authenticated | sí | sí |
| RPC | catálogo: clientes_noche(uuid,integer) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta contacto_club_borrar(uuid) | authenticated | sí | sí |
| RPC | catálogo: contacto_club_borrar(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta contacto_club_marcar(uuid,text) | authenticated | sí | sí |
| RPC | catálogo: contacto_club_marcar(uuid,text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: contacto_huella(text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: contacto_intentos_limpiar() (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta contactos_clubes_admin(text,integer,integer) | authenticated | sí | sí |
| RPC | catálogo: contactos_clubes_admin(text,integer,integer) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta contactos_clubes_conteo() | authenticated | sí | sí |
| RPC | catálogo: contactos_clubes_conteo() (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta fraude_alerta_cambiar(uuid,text,text) | authenticated | sí | sí |
| RPC | catálogo: fraude_alerta_cambiar(uuid,text,text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta fraude_alerta_detalle(uuid) | authenticated | sí | sí |
| RPC | catálogo: fraude_alerta_detalle(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta fraude_alertas_listar(uuid,text,text,uuid,date,date,integer,integer) | authenticated | sí | sí |
| RPC | catálogo: fraude_alertas_listar(uuid,text,text,uuid,date,date,integer,integer) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta fraude_alertas_rps(uuid) | authenticated | sí | sí |
| RPC | catálogo: fraude_alertas_rps(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: fraude_autorizar(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta fraude_catalogo() | authenticated | sí | sí |
| RPC | catálogo: authenticated ejecuta fraude_detectar(uuid,date,date) | authenticated | sí | sí |
| RPC | catálogo: fraude_detectar(uuid,date,date) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta fraude_mis_antros() | authenticated | sí | sí |
| RPC | catálogo: fraude_mis_antros() (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: fraude_nombre(uuid,uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: fraude_parametros(uuid,text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: fraude_puede_revisar(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: fraude_regla_activa(uuid,text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta fraude_regla_guardar(uuid,text,boolean,jsonb) | authenticated | sí | sí |
| RPC | catálogo: fraude_regla_guardar(uuid,text,boolean,jsonb) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta fraude_reglas_cambios_leer(uuid,integer) | authenticated | sí | sí |
| RPC | catálogo: fraude_reglas_cambios_leer(uuid,integer) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta fraude_reglas_leer(uuid) | authenticated | sí | sí |
| RPC | catálogo: fraude_reglas_leer(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta fraude_ultima_deteccion(uuid) | authenticated | sí | sí |
| RPC | catálogo: fraude_ultima_deteccion(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: funcion_activa(uuid,text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta funcion_cambiar(uuid,text,boolean) | authenticated | sí | sí |
| RPC | catálogo: funcion_cambiar(uuid,text,boolean) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta funciones_estado() | authenticated | sí | sí |
| RPC | catálogo: funciones_estado() (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta grupo_funcion_cambiar(uuid,text,boolean) | authenticated | sí | sí |
| RPC | catálogo: grupo_funcion_cambiar(uuid,text,boolean) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta inventario_conteo(uuid,integer,text,uuid,integer) | authenticated | sí | sí |
| RPC | catálogo: inventario_conteo(uuid,integer,text,uuid,integer) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta inventario_entrada(uuid,integer,bigint,text,uuid) | authenticated | sí | sí |
| RPC | catálogo: inventario_entrada(uuid,integer,bigint,text,uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta inventario_historial(uuid,integer) | authenticated | sí | sí |
| RPC | catálogo: inventario_historial(uuid,integer) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta inventario_merma(uuid,integer,text,uuid) | authenticated | sí | sí |
| RPC | catálogo: inventario_merma(uuid,integer,text,uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: inventario_movimiento_previo(uuid,uuid,text,integer,integer) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: inventario_producto_para_escribir(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta inventario_reporte_noche(uuid,date) | authenticated | sí | sí |
| RPC | catálogo: inventario_reporte_noche(uuid,date) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta lista_negra_aviso(uuid,text) | authenticated | sí | sí |
| RPC | catálogo: lista_negra_aviso(uuid,text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta lista_negra_bloquear(uuid,text,uuid,text,integer,text) | authenticated | sí | sí |
| RPC | catálogo: lista_negra_bloquear(uuid,text,uuid,text,integer,text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta lista_negra_bloqueos(uuid,boolean) | authenticated | sí | sí |
| RPC | catálogo: lista_negra_bloqueos(uuid,boolean) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta lista_negra_desbloquear(uuid,uuid,uuid,text) | authenticated | sí | sí |
| RPC | catálogo: lista_negra_desbloquear(uuid,uuid,uuid,text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta lista_negra_historial(uuid,integer) | authenticated | sí | sí |
| RPC | catálogo: lista_negra_historial(uuid,integer) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta lista_negra_noshows(uuid) | authenticated | sí | sí |
| RPC | catálogo: lista_negra_noshows(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta lista_negra_politica(uuid) | authenticated | sí | sí |
| RPC | catálogo: lista_negra_politica(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta lista_negra_politica_guardar(uuid,integer,integer,integer) | authenticated | sí | sí |
| RPC | catálogo: lista_negra_politica_guardar(uuid,integer,integer,integer) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta lista_negra_tachar(uuid) | authenticated | sí | sí |
| RPC | catálogo: lista_negra_tachar(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: anon ejecuta lista_negra_tel(text) | anon | sí | sí |
| RPC | catálogo: authenticated ejecuta lista_negra_tel(text) | authenticated | sí | sí |
| RPC | catálogo: authenticated ejecuta lista_negra_ver_telefono(uuid,uuid) | authenticated | sí | sí |
| RPC | catálogo: lista_negra_ver_telefono(uuid,uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta mis_funciones(uuid) | authenticated | sí | sí |
| RPC | catálogo: mis_funciones(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: anon ejecuta para_clubes_activa() | anon | sí | sí |
| RPC | catálogo: authenticated ejecuta para_clubes_activa() | authenticated | sí | sí |
| RPC | catálogo: para_clubes_activa() (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: anon ejecuta para_clubes_contacto_enviar(text,text,text,text,text,text,text,text) | anon | sí | sí |
| RPC | catálogo: authenticated ejecuta para_clubes_contacto_enviar(text,text,text,text,text,text,text,text) | authenticated | sí | sí |
| RPC | catálogo: para_clubes_contacto_enviar(text,text,text,text,text,text,text,text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta plataforma_bandera_cambiar(text,boolean) | authenticated | sí | sí |
| RPC | catálogo: plataforma_bandera_cambiar(text,boolean) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta plataforma_banderas_estado() | authenticated | sí | sí |
| RPC | catálogo: plataforma_banderas_estado() (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta pos_asignar(uuid,uuid[],uuid) | authenticated | sí | sí |
| RPC | catálogo: pos_asignar(uuid,uuid[],uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: pos_candidatos(uuid[]) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta pos_conciliacion(uuid,date) | authenticated | sí | sí |
| RPC | catálogo: pos_conciliacion(uuid,date) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta pos_cuentas_noche(uuid,date) | authenticated | sí | sí |
| RPC | catálogo: pos_cuentas_noche(uuid,date) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: pos_exigir(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta pos_importacion_deshacer(uuid,text) | authenticated | sí | sí |
| RPC | catálogo: pos_importacion_deshacer(uuid,text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta pos_importaciones_lista(uuid) | authenticated | sí | sí |
| RPC | catálogo: pos_importaciones_lista(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta pos_importar(uuid,text,text,text,uuid,jsonb) | authenticated | sí | sí |
| RPC | catálogo: pos_importar(uuid,text,text,text,uuid,jsonb) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: pos_leer_lineas(uuid,jsonb) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta pos_mapeo_borrar(uuid) | authenticated | sí | sí |
| RPC | catálogo: pos_mapeo_borrar(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta pos_mapeo_guardar(uuid,text,jsonb) | authenticated | sí | sí |
| RPC | catálogo: pos_mapeo_guardar(uuid,text,jsonb) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta pos_mapeos_lista(uuid) | authenticated | sí | sí |
| RPC | catálogo: pos_mapeos_lista(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta pos_mis_antros() | authenticated | sí | sí |
| RPC | catálogo: pos_mis_antros() (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta pos_preparar(uuid,jsonb,text) | authenticated | sí | sí |
| RPC | catálogo: pos_preparar(uuid,jsonb,text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: pos_puede_usar(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta pos_religar(uuid,date) | authenticated | sí | sí |
| RPC | catálogo: pos_religar(uuid,date) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: pos_resolver_lote(uuid,jsonb) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta pos_tickets(uuid,date) | authenticated | sí | sí |
| RPC | catálogo: pos_tickets(uuid,date) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta propinas_anular_de_cobro(uuid,text) | authenticated | sí | sí |
| RPC | catálogo: propinas_anular_de_cobro(uuid,text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta propinas_anular_reparto(uuid,text) | authenticated | sí | sí |
| RPC | catálogo: propinas_anular_reparto(uuid,text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta propinas_calcular(uuid,uuid[],integer,integer,integer,boolean) | authenticated | sí | sí |
| RPC | catálogo: propinas_calcular(uuid,uuid[],integer,integer,integer,boolean) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta propinas_config_guardar(uuid,integer,integer,integer,boolean) | authenticated | sí | sí |
| RPC | catálogo: propinas_config_guardar(uuid,integer,integer,integer,boolean) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta propinas_config_leer(uuid) | authenticated | sí | sí |
| RPC | catálogo: propinas_config_leer(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: propinas_de_noche(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: propinas_detalle(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: propinas_partes(uuid,integer,integer) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: propinas_regla(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta propinas_repartir(uuid,uuid[],bigint,integer,integer,integer,boolean) | authenticated | sí | sí |
| RPC | catálogo: propinas_repartir(uuid,uuid[],bigint,integer,integer,integer,boolean) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta propinas_reporte_noche(uuid,date) | authenticated | sí | sí |
| RPC | catálogo: propinas_reporte_noche(uuid,date) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta puerta_copia_noche(uuid) | authenticated | sí | sí |
| RPC | catálogo: puerta_copia_noche(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta puerta_entrada_diferida(uuid,uuid,uuid,timestamp with time zone) | authenticated | sí | sí |
| RPC | catálogo: puerta_entrada_diferida(uuid,uuid,uuid,timestamp with time zone) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta puerta_escanear_codigo(uuid,text,uuid) | authenticated | sí | sí |
| RPC | catálogo: puerta_escanear_codigo(uuid,text,uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: reporte_pdf_autorizar(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta reporte_pdf_noche(uuid,date) | authenticated | sí | sí |
| RPC | catálogo: reporte_pdf_noche(uuid,date) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta reporte_pdf_semana(uuid,date) | authenticated | sí | sí |
| RPC | catálogo: reporte_pdf_semana(uuid,date) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: reservations_antiabuso_anon() (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: reservations_lista_negra() (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta whatsapp_plantilla_guardar(uuid,text,text) | authenticated | sí | sí |
| RPC | catálogo: whatsapp_plantilla_guardar(uuid,text,text) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta whatsapp_plantillas(uuid) | authenticated | sí | sí |
| RPC | catálogo: whatsapp_plantillas(uuid) (security definer) con search_path fijo | - | sí | sí |
| RPC | catálogo: authenticated ejecuta whatsapp_reserva(uuid) | authenticated | sí | sí |
| RPC | catálogo: whatsapp_reserva(uuid) (security definer) con search_path fijo | - | sí | sí |

#### Escaneo de NULL (244 funciones; 26 con patrón)

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
| `para_clubes_contacto_enviar(text,text,text,text,text,text,text,text)` | if-not-funcion | seguro: «if not para_clubes_activa()» y para_clubes_activa() es coalesce((select activa …), false): nunca NULL; no autoriza por rol (lo puede llamar el anónimo a propósito) |
| `producto_guardar(uuid,uuid,text,text,bigint,integer,boolean,integer)` | if-not-funcion | seguro: es_gerente_o_dueno() nunca NULL |
| `producto_importar(uuid,jsonb)` | if-not-funcion | seguro: es_gerente_o_dueno() nunca NULL |

#### Ayudantes boolean (29)

| Función | En políticas | En «if not f(…)» de | Veredicto |
|---|---|---|---|
| `_club_config_puede(uuid,text)` | 0 | — | nunca NULL: cada rama en coalesce(…, false) |
| `_config_aplicar_club(uuid,text,jsonb,uuid,date,boolean)` | 0 | — | SIN REVISAR |
| `_lista_negra_auto(uuid,text)` | 0 | — | nunca NULL: «return false» o coalesce(v_n >= …, false); no autoriza |
| `_lista_negra_gestiona(uuid)` | 0 | — | nunca NULL: coalesce(…, false) por fuera |
| `_lista_negra_manual(uuid,text,uuid)` | 0 | — | nunca NULL: coalesce(exists(…), false); no autoriza (dice si hay bloqueo) |
| `_lista_negra_ve_avisos(uuid)` | 0 | — | nunca NULL: coalesce(…, false) por fuera |
| `_whatsapp_trabaja(uuid)` | 0 | — | nunca NULL: coalesce(…, false) por fuera |
| `boleto_muestra_codigo(text)` | 0 | — | nunca NULL: coalesce(…, false); no autoriza (sí/no del código corto en el boleto) |
| `caja_puede_ver(uuid)` | 2 | — | nunca NULL: coalesce(…, false) |
| `caja_tiene_permiso(uuid,text)` | 0 | caja_abrir_mesa, caja_anular_consumo, caja_anular_pago, caja_cerrar_mesa, caja_cerrar_noche, caja_cuadrar_mesa, caja_reabrir_mesa, caja_registrar_consumo_producto, caja_registrar_consumo, caja_sentar_cliente | NULL solo si p_permiso es NULL («return p_permiso in (…)»); todos los que llaman pasan una constante y caja_permisos.permitido es not null |
| `club_es_dueno(uuid)` | 8 | — | nunca NULL: «uid is not null and rol is not null and exists(…)» |
| `club_es_dueno_grupo(uuid)` | 1 | — | nunca NULL: «uid is not null and rol is not null and exists(…)» |
| `dueno_tiene_club()` | 1 | — | nunca NULL: exists(…) (sql/post-junta-2/62) |
| `es_dueno_de_grupo(uuid)` | 0 | — | nunca NULL: coalesce(uid is not null and rol = dueno and exists(…), false) |
| `es_gerente_o_dueno(uuid)` | 7 | actividad_club, config_rp_actual, config_rp_cambiar_regla, config_rp_cambiar_visibilidad, config_rp_historial, nomina_cambiar_estado, producto_guardar, producto_importar | nunca NULL: coalesce y ramas booleanas |
| `fraude_puede_revisar(uuid)` | 0 | — | nunca NULL: coalesce(uid is not null and rol is not null and (coalesce(es_gerente_o_dueno) or coalesce(club_es_dueno_grupo)), false) |
| `fraude_regla_activa(uuid,text)` | 0 | — | nunca NULL: coalesce(activa, true); no autoriza (regla encendida por defecto) |
| `funcion_activa(uuid,text)` | 0 | — | nunca NULL: coalesce(club, grupo, false); quien la llama la envuelve además en coalesce(…, false) |
| `grupo_puede_editar(uuid)` | 0 | — | nunca NULL: coalesce(… admin, false) or es_dueno_de_grupo() (nunca NULL) |
| `invitacion_puede(uuid,text)` | 2 | — | nunca NULL: returns false / coalesce en cada rama |
| `nomina_transicion_valida(text,text)` | 0 | nomina_cambiar_estado | nunca NULL desde sql/post-junta-2/60 (antes NULL con estados nulos) |
| `para_clubes_activa()` | 0 | para_clubes_contacto_enviar | nunca NULL: coalesce((select activa …), false) |
| `plataforma_bandera_cambiar(text,boolean)` | 0 | — | SIN REVISAR |
| `pos_puede_usar(uuid)` | 0 | — | nunca NULL: «return false» si falta sesión, antro o rol; si no, coalesce(es_gerente_o_dueno) or coalesce(club_es_dueno_grupo) |
| `puede_ver_club(uuid)` | 3 | — | nunca NULL: coalesce |
| `puerta_es_tarde(uuid,date,timestamp with time zone)` | 0 | — | NULL a propósito (antro sin tolerancia); no autoriza: solo llena reservations.llegada_tarde |
| `rp_es_del_club(uuid,uuid)` | 6 | — | nunca NULL: coalesce(exists(…), false) (sql/post-junta-2/64) |
| `sesion_sin_acceso()` | 7 | — | nunca NULL: «uid is not null and (exists(…) or coalesce(…))» (sql/post-junta-2/61) |
| `soy_rp_dado_de_baja()` | 2 | — | nunca NULL: exists(…) |
