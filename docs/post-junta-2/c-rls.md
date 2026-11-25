# Carril c-rls — etapa 1: auditoría de RLS (C1)

Rama `c-rls` (desde `post-junta-2`). Todo probado solo en **antroapp-dev**;
nada se tocó en producción (ni lectura). El reporte completo, con la matriz
por tabla y rol, está en `docs/auditoria-rls.md`.

## Qué se hizo

| Pieza | Qué es |
|---|---|
| `scripts/dev/auditoria-rls.mjs` | Auditoría reutilizable con sesiones reales: 23 sesiones (anónimo, sin perfil, cliente, RP/staff/gerente/dueño de dos antros, dueño de grupo, admin, staff y RP dados de baja, gerente/RP/dueño con contraseña temporal, gerente sin antro) contra todas las tablas de `public` (SELECT/INSERT/UPDATE/DELETE), RPCs, candados, los dos buckets y las rutas con service role; escaneo de NULL de todas las funciones y de los ayudantes boolean. Sale con 0 si todo coincide. |
| `sql/post-junta-2/60-autorizacion-nulos-c.sql` | `personal_cambiar_estado` y `nomina_transicion_valida` con coalesce (no fallan abiertas con NULL). |
| `sql/post-junta-2/61-sesion-sin-acceso.sql` | `sesion_sin_acceso()` + restrictiva de SELECT en 7 tablas: una sesión dada de baja o con contraseña temporal no ve «lo suyo» (pagos por día, turnos, asistencias, tarifas, comisiones, reservas). |
| `sql/post-junta-2/62-clubs-dueno-valido.sql` | Crear antro: solo admin o un dueño válido sin otro antro. Editar antro, fotos, documentos y archivos: dueño válido (`club_es_dueno`, respeta baja y contraseña temporal). |
| `sql/post-junta-2/63-bucket-fotos-limites.sql` | `club-photos`: 10 MB y solo imágenes de foto. |
| `sql/post-junta-2/64-rp-del-club.sql` | Turnos, asistencias y tarifas solo para RPs del mismo antro; reservas solo en antros visibles (defensa en profundidad). |
| `lib/contrasena-temporal.ts` y 4 rutas | `create-staff`, `alta-club`, `rechazar-verificacion` y la mensualidad rechazan (403) a quien no ha cambiado su contraseña temporal, igual que la base. `rechazar-verificacion` además rechaza a un admin dado de baja. |

Ajustes de esta reanudación (25/11 en la mañana) sobre el avance PARCIAL:
- Lecturas de la service role con reintento (otro agente aplicando DDL
  bloqueaba `caja_noches` y la primera corrida abortó por timeout).
- Matriz para las tablas nuevas de otros carriles: `invitaciones`,
  `invitacion_lotes`, `correos_salida`, `invitacion_envios`,
  `invitacion_intentos` (b-equipo), `reserva_intentos` (72) y prueba de
  `invitacion_crear`. Una tabla sin GRANT para la API se comprueba sola
  («nadie la lee ni la escribe»); una expuesta sin especificación es falla
  con `--estricto`.
- El RP ya no lee `reservations` directo cuando b-cliente 41 está aplicado:
  el script lo detecta en el catálogo y ajusta lo esperado.
- Escaneo de ayudantes boolean (pueden dar NULL / dónde se usan con
  `if not`) y veredicto de `_admin_alta_club_base` (b-alta 12).
- Limpieza con segunda vuelta para los antros y registro del error.
- El hallazgo 2 del 64 («reservar en un antro no publicado») **no era hueco**:
  con el 64 quitado, ni el anónimo ni el cliente pudieron. Se corrigió el
  comentario del SQL; la restrictiva se queda como defensa en profundidad.

## SQL en orden (dev: aplicado; producción: NO)

