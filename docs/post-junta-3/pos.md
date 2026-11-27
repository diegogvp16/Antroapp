# Noche 4, bloque 1: importar ventas del POS (rama `n4-pos`)

Fecha: 27/11/2026 (revisión 2, después de la revisión independiente).
Base: `post-junta-3`. Estado: **en el working tree, sin commit**. SQL
**aplicado en antroapp-dev**; en producción **no**.

Todo está detrás de la bandera por antro **`pos_ventas`**
(`sql/post-junta-3/00-funciones-club.sql`), **apagada** por defecto y sin
valor en ningún antro ni grupo de dev al terminar.

## Qué se construyó

1. **Capa de adaptadores** (`lib/pos/`), pura y sin dependencias nuevas:
   - `tipos.ts`: forma normalizada `VentaPos` (ticket, fechaHora local
     «AAAA-MM-DDTHH:MM:SS», mesa, cuenta, producto, cantidad, precio y total
     en centavos, forma de pago, mesero), `AdaptadorPos`, catálogo de campos
     y límites (5,000 líneas, 10 MB).
   - `csv.ts`: UTF-8 (con/sin BOM), UTF-16 con BOM y Windows-1252; separador
     `,` `;` tab `|` (por consistencia de columnas, o `sep=`); comillas con
     separador y saltos de línea; número de línea real.
   - `xlsx.ts`: lector de `.xlsx` sin dependencias (directorio central del
     zip, `DecompressionStream("deflate-raw")` con tope de 50 MB por parte,
     primera hoja, textos compartidos, estilos de fecha / hora / fecha y
     hora, seriales 1900 y 1904, XML con prefijo). Recorre el XML con
     expresiones regulares (no `DOMParser`) para que la prueba en Node sea la
     misma que corre en la pantalla.
   - `numeros.ts`: punto decimal (`1,234.50`) o coma decimal (`1.234,50`),
     decidido **por columna**; un valor ambiguo (`1.500`) sin formato
     conocido es error, no se adivina.
   - `fecha-hora.ts`: dd/mm/aaaa, aaaa-mm-dd, con hora (24 h o a. m./p. m.),
     mes con nombre, mdy opcional; rechaza zona horaria; noche con corte 08:00.
   - `mapeo.ts`: fila de encabezados, sugerencia de mapeo por sinónimos en
     español (prefiere apertura o venta sobre cierre, y avisa si la hora es
     de cierre), formato de números por columna, normalización con errores y
     avisos por línea.
   - `adaptadores.ts`, `conciliacion.ts`.
2. **Mapeos guardados por antro** (`pos_mapeos`), con formato de fecha y de
   montos.
3. **Pantalla** `/staff/pos` (gerente) y `/dueno/pos` (dueño, dueño de grupo
   y admin): Importar (archivo → mapeo → vista previa → confirmar),
   Conciliar (por mesa y cuenta, y «Tickets del POS» para asignar,
   reasignar o quitar cuenta) e Importaciones (con deshacer). Enlace en los
   paneles del gerente y del dueño **solo con la bandera encendida**.
4. **Liga por ticket** a mesa, noche, sesión y cuenta, por conjuntos en la
   base (`pos_resolver_lote`).
5. **Conciliación por noche**: coincide / diferencia / solo POS / solo caja.
6. `docs/pos.md`: qué necesita AntroApp de cualquier POS.

Las ventas del POS **no crean `caja_consumos` ni cambian totales de caja,
comisiones ni nómina** (foto de la caja antes y después en `probar-pos.mjs`).

## Arreglos de la revisión independiente

