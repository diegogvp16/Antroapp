# Reportes PDF del dueño (bloque 7, noche 4 — rama `n4-reportes`)

Estado: **aplicado y probado solo en antroapp-dev**. En producción no hay nada.
Va detrás de la bandera por antro `reportes_pdf` (sql/post-junta-3/00), que quedó
**apagada** en dev al terminar (sin valor en `club_funciones` ni en `grupo_funciones`).

## Qué hay

La pantalla `/grupo/reportes` permite:

- elegir el antro, si hay más de uno con la bandera encendida;
- elegir «Reporte de la noche» o «Reporte de la semana»;
- moverse de noche o de semana;
- ver las cifras clave;
- **Descargar PDF**, un archivo real en tamaño carta.

Entradas, que solo aparecen con la bandera encendida:

- `/dueno/panel`: botón «Reportes PDF (noche y semana)», debajo de los de nómina y CSV.
- `/grupo`: el mismo enlace, debajo de «Configuración del grupo».

Por defecto abre la **noche anterior** a la noche en curso del antro (la última
completa) y la **semana en curso** (lunes a domingo). Si la bandera está apagada
en todos sus antros, la pantalla dice «Los reportes PDF no están activos para tus
antros.» y los enlaces no aparecen.

### Reporte de la noche (PDF)

1. **Encabezado.**
   - Nombre del antro; los nombres largos se parten en renglones.
   - «Noche del miércoles 25 de noviembre de 2026».
   - «Generado el … (hora del antro, zona)».
2. **Aviso en recuadro**, según el caso:
   - noche en curso (cifras parciales);
   - noche futura;
   - caja que sigue abierta después del corte;
   - **sin movimientos**: en ese caso el PDF solo lleva el aviso y las definiciones.
3. **Resumen.**
   - Consumo total, con reserva y sin reserva.
   - Ticket promedio.
   - Cuentas: con reserva, walk-in y con consumo.
   - Mesas usadas de N, y grupos de mesa.
   - Reservas: personas, llegaron y consumieron.
   - No llegaron / por llegar.
4. **Cobros y cuadre.**
   - Por método (efectivo, tarjeta, otro): lo cobrado y lo contado al cerrar.
   - Total cobrado (con el número de cobros) y por cobrar.
   - Diferencia del cuadre (contado − cobrado): «Cuadra», «Sobran $X» o «Faltan $X».
   - Quién cuadró y cuándo (hora del antro), lo registrado en caja, el saldo sin cobrar al cerrar y las notas (300 letras como máximo).
   - Sin cierre en caja: «Sin cuadre general…» y el contado sale «—».
5. **Comisiones de RPs.**
   - Comisiones por reserva (con su número).
   - Pagos por día (con su número).
   - Total.
   - Aviso si hay cuentas de RP sin cuadrar, porque su comisión todavía no nace.
6. **Rendimiento por RP.** Reservas, llegaron, consumieron, consumo y comisión; marca «dado de baja».
7. **Anulaciones.** Consumos anulados y cobros anulados (número y monto) y mesas reabiertas.
8. **Definiciones.** En cada hoja va además un pie con la fuente de las cifras y «Página i de N».
   - El pie dice: «cierre de la noche (caja por mesa, cobros, cuadre, anulaciones y comisiones) y rendimiento por RP de /grupo».
   - El PDF no repite el detalle por origen ni el de mesas del cierre (abiertas, cuadradas): sigue en la pantalla.

### Reporte de la semana (PDF)

- Lo mismo que el de la noche, sumado para la semana.
- La tabla **Noche por noche**, con 7 renglones: reservas, llegaron, cuentas, consumo, ticket, cobrado y comisiones.
- Cada noche puede llevar una nota: «sin caja», «caja sin cerrar», «en curso (parcial)» o «todavía no empieza».
- Un renglón final «Semana» con los totales.
- El aviso «Semana en curso: N noches no han terminado» cuando aplica.
- **Anulaciones y cuadres**:
  - consumos y cobros anulados (número y monto) y mesas reabiertas de las 7 noches;
  - «Noches cerradas con cuadre: N de 7»;
  - suma de las diferencias de esos cuadres.
- Las secciones van en este orden: Resumen, Noche por noche, Cobrado, Comisiones, RPs, Anulaciones y cuadres, Definiciones.

### Nombres largos y texto libre

`profiles.nombre` no tiene límite en la base, y un RP puede cambiar el suyo.