| Orden | Archivo | Rollback | En prod hace falta por |
|---|---|---|---|
| 0 | `sql/2026-11-25-perfil-sin-club-ajeno.sql` (de C2, ya en dev) | `…-rollback.sql` | Hueco CRÍTICO vigente |
| 1 | `sql/post-junta-2/60-autorizacion-nulos-c.sql` | `60-…-rollback.sql` | `personal_cambiar_estado` es de post-junta 02: **no aplicar en prod antes de `sql/post-junta/02-baja-personal.sql`** (el `create or replace` crearía la función sin su tabla). La parte de `nomina_transicion_valida` sí aplica a prod tal cual. |
| 2 | `sql/post-junta-2/61-sesion-sin-acceso.sql` | `61-…-rollback.sql` | RP dado de baja que lee su nómina (vigente) |
| 3 | `sql/post-junta-2/62-clubs-dueno-valido.sql` | `62-…-rollback.sql` | Cualquiera con cuenta crea un antro (vigente). Usa `club_es_dueno()`, que en prod ya existe (pase 1, paso 4) pero sin exigir rol; con `sql/post-junta/08-revision-seguridad.sql` además respeta baja y contraseña temporal. Puede ir antes o después del 08. |
| 4 | `sql/post-junta-2/63-bucket-fotos-limites.sql` | `63-…-rollback.sql` | Bucket público sin límites (vigente) |
| 5 | `sql/post-junta-2/64-rp-del-club.sql` | `64-…-rollback.sql` | Turnos/tarifas a RPs de otro antro (vigente) |

Rollback en orden inverso (64 → 60). Ciclo probado el 25/11: rollback de
los cinco → la auditoría da 28 diferencias (los huecos documentados) → se
vuelven a aplicar → 0 diferencias en lo de este carril. **Dev quedó con los
cinco aplicados.** Todos los archivos en LF.

Antes de pasar a producción: el 61 y el 64 crean políticas nuevas con
`create policy` (fallan si ya existen); el 62 usa `alter policy` sobre los
nombres del esquema de producción (verificados en
`sql/esquema/esquema-prod.sql`: `clubs insert dueno o admin`,
`clubs update dueno o admin`, `club_photos_insert_dueno`,
`club_photos_delete_dueno`, `verif_docs_insert`, `verif_docs_select`,
`club_photos_restrictiva_*`, `verificacion_docs_restrictiva`).

## Pruebas automáticas (resultados reales, 25/11)

| Prueba | Resultado |
|---|---|
| `node scripts/dev/auditoria-rls.mjs --base=http://localhost:3026 --estricto` (dev con 60–64) | **8,961 / 8,961**, sale con 0 (tablas 8,165 · RPC 494 · candados 30 · storage 268 · rutas 4). Limpieza: 0 antros, 0 cuentas, 0 perfiles de prueba restantes. ~4 min. |
| La misma, con los cinco rollbacks aplicados | 28 diferencias (los huecos documentados en `docs/auditoria-rls.md`, hallazgos 1–7); se volvieron a aplicar y regresó a 0 |
| `node scripts/dev/probar-perfil-club-ajeno.mjs` (hueco CRÍTICO de C2) | 4/4 |
| `node scripts/probar-clubs-visibilidad.mjs --env=.env.dev` | 80/118: **37 de las 38 fallas son de antros de OTROS agentes** (`T cli …`, `T e2e …`) que se crearon o borraron a media prueba; la otra es el conteo total de antros que ve el admin (misma causa: compara contra la lista tomada al inicio). Las 67 líneas restantes (Panic Room, Club Demo Dev, Tijuana, Antro Borrador Dev y los antros propios de la prueba, con anónimo, cliente, RP, dueños y admin) pasan. No se pudo obtener una corrida limpia con la base compartida. |
| `npx tsc --noEmit` | sin errores |
| `npx eslint` de los archivos tocados | sin errores |
| `NEXT_DIST_DIR=.next-build npx next build` (llaves de dev) | sin errores (25/11; `tsconfig.json` no cambió) |

No hay cambios de pantalla en este carril (solo rutas de servidor, SQL y el
script), así que no hay capturas. El texto nuevo que puede ver alguien es
«Primero cambia tu contraseña temporal.» (403 de `create-staff`, `alta-club`
y la mensualidad), que solo sale si una cuenta con contraseña temporal llama
a esas rutas sin pasar por la pantalla de cambio.

## Pasos de prueba manual (clic a clic)

Usuarios: los `dev_<rol>@example.com` (contraseña en
`backups/dev-credenciales.json`, campo `password`). Contra un Preview o
`next dev` con llaves de dev. Teléfono a 390 px.

1. **Auto-registro de dueño sigue funcionando** (62). Abre `/dueno/signup`
   en una ventana privada, registra `prueba-dueno-<algo>@example.com` con
   un antro. Debe entrar a `/dueno/panel` y ver su antro en borrador.
   Después pide al admin (o con la service role) borrar esa cuenta y su
   antro.
