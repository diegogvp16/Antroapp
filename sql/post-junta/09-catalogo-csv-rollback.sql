-- Rollback de sql/post-junta/09-catalogo-csv.sql (no borra productos).
drop function if exists public.producto_importar(uuid, jsonb);
