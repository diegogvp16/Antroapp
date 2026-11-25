-- ============================================================================
-- AntroApp — Límites del bucket público club-photos
-- Fecha: 2026-11-25 (rama c-rls, auditoría de RLS)
-- Estado: APLICADO Y PROBADO EN DEV (scripts/dev/auditoria-rls.mjs). En producción NO.
-- Rollback: sql/post-junta-2/63-bucket-fotos-limites-rollback.sql
--
-- Hallazgo (también en PRODUCCIÓN, el bucket es igual: sin límite de tamaño
-- ni de tipo): un dueño (y hoy, sin el 62, cualquier cliente o RP que se
-- crea un antro) sube al bucket PÚBLICO cualquier archivo de cualquier
-- tamaño: probado en dev con un HTML (Supabase lo sirve como text/plain, así
-- que no ejecuta script) y un archivo de 11 MB. Es hosting gratis a costa
-- del proyecto y contenido arbitrario con la URL de AntroApp.
--
-- Arreglo: 10 MB como verificacion-docs y solo imágenes de foto (sin SVG,
-- que puede llevar script). /dueno/panel revisa los mismos límites antes de
-- subir (lib/fotos-club.ts: misma lista en accept, tope de 10 MB y un aviso
-- con el motivo); si cambian aquí, cambiar también allá.
-- DECISIÓN para Diego: el tope de 10 MB (fotos de celular: 2–8 MB).
-- Los archivos que ya están no se tocan: el límite aplica al subir.
-- ============================================================================

update storage.buckets
set file_size_limit = 10485760,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif', 'image/gif']
where id = 'club-photos';
