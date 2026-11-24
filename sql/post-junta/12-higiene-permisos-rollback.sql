-- Rollback de sql/post-junta/12-higiene-permisos.sql (regresa el permiso por defecto).
grant execute on function public.lunes_de(date) to public;
grant execute on function public.siguiente_corte(timestamptz, text) to public;
grant execute on function public.mensualidad_rango_status(text) to public;
grant execute on function public.aceptaciones_fecha_servidor() to public;
grant execute on function public.clubs_candado_suscripcion() to public;
