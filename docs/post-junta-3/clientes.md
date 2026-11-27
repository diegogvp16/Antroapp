# Clientes: lista negra / no-show y mensajes de WhatsApp (noche 4, rama `n4-clientes`)

Dos bloques, cada uno detrás de su bandera por antro (sql/post-junta-3/00),
**apagadas por defecto** y apagadas en dev al terminar:

- **Bloque 4 — `lista_negra`**: lista negra por antro y política de no-show.
- **Bloque 6 — `whatsapp`**: plantillas por antro y enlaces wa.me. **Sin API:
  nada se envía solo.** Abrir el enlace abre WhatsApp con el texto escrito; la
  persona decide si lo manda. Las pantallas lo dicen así.

Con las dos apagadas, todo queda como hoy: los triggers nuevos de reservas
regresan sin revisar nada, el botón del panel no aparece y las funciones de
gestión responden «no está activa» (probado en la base, por la API real y en
pantalla).

Segunda vuelta (27/11/2026): se corrigieron los 8 hallazgos de la revisión
independiente (sección «Correcciones de la revisión»).

## Qué se construyó

### Lista negra (bloque 4)

- **Bloqueo manual** por teléfono y, si la reserva era de un cliente con
  cuenta, también por su cuenta (`cliente_id`: aunque cambie de teléfono,
  sigue bloqueado). Motivo obligatorio (3–300), quién y cuándo, vencimiento
  opcional (30 / 90 / 365 días o sin vencimiento), desbloqueo con motivo.
  **Nada se borra**: el desbloqueo cierra la fila; un trigger impide borrar o
  editar (salvo la cascada al borrar el antro y el tachado del admin, abajo).
- **Teléfono** (`lista_negra_tel` = `claveTelefono` en el código): solo los
  dígitos; si es un número de México en una forma conocida (10 dígitos;
  52+10; 521+10; 044/045+10; 01+10), sus 10 dígitos; cualquier otra cosa de
  8 a 15 dígitos se guarda **completa** (no se recorta). Un número que no es
  de México y que **contiene** uno bloqueado cuenta como bloqueado
  («+52 1 331 999 8877 1» no esquiva el bloqueo de 3319998877).
- **No-show** = reserva del antro cuya noche ya terminó (fecha anterior a la
  noche operativa del antro, corte 08:00, o caja de esa noche cerrada) **sin
  entrada** (`puerta_estado = 'entro'` o `status = 'usada'`) **y sin consumo**
  en caja. Misma definición que «No llegó» de `rp_mis_reservas` y
  «no_llegaron» del cierre de la noche (la prueba lo compara con los datos
  demo: 35 reservas de un RP, 0 distintas; 30 noches del antro, igual).
  Se cuenta **por noches distintas** (tres reservas de una noche = 1).
- **Política por antro**: avisar desde N no-shows en M días (de fábrica 2 en
  90) y, opcional, **bloqueo automático** desde K (de fábrica **apagado**).
  Para el bloqueo automático **solo cuentan las reservas de clientes con
  cuenta o hechas por un RP**: una reserva sin cuenta la puede hacer
  cualquiera con el teléfono de otro (solo da aviso). El automático no crea
  filas: se calcula al reservar. Desbloquear («Quitar bloqueo automático»)
  registra hasta qué noche perdona (`perdona_hasta`: la de hoy si su caja ya
  cerró, si no la anterior) y desde ahí solo cuentan noches posteriores.
- **Al reservar** (sin cuenta, cliente con cuenta y RP) y **al cambiar** el
  teléfono, la cuenta, el antro o la noche de una reserva (p. ej. el staff
  corrige el teléfono): si está bloqueado en ESE antro y la bandera está
  encendida, P0001.
  - Cliente y sin cuenta: «No pudimos apartar tu lugar en este antro.
    Comunícate directamente con el antro.» (ni «bloqueado», ni motivo).
  - RP: «Este cliente no puede reservar en este antro por ahora. Si crees que
    es un error, habla con tu gerente.» — el RP **sí se entera** de que ese
    cliente no puede reservar ahí (no del motivo).
  - Staff que cambia el teléfono: «Ese cliente no puede reservar en este
    antro por ahora (lo revisa el gerente).»
  - La service role (scripts) no pasa por aquí.
