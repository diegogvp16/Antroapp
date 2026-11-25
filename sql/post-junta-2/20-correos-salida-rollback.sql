-- Rollback de sql/post-junta-2/20-correos-salida.sql.
-- Borra la bandeja (y lo archivado en ella). El código que la usa
-- (lib/correo.ts) no se rompe sin la tabla: registra el error y, en modo
-- "enviar", manda el correo de todos modos.
drop function if exists public.correos_purgar(integer);
drop table if exists public.correos_salida;