- Antes de maquetar, todo nombre se recorta a 120 letras (`limitar`). Las notas del cuadre se recortan a 300.
- El maquetador además pone tope:
  - 3 renglones por celda y por nombre del antro;
  - 3 para los detalles;
  - 4 para las notas;
  - 6 para los avisos.
  - Lo que sobra termina en «…».
- Partir y recortar texto se hace en una sola pasada (anchos acumulados).
- Con un nombre de 20,000 letras, el PDF se arma en milisegundos y nada se sale de la hoja.

### Definiciones (impresas en el PDF)

- **Noche**: noche de operación del antro. Termina a las 08:00 del día siguiente en
  `clubs.zona_horaria` (`club_fecha_operacion`).
- **Semana**: lunes a domingo (ISO). Cada noche cuenta por su fecha de operación.
- **Consumo total**: todo lo registrado en caja, con y sin reserva, sin anulados.
- **Cuenta**: la de un cliente en una mesa (reserva o walk-in).
- **Grupo de mesa**: cada vez que se ocupa una mesa (`mesa_sesiones`). El cierre de la noche lo llama «grupos».
- **Ticket promedio = consumo total ÷ cuentas con consumo**, redondeado al centavo.
  - Cuenta con consumo = tiene al menos un consumo no anulado.
  - En la semana se divide el consumo de las 7 noches entre todas sus cuentas con consumo. No es el promedio de los tickets de cada noche.
  - Es la misma definición que usan `reporte_cierre_noche` y `grupo_resumen`.
- **Cobrado**: cobros en caja, sin anulados. Por cobrar = consumo − cobrado.
- **Comisiones**: comisiones de RP por reserva más pagos por día, sin anuladas. Es lo mismo que la nómina.
  - Las comisiones por reserva nacen al cuadrar la mesa.
  - Se incluyen las de $0 por la cuota.
- **Rendimiento por RP**: solo las reservas de origen RP, con el consumo de sus cuentas.
- **Cuadre**: el conteo físico que se guarda al cerrar la noche en caja.
  - Diferencia = contado − cobrado: positiva = sobran, negativa = faltan.
  - Sin cierre en caja no hay cuadre.
  - En la semana: suma de las diferencias de las noches con cuadre.
- **Anulaciones**: consumos y cobros anulados con motivo, que no cuentan en consumo ni en cobrado, y mesas reabiertas.

## Cómo se entrega el archivo

`entregarPdf` en `lib/domain/reporte-pdf.ts` elige la vía según el equipo:

1. **Teléfono o app instalada** (pantalla táctil, `display-mode: standalone` o `navigator.standalone`), si `navigator.canShare({ files })` lo permite:
   - Abre la hoja de compartir del sistema: «Guardar en Archivos», WhatsApp, correo…
   - En iOS es la vía confiable, sobre todo con la app instalada.
2. **Si no**, descarga normal con `<a download>`.
3. **Si el navegador no sabe descargar**, abre el PDF en otra pestaña.

El enlace temporal del archivo se libera a los 60 s.

En computadora no se usa compartir aunque el navegador lo tenga (Chrome en Windows sí lo tiene): ahí se descarga. Es una precisión sobre lo que se pidió.

Mensajes en pantalla, según cómo terminó:

| Resultado | Mensaje |
|---|---|
| Compartido | «Se generó el PDF.» |
| Descargado | «Se generó el PDF. Si no lo ves, revisa tus descargas.» |
| Abierto en otra pestaña | «Se generó el PDF y se abrió en otra pestaña.» |
| Hoja de compartir cancelada | «Se generó el PDF, pero no se guardó ni se compartió.» |

La pantalla ya no dice «Listo: el PDF se descargó».

## De dónde salen los números

En el navegador no se calcula nada: solo se da formato (de centavos a MXN, al final).

| Reporte | Fuente |
|---|---|
| Noche | `reporte_pdf_noche` = `reporte_cierre_noche(club, fecha)` tal cual (+ `generado_local`) |
| Semana, cada noche | `reporte_cierre_noche` de cada una de las 7 noches, en una sola lectura (mismo instante) |
| Semana, totales | suma de las 7 noches, hecha en la base; ticket = round(consumo / cuentas con consumo) |
| Semana, anulaciones y cuadres | suma de `anulaciones` y de `cuadre.diferencia_centavos` de los 7 cierres (en la base) |
| Semana, RPs | `grupo_rendimiento_rp(club, lunes, domingo)` (la misma de /grupo) |

