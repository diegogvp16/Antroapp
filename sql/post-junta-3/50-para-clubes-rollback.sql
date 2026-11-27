-- Rollback de sql/post-junta-3/50-para-clubes.sql: quita las banderas de
-- plataforma, el formulario de contacto de /para-clubes y su bitácora.
-- NO toca public.ip_cliente() (es de sql/post-junta-3/02-ip-cliente.sql).
-- ANTES de correrlo con datos reales: exportar contactos_clubes (trae
-- nombres, correos y teléfonos de antros interesados) y para_clubes_bitacora.
-- La página /para-clubes da 404 sin estas funciones (no truena) y la tarea
-- diaria solo anota que falta contacto_intentos_limpiar.
begin;
drop function if exists public.contacto_club_borrar(uuid);
drop function if exists public.contacto_club_marcar(uuid, text);
drop function if exists public.contactos_clubes_conteo();
drop function if exists public.contactos_clubes_admin(text, integer, integer);
drop function if exists public.para_clubes_contacto_enviar(text, text, text, text, text, text, text, text);
drop function if exists public.contacto_intentos_limpiar();
drop function if exists public.contacto_huella(text);
drop table if exists public.contacto_intentos;
drop table if exists public.contacto_sal;
drop table if exists public.contactos_clubes;
drop function if exists public.plataforma_banderas_estado();
drop function if exists public.plataforma_bandera_cambiar(text, boolean);
drop function if exists public.para_clubes_activa();
drop table if exists public.para_clubes_bitacora;
drop table if exists public.plataforma_banderas;
commit;
