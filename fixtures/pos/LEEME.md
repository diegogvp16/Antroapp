# Archivos de ejemplo del importador de ventas del POS

Exportes de ventas **ficticios** (antro, meseros y productos inventados) con
las variaciones que traen los POS y Excel en México, y archivos que el
importador debe rechazar. Los usa `scripts/dev/probar-pos-fixtures.mjs`,
que corre con cada uno el camino real de la pantalla (leer → mapear →
revisar) y, con las ventas que entran, la validación y la vista previa de la
base de antroapp-dev en una transacción que se deshace.

- Regenerar: `node scripts/dev/generar-pos-fixtures.mjs` (reproducible, sin
  dependencias nuevas; los `.xlsx` salen de `scripts/dev/pos-archivos-prueba.mjs`).
- Probar: `node scripts/dev/probar-pos-fixtures.mjs` (o `--sin-base`).
- Los bytes importan (BOM, CRLF, Windows-1252, UTF-16): `.gitattributes`
  marca esta carpeta como binaria para que Git no los cambie.
- Las fechas son de noviembre de 2026 (noches del 20, 21 y 22).
- Para la importación de prueba en la pantalla sirven igual: elige el
  archivo en «Ventas del POS» de un antro de dev con la bandera encendida.

## Se leen bien

| Archivo | Qué variación trae | Resultado esperado |
|---|---|---|
| `01-utf8-bom-titulos-totales.csv` | UTF-8 con BOM, coma, CRLF; 3 renglones de título y uno vacío arriba; montos `"$2,850.00"` entre comillas; `ñ` y acentos (Piña colada, Íñigo); renglón vacío en medio; renglón de solo comas; fila `TOTAL` al final sin folio | Encabezado en la fila 5. 6 ventas, **$3,969.50**, noche 20/11 (00:35 y 01:20 del 21 cuentan para el 20). La fila de totales se ignora con aviso. |
| `02-punto-y-coma-coma-decimal.csv` | Punto y coma, coma decimal (`1.850,00`), fecha `dd/mm/aa` con la hora en la misma celda (`20/11/26 23:40:15`), encabezados en MAYÚSCULAS con acento (`DESCRIPCIÓN`), LF | Montos detectados con coma decimal. 5 ventas, **$2,570.70**, noche 20/11. |
| `03-windows-1252.csv` | Windows-1252 (como guarda Excel «CSV delimitado por comas»), folios con ceros (`00871`), mesa `04`, comillas con coma y `""` adentro, columna extra «Observaciones» | Leído como Windows-1252. 4 ventas, **$3,594.00**, «Café de olla», «Ángeles», «12 años» bien; el folio conserva los ceros. |
| `04-utf16-tabuladores.txt` | Excel «Texto Unicode»: UTF-16 LE con BOM, tabuladores, `1,250.00` sin comillas, `23:59:59` | Leído como UTF-16 por tabulador. 3 ventas, **$2,080.00**. |
| `05-encabezados-raros-12h.csv` | Encabezados con espacios y otros nombres (`  No. de Orden `, ` FECHA `, `Núm. de Mesa`, `Artículo / Descripción`, `Importe Total ($)`, `Atendió`); hora de apertura y de cierre; columnas extra (Descuento, IVA, Propina, Estatus, Área); fechas `20-nov-2026` y `21 de noviembre de 2026`; horas `10:45 p. m.`, `11:20 p.m.`, `12:15 a. m.`; montos `$ 95.00`, `MXN 1,180.00`, `250.00 M.N.` | Propone la hora de **apertura** (no la de cierre) y no mapea las columnas extra. 3 ventas, **$1,620.00**; 12:15 a. m. = 00:15. |
| `06-por-ticket-devoluciones.csv` | Un renglón por ticket (sin producto ni cantidad), fechas `AAAA-MM-DD` y `AAAA/MM/DD`, devolución `(250.00)`, cancelación `320.00-`, cortesía `0.00`, ticket sin mesa, «Gran total» al final | 5 ventas «(sin detalle)», **$1,830.50** (las negativas restan), con avisos de devolución, cortesía y sin mesa; el gran total se ignora. |
| `07-sep-comillas-saltos.csv` | Pista `sep=;` de Excel en la 1.ª línea, todo entre comillas, producto con `;`, otro con `""` y salto de línea adentro, cantidad `1,5` | Las líneas conservan su número del archivo (3, 4 y 6). 3 ventas, **$862.50**; el salto de línea queda como espacio. |
| `08-montos-ambiguos.csv` | Totales `1.500`, `2.300` y `350`: ningún valor dice si el punto es decimal o de miles | Sin elegir formato: las 2 primeras **no entran** (««1.500» es ambiguo: elige en el mapeo…»), la de $350 sí. Eligiendo «coma decimal»: $1,500 + $2,300 + $350 = **$4,150.00**. Eligiendo «punto decimal»: $1.50 + $2.30 + $350. |
| `09-ingles-mes-dia.csv` | POS en inglés: `11/20/2026`, `10:15 PM`, `Ticket #`, `Date`, `Time`, `Table`, `Item`, `Qty`, `Amount` | Detecta **mes/día** (hay un 20 en la segunda posición). 3 ventas, **$492.50**; 12:40 AM = 00:40. |
| `10-sin-total-con-precio.csv` | Sin columna de total, con cantidad y precio unitario; cantidad `2.5`; precio `99.995` | Total = cantidad × precio al centavo: 3 × 33.33 = **99.99**; 2.5 × 40 = 100.00; 99.995 → 100.00. Suma **$299.99**. |
| `11-windows-1252-punto-y-coma.csv` | Windows-1252 + punto y coma + `$1.234,50` (Excel con coma decimal), `Ñeco`, `Champiñones` | 3 ventas, **$1,482.50**. |
| `12-titulo-largo-arriba.csv` | Título que nombra varios datos («…por ticket, fecha y hora, mesa y producto») arriba de un encabezado corto de 4 columnas | Encabezado en la fila 3 (no el título). 2 ventas, **$1,550.00**. *(Antes del arreglo de esta rama tomaba el título como encabezado y el archivo no se podía importar.)* |
| `13-total-en-columna-folio.csv` | Fila de totales con `TOTAL` en la columna del **folio** | Entran las 2 ventas (**$160.00**); la fila `TOTAL` sale como línea con error («falta la fecha») y hay que confirmar que se importa sin ella. |
| `x01-excel-normal.xlsx` | Excel: título y renglón vacío arriba, celdas con formato de fecha y hora (una a las **00:00** en punto), montos con formato de moneda, mesa numérica, columna extra (Propina), fila «Total» sin folio, segunda hoja «Resumen» | Aviso de que solo se lee la primera hoja; encabezado en la fila 3. 4 ventas, **$3,440.40**; la de las 00:00 queda `2026-11-22T00:00:00` (noche del 21). |
| `x02-fecha-hora-separadas-1904.xlsx` | Fecha y hora en celdas separadas, sistema de fechas **1904**, XML con prefijo `x:` y textos en línea | 2 ventas, **$223.50**, 23:40 del 20 y 01:15 del 21 (las dos de la noche del 20). |
| `x03-celdas-de-texto.xlsx` | Todo escrito como texto en las celdas: `  NÚMERO DE CUENTA `, `21/11/2026`, `11:15 p. m.`, `$1.234,50` | Coma decimal detectada. 2 ventas, **$1,259.50**. |

