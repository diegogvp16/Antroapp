# Ventas del POS: qué necesita AntroApp de cualquier punto de venta

AntroApp puede recibir lo que vendió el punto de venta (POS) del antro y
compararlo, noche por noche, con el consumo que el staff registró en la caja
por mesa. No se conecta a ningún POS en particular: lee un **archivo
exportado** (CSV o Excel `.xlsx`) y la persona dice qué columna es cada dato.

Está detrás de la bandera **«Ventas del POS»** (`pos_ventas`) de cada antro,
apagada por defecto. Solo la enciende el admin (`/admin/funciones`).

## Quién lo usa

- **Gerente** del antro: desde su panel, «Ventas del POS» (`/staff/pos`).
- **Dueño** del antro (y dueño del grupo al que pertenece): desde su panel
  (`/dueno/pos`).
- **Admin**: entra por `/dueno/pos` y elige el antro.
- El staff, los RPs y los clientes no lo ven ni lo pueden usar (lo revisa la
  base, no solo la pantalla).

## Qué hace y qué NO hace con los datos

Hace:

- Guarda cada línea de venta como un registro aparte (`pos_ventas`), con el
  archivo del que vino (`pos_importaciones`).
- Intenta ligar cada venta a la mesa, la noche y la cuenta de la caja.
- Muestra la conciliación de una noche: por mesa y cuenta, el consumo de la
  caja contra el total del POS.

No hace:

- **No crea ni cambia consumos de la caja**, ni sus totales, pagos, cuadres,
  comisiones de RPs ni nómina. La caja sigue siendo la fuente para todo eso.
- No cobra, no factura y no manda nada al POS.
- No sube el archivo: se lee en el navegador y a la base solo llegan las
  ventas ya revisadas (los datos de las columnas mapeadas), el nombre del
  archivo y su huella. Las columnas que no se mapean no se guardan.

## Datos que necesita

| Dato | Nivel | Formato | Para qué |
|---|---|---|---|
| Ticket o folio | **Requerido** | Texto, hasta 60 caracteres | Agrupar líneas del mismo ticket; reconocer repetidas. |
| Fecha | **Requerido** | Ver «Fechas» | Saber de qué noche es. |
| Hora | **Requerido** (en la misma columna que la fecha o en otra) | `23:15`, `23:15:30`, `11:15 p. m.` | Saber de qué noche y de qué grupo de la mesa es. Sin hora no se importa. |
| Total de la línea | **Requerido** (o precio unitario) | Ver «Montos» | Lo que se compara con la caja. Si no hay total, se calcula cantidad × precio. |
| Mesa | Recomendado | Texto: `5`, `Mesa 5`, `05`, `VIP 1` | Ligar la venta a la mesa de la caja. Sin mesa se guarda, pero no se liga. |
| Producto | Recomendado | Texto, hasta 120 caracteres | Detalle. Si el archivo es un renglón por ticket, se guarda «(sin detalle)». |
| Cantidad | Opcional | Número, hasta 3 decimales | Si no viene, cuenta 1. |
| Precio unitario | Opcional | Monto | Calcular el total si no hay columna de total. |
| Cuenta o comensal | Opcional | Texto | Si coincide con el nombre de la cuenta en caja, ayuda a elegir la cuenta. |
| Forma de pago | Opcional | Texto | Solo informativo. |
| Mesero | Opcional | Texto | Solo informativo. |

### Una línea por producto o una por ticket

Las dos sirven. Lo mejor es **una línea por producto vendido** (más detalle).
Si el POS solo exporta un renglón por ticket con su total, también funciona:
sin columna de producto, cada línea se guarda como «(sin detalle)».

### Montos

Dos formatos: **punto decimal** (México: `1,234.50`, `$1,234.50`,
`$ 1234.5`, `MXN 99.90`) y **coma decimal** (configuración regional de
España y otros: `1.234,50`, `12,5`). Negativos: `-120.00`, `(120.00)` o
`120.00-` (se toman como devolución o cancelación y restan). Se redondea a
centavos. Tope por línea: $1,000,000.

