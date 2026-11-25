-- ============================================================================
-- AntroApp — Rollback de 67-club-photos-listar.sql
-- Fecha: 2026-11-25 (rama c-rls). Quita la restrictiva de SELECT: el bucket
-- club-photos vuelve a listarse completo por la API (igual que en
-- sql/esquema/esquema-prod.sql). Vuelve a abrir el hueco del 67.
-- ============================================================================

drop policy if exists club_photos_restrictiva_select on storage.objects;
