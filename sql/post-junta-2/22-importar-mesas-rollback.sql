-- Rollback de sql/post-junta-2/22-importar-mesas.sql.
-- Quita la función de importar y el índice único. No toca ninguna mesa.
drop function if exists public.mesas_importar(uuid, jsonb);
drop index if exists public.club_tables_numero_unico;

notify pgrst, 'reload schema';
