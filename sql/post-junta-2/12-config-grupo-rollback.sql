-- ============================================================================
-- Rollback de sql/post-junta-2/12-config-grupo.sql
-- Deja admin_alta_club EXACTAMENTE como la del 11 (se le regresa su nombre:
-- el cuerpo nunca cambió) con su mismo ACL, y borra triggers, funciones y
-- tablas de la configuración por grupo.
-- Lo que el grupo ya escribió en los antros (reglas programadas, qué ven los
-- RPs, modo de pago, tarifas, permisos de caja por rol, cover, hora límite)
-- SE QUEDA: son valores normales de cada antro, con su bitácora en
-- config_rp_cambios. Solo se pierde de dónde salieron (grupo o propio) y la
-- bitácora del grupo. Si hace falta conservarla, exportar antes
-- grupo_config, club_config_propia y grupo_config_cambios.
-- Va ANTES del rollback del 11.
-- ============================================================================

-- 1. Alta: quitar la envoltura y regresar la del 11 con su nombre y su ACL.
drop function public.admin_alta_club(jsonb);
alter function public._admin_alta_club_base(jsonb) rename to admin_alta_club;
revoke all on function public.admin_alta_club(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.admin_alta_club(jsonb) to authenticated, service_role;

-- 2. Triggers.
drop trigger reglas_comision_config_grupo on public.reglas_comision;
drop trigger club_config_rp_config_grupo on public.club_config_rp;
drop trigger caja_permisos_config_grupo on public.caja_permisos;
drop trigger club_dia_tarifas_config_grupo on public.club_dia_tarifas;
drop trigger clubs_config_grupo on public.clubs;
drop trigger grupo_clubs_config_grupo on public.grupo_clubs;

-- 3. Funciones.
drop function public.club_config_efectiva(uuid);
drop function public.club_config_sobrescribir(uuid, text);
drop function public.club_config_heredar(uuid, text);
drop function public._club_config_puede(uuid, text);
drop function public.grupo_config_quitar(uuid, text);
drop function public.grupo_config_cambiar(uuid, text, jsonb, boolean);
drop function public.grupo_config_actual(uuid);
drop function public.grupo_config_mis_grupos();
drop function public._trg_config_grupo_clubs();
drop function public._trg_config_propia_clubs();
drop function public._trg_config_propia_tarifas();
drop function public._trg_config_propia_permisos();
drop function public._trg_config_propia_visibilidad();
drop function public._trg_config_propia_regla();
drop function public._config_marcar_propia(uuid, text);
drop function public._config_aplicar_club(uuid, text, jsonb, uuid, date, boolean);
drop function public._config_valor_club(uuid, text);
drop function public._config_normalizar(text, jsonb);
drop function public.grupo_puede_editar(uuid);
drop function public.es_dueno_de_grupo(uuid);

-- 4. Tablas.
drop table public.grupo_config_cambios;
drop table public.club_config_propia;
drop table public.grupo_config;