- **Avisos sin motivo**: staff y gerente, en «Clientes y mensajes → Noche»
  («N noches sin llegar antes», «Bloqueado en este antro: habla con el
  gerente»); RP, al crear una reserva y en el detalle de SUS reservas.
- **Pantalla** (gerente y dueño): pestañas No-show, Bloqueados, Política
  (con el historial). En Bloqueados el teléfono sale enmascarado (`***1234`) y
  el completo con «Ver teléfono», que queda en el historial (ver Privacidad:
  no es una barrera). Estados de carga, vacío y error.
- **Tachar** (`lista_negra_tachar`, solo admin, sin pantalla): cambia el
  motivo y el motivo de desbloqueo por «[tachado]», quita el nombre de
  referencia, tacha el motivo en la bitácora de ese teléfono y lo registra.

### WhatsApp (bloque 6)

- Plantillas de **confirmación, recordatorio y aviso de no-show**. De fábrica
  en el código (la confirmación incluye «el QR no garantiza la entrada»);
  cada antro puede guardar la suya (gerente, dueño). Variables: `{nombre}`,
  `{antro}`, `{fecha}` («miércoles 25 de noviembre»), `{hora}` (**el horario
  del antro tal como está en su perfil**: las reservas no tienen hora),
  `{personas}`, `{enlace_boleto}`. Validación igual en el código y en la base
  (variables desconocidas, llaves sueltas, vacío, más de 1000). Vista previa,
  «Volver al de fábrica», bitácora de cambios.
- `{nombre}` = primer nombre **solo si son letras** (con acentos) y hasta 30;
  si no, vacío (un nombre como «https://…» no entra al mensaje que el staff
  manda desde su WhatsApp).
- Enlaces `https://wa.me/52XXXXXXXXXX?text=…` **solo con números de México**;
  con cualquier otro (o sin teléfono), `https://wa.me/?text=…` marcado «sin
  teléfono»: la persona elige a quién mandarlo. Según el estado: por llegar →
  confirmación y recordatorio; no llegó → aviso de no-show.
  - Staff/gerente/dueño: «Clientes y mensajes → Noche» (anoche, esta noche,
    mañana). El staff ya ve hoy los teléfonos de las reservas de su antro.
  - RP: en el detalle de SUS reservas (`whatsapp_reserva` solo responde por
    reservas del propio RP).
  - Ojo: el botón «Compartir por WhatsApp» que ya existía en el panel del RP
    (`enlaceWhatsApp` de `lib/domain/rp-reservas.ts`) **no se cambió**: con un
    número que no es de 10 dígitos lo manda tal cual a wa.me.

## Correcciones de la revisión (segunda vuelta)

1. **(Alto) Enumeración gratis**: el trigger era BEFORE INSERT y respondía
   antes que RLS. Ahora es **AFTER INSERT** (y AFTER UPDATE de teléfono,
   antro, cuenta o fecha): primero pasan RLS, CHECK, el índice único y el
   límite de reservas sin cuenta; una inserción que de todos modos se
   rechazaría responde igual con un teléfono bloqueado y con uno libre
   (42501 en ambos, probado en la base y por la API).
2. **(Medio) No-shows inflados**: se cuentan noches distintas, y para el
   automático solo reservas con cuenta o de RP.
3. **(Medio) Teléfonos**: se quitó el «últimos 10 dígitos»; números no
   mexicanos no generan wa.me directo; la lista negra compara los dígitos
   completos y detecta un número bloqueado dentro de uno «alargado».
   **Decisión para Diego**: el límite de reservas sin cuenta (72/66, ahora
   02) acepta 10–15 dígitos de cualquier forma; rechazar ahí números que no
   sean de México cerraría más trucos, pero cambia una regla que no es de
   esta pista (no se tocó).
4. **(Medio) Rendimiento**: índice `reservations_club_tel_fecha` (club,
   `lista_negra_tel(cliente_telefono)`, fecha) y conteo por teléfono con SQL
   dinámico para que use el índice. `lista_negra_tel` es ejecutable por anon
   y authenticated porque Postgres revisa el permiso de la función del índice
   al insertar (comprobado: sin EXECUTE, la inserción falla con 42501); es
   pura (IMMUTABLE, sin leer tablas, no SECURITY DEFINER).