| # | Hallazgo | Arreglo |
|---|---|---|
| 1 ALTO | 5,000 líneas: 18 s al importar, 6 s la vista previa, 12 s volver a ligar (se cancelaban a los 8 s) | Validación y liga **por conjuntos** (llaves de mesa una vez, joins con sesiones y cuentas; sin función por línea). Historial y deshacer con joins. `ANALYZE` de las tablas del POS tras una carga de 200+ líneas (sin estadísticas, la siguiente consulta podía tardar 17 s). Candidatas una vez por grupo en la vista previa (respuesta más chica). Medido abajo. Tope sin cambio: 5,000 líneas. |
| 2 MEDIO | Deshacer borraba líneas que otro archivo había saltado como repetidas | Tabla `pos_importacion_lineas` (llaves de cada archivo, también las repetidas). Al deshacer, las ventas que trae otro archivo vigente **pasan a ese**; solo se borran las demás. Deshacer toma el mismo candado que importar. El botón dice cuántas se borran. |
| 3 MEDIO | Las ligas de `pos_ventas` impedían borrar la caja (`limpiar-demo-caja.sql`, `limpiarCajaDev`) | `on delete set null` en noche, sesión y cuenta; el disparador `pos_ventas_caja_borrada` marca la venta «caja_borrada» (sin liga) para que los check sigan valiendo. Probado con las dos limpiezas dentro de transacciones deshechas. |
| 4 MEDIO | Mesa reutilizada: una venta de las 23:40 se ligaba sola al grupo sentado a las 23:35; un ticket se podía partir entre dos grupos; no había forma de reasignar | Liga **por ticket** (hora de la primera y de la última línea): si cae en dos grupos o en grupos distintos → «varias sesiones», se elige a mano. «Reasignar» y «Quitar cuenta» en la conciliación. El mapeo prefiere hora de venta o apertura y **avisa** si la hora es de cierre. |
| 5 MEDIO | `1.500` se leía como $1.50 sin aviso | Formato de números por columna; un valor ambiguo sin formato conocido es error; el mapeo puede fijar punto o coma. |
| 6 MEDIO | Excel: una fecha y hora a las 00:00 salía sin hora («falta la hora»); hora 0 en libros 1904 | Con formato de fecha y hora, siempre fecha y hora; con formato de hora, siempre hora (también en 1904). |
| 7 BAJO | La vista previa mezclaba tickets de dos noches con el mismo folio | La llave del grupo lleva la noche. |
| 8 BAJO | Sin tope al descomprimir; `&#99999999;` rompía con un error crudo | Tope de 50 MB por parte con mensaje en español; entidad fuera de Unicode → mensaje en español. |
| 9 BAJO | La noche por defecto era la del centro (Tijuana) | `pos_mis_antros` trae `noche_en_curso` = `club_fecha_operacion` (zona del antro). Documentado: venta después de las 08:00 con la caja anterior abierta cae en la noche siguiente; hora repetida o inexistente por horario de verano. |

`docs/post-junta-3/pos.md` decía «se quedan sin ligar, no se ligan mal»:
era falso con mesas reutilizadas; ya no se dice.

## Archivos

Nuevos:

- `lib/pos/{tipos,csv,xlsx,numeros,fecha-hora,mapeo,adaptadores,conciliacion}.ts`
- `components/pos/{enlace-pos,pantalla-pos,importar-ventas,conciliacion-noche}.tsx`
- `app/staff/pos/page.tsx`, `app/dueno/pos/page.tsx`
- `sql/post-junta-3/10-pos-ventas.sql` y `10-pos-ventas-rollback.sql`
- `scripts/dev/probar-pos-dominio.mjs`, `probar-pos.mjs`,
  `probar-pos-pantalla.mjs`, `probar-pos-carga.mjs`,
  `pos-escenario-prueba.mjs` (escenario de prueba, se borra solo aunque
  falle a medias), `pos-archivos-prueba.mjs` (arma `.xlsx` reales)
- `docs/pos.md`, este archivo

Cambiados (una línea de import y una de montaje cada uno):
`app/staff/panel/page.tsx` y `app/dueno/panel/page.tsx`.

Sin dependencias npm nuevas.

## SQL: orden y rollback

Un solo archivo, después de `00-funciones-club.sql`:
`sql/post-junta-3/10-pos-ventas.sql`. Rollback:
`sql/post-junta-3/10-pos-ventas-rollback.sql` (borra funciones y tablas, con
sus datos). No redefine ninguna función anterior; usa sin cambiarlas
`es_gerente_o_dueno`, `club_es_dueno_grupo`, `current_role_name`,
`funcion_activa` y `club_fecha_operacion`.

