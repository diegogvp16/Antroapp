-- ============================================================================
-- AntroApp — Rollback de sql/post-junta-3/10-pos-ventas.sql
-- Fecha: 2026-11-27 (revisión 2). Deja el esquema como antes de aplicarlo.
-- OJO: borra las ventas del POS importadas, los mapeos y las importaciones.
-- No toca la caja (las ventas del POS nunca la cambiaron).
-- ============================================================================
begin;

drop function public.pos_cuentas_noche(uuid, date);
drop function public.pos_tickets(uuid, date);
drop function public.pos_conciliacion(uuid, date);
drop function public.pos_religar(uuid, date);
drop function public.pos_asignar(uuid, uuid[], uuid);
drop function public.pos_importacion_deshacer(uuid, text);
drop function public.pos_importaciones_lista(uuid);
drop function public.pos_importar(uuid, text, text, text, uuid, jsonb);
drop function public.pos_preparar(uuid, jsonb, text);
drop function public.pos_mapeo_borrar(uuid);
drop function public.pos_mapeo_guardar(uuid, text, jsonb);
drop function public.pos_mapeos_lista(uuid);
drop function public.pos_mis_antros();
drop function public.pos_resolver_lote(uuid, jsonb);
drop function public.pos_candidatos(uuid[]);
drop function public.pos_leer_lineas(uuid, jsonb);
drop function public.pos_clave_mesa(text);
drop function public.pos_exigir(uuid);
drop function public.pos_puede_usar(uuid);

drop table public.pos_ventas;
drop function public.pos_ventas_caja_borrada();
drop table public.pos_importacion_lineas;
drop table public.pos_importaciones;
drop table public.pos_mapeos;

commit;
