-- ROLLBACK de sql/2026-11-21-rp-panel.sql (solo quita funciones; no toca datos).
drop function if exists public.rp_progreso_cuota();
drop function if exists public.rp_mis_reservas(date, date);
drop function if exists public.rp_nivel_visibilidad(uuid);