Tablas (RLS encendida, `revoke all` a public, anon y authenticated):
`pos_mapeos`, `pos_importaciones`, `pos_importacion_lineas`, `pos_ventas`.

Funciones para la app (`security definer`, `search_path = ''`, autorización
primero con `coalesce(…, false)` y luego la bandera; solo `authenticated` y
`service_role`): `pos_mis_antros`, `pos_mapeos_lista`, `pos_mapeo_guardar`,
`pos_mapeo_borrar`, `pos_preparar`, `pos_importar`, `pos_importaciones_lista`,
`pos_importacion_deshacer`, `pos_asignar`, `pos_religar`, `pos_conciliacion`,
`pos_tickets`, `pos_cuentas_noche`.

Internas (sin `execute` para anon ni authenticated): `pos_puede_usar`,
`pos_exigir`, `pos_clave_mesa`, `pos_leer_lineas`, `pos_candidatos`,
`pos_resolver_lote` y el disparador `pos_ventas_caja_borrada`.

### Prueba de rollback exacto en dev

Con `node scripts/db/extraer-esquema.mjs --origen=dev`, ignorando las líneas
de encabezado, en ciclos aplicar → rollback → aplicar → rollback → aplicar:

| Comparación | Objetos `pos_*` | Esquema completo |
|---|---|---|
| Rollback vs. esquema antes de aplicar | idénticos (ninguno) | distinto solo en objetos de **otras pistas** que se aplicaron en dev mientras tanto (antifraude, propinas, lista negra) |
| Rollback vs. rollback (con aplicar en medio) | idénticos | **idéntico** |
| Aplicado vs. reaplicado (dos veces) | idénticos (144 unidades) | **idéntico** |

Dev quedó **con el SQL aplicado**, sin filas en `pos_*` y sin valor de la
bandera `pos_ventas` en ningún antro ni grupo. Hubo dos `deadlock detected`
con el DDL de otra pista; se reintentó a los 60 s sin tocar sus objetos.

## Pruebas

Contra antroapp-dev, con el SQL final aplicado:

| Prueba | Resultado |
|---|---|
| `node scripts/dev/probar-pos-dominio.mjs` (sin base) | **189/189** |
| `node scripts/dev/probar-pos.mjs` (base, sesiones reales de Supabase Auth) | **162/162** |
| `node scripts/dev/probar-pos-carga.mjs` (gerente por la API, `statement_timeout` = 8 s) | **29/29** |
| `PLAYWRIGHT_DESDE=… node scripts/dev/probar-pos-pantalla.mjs http://localhost:3041` (390×844 y 360×740) | **62/62** |
| `npx tsc --noEmit`, `npx eslint` de los archivos tocados, `NEXT_DIST_DIR=.next-build npx next build` | sin errores |

Carga (50 mesas, dos grupos por mesa, 155 cuentas; archivo de 5,000 líneas
en 1,000 tickets, «Mesa N» por la llave tolerante; 1.1 MB), como gerente
por PostgREST, con dev tranquilo:

| Llamada | Tiempo |
|---|---|
| `pos_preparar` 5,000 líneas | 3.0 s |
| `pos_importar` 5,000 líneas | 3.4 s |
| `pos_preparar` del mismo archivo (5,000 repetidas) | 2.6 s |
| `pos_religar` (5,000 ventas) | 0.8 s |
| `pos_importar` 5,000 (2,500 repetidas) | 2.9 s |
| `pos_importacion_deshacer` (2,500 borradas, 2,500 conservadas) | 0.5 s |
| `pos_conciliacion` / `pos_tickets` / `pos_importaciones_lista` | 0.16 / 0.31 / 0.11 s |