2. **El dueño edita su antro y sube una foto** (62, 63). Entra como
   `dev_dueno`, `/dueno/panel`: cambia el horario y guarda → se guarda.
   Sube una foto JPG del celular (< 10 MB) → aparece en la galería. Los
   casos de error (formato y peso) están en el paso 10 (etapa 3). Quita la
   foto de prueba al terminar.
3. **Documentos de verificación** (62). Mismo dueño, bloque «Verificación
   de tu antro»: sube un comprobante → aparece como subido. (Si el antro ya
   está verificado, el bloque no deja subir: es lo esperado.)
4. **Staff: turnos y asistencia de su RP** (64). Entra como `dev_staff`,
   `/staff/panel` → RPs: asigna un turno a su RP y registra su asistencia
   manual → se guardan. Borra el turno de prueba.
5. **Gerente: tarifa propia de un RP** (64). Entra como `dev_gerente`,
   «Reglas de pago de RPs» → tarifa individual para su RP → se guarda.
   Regresa la tarifa a como estaba.
6. **RP activo ve su panel completo** (61). Entra como `dev_rp`,
   `/rp/panel`: Perfil, Reservas, Turnos y Nómina cargan con datos.
7. **RP dado de baja ya no ve nada** (61). Como `dev_staff`, da de baja a
   un RP de prueba creado para esto (no a `dev_rp`) con la sesión del RP
   abierta en otro navegador; en el navegador del RP recarga `/rp/panel`:
   no debe mostrar turnos ni nómina (y el login nuevo lo rechaza). Reactívalo
   o bórralo al terminar.
8. **Gerente con contraseña temporal** (61 y rutas). Da de alta un antro de
   prueba en `/admin/alta-antro` con un gerente; entra con la contraseña
   temporal: la app lo manda a cambiarla. Antes de cambiarla, ninguna
   pantalla de operación debe cargar datos. Después de cambiarla, entra
   normal. Borra el antro de prueba al terminar.
9. **Reserva sin cuenta** (64 y 72). En ventana privada, `/cliente` → Club
   Demo Dev → reservar: se crea y da su QR.

## Decisiones pendientes para Diego

1. **«Un dueño, un antro» en la base** (62). Un dueño ya no puede crear un
   segundo antro por la API (rompía su panel). Los dueños con varios antros
   van por grupos y por el alta del admin, que no pasa por esta política.
   ¿De acuerdo, o se quiere soportar varios antros por dueño en `/dueno/panel`?
2. **Tope de 10 MB y tipos de imagen en `club-photos`** (63). Fotos de
   celular pesan 2–8 MB. ¿10 MB está bien? ¿Se acepta GIF?
3. **¿El pase de 61, 62 (parte de clubs), 63 y 64 a producción va en el
   siguiente pase?** Los cuatro tapan huecos vigentes allá (bajos y medios);
   el CRÍTICO (perfil con club ajeno) va primero y aparte.
4. La baja de un **RP** no cierra sus sesiones (la de staff sí, por
   `personal_cambiar_estado`). Con el 61 ya no ve nada, pero ¿se quiere
   también cerrarle la sesión al darlo de baja?

## Riesgos

- **Base compartida.** Otros agentes crean y borran tablas y antros mientras
  corre la auditoría: puede salir una diferencia en una tabla de otro carril
  que cambió a media corrida (pasó con `invitacion_lotes`). Volver a correr
  antes de concluir.
- **`probar-clubs-visibilidad` contra dev compartido** da fallas en antros
  de prueba de OTROS agentes (`T cli …`, `T e2e …`) que se crean y borran a
  media prueba; las líneas de sus propios antros, Panic Room y Club Demo
  pasan.
- **62 cambia políticas viejas** de `clubs`, `club_photos`,
  `verificacion_documentos` y Storage. Si alguna pantalla del dueño hacía
  algo que dependía de `dueno_id = auth.uid()` sin rol `dueno`, dejará de
  funcionar. Lo cubre la matriz (dueño normal: todo sí) y los pasos 1–3.
- **El 60 reemplaza `personal_cambiar_estado`**: si otro carril la redefine
  después, hay que conservar el `coalesce`. Hoy el cuerpo en dev es idéntico
  al del 60.
- No se probó el arreglo de rutas «antes» (habría que revertir el código):
  solo que hoy responden 403.

---

# Carril c-rls — etapa 2: pruebas de concurrencia (C5)

Mismo criterio: solo **antroapp-dev**, nada en producción. Resultados por
caso en `docs/auditoria-rls.md`, sección «Concurrencia».

## Qué se hizo (etapa 2)