5. **(Bajo-medio) `{nombre}` con enlaces**: solo letras, hasta 30.
6. **(Bajo) Desbloquear antes de las 08:00**: se guarda la última noche
   terminada y se compara con «>» (con K=1 ya sirve; probado con la caja de
   hoy cerrada).
7. **(Bajo) Borrado y tachado**: la cascada al borrar un antro pasa (el
   trigger ve que el antro ya no existe); `lista_negra_tachar` para el admin.
   La salida de emergencia `antroapp.borrado_pruebas` solo la usa el rol
   `postgres` (dueño de la base: SQL Editor o `DATABASE_URL`), nunca la API;
   existe igual en producción.
8. **(Bajo) Documentos**: corregidos (el RP sí se entera; teléfonos completos
   sin registro fuera de la pantalla de bloqueados).

## Decisiones (para Diego)

1. **Quién gestiona la lista**: gerente activo del antro, dueño, **dueño del
   grupo** (solo antros de su grupo) y admin. **El staff no**: ve avisos, no
   motivos. El dueño de otro antro no ve nada. Pantalla solo para gerente
   (`/staff/clientes`) y dueño (`/dueno/clientes`); sin selector de antro para
   dueño de grupo y admin.
2. **Bloqueo automático**: apagado de fábrica; es una decisión automatizada
   sobre una persona (ver Riesgos).
3. **Se rechaza al reservar, no en la puerta**: una reserva hecha antes del
   bloqueo sigue viva; la puerta la ve marcada «Bloqueado» y decide el gerente.
4. **Teléfono en claro** en `club_bloqueos`: el gerente necesita reconocerlo;
   la reserva misma ya lo guarda en claro. El enmascarado de la pantalla de
   bloqueados no es una barrera: staff, gerente y dueño ya leen hoy el
   teléfono completo de las reservas de su antro, sin registro.
5. **Números que no son de México** en el límite de reservas sin cuenta
   (punto 3 de arriba).
6. **Plazo de conservación** de bloqueos y bitácora: hoy ninguno.

## Enumeración (lo que queda)

- La lista y los motivos solo salen por funciones de gestión; tablas cerradas.
- Una inserción inválida ya no distingue un teléfono bloqueado de uno libre.
- Con una inserción **válida**, la señal «se pudo / no se pudo» es
  inevitable. Cada teléfono libre probado crea una **reserva real** (visible
  en la lista de la puerta) y gasta el tope sin cuenta (3 por
  teléfono/antro/noche, 20 por IP por hora); el CAPTCHA, cuando se encienda,
  suma.
- **Lo que no cuesta**: un rechazo por lista negra deshace también su renglón
  en `reserva_intentos` (misma transacción), así que probar un teléfono que
  **sí** está bloqueado no gasta el tope (probado: 1→1). En números: desde una
  IP se pueden probar ~20 teléfonos libres por hora más todos los bloqueados
  que caigan entre los probados; como casi ningún teléfono está bloqueado, en
  la práctica son ~20 por hora por IP. Cerrarlo del todo exigiría contar los
  rechazos fuera de la transacción (ruta del servidor o pg_net); no se hizo.
- Los avisos de no-show van por reserva (id o QR) que quien pregunta ya ve.

## Archivos

- SQL: `sql/post-junta-3/40-lista-negra.sql` (+ `-rollback.sql`),
  `sql/post-junta-3/60-whatsapp-plantillas.sql` (+ `-rollback.sql`).
- Dominio: `lib/domain/lista-negra.ts`, `lib/domain/whatsapp.ts`.
- Pantallas: `app/staff/clientes/page.tsx`, `app/dueno/clientes/page.tsx`,
  `components/clientes/` (10 componentes).
- Líneas mínimas en páginas compartidas: `app/staff/panel/page.tsx`,
  `app/dueno/panel/page.tsx` (botón, solo con una bandera encendida),
  `app/rp/panel/page.tsx` (muestra los avisos P0001 al crear y el aviso de
  no-shows), `components/rp/detalle-reserva-rp.tsx` (aviso y mensajes).
- Pruebas: `scripts/dev/probar-clientes-dominio.mjs`,
  `scripts/dev/probar-lista-negra.mjs` (`--rest`, `--carga`),
  `scripts/dev/probar-clientes-pantalla.mjs`.
- `docs/legal/inventario-datos.md` actualizado.