Con dev cargado por otras pistas, en otra corrida, la vista previa de
repetidas tardó 4.1 s (la única llamada arriba de 4 s; todas abajo de 8 s).
Lo más pesado es la validación y el viaje de 1.1 MB de JSON; el resto es
menos de un segundo.

`probar-pos.mjs` cubre, además de lo de la revisión 1 (roles, aislamiento,
bandera, mapeos, todo o nada, idempotencia, concurrencia, conciliación,
caja sin cambios): la noche en curso por zona del antro; reasignar y quitar
cuenta; liga por ticket (ticket partido entre grupos, venta entre dos
grupos, el caso exacto de la revisión 23:25/23:35/23:40, y que lejos del
cambio sí se liga); deshacer con líneas compartidas en los dos sentidos y
deshacer e importar a la vez; y las dos limpiezas de caja con ventas
ligadas. `probar-pos-dominio.mjs` suma montos ambiguos y formato por
columna, Excel a las 00:00 y 1904, bomba zip, entidad fuera de Unicode y
el aviso de hora de cierre. La pantalla suma el aviso de cierre, el formato
de montos, reasignar y quitar cuenta, y el texto de deshacer.

Las pruebas crean su propio escenario (`T n4 pos A/B …`, cuentas
`t_n4_pos_*`, noche de caja del 07/10/2026) y lo borran al final; 0 restos.
Capturas en `screenshots-n4-pos/` (ignorada por Git).

## Decisiones (para que Diego confirme)

1. **Quién**: admin, dueño del antro, **dueño del grupo** y gerente,
   activos y sin contraseña temporal. El staff puro no.
2. **Rutas**: `/staff/pos` (gerente) y `/dueno/pos` (dueño y admin). El
   admin no tiene enlace desde `/admin`.
3. **Líneas con error** no entran; la pantalla pide confirmar.
4. **Sin hora no se importa.**
5. **Llave de línea**: ticket + fecha y hora + mesa + cuenta + producto +
   cantidad + total + ocurrencia en el archivo. Si un POS cambia la hora de
   una línea entre dos exportes, esa línea se ve como nueva.
6. **Liga conservadora**: tolerancias fijas (15 min antes de abrir, 60
   después de cerrar). Con mesas que se reutilizan rápido, muchas ventas
   quedarán para elegir a mano en vez de ligarse solas (preferimos eso a
   ligar mal). Si hace falta, las tolerancias se vuelven configuración por
   antro.
7. **Montos ambiguos** (`1.500` sin otro valor que diga el formato) no
   entran hasta elegir el formato en el mapeo.
8. **Devoluciones** (totales negativos) se aceptan y restan.
9. **Deshacer** conserva las ventas que trae otro archivo vigente.
10. **Tope**: 5,000 líneas y 10 MB por archivo.

## Riesgos

- El lector `.xlsx` solo se probó con libros armados por la prueba, **no con
  exportes reales** de un POS ni de Excel, LibreOffice o Google Sheets.
- Los tiempos se midieron en dev (instancia compartida con otras pistas):
  3–4 s para 5,000 líneas. En producción no se midió; con un antro que
  tenga muchas más ventas guardadas, la validación no cambia, pero la
  búsqueda de repetidas crece (por índice).
- `pos_importar` y `pos_importacion_deshacer` corren `ANALYZE` de las tablas
  del POS tras cargas grandes; en dev cuesta ~0.2 s. No se probó en
  producción.
- La liga por hora depende de que el reloj del POS y el de la caja estén
  cerca y de que el POS exporte la hora de la venta (no la de cierre).
- Ventas después de las 08:00 con la caja de la noche anterior abierta
  caen en la noche siguiente y no se pueden ligar a esa caja.

## Qué NO está hecho

- Ninguna integración con un POS en particular (ni API ni conexión directa).
- No se leen `.xls` (formato viejo) ni otras hojas además de la primera.
- No hay alta de mesas desde el POS.
- La conciliación no se exporta a CSV ni entra al reporte de la noche.
- No hay alertas automáticas por diferencias.
- El admin no tiene enlace desde `/admin`.
- No se aplicó nada en producción.