| Pieza | Qué es |
|---|---|
| `scripts/dev/probar-concurrencia-noche3.mjs` | 46 revisiones en 5 casos con sesiones reales (PostgREST + RLS) y peticiones a la vez (`Promise.all`), más **carreras forzadas** repetibles: dos conexiones directas con el rol y el JWT de quien llama (como PostgREST); la primera deja su transacción abierta y se mide si la segunda espera el candado y qué responde. Crea antros «T rls conc A/B <tag>» y cuentas `t_rls_<tag>_…@example.com` y los borra al final (try/finally); comprueba que no queden restos. No toca Club Demo Dev. ~1 min. |
| `sql/post-junta-2/65-concurrencia-puerta-cobro.sql` | (1) `puerta_confirmar_entrada`: la segunda confirmación de la misma reserva recibía «Primero escanea el QR» (falso); ahora «Esta reserva ya entró a las HH:MM.» (hora del antro). `puerta_escanear` agrega la misma hora a su aviso. (2) `caja_registrar_pago`: la clave de idempotencia se busca otra vez **con la mesa bloqueada**; el mismo cobro enviado varias veces a la vez ya no le da al staff «El saldo de la mesa cambió» por un cobro que sí entró. Va en un bloque `do` que corrige la versión que exista (con propina = fase 2, o sin propina = producción). |
| `sql/post-junta-2/66-reservas-antiabuso-concurrencia.sql` | El trigger del 72 (topes de reservas sin cuenta) contaba sin candado: dos reservas a la vez del mismo teléfono veían el mismo conteo y pasaban las dos (la «4a» entraba). Ahora el conteo por teléfono+antro+noche y el de IP van detrás de `pg_advisory_xact_lock`. **Va después del 72** (si no existe, se detiene con error y no cambia nada). |
| `scripts/dev/probar-caja.mjs` | La revisión «dueño: INSERT de antro con RETURNING» usaba un dueño que ya tenía antro; desde el 62 (etapa 1) eso se rechaza a propósito. Ahora usa un dueño sin antro, y se agregó «dueño con antro: un segundo antro se rechaza (62)». |

Sin cambios de pantalla en esta etapa: los avisos nuevos de la puerta y la
caja salen de la base como P0001 y el panel de staff ya los muestra tal cual
(`mensajeDeError` → `mensajeParaUsuario`). `/cliente/reservar` ya traducía
el 23505 («Ya tienes una reserva en este antro para esa noche.»; prueba 2e).
**Corrección (etapa 3):** aquí decía que los avisos nuevos se veían en
pantalla, y para `/cliente/reservar` no era cierto: los P0001 del tope de
reservas sin cuenta (72/66) terminaban en «No pudimos crear tu reserva.
Intenta de nuevo…». Se arregló en la etapa 3.

## SQL en orden, etapa 2 (dev: aplicado; producción: NO)

| Orden | Archivo | Rollback | Notas para producción |
|---|---|---|---|
| 6 | `sql/post-junta-2/65-concurrencia-puerta-cobro.sql` | `65-…-rollback.sql` | Necesita la puerta y la caja del pase (noche2: `2026-11-21-caja-idempotencia.sql`, `2026-11-20-caja-candado-puerta.sql`). Si después se pasa la fase 2 (P11), su `create function caja_registrar_pago` regresa la versión sin el arreglo: **volver a correr el 65 después de P11**. El rollback también es condicional (con o sin propina). |
| 7 | `sql/post-junta-2/66-reservas-antiabuso-concurrencia.sql` | `66-…-rollback.sql` | Después de `sql/post-junta-2/72-reservas-antiabuso.sql`. El rollback regresa el cuerpo idéntico al del 72. |

Ciclo probado el 25/11 en dev: aplicar 65+66 → 46/46; rollback del 66 y
del 65 → el catálogo (`pg_get_functiondef` de las 4 funciones y sus ACL)
queda **idéntico byte por byte** al de antes; volver a aplicar → 46/46.
**Dev quedó con 65 y 66 aplicados.** La rama sin propina del 65 y de su
rollback solo se comprobó compilándola dentro de una transacción que se
deshizo (dev tiene la fase 2): no se ejecutó.

## Pruebas automáticas, etapa 2 (resultados reales, 25/11)

