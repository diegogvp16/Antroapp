-- ============================================================================
-- AntroApp — Rollback de 68-un-antro-por-dueno-candado.sql
-- Fecha: 2026-11-25 (rama c-rls). Quita el trigger y su función: "un dueño,
-- un antro" queda solo con la lectura del WITH CHECK del 62 (dos altas a la
-- vez del mismo dueño vuelven a pasar las dos).
-- ============================================================================

drop trigger if exists clubs_un_antro_por_dueno on public.clubs;
drop function if exists public.clubs_un_antro_por_dueno();