## Archivos

- `sql/post-junta-3/70-reportes-pdf.sql` y `sql/post-junta-3/70-reportes-pdf-rollback.sql`
- `lib/pdf/escritor.ts`: escritor de PDF sin dependencias.
- `lib/domain/reporte-pdf.ts`: normalización (con tope de largo), formato, maquetación y entrega (compartir, descargar o abrir).
- `components/reportes/reportes-pdf.tsx`: la pantalla.
- `components/reportes/enlace-reportes-pdf.tsx`: el enlace, que respeta la bandera.
- `app/grupo/reportes/page.tsx`: la ruta (delgada).
- `app/dueno/panel/page.tsx` y `app/grupo/page.tsx`: **solo** un import y una línea cada uno.
- Pruebas:
  - `scripts/dev/probar-reportes-pdf.mjs`
  - `scripts/dev/probar-reportes-pdf-maqueta.mjs`
  - `scripts/dev/probar-pdf-escritor.mjs`

## Dependencia: ninguna (escritor propio)

Se eligió la opción (b): `lib/pdf/escritor.ts`, de unas 300 líneas y sin imports.

- **Fuentes.** Usa las estándar Helvetica y Helvetica-Bold con **WinAnsiEncoding**. Todos los lectores de PDF las traen, así que no se incrustan.
- **Caracteres.** WinAnsi cubre á é í ó ú ü ñ Á É Í Ó Ú Ü Ñ ¿ ¡ $ « » – — € ÷ · © ® ™.
  - **No se imprimen:** invisibles (`\p{Default_Ignorable_Code_Point}`: U+200E/F, U+200B, U+200D, U+FE0F…), emojis y pictogramas, tonos de piel, letras de bandera y caracteres de control. «Ana ❤️» → «Ana ».
  - **Compatibilidad NFKD:** letras de ancho completo → normales (ＡＢＣ → ABC), ligaduras (ﬁ → fi), acentos fuera de Latin-1 (ő → o).
  - **«?»** solo para letras sin lugar en WinAnsi (Ł, Ж).
  - El signo menos (−) sale como guion.
- **Medidas.** Los anchos de los glifos salen de los AFM de Adobe; sirven para alinear a la derecha y partir renglones.
- **Archivo.** ASCII sin compresión, con el texto en hexadecimal.
- **Orden de escritura.** Cada fila de tabla se escribe en orden de lectura: primero el primer renglón de la primera columna, luego las demás celdas, después los renglones partidos y la nota.

Por qué no pdf-lib:

- `node_modules` es un junction compartido con el repo principal: instalarla afectaría a las otras ramas.
- Agrega peso y su propia auditoría.
- Para tablas y texto no hace falta.

Por qué no `window.print()`: no produce un archivo que se pueda mandar por WhatsApp o correo, y el resultado depende del navegador.

Límites asumidos:

- sin imágenes ni logotipo;
- sin fuentes propias;
- los caracteres fuera de WinAnsi no se conservan.

## SQL (orden y rollback)

Requiere `sql/post-junta-3/00-funciones-club.sql` y `sql/post-junta-2/30-cierre-noche.sql`,
con lo que esos a su vez piden. Es un solo archivo:

1. **`sql/post-junta-3/70-reportes-pdf.sql`.** Tres funciones nuevas; ninguna existente se redefine.
   - `reporte_pdf_autorizar(club)`: interna, solo para `service_role`.
   - `reporte_pdf_noche(club, fecha)` y `reporte_pdf_semana(club, lunes)`: para `authenticated` y `service_role`, con `revoke all … from public, anon` explícito.
   - Las tres son SECURITY DEFINER con `search_path = ''`.
   - Autorizan primero, con `coalesce(…, false)`.
   - Sus mensajes son P0001 en español.
   - La semana valida que la fecha sea lunes y que esté entre 2020 y los próximos 3 meses.
   - Revisión del 27/11: la semana suma además las anulaciones y los cuadres de los 7 cierres.
     - Por noche: `consumos_anulados(_centavos)`, `cobros_anulados(_centavos)`, `mesas_reabiertas`, `con_cuadre` y `diferencia_centavos`.
     - En los totales: `noches_con_cuadre` y `diferencia_centavos`.
2. **Rollback: `sql/post-junta-3/70-reportes-pdf-rollback.sql`.** Solo hace `drop function`; no hay datos que guardar.

