-- ROLLBACK de sql/2026-11-21-rp-panel.sql (quita funciones y políticas; no toca datos).
drop policy if exists commissions_rp_dado_de_baja on public.commissions;
drop policy if exists reservations_rp_dado_de_baja on public.reservations;
drop function if exists public.soy_rp_dado_de_baja();
drop function if exists public.rp_progreso_cuota();
drop function if exists public.rp_mis_reservas(date, date);
drop function if exists public.rp_nivel_visibilidad(uuid);