| Prueba | Resultado |
|---|---|
| `node scripts/dev/probar-concurrencia-noche3.mjs` **sin** 65/66 | 40/46: fallan 1d y 1i (aviso «Primero escanea el QR»), 2h (la 4a reserva sin cuenta pasa sin esperar), 3a/3b (en esa corrida; dependen de la red) y 3j (carrera forzada: «el saldo cambió»). En la primera corrida sin el arreglo 3a pasó y falló 3d (5 envíos de la misma clave: 4 con «el saldo cambió»). |
| La misma **con** 65/66 | **46/46** (dos corridas); limpieza sin restos |
| `node scripts/dev/probar-caja-concurrencia.mjs` (con 65/66) | 29/29 |
| `node scripts/dev/probar-caja.mjs` (con 65/66 y el ajuste del 62) | **168/168**. Antes del ajuste: 166/167 (la del dueño con antro). Una corrida intermedia abortó con «Mesa no encontrada» al sentar (19/29; la base compartida cambió a media prueba); la siguiente, limpia. |
| `node scripts/dev/auditoria-rls.mjs --estricto` (con 60–66, sin servidor: rutas saltadas) | 8,957 / 8,957, sale con 0 |
| `npx tsc --noEmit` · `npx eslint` de los 2 scripts | sin errores |
| `NEXT_DIST_DIR=.next-build npx next build` (llaves de dev) | sin errores; `tsconfig.json` no cambió |

## Pasos de prueba manual, etapa 2 (clic a clic)

Dos teléfonos (o dos navegadores) a 390 px contra un Preview o `next dev`
con llaves de dev. Usuarios `dev_staff` y `dev_gerente` (contraseña en
`backups/dev-credenciales.json`, campo `password`), Club Demo Dev. Esto
escribe en la noche de Club Demo Dev: usar una reserva de prueba y avisar,
porque la base es compartida.

1. **Dos staff, misma reserva** (65). En los dos teléfonos abre
   `/staff/panel` → Escanear y lee el mismo QR (o, en el segundo, la misma
   reserva en la lista con la entrada manual). En el primero toca
   «Confirmar entrada» → entra. En el segundo toca «Confirmar entrada» →
   debe decir **«Esta reserva ya entró a las HH:MM.»** (no «Primero escanea
   el QR»). Escanear otra vez ese QR → el mismo aviso con la hora.
2. **Cobro repetido con mala señal** (65). `dev_staff`, caja → una mesa con
   consumo. Pon el teléfono en modo avión justo después de tocar «Cobrar»,
   quítalo y deja que reintente (o toca otra vez). Debe quedar **un solo
   cobro** y ningún «El saldo de la mesa cambió». Revisa la lista de cobros.
3. **Dos staff cobran el saldo completo a la vez** (ya existía). Misma mesa
   abierta en los dos teléfonos, los dos cobran el total: uno entra y el
   otro ve «El saldo de la mesa cambió… (ahora es $0.00)».
4. **Dos gerentes cuadran la misma mesa** (ya existía). `dev_gerente` en
   los dos, mesa cerrada, «Cuadrar» a la vez: un solo cuadre; la pantalla
   del segundo trata el «ya cuadrada» como éxito.
5. **Dos gerentes cierran la noche** (ya existía). Solo en un antro de
   prueba, no en Club Demo Dev (cierra la caja de la noche para todos). La
   pantalla del segundo pasa a «cerrada» **sin aviso** y su conteo no se
   guarda (ver decisión 6).
6. **Reserva duplicada** (índice del pase). Con una cuenta de cliente de
   prueba, reserva en Club Demo Dev para mañana; vuelve a reservar mismo
   antro y misma noche → «Ya tienes una reserva en este antro para esa
   noche.» Borra la reserva y la cuenta de prueba al terminar.

## Decisiones pendientes para Diego (etapa 2)

5. **Segunda confirmación de entrada**: hoy es un aviso («ya entró a las
   HH:MM»). ¿Se quiere además decir **quién** la registró? (El dato está:
   `entrada_por`.)
6. **Dos gerentes cierran la noche**: gana el primero; la pantalla del
   segundo pasa a «cerrada» sin decirle que su conteo no se usó. Si contaron
   distinto, el segundo no se entera. ¿Mostrar «La cerró <nombre> a las
   HH:MM con su conteo»? (Cambio en `components/caja/cuadre-noche.tsx`, no
   hecho.)
7. **Cobro sin clave ni saldo esperado** (código viejo de caja): dos cobros
   a la vez con claves distintas y sin `p_saldo_esperado` entran los dos (lo
   de siempre; el código actual siempre manda los dos).

## Riesgos (etapa 2)