## SQL: orden y rollback

Requiere `00-funciones-club.sql`. Orden: **40** y luego **60**. Rollback en
orden inverso: **60-rollback** y luego **40-rollback** (borran bloqueos,
política, bitácora y textos propios: respaldar antes si hay datos). Ninguno
toca triggers, políticas ni columnas existentes de `reservations`: 40 agrega
dos triggers NUEVOS (`reservations_lista_negra`,
`reservations_lista_negra_cambio`; AFTER, SECURITY DEFINER,
`search_path = ''`) y un índice nuevo (`reservations_club_tel_fecha`). En
producción el índice se crea dentro de la transacción del pase (bloquea
escrituras de `reservations` mientras se arma; con pocos miles de filas es
instantáneo).

En dev: rollback exacto, probado con la versión final (foto del esquema sin lo nuestro, aplicar, rollback, foto: 0 líneas de diferencia; aplicar dos veces: idéntico). Otras pistas cambiaban dev al mismo tiempo; en una de las comparaciones aparecieron 831 líneas de diferencia, todas de otra pista y ninguna de nuestros objetos (se filtró por nombre). Dev queda **con 40 y 60 aplicados** y las
banderas apagadas.

## Pruebas (27/11/2026, contra antroapp-dev)

| Prueba | Resultado |
|---|---|
| `node scripts/dev/probar-clientes-dominio.mjs` | 68/68 |
| `node scripts/dev/probar-lista-negra.mjs --rest --carga` (sesiones simuladas de 14 tipos; privilegios como en producción; cascada; API real anon/cliente/RP; carga de 20,000 reservas) | 197/197 |
| `PLAYWRIGHT_DESDE=… node scripts/dev/probar-clientes-pantalla.mjs http://localhost:3044` (390×844 y 360×740) | 111/111 |
| `node scripts/dev/probar-reservas-antiabuso.mjs` | 14/14 |
| `node scripts/dev/probar-concurrencia-noche3.mjs` | 52/52 (una primera corrida dio 25/32 por *statement timeout* en 2a/3g con dev cargado por otras pistas; la segunda, sin cambios, 52/52) |
| `node scripts/dev/auditoria-rls.mjs` | 10049 coinciden, 0 no coinciden (el único aviso es de otra pista: `para_clubes_*`) |
| `node scripts/dev/probar-funciones-club.mjs` | 31/31 |
| `npx tsc --noEmit`, `npx eslint` (archivos tocados), `next build` | sin errores |

Carga (20,000 reservas sintéticas en una transacción que se deshace, tiempos
en el servidor con EXPLAIN ANALYZE): el plan usa `reservations_club_tel_fecha` (Index Scan); conteo de un teléfono 1.8 ms; trigger completo de una reserva sin cuenta con el bloqueo automático encendido 2.8 ms (inserción 4.2 ms); la lista de no-show del gerente (todo el antro, 90 días) ~0.7–1.2 s y la lista de anoche del staff ~1 s (medida desde el cliente, con red).

Las pruebas de base reintentan una parte entera si chocan (deadlock) con el
DDL de otras pistas que usan dev al mismo tiempo; las notas de la vuelta
fallida se descartan. Datos de prueba con prefijo `t_n4_cli` / `T n4 cli`,
borrados al terminar (0 restos verificados). Capturas en
`screenshots-n4-clientes/`.

## Riesgos

- **Privacidad**: teléfonos y motivos escritos a mano sobre personas, sin
  plazo de borrado (pendientes 4 y 5 de `docs/legal/inventario-datos.md`).
- **Bloqueo automático = decisión automatizada**: revisar con el abogado.
- **Enumeración**: ver arriba.
- **Rendimiento**: la lista de no-show del gerente y la lista de la noche
  recorren más (ver carga); el conteo en cada reserva va por índice.
- El RP ve en cuántas noches no llegaron sus propios clientes.

## Lo que NO está hecho

- Envío por API de WhatsApp (a propósito: solo enlaces).
- Selector de antro para dueño de grupo y admin; pantalla para tachar.
- Bloqueo en la puerta / check-in (solo se marca).
- Conteo de rechazos fuera de la transacción (enumeración).
- Plazo de conservación; pantalla para que un cliente pida revisión.
- Recordatorios programados.
- Nada de esto está en producción ni se probó con datos reales.
