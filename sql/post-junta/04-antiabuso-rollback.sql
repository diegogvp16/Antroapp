-- Rollback de sql/post-junta/04-antiabuso.sql.
drop function if exists public.antiabuso_limpiar();
drop table if exists public.registro_intentos;