- **El 65 redefine `caja_registrar_pago`** con dos versiones posibles. Si
  otro carril o la fase 2 la vuelven a definir después, se pierde el arreglo
  (la prueba 3j lo detecta). La rama sin propina no se ejecutó en dev.
- **El 66 depende del 72**, que no está en esta rama (vive en la carpeta
  del coordinador): integrar los dos juntos.
- El candado del 66 forma en fila las reservas sin cuenta del mismo
  teléfono o la misma IP (milisegundos). Muchas reservas anónimas desde una
  sola IP (p. ej. el wifi del antro) se procesan una por una.
- Base compartida: una corrida de `probar-caja` abortó a media prueba por
  cambios ajenos; volver a correr antes de concluir.

---

# Carril c-rls — etapa 3: correcciones de la revisión (25/11, tarde)

El revisor del carril encontró 4 defectos. Los verifiqué uno por uno en dev
antes de tocar nada; **los 4 eran reales** y quedaron arreglados. Nada en
producción (ni lectura). Sin commits (los hace el coordinador): todo está
en el working tree de `c-rls`.

## Qué se hizo, por defecto

| # | Defecto (revisor) | Verificación | Arreglo |
|---|---|---|---|
| 1 | El anónimo lista el bucket público `club-photos`: carpetas (id del antro) y nombres de archivo de antros **no publicados**. La auditoría no lo probaba y el reporte decía «leer, listar» para los dos buckets. | Real. Antes: el script del revisor (solo lectura) dio 2 carpetas de antros no publicados con sus archivos; la auditoría sin el 67 da 42 diferencias (14 sesiones × listar raíz, listar carpeta y `list-v2`). | `sql/post-junta-2/67-club-photos-listar.sql`: restrictiva de SELECT en `storage.objects` para `club-photos` (admin, o carpeta de un antro que `puede_ver_club()` acepta). La auditoría ahora lista la raíz, la carpeta y `list-v2` en A y B para las 19 sesiones. `docs/auditoria-rls.md`: fila de Storage corregida, hallazgo 9 y el límite conocido de la ruta exacta. |
| 2 | `/dueno/panel` no se ajustó al tope del 63: `accept="image/*"`, sin revisar peso ni tipo, error genérico «Intenta de nuevo», y el lote se cortaba a la mitad sin decir qué se subió. | Real (código y catálogo). | `lib/fotos-club.ts` (misma lista y tope que el bucket; el tipo vacío de HEIC se deduce por la extensión; traduce el 413/415 de Storage). En `handleUploadPhotos`: revisa todo el lote **antes** de subir, sube solo las válidas, avisa cuál no y por qué («ese formato no se acepta. Usa JPG, PNG o WebP.» / «pesa 11.0 MB y el máximo es 10 MB»), y si algo falla a la mitad dice «Se subieron N de M fotos; las demás no.» y recarga la galería. `accept` con la lista exacta; el texto de ayuda dice «de hasta 10 MB cada una». Se corrigió el comentario del 63. |
| 3 | «Un dueño, un antro» del 62 sin candado: dos altas a la vez pasan las dos. | Real, y más fácil que en la revisión: **por la API**, 3 altas a la vez del mismo dueño dejaron **3 antros** (sin forzar la carrera). | `sql/post-junta-2/68-un-antro-por-dueno-candado.sql`: trigger `BEFORE INSERT` (función `SECURITY INVOKER`, `search_path` vacío) que, para `current_user = authenticated` no admin, toma `pg_advisory_xact_lock` por dueño y vuelve a contar con `dueno_tiene_club()`; si ya tiene, P0001 «Ya tienes un antro registrado. Para sumar otro, pídelo al equipo de AntroApp.». Admin, service role y funciones `SECURITY DEFINER` (`_admin_alta_club_base`) no pasan por él, igual que la política del 62. No es índice único (decisión 1). Caso 6 nuevo en `probar-concurrencia-noche3.mjs`. |
| 4 | El reporte decía que la 4a reserva sin cuenta «se rechaza con "Ya hay varias reservas…"»; la pantalla mostraba el genérico. | Real (código; la suite C4 de la rama base ya lo había visto). | `app/cliente/reservar/page.tsx`: un error P0001 se muestra tal cual y sin «Intenta de nuevo» (antes del `throw`). Prueba 2e' (código) y `probar-fotos-y-avisos.mjs` 2a (en pantalla). Reporte corregido (fila 2' de Concurrencia y la nota de la etapa 2 de este archivo). |

