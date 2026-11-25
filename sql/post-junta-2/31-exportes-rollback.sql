-- Rollback de sql/post-junta-2/31-exportes.sql (exportables CSV, B4).
-- Solo quita las funciones de lectura; no hay datos que perder.
-- La pantalla de exportación dice "todavía no está disponible" sin ellas.
drop function if exists public.reporte_comisiones(uuid, date, date, text, integer);
drop function if exists public.reporte_consumos(uuid, date, date, text, integer);
drop function if exists public.reporte_reservas(uuid, date, date, text, integer);
drop function if exists public.reporte_exportes_info(uuid);
drop function if exists public.reporte_telefono(text, text);
drop function if exists public.reporte_exportes_autorizar(uuid, date, date, text);
drop function if exists public.reporte_nivel_exportes(uuid);