## Se rechazan (con mensaje claro)

| Archivo | Qué trae | Mensaje esperado |
|---|---|---|
| `r01-vacio.csv` | 0 bytes | «El archivo está vacío.» |
| `r02-solo-bom-y-renglones-vacios.csv` | BOM y renglones vacíos o de solo comas | «El archivo no trae filas.» |
| `r03-solo-encabezados.csv` | Solo la fila de encabezados | «El archivo solo trae encabezados, sin ventas.» |
| `r04-sin-columna-total.csv` | Sin columna de total ni de precio | El mapeo pide «Total (o precio unitario)»; cada línea: «falta el total». |
| `r05-encabezados-desconocidos.csv` | Encabezados `Col1, Col2, Col3` | El mapeo pide «Ticket o folio», «Fecha» y «Total (o precio unitario)». |
| `r06-fechas-imposibles.csv` | 31/11, 29/02/2026, mes 13, día 00, hora 25:10 y 23:61, año 2019, año 2030, «ayer»; una línea buena | 9 líneas no entran, cada una con su motivo («la fecha «31/11/2026» no existe», ««25:10» no es una hora», «la fecha es anterior a 2020», «la fecha es futura», ««ayer» no es una fecha»). Entra la buena ($100.00). |
| `r07-sin-hora.csv` | Fecha sin hora y sin columna de hora | Ninguna entra: «falta la hora (sin hora no se sabe de qué noche ni de qué mesa es)». |
| `r08-zona-horaria.csv` | `2026-11-20T23:15:00Z` y `…-06:00` | Ninguna entra: «… trae zona horaria: exporta la hora local del antro». |
| `r09-montos-invalidos.csv` | Totales `N/A`, `12.34.5`, `$`, `$2,000,000.00`, vacío; cantidad `0` y `dos`; una línea buena | 7 líneas no entran con su motivo (««N/A» no es un monto», «es demasiado grande», «la cantidad es 0», ««dos» no es una cantidad», «falta el total»). Entra la buena. |
| `r10-sin-folio.csv` | Ventas sin folio (y sin «Total» en la fila) | Ninguna entra: «falta el ticket o folio». |
| `r11-excel-viejo.xls` | `.xls` viejo (binario de Office) | «Ese archivo no se puede leer: usa CSV o Excel .xlsx (un .xls viejo: ábrelo y guárdalo como .xlsx).» |
| `r12-csv-renombrado.xlsx` | Un CSV con la extensión cambiada a `.xlsx` | El mismo mensaje de «usa CSV o Excel .xlsx». |
| `r13-xlsx-danado.xlsx` | `.xlsx` con la hoja corrupta (el índice del zip está bien) | «El archivo de Excel está dañado (una parte no se pudo descomprimir): vuelve a exportarlo o usa CSV.» *(Antes del arreglo: mensaje vacío, la pantalla no mostraba nada.)* |
| `r14-xlsx-truncado.xlsx` | `.xlsx` cortado a la mitad | «El archivo no es un Excel válido (no se encontró el índice del zip).» |
| `r15-zip-no-excel.xlsx` | Un zip que no es libro de Excel | «El archivo no es un libro de Excel (falta xl/workbook.xml).» |
| `r16-xlsx-solo-encabezados.xlsx` | Libro con solo encabezados | «El archivo solo trae encabezados, sin ventas.» |