## SQL en orden, etapa 3 (dev: aplicado; producción: NO)

| Orden | Archivo | Rollback | Notas para producción |
|---|---|---|---|
| 8 | `sql/post-junta-2/67-club-photos-listar.sql` | `67-…-rollback.sql` (`drop policy if exists`) | Hueco **vigente en producción** (misma permisiva abierta). Requiere `puede_ver_club(uuid)`, que ya está allá desde el pase 1 (`2026-11-20-caja-por-mesa.sql`). Independiente de 60–66: puede ir solo y antes. Usa `create policy`: falla si ya existe. |
| 9 | `sql/post-junta-2/68-un-antro-por-dueno-candado.sql` | `68-…-rollback.sql` | **Después del 62** (usa `dueno_tiene_club()`). Se puede volver a correr (`create or replace` + `drop trigger if exists`). |

Ciclo probado el 25/11: rollback del 68 y del 67 → auditoría con 42
diferencias (hallazgo 9) → se vuelven a aplicar → 0. Para el 68: sin él el
caso 6 falla (6a–6d), con él pasa. **Dev quedó con 60–68 aplicados.** Los
cuatro archivos nuevos en LF.

## Pruebas automáticas, etapa 3 (resultados reales, 25/11 en la tarde)

| Prueba | Resultado |
|---|---|
| `node scripts/dev/auditoria-rls.mjs --base=http://localhost:3026 --estricto` (dev con 60–68, `next dev` sin Turbopack en 3026) | **9,113 / 9,113**, sale con 0 (tablas 8,165 · RPC 494 · candados 30 · storage 420 · rutas 4). Dos corridas iguales. Limpieza: 0 antros, 0 cuentas, 0 perfiles. Matriz regenerada en `docs/auditoria-rls.md`. |
| La misma con el rollback de 67 y 68 | 9,071 / 9,113: **42 diferencias**, todas de listar `club-photos` B (raíz, carpeta y `list-v2`) por las 14 sesiones que no deben verlo. |
| Script del revisor (`rev-crls/lista.mjs`, solo lectura, anónimo) | Antes: 4 carpetas, 2 de antros no publicados con sus archivos. Después: 2 carpetas, **0** de antros no publicados, 0 archivos. La URL pública de una foto de Club Demo Dev sigue en 200. |
| `node scripts/dev/probar-concurrencia-noche3.mjs` | Antes de los arreglos: **47/52** (fallan 2e' y 6a–6d; por la API 3 altas → 3 antros). Después: **52/52** (dos corridas), sin restos. |
| `PLAYWRIGHT_DESDE=… node scripts/dev/probar-fotos-y-avisos.mjs http://localhost:3026` (nuevo) | **12/12**: `accept` exacto; BMP y 11 MB rechazados con su motivo a 390 y 360 px y sin llegar a Storage; lote PNG + BMP sube el PNG (Storage y galería) y avisa del BMP; la 4a reserva sin cuenta muestra «Ya hay varias reservas con este teléfono para esa noche en este antro.» a 390 y 360 px y no se guarda. Sin restos. La primera corrida dio 10/12 por un error de la prueba (tomaba el `role=alert` vacío del anunciador de rutas de Next); corregido. |
| `node scripts/dev/probar-caja.mjs` | **168/168** (el segundo antro del dueño ahora lo rechaza el trigger del 68 antes que la política; la prueba pasa igual) |
| `node scripts/dev/probar-caja-concurrencia.mjs` | 29/29 |
| `node scripts/dev/probar-perfil-club-ajeno.mjs` | 4/4 |
| `node scripts/probar-clubs-visibilidad.mjs --env=.env.dev` | 73/78: las 5 fallas son de `T caja multi…`, un antro de prueba de **otro agente** cuyas fotos se borraron a media corrida (ni el admin las vio). Panic Room, Club Demo Dev, Antro Borrador Dev y los antros propios pasan. Mismo riesgo de base compartida de la etapa 1. |
| `npx tsc --noEmit` · `npx eslint` de los 7 archivos tocados | sin errores |
| `NEXT_DIST_DIR=.next-build npx next build` (llaves de dev) | sin errores; `tsconfig.json` no cambió |

Capturas (390×844 y 360×740, revisadas) en `screenshots-c-rls/` (ignorada
por git): `fotos-formato-*.png`, `fotos-peso-*.png`, `fotos-lote-390.png`,
`reservar-tope-*.png`. El texto cabe a 360 px; el aviso usa
`text-destructive` (token).

No probado: el mensaje de `mensajeErrorStorageFoto` (413/415 de Storage)
no se ve en pantalla, porque la revisión previa ya no deja llegar esos
archivos; solo saldría si el bucket cambia sin cambiar `lib/fotos-club.ts`.
Tampoco un HEIC real con tipo vacío (la deducción por extensión no se probó
en un navegador).

## Pasos de prueba manual, etapa 3 (clic a clic)

Teléfono a 390 px contra un Preview o `next dev` con llaves de dev.

10. **Fotos con formato o peso inválido** (63 y panel). Entra con un dueño
    de prueba con antro propio (no Club Demo Dev; por ejemplo uno creado en
    `/dueno/signup` como en el paso 1). «Fotos de mi antro» → «Elegir
    fotos»: el selector del teléfono solo ofrece fotos. Elige una foto de
    más de 10 MB (una panorámica o una de 108 MP) → debe decir ««nombre»
    pesa N MB y el máximo es 10 MB. Reduce la foto e intenta otra vez.» y
    no aparece en la galería. Desde una computadora elige un `.bmp` o
    `.tiff` → «ese formato no se acepta. Usa JPG, PNG o WebP.». Elige dos a
    la vez, una JPG buena y un BMP → la JPG aparece y el aviso nombra solo
    al BMP. Borra las fotos de prueba.
11. **Listar el bucket ya no muestra borradores** (67). No tiene pantalla:
    lo cubre la auditoría. Como control, abre `/cliente` sin sesión → las
    fotos de Club Demo Dev se ven igual que antes; y como `dev_dueno` en
    `/dueno/panel`, la galería de su antro carga (sin subir nada).
12. **Un dueño, un antro** (68). No hay pantalla para crear un segundo
    antro: lo cubre la prueba 6. Si se quiere ver: en `/dueno/signup`, con
    la misma cuenta nueva en dos pestañas, tocar «Registrar» en las dos a la
    vez → un solo antro. Borrar la cuenta y el antro de prueba.
13. **Tope de reservas sin cuenta en pantalla** (66/72 y pantalla). Ventana
    privada, `/cliente` → un antro de prueba publicado (no Club Demo Dev) →
    reservar 3 veces para la misma noche con el mismo teléfono; la 4a debe
    decir «Ya hay varias reservas con este teléfono para esa noche en este
    antro.» (sin «Intenta de nuevo») y no dar QR. Borrar las reservas de
    prueba.

## Decisiones pendientes para Diego (etapa 3)

8. **Nombre original del archivo en la ruta** de `club-photos`
   (`{club}/{uuid}-{nombre}`). Con el 67 ya no se lista, pero la URL
   pública de una foto publicada sigue llevando el nombre que le puso el
   dueño (p. ej. «IMG_2041.jpg» o algo personal). ¿Guardar solo
   `{club}/{uuid}.{ext}`? (cambio chico en `/dueno/panel`, no hecho).
9. **Formatos**: el aviso dice «Usa JPG, PNG o WebP» aunque también pasan
   HEIC, AVIF y GIF (la decisión 2 de la etapa 1 sigue abierta).
10. **«Un dueño, un antro»** (decisión 1): el 68 la hace firme también en
    paralelo. Si Diego decide «varios antros por dueño» en `/dueno/panel`,
    se quitan juntos la condición del 62 y el 68.

## Riesgos (etapa 3)

- **Ruta exacta en bucket público**: el 67 evita que se descubran las rutas,
  pero quien ya tenga la URL de una foto de un borrador la sigue viendo (es
  público por diseño; anotado en la matriz como «ruta exacta: sí»). Para
  cerrarlo del todo, las fotos de borradores tendrían que vivir en un
  bucket privado hasta publicar.
- **El 67 llama a `puede_ver_club` por cada antro** al listar (una vez por
  consulta, no por archivo). Con cientos de antros, listar es más lento;
  la app no lista ese bucket (solo sube, borra y usa URL públicas).
- **El 68 forma en fila** las altas del mismo dueño (milisegundos); no
  afecta a dueños distintos. Lo que cree antros como un rol distinto de
  `authenticated` no pasa por el candado (igual que la política del 62).
- `app/dueno/panel/page.tsx` y `app/cliente/reservar/page.tsx` los pueden
  tocar otros carriles: revisar el merge de `handleUploadPhotos` y del
  bloque `if (insertError)`.
