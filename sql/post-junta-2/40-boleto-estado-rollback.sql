-- ============================================================================
-- AntroApp — ROLLBACK de sql/post-junta-2/40-boleto-estado.sql
-- Restaura obtener_reserva_por_qr EXACTAMENTE como está hoy en producción y
-- en dev (sql/esquema/esquema-prod.sql, extraído del catálogo): mismas seis
-- columnas, mismo cuerpo, search_path 'public', 'pg_temp' y los mismos
-- GRANT (anon, authenticated y service_role; nada a PUBLIC).
-- El código nuevo de /r/<codigo> sigue funcionando con esta versión: sin
-- estado_boleto cae al cálculo de respaldo (status y fecha).
-- ============================================================================

drop function if exists public.obtener_reserva_por_qr(text);

CREATE OR REPLACE FUNCTION public.obtener_reserva_por_qr(p_qr text)
 RETURNS TABLE(cliente_nombre text, fecha date, personas integer, status text, qr_code text, club_nombre text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select r.cliente_nombre,
         r.fecha,
         r.personas,
         r.status,
         r.qr_code,
         c.nombre as club_nombre
  from public.reservations r
  left join public.clubs c on c.id = r.club_id
  where r.qr_code = p_qr
  limit 1;
$function$;

revoke all on function public.obtener_reserva_por_qr(p_qr text) from public, anon, authenticated, service_role;
grant execute on function public.obtener_reserva_por_qr(p_qr text) to anon;
grant execute on function public.obtener_reserva_por_qr(p_qr text) to authenticated;
grant execute on function public.obtener_reserva_por_qr(p_qr text) to service_role;
