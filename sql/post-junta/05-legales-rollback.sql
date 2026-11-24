-- Rollback de sql/post-junta/05-legales.sql (borra la constancia de aceptaciones).
drop table if exists public.aceptaciones_legales;
drop function if exists public.aceptaciones_fecha_servidor();
