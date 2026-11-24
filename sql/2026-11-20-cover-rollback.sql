-- ============================================================================
-- ROLLBACK de sql/2026-11-20-cover.sql
-- Deja clubs como estaba antes del cover. Se pierde el cover que hayan
-- configurado los antros (es solo informativo; no hay dinero en juego).
-- Probado en dev: aplicar cover -> rollback -> el esquema vuelve a ser igual
-- al de producción (scripts/db/extraer-esquema.mjs + diff).
-- ============================================================================
alter table public.clubs drop constraint if exists clubs_cover_monto_coherente;
alter table public.clubs drop column if exists cover_monto;
alter table public.clubs drop column if exists cover_modo;
comment on column public.clubs.deposito_monto is null;
alter table public.clubs alter column deposito_monto set default 100;
