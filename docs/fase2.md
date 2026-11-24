# Fase 2: inventario y propinas (rama `fase2`)

**Aislada.** Vive solo en la rama `fase2` (creada desde `noche2`). No se
mezcla con `desarrollo` ni con `master` sin autorización de Diego. El código
va detrás de la bandera `NEXT_PUBLIC_FASE2`, **apagada por defecto**: sin ella
la app se comporta exactamente igual (probado: caja de 3 sesiones 17/17 con
la bandera apagada en esta rama).

## Qué hace (con la bandera en `1`)

| Parte | Qué hace |
|---|---|
| Catálogo (`/staff/catalogo`, solo gerente) | Productos por antro: nombre, categoría, precio, existencias, mínimo para el aviso. Alta, edición, apagar (no se borra) y ajuste de existencias con motivo ("entra" pedido / "sale" merma o conteo). Aviso arriba de los productos con existencias bajas. Enlace en el panel del gerente. |
| Agregar consumo (caja) | Si el antro tiene catálogo: categorías, buscador (sin acentos ni mayúsculas), existencias junto al precio (en ámbar si están bajas o si se pide más de lo que hay). "Otro concepto (fuera del catálogo)" sigue disponible plegado, y avisa que no descuenta inventario. Sin catálogo, la hoja es la de siempre. |
| Existencias | Cada venta de catálogo descuenta (`caja_registrar_consumo_producto`: precio y concepto los pone la base, misma clave de idempotencia de la caja: un reintento no descuenta dos veces). Anular el cargo las regresa (trigger). Todo queda en `producto_movimientos`. Se puede vender aunque el conteo diga 0: queda negativo y el aviso lo marca ("Faltan N, revisa el conteo"). |
| Propinas | Campo "Propina (opcional)" al cobrar, en efectivo o tarjeta. Se guarda aparte del monto (`caja_pagos.propina_centavos`): no cambia el saldo, ni lo cobrado del cuadre, ni la comisión del RP. Se ve en cada cobro, en el total de la mesa, en la hoja de cuadrar y en "Propinas de la noche" del cuadre general. |

## SQL (solo antroapp-dev)

- `sql/fase2/2026-11-21-inventario-propinas.sql`:
  - tablas `productos` y `producto_movimientos`, con RLS y GRANT explícitos (lectura: staff, gerente y dueño del antro; la bitácora solo gerente y dueño; escritura solo por funciones);
  - las columnas `caja_consumos.producto_id` y `cantidad`, y `caja_pagos.propina_centavos`;
  - las funciones `producto_guardar`, `producto_ajustar_existencias`, `caja_registrar_consumo_producto` y `caja_registrar_pago` (con `p_propina_centavos default 0`);
  - el trigger que regresa existencias al anular.
- Requiere `sql/2026-11-21-caja-idempotencia.sql` (rama `noche2`).
- **Cómo revertir el esquema de dev a lo anterior** (deja dev igual que
  `noche2`, probado con diff vacío):
  ```bash
  node scripts/db/aplicar-dev.mjs sql/fase2/2026-11-21-inventario-propinas-rollback.sql
  ```
  Borra el catálogo y las propinas de prueba de dev.
- Mientras esté aplicado, `desarrollo` y `noche2` (que comparten dev) siguen
  funcionando: los parámetros nuevos tienen default. Probado con
  probar-caja 167/167, concurrencia 29/29, dashboards 28/28, visibilidad
  68/68 y verificar-cuadre sin diferencias.

## Pruebas

| Prueba | Resultado |
|---|---|
| `node scripts/dev/probar-fase2.mjs` (base, sesiones reales) | 51/51: permisos del catálogo por rol y antro, ventas con reintento, 5 envíos iguales y 3 staff a la vez, anulación, propina aparte del saldo, del cuadre y de la comisión, verificar-cuadre sin diferencias. |
| `NEXT_PUBLIC_FASE2=1 node scripts/dev/servidor-prod-dev.mjs` + `node scripts/dev/probar-fase2-pantalla.mjs` | 12/12 en pantalla a 390 px. Capturas en `screenshots-fase2/`. |
| `node scripts/dev/probar-caja-multi.mjs` con la bandera apagada | 17/17 (igual que `noche2`). |

## Decisiones para Diego

1. **Propinas y conteo de caja**: la propina no entra al conteo del cierre de
   noche (se entrega aparte al personal). Si el antro la mete a la caja y la
   reparte después, hay que cambiar el cuadre general para esperarla.
2. **Vender sin existencias**: hoy se permite (queda negativo con aviso). La
   alternativa es bloquear la venta; en un antro eso detiene la barra por un
   conteo mal hecho.
3. **Concepto libre con catálogo**: se dejó como "Otro concepto (fuera del
   catálogo)". ¿Se quita para obligar a usar el catálogo?
4. **¿Quién edita el catálogo?** Hoy, en pantalla, solo el gerente. La base también
   deja al dueño, que todavía no tiene su propia pantalla.
5. **¿Las propinas son del mesero o del RP?** Hoy son de la mesa, no de una persona.

## Pendiente

- Reporte de inventario por noche (vendido por producto) y exportar.
- Catálogo desde el panel del dueño.
- La firma de la noche no incluye cambios del catálogo: si el gerente cambia
  un precio, la caja lo ve al siguiente movimiento o al recargar.

## Integración en `post-junta` (24/11/2026)

- La rama `fase2` se fusionó en `post-junta` sin conflictos (la rama `fase2`
  no se tocó). Su SQL (`sql/fase2/…`) se volvió a aplicar en dev.
- **Importar el catálogo desde CSV** (`/staff/catalogo`, «Importar desde
  CSV»): «nombre, categoría, precio, mínimo, existencias», encabezado
  opcional, coma, punto y coma o tabulador. Primero «Revisar» (vista previa y
  errores por línea) y luego «Importar». Todo o nada
  (`producto_importar`, `sql/post-junta/09-catalogo-csv.sql`). Un producto
  que ya existe actualiza precio, categoría y mínimo, **no** sus existencias.
- **Alerta de existencias bajas** también en el panel del gerente (enlaza al
  catálogo). La venta sigue sin bloquearse por existencias.
- Pruebas: `probar-fase2.mjs` 51/51 y `probar-catalogo-csv.mjs` 16/16.
