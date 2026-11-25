-- Rollback de sql/post-junta-2/21-invitaciones.sql.
-- Borra las funciones y las tablas de invitaciones (con su historial).
-- Las cuentas y perfiles que ya se crearon al aceptar invitaciones NO se
-- tocan: son personal normal del antro. El código que las usa responde con
-- error genérico sin las funciones; create-staff sigue funcionando igual.
drop function if exists public.invitaciones_limpiar();
drop function if exists public.invitacion_aceptar(text, uuid);
drop function if exists public.invitacion_consultar(text);
drop function if exists public.invitacion_estado(timestamptz, timestamptz, timestamptz);
drop function if exists public.invitacion_emitir_token(uuid);
drop function if exists public.invitacion_revocar(uuid);
drop function if exists public.invitacion_reenviar(uuid);
drop function if exists public.invitacion_crear(uuid, text, text, text);
drop table if exists public.invitacion_intentos;
drop table if exists public.invitacion_envios;
drop table if exists public.invitaciones;
-- invitacion_puede la usa la política de invitaciones: va después de la tabla.
drop function if exists public.invitacion_puede(uuid, text);

notify pgrst, 'reload schema';
