-- ============================================================================
-- Rollback de sql/post-junta-3/70-reportes-pdf.sql
-- Solo quita las 3 funciones (no hay tablas ni datos). La pantalla
-- /grupo/reportes muestra "todavía no está disponible" si faltan.
-- ============================================================================
begin;

drop function if exists public.reporte_pdf_semana(uuid, date);
drop function if exists public.reporte_pdf_noche(uuid, date);
drop function if exists public.reporte_pdf_autorizar(uuid);

commit;