El formato se decide **por columna**, con todos sus valores: si alguno
dice el formato (`1,234.50`, `12,5`), vale para toda la columna. Un valor
con un solo separador seguido de exactamente 3 dígitos (`1.500`, `1,234`)
es **ambiguo** (¿mil quinientos o uno cincuenta?): si la columna no dice
el formato, esa línea sale con error y no entra. En el mapeo se puede fijar
«Los montos usan: punto decimal / coma decimal», y entonces se lee sin
duda. Lo mismo para la cantidad.

### Fechas

`25/11/2026`, `25-11-26`, `25.11.2026`, `2026-11-25`, `2026/11/25`,
`25-nov-2026`, `25 de noviembre de 2026`, con o sin hora en la misma celda
(`25/11/2026 23:15`, `2026-11-25T23:15:30`). Si el POS escribe mes/día/año
(`11/25/2026`), se elige en el mapeo. En Excel, las celdas con formato de
fecha y hora se leen directo (también las de las 00:00 en punto).

La hora es **la del antro**, sin zona horaria. Una fecha con zona (`Z`,
`-06:00`) se rechaza, porque no se sabría a qué hora local corresponde.

**Mejor la hora de la venta (o de apertura del ticket) que la de cierre.**
Si el POS solo trae la hora de cierre o cobro, se puede usar, pero la
pantalla avisa: un ticket que se cerró cuando ya se había sentado otro
grupo en esa mesa no se liga solo (se elige a mano).

La noche usa el mismo corte que la caja (`club_fecha_operacion`): de 00:00
a 07:59 cuenta para la noche anterior; desde las 08:00, para el día que
empieza. Una venta de las 08:30 queda en la noche siguiente aunque la caja
de la noche anterior siga abierta, y no se puede ligar a esa caja.

En antros con horario de verano (por ejemplo, zona de Tijuana), la hora que
se repite al atrasar el reloj (01:00–01:59 del primer domingo de
noviembre) se toma como la segunda (ya en horario normal), y una hora que
no existe al adelantarlo (02:00–02:59 de marzo) se corre una hora. Así lo
hace la base; para la noche no cambia nada, pero la liga con la mesa en
esa hora puede quedar una hora corrida.

### Archivos

- **CSV o texto separado**: separado por coma, punto y coma, tabulador o
  barra vertical (se detecta solo). Codificación UTF-8 (con o sin BOM),
  UTF-16 con BOM o Windows-1252 (lo que exportan muchos programas de
  Windows). Campos entre comillas con comas o saltos de línea, sí.
- **Excel `.xlsx`**: se lee la **primera hoja**. Los `.xls` viejos no: hay
  que abrirlos y guardarlos como `.xlsx` o CSV. Si una parte del libro pasa
  de 50 MB al descomprimirla, se detiene con un aviso (un archivo así no es
  un reporte normal).
- Los encabezados pueden estar debajo de un título del reporte: se busca la
  fila de encabezados entre las primeras 15.
- Las filas de totales del reporte (sin ticket y con «Total») se ignoran.
- Máximo 10 MB y 5,000 líneas por archivo: si es más, exportar por noche.

## Cómo exportar desde un POS (en general)

Cada POS lo llama distinto. En general:

1. Buscar el reporte de **ventas por producto**, **detalle de ventas** o
   **ventas por ticket**, del día o del turno.
2. Elegir el rango de la noche (por ejemplo, del día a las 20:00 al día
   siguiente a las 07:00) o el día completo.
3. Que traiga al menos: ticket o folio, fecha y hora, mesa y total por línea.
4. Exportar a **Excel** o **CSV**.

## Cómo funciona el mapeo

1. Al subir el archivo, AntroApp propone qué columna es cada dato por el
   nombre del encabezado (por ejemplo «No. Ticket», «Folio» o «Comanda» →
   ticket; «Importe» o «Total» → total; «No. Mesa» → mesa). Se puede cambiar
   cada uno.
