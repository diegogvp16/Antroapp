-- ============================================================================
-- AntroApp — Rollback de 63-bucket-fotos-limites.sql
-- Fecha: 2026-11-25 (rama c-rls). Deja club-photos sin límites, como antes
-- (igual que en sql/esquema/esquema-prod.sql).
-- ============================================================================

update storage.buckets
set file_size_limit = null,
    allowed_mime_types = null
where id = 'club-photos';