Prueba de rollback exacto en dev, repetida tras la revisión. El esquema se extrajo con `extraer-esquema --origen=dev`, sin las líneas de encabezado:

- antes = después del rollback: **idéntico**;
- aplicado = reaplicado: **idéntico**.

En el primer intento de la revisión, la comparación «antes / después» salió distinta: entre las dos capturas, otro carril agregó al mismo tiempo los `CHECK` de largo de `profiles` y `reservations`. Se repitió el ciclo completo sin cambios ajenos de por medio y salió idéntico.

Quedó aplicado en dev.

**Acceso, revisado en la base:**

- Entran: admin, el dueño del antro, el dueño de su grupo y el gerente ACTIVO del antro.
- Después se revisa la bandera. A quien no tiene acceso no se le dice si está encendida.
- Staff, RP, cliente, cuenta sin perfil, dado de baja o con contraseña temporal reciben «No tienes acceso…».
- Anónimo: sin EXECUTE (42501).
- `reporte_cierre_noche` y `grupo_rendimiento_rp` vuelven a autorizar por dentro, porque `auth.uid()` no cambia dentro de una función SECURITY DEFINER.

## Pruebas (27/11/2026, contra dev)

### `node scripts/dev/probar-pdf-escritor.mjs`: 38/38

- La tabla xref es exacta.
- El archivo es ASCII.
- pdftotext lee bien los acentos.
- Partir y recortar texto funcionan.
- Los caracteres fuera de WinAnsi salen como se espera.
- Nuevo:
  - emojis, «Ana ❤️», familia con U+200D, tono de piel y bandera, U+200E/U+200F/U+200B, ancho completo, ﬁ, acento combinado, Ж/Ł, © ® ™ €, controles;
  - 20,000 letras: partir en 5 ms, recortar en 1 ms, tope de 3 renglones con «…», todo cabe.

### `node scripts/dev/probar-reportes-pdf-maqueta.mjs`: 34/34

Con datos en memoria:

- antro y RP con nombres muy largos y acentos;
- 40 RPs repartidos en 3 hojas;
- encabezado de tabla repetido y «continúa» en las hojas siguientes;
- noche vacía y semana en curso;
- nombres de archivo.
- Nuevo:
  - cuadre (contado por método, «Faltan $500.00», quién, notas) y noche sin cuadre;
  - anulaciones de la noche y de la semana;
  - revisión de que **todo texto escrito cae dentro de la hoja**.
  - Nombres de 20,000 letras en antro, RP y notas, con y sin el tope de 120: el PDF se arma en 3–12 ms, con ≤ 3 hojas y < 100 KB, y todo dentro de la hoja.

### `PLAYWRIGHT_DESDE=… node scripts/dev/probar-reportes-pdf.mjs http://localhost:3045`: 152/152

Corrió contra `next dev` local.

**Bandera apagada:**

- Admin, dueño y gerente reciben el rechazo.
- Los enlaces no aparecen en `/dueno/panel` ni en `/grupo`.
- La pantalla dice «no están activos».
- La bandera de un antro no abre otro.

**Acceso:**

- Sí: admin, dueño y gerente de Club Demo Dev; dueño de grupo, dueño y gerente de Tijuana.
- No: staff, RP, cliente, dueño y gerente del otro antro, staff y RP de Tijuana, anónimo y cuenta sin perfil.

**Cifras, al centavo:**

- Noche 25/11: el reporte es igual a `reporte_cierre_noche` (JSON completo), con sesión de dueño, de admin y de gerente.
- Semanas 16–22/11 (cerrada) y 23–29/11 (en curso):
  - cada noche es igual a su cierre;
  - totales = `grupo_resumen` (consumo, cuentas con consumo, ticket, reservas, entraron, consumieron y comisiones);
  - RPs = `grupo_rendimiento_rp`;
  - comisiones = `nomina_semana`, en total y por RP;
  - totales = exportes (reservas, estado consumio, consumos y comisiones sin anulados);
  - cobrado por método = `caja_pagos`;
  - anulaciones = `caja_consumos` y `caja_pagos` anulados y `caja_eventos` `reabrir_mesa`;
  - cuadres = `caja_cuadres` (noches con cuadre y suma de diferencias).
- Noche cerrada 21/11: cobrado y contado por método, diferencia, registrado y saldo del cuadre, y anulaciones en el PDF = `reporte_cierre_noche`.

