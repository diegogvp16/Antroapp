-- Rollback de sql/post-junta-3/40-lista-negra.sql: quita la lista negra y la
-- política de no-show (trigger nuevo de reservations, funciones y tablas).
-- OJO: borra los bloqueos, la política y la bitácora de todos los antros.
-- Si hay datos que conservar, respaldarlos antes (docs/respaldos.md).
-- Si ya se aplicó 60-whatsapp-plantillas.sql, correr antes su rollback
-- (clientes_noche usa las funciones de aquí).
begin;
drop trigger if exists reservations_lista_negra_cambio on public.reservations;
drop trigger if exists reservations_lista_negra on public.reservations;
drop function if exists public.reservations_lista_negra();

drop function if exists public.lista_negra_tachar(uuid);
drop function if exists public.lista_negra_aviso(uuid, text);
drop function if exists public.lista_negra_historial(uuid, int);
drop function if exists public.lista_negra_noshows(uuid);
drop function if exists public.lista_negra_ver_telefono(uuid, uuid);
drop function if exists public.lista_negra_bloqueos(uuid, boolean);
drop function if exists public.lista_negra_desbloquear(uuid, uuid, uuid, text);
drop function if exists public.lista_negra_bloquear(uuid, text, uuid, text, int, text);
drop function if exists public.lista_negra_politica_guardar(uuid, int, int, int);
drop function if exists public.lista_negra_politica(uuid);
drop function if exists public._lista_negra_exigir(uuid);
drop function if exists public._lista_negra_manual(uuid, text, uuid);
drop function if exists public._lista_negra_auto(uuid, text);
drop function if exists public._lista_negra_noshows(uuid, date, text);
drop function if exists public._lista_negra_politica(uuid);
drop function if exists public._lista_negra_ve_avisos(uuid);
drop function if exists public._lista_negra_gestiona(uuid);
drop function if exists public._lista_negra_mascara(text);
drop index if exists public.reservations_club_tel_fecha;
drop function if exists public.lista_negra_tel(text);

-- Los triggers "nada se borra" impedirían el drop de filas, no el de la
-- tabla: drop table no dispara triggers de fila.
drop table if exists public.lista_negra_eventos;
drop table if exists public.club_noshow_politica;
drop table if exists public.club_bloqueos;
drop function if exists public.lista_negra_sin_borrar();
commit;
