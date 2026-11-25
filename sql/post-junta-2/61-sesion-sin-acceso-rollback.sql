-- ============================================================================
-- AntroApp — Rollback de 61-sesion-sin-acceso.sql
-- Fecha: 2026-11-25 (rama c-rls). Vuelve a dejar que un RP dado de baja o con
-- contraseña temporal lea lo suyo (pagos por día, turnos, tarifa…).
-- ============================================================================

drop policy if exists reservations_sin_acceso on public.reservations;
drop policy if exists commissions_sin_acceso on public.commissions;
drop policy if exists rp_pagos_dia_sin_acceso on public.rp_pagos_dia;
drop policy if exists rp_schedule_sin_acceso on public.rp_schedule;
drop policy if exists rp_attendance_sin_acceso on public.rp_attendance;
drop policy if exists rp_comision_overrides_sin_acceso on public.rp_comision_overrides;
drop policy if exists rp_dia_tarifa_overrides_sin_acceso on public.rp_dia_tarifa_overrides;
drop function if exists public.sesion_sin_acceso();
