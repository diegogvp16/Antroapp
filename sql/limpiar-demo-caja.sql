-- ============================================================================
-- Limpiar la CAJA de la demo de Club Demo (producción, después del pase).
-- Se corre A MANO en el SQL Editor solo si scripts/demo-datos.mjs lo pide
-- ("Hay N cuentas de caja de una demo anterior"). La caja no se borra por la
-- API ("nada se borra en caja"); este bloque usa el permiso de limpieza de
-- pruebas, que solo funciona como dueño de las tablas (postgres).
-- Solo toca el antro de demostración Club Demo (d2f531df-8116-442e-b967-4a1004fcd02e).
-- ============================================================================
begin;
set local antroapp.borrado_pruebas = 'on';
delete from public.caja_eventos  where club_id = 'd2f531df-8116-442e-b967-4a1004fcd02e';
delete from public.caja_cuadres  where club_id = 'd2f531df-8116-442e-b967-4a1004fcd02e';
delete from public.caja_pagos    where club_id = 'd2f531df-8116-442e-b967-4a1004fcd02e';
delete from public.caja_consumos where club_id = 'd2f531df-8116-442e-b967-4a1004fcd02e';
delete from public.mesa_cuentas  where club_id = 'd2f531df-8116-442e-b967-4a1004fcd02e';
delete from public.mesa_sesiones where club_id = 'd2f531df-8116-442e-b967-4a1004fcd02e';
delete from public.caja_noches   where club_id = 'd2f531df-8116-442e-b967-4a1004fcd02e';
-- Revisa los conteos antes de confirmar: todo debe ser de la demo.
commit;
