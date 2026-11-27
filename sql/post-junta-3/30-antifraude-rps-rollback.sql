-- ============================================================================
-- Rollback de sql/post-junta-3/30-antifraude-rps.sql (revisión de RPs).
-- Borra las funciones y las tablas nuevas, con sus alertas, reglas,
-- bitácoras, últimas búsquedas y la clave del HMAC. No toca nada que
-- existiera antes (la bandera 'antifraude' vive en el SQL 00).
-- Ojo: reaplicar después genera una clave nueva; como el rollback borra las
-- alertas, no queda nada que dependa de la anterior.
-- ============================================================================
begin;

drop function if exists public.fraude_alerta_cambiar(uuid, text, text);
drop function if exists public.fraude_alerta_detalle(uuid);
drop function if exists public.fraude_alertas_rps(uuid);
drop function if exists public.fraude_alertas_listar(uuid, text, text, uuid, date, date, integer, integer);
drop function if exists public.fraude_ultima_deteccion(uuid);
drop function if exists public.fraude_detectar(uuid, date, date);
drop function if exists public.fraude_reglas_cambios_leer(uuid, integer);
drop function if exists public.fraude_regla_guardar(uuid, text, boolean, jsonb);
drop function if exists public.fraude_reglas_leer(uuid);
drop function if exists public.fraude_mis_antros();
drop function if exists public.fraude_nombre(uuid, uuid);
drop function if exists public.fraude_enmascarar_texto(text);
drop function if exists public.fraude_enmascarar_tel(text);
drop function if exists public.fraude_tel10(text);
drop function if exists public.fraude_regla_activa(uuid, text);
drop function if exists public.fraude_parametros(uuid, text);
drop function if exists public.fraude_autorizar(uuid);
drop function if exists public.fraude_puede_revisar(uuid);

drop table if exists public.fraude_secreto;
drop table if exists public.fraude_detecciones;
drop table if exists public.fraude_alertas_cambios;
drop table if exists public.fraude_alertas;
drop table if exists public.fraude_reglas_cambios;
drop table if exists public.fraude_reglas;

drop function if exists public.fraude_catalogo();

commit;
