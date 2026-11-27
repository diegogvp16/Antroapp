-- Rollback de sql/post-junta-3/00-funciones-club.sql. Va AL FINAL de los
-- rollbacks de post-junta-3 (los demás SQL de esa carpeta usan funcion_activa).
-- Borra las banderas y su bitácora.
begin;
drop function if exists public.grupo_funcion_cambiar(uuid, text, boolean);
drop function if exists public.funcion_cambiar(uuid, text, boolean);
drop function if exists public.funciones_estado();
drop function if exists public.mis_funciones(uuid);
drop function if exists public.funcion_activa(uuid, text);
drop table if exists public.funciones_cambios;
drop table if exists public.grupo_funciones;
drop table if exists public.club_funciones;
commit;