**Entrega del archivo** (Chromium con `navigator.share` simulado, contexto táctil):

- En el teléfono comparte UN archivo `application/pdf` y no descarga nada. El archivo compartido es el reporte, con las cifras de la base.
- Cancelar la hoja de compartir lo dice en pantalla.
- Sin compartir archivos, descarga.
- En computadora, descarga con su mensaje.
- Sin `<a download>`, abre un `blob:` en otra pestaña y lo dice.

**PDF descargado desde la pantalla:**

- Lo leen **pdftotext** (lector independiente) y **pdf.js** (que lo dibuja).
- Cada cifra y cada renglón coincide con la base: cobros, comisiones, 5 RPs, 7 noches y el renglón «Semana».
- Acentos, definición del ticket y pie correctos.
- Salen bien los avisos de noche en curso, semana en curso y noche sin movimientos.

**Pantalla a 390×844 y 360×740:**

- sin scroll horizontal;
- controles de al menos 40 px;
- sin errores de consola.

Las capturas están en `screenshots-n4-reportes/` (Git la ignora).

**Cifras de la corrida:**

| | Consumo | Ticket | Cobrado | Comisiones | RPs |
|---|---|---|---|---|---|
| Noche 25/11 | $161,550.00 | $6,462.00 (25 cuentas) | $119,425.00 | $1,550.00 | 5 |
| Semana 16–22/11 | $470,000.00 | $8,103.45 (58 cuentas) | $470,000.00 | $13,774.00 | 5 |

### Otros resultados

- La bandera se enciende como admin (`funcion_cambiar`) solo durante la prueba y al final se restaura al valor previo.
  - Sus cambios quedan en la bitácora `funciones_cambios`, que es lo esperado.
- Restos `t_n4_rep_` al terminar: 0.
- `npx tsc --noEmit`, `npx eslint` sobre los archivos tocados y `next build` (con `NEXT_DIST_DIR=.next-build`) salieron limpios. `tsconfig.json` no cambió.

## Decisiones para Diego

1. **El gerente sí ve los reportes PDF**, de su antro y si está activo.
   - Motivo: el cierre de la noche, `/grupo` y los exportes ya le muestran exactamente estas cifras, comisiones incluidas, y CLAUDE.md dice que el gerente sí ve las reglas de pago.
   - El staff puro nunca los ve.
   - Para dejarlos solo al dueño: quitar la línea del gerente en `reporte_pdf_autorizar` (y su caso en la prueba).
2. La noche por defecto es la anterior a la noche en curso (la última completa), no la en curso como en `/grupo/noche`.
3. El PDF es tamaño carta, en tema claro (pensado para imprimir) y sin logotipo.
4. ~~El reporte no repite el cuadre ni las anulaciones~~: desde la revisión del 27/11 sí los trae (noche y semana).
5. En teléfono, el botón abre la hoja de compartir en vez de descargar. En computadora, descarga.

## Riesgos

- El PDF se arma en el navegador con lo que devolvió la base. Sus cifras son las de la base, pero el archivo no va firmado: se puede editar después de descargarlo, como cualquier PDF.
- La semana son 7 llamadas a `reporte_cierre_noche` dentro de una sola consulta. No se midió con carga; con muchas mesas podría tardar.
- `reporte_pdf_semana` toma los campos del JSON de `reporte_cierre_noche` por nombre. Si ese JSON cambia hay que revisar ambas funciones juntas; la prueba lo detectaría.
- El admin solo ve en el selector los antros que tienen la bandera encendida (de los que devuelve `grupo_resumen`).
- La entrega por la hoja de compartir solo se probó con `navigator.share` simulado en Chromium. Falta verla en un iPhone real (Safari y app instalada) y en Android.
- El límite de largo de `profiles.nombre` en la base lo agrega otro carril. Aquí solo se recorta al mostrar.

## Lo que NO está hecho

- Nada en producción, ni SQL ni código. En el pase, el 70 va después del 00 de post-junta-3 y del 30 de post-junta-2.
- No hay envío por correo ni programado, ni reporte mensual, ni gráficas.
- Pruebas que faltan:
  - En un iPhone o Android real (solo se probó en Chromium a 390 y 360 px) ni en el visor de PDF de iOS. Sí se probó con pdftotext (Xpdf 4.00) y pdf.js 3.11.
  - Con un gerente dado de baja creado a propósito. La condición es la misma de `reporte_cierre_noche`, cuya prueba sí lo cubre.
