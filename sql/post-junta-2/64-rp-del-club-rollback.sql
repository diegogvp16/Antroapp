-- ============================================================================
-- AntroApp — Rollback de 64-rp-del-club.sql
-- Fecha: 2026-11-25 (rama c-rls). Quita las restrictivas: vuelve a permitir
-- turnos/tarifas para RPs de otro antro y reservas en antros no publicados.
-- ============================================================================

drop policy if exists reservations_insert_solo_publicados on public.reservations;
drop policy if exists rp_dia_tarifa_overrides_rp_del_club_upd on public.rp_dia_tarifa_overrides;
drop policy if exists rp_dia_tarifa_overrides_rp_del_club on public.rp_dia_tarifa_overrides;
drop policy if exists rp_comision_overrides_rp_del_club_upd on public.rp_comision_overrides;
drop policy if exists rp_comision_overrides_rp_del_club on public.rp_comision_overrides;
drop policy if exists rp_attendance_rp_del_club on public.rp_attendance;
drop policy if exists rp_schedule_rp_del_club on public.rp_schedule;
drop function if exists public.rp_es_del_club(uuid, uuid);