2. El mapeo se puede **guardar con un nombre** (por ejemplo, el del POS). La
   próxima vez que se suba un archivo con esas columnas, se elige solo.
   Lo guardan y usan el gerente, el dueño y el admin del antro; máximo 30
   por antro.
3. Con el mapeo listo, la vista previa revisa cada línea:
   - **Error** (la línea no entra): falta ticket, fecha u hora; monto o
     cantidad que no se entienden; cantidad 0; fecha futura.
   - **Aviso** (entra): sin mesa, total distinto de cantidad × precio
     (descuento), devolución, cortesía en cero, texto recortado.
   - **Ya importada**: la misma línea ya está en AntroApp.
   - **Cómo se liga** a la caja (ver abajo).
4. Si hay líneas con error, hay que confirmar que se importa sin ellas. Lo
   que entra, entra **todo o nada** (si algo falla en la base, no se guarda
   ninguna línea).

## Sin duplicados

- El **mismo archivo** no se importa dos veces (huella SHA-256 del archivo).
- La **misma línea** tampoco, aunque venga en otro archivo: su llave sale
  del ticket, fecha y hora, mesa, cuenta, producto, cantidad y total (sin
  importar el orden de las columnas ni el formato del monto). Dos líneas
  idénticas dentro del mismo archivo cuentan como dos ventas.
- Si se mapeó mal, en «Importaciones» se puede **deshacer** un archivo (con
  motivo): se borran sus ventas **salvo las que también vienen en otro
  archivo importado** (esas pasan a ese otro archivo), y el archivo se puede
  volver a subir. El botón dice cuántas se borrarían.

## Cómo se liga una venta a la caja

1. **Mesa**: el texto del POS contra las mesas del antro, sin mayúsculas ni
   espacios de las orillas. Si no coincide, se intenta quitando «Mesa»,
   «No.», «#» y ceros a la izquierda (`Mesa 05` = `5`). Si se parece a dos
   mesas, no se liga.
2. **Noche**: por la fecha y hora, con el corte de las 08:00.
3. **Por ticket**: las líneas del mismo ticket (y misma noche, mesa y
   cuenta del POS) se ligan juntas, nunca se reparten entre dos grupos.
4. **Grupo de la mesa** (sesión de caja): el que estaba abierto a la hora
   de la primera y de la última línea del ticket, con tolerancia de 15
   minutos antes de abrir y 60 minutos después de cerrar. Si a esa hora
   caen dos grupos (por ejemplo, uno se cuadró a las 23:30 y el siguiente
   se sentó a las 23:35), o el ticket cae en grupos distintos, **no se
   adivina**: queda sin ligar y se elige a mano.
5. **Cuenta**: si el grupo tiene una sola, esa. Si tiene varias: la que se
   llame igual que la «cuenta o comensal» del POS; si no, la única que ya
   existía a la hora de la primera línea. Si siguen siendo varias, **queda
   sin ligar** y se elige a mano (en la vista previa o después, en la
   conciliación).

Si la caja cambia después de importar (una mesa abierta tarde, una cuenta
nueva), «Volver a ligar con la caja» repite estas reglas para esa noche. Lo
que se asignó o se quitó a mano no se toca.

Si la caja de una noche se borra (por ejemplo, al limpiar una demo), las
ventas del POS se quedan y solo pierden la liga («la cuenta de caja ya no
existe»).

## Conciliación

Por noche, para cada mesa y cada cuenta:

- **Coincide**: consumo de caja (sin anulados) = total del POS.
- **Diferencia**: los dos tienen algo y no son iguales.
- **Solo POS**: hay ventas del POS y nada en caja (o la venta no se pudo
  ligar a una cuenta).
- **Solo caja**: hay consumo en caja y ninguna venta del POS.

Arriba, el total de la noche en caja, en el POS y la diferencia. Abajo,
«Tickets del POS»: los que no tienen cuenta (para asignarlos) y, en
«Todos», también los ligados, que se pueden **reasignar** a otra cuenta o
dejar **sin cuenta**. Una cuenta quitada a mano no se vuelve a ligar sola.
La pantalla abre en la noche en curso del antro, con su zona horaria.
