-- ============================================================================
-- Rollback de sql/post-junta-3/80-inventario.sql
-- Deja la bitácora como la dejó la fase 2: los movimientos nuevos (entrada,
-- merma, conteo) NO se borran; pasan a «ajuste» con la misma cantidad (las
-- existencias siguen cuadrando con la bitácora) y su detalle queda en el
-- motivo. Se pierden las columnas costo, referencia, contado, clave y orden.
-- ============================================================================
begin;

drop function if exists public.inventario_reporte_noche(uuid, date);
drop function if exists public.inventario_historial(uuid, int);
drop function if exists public.inventario_conteo(uuid, int, text, uuid, int);
drop function if exists public.inventario_merma(uuid, int, text, uuid);
drop function if exists public.inventario_entrada(uuid, int, bigint, text, uuid);
drop function if exists public.inventario_movimiento_previo(uuid, uuid, text, int, int);
drop function if exists public.inventario_producto_para_escribir(uuid);

update public.producto_movimientos
   set motivo = left(case tipo
                       when 'entrada' then 'Entrada' || coalesce(' (' || referencia || ')', '')
                       when 'merma' then 'Merma: ' || coalesce(motivo, '')
                       else 'Conteo (' || coalesce(contado::text, '?') || '): ' || coalesce(motivo, '')
                     end, 300),
       tipo = 'ajuste'
 where tipo in ('entrada', 'merma', 'conteo');

drop index if exists public.producto_movimientos_club_hecho;
drop index if exists public.producto_movimientos_clave;
alter table public.producto_movimientos
  drop column orden,
  drop column clave_cliente,
  drop column contado,
  drop column referencia,
  drop column costo_centavos;

alter table public.producto_movimientos drop constraint producto_movimientos_tipo_check;
alter table public.producto_movimientos add constraint producto_movimientos_tipo_check
  check (tipo in ('alta', 'ajuste', 'venta', 'anulacion'));

commit;
