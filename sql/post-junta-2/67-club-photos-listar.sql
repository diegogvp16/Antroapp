-- ============================================================================
-- AntroApp — club-photos: nadie lista ni lee por la API las carpetas de un
-- antro que no puede ver
-- Fecha: 2026-11-25 (rama c-rls, corrección de la revisión del carril)
-- Estado: APLICADO Y PROBADO EN DEV (scripts/dev/auditoria-rls.mjs). En producción NO.
-- Rollback: sql/post-junta-2/67-club-photos-listar-rollback.sql
-- Requiere: public.puede_ver_club(uuid) (sql/2026-11-20-caja-por-mesa.sql,
-- ya en producción desde el pase 1).
--
-- Hallazgo (también en PRODUCCIÓN: sql/esquema/esquema-prod.sql tiene la
-- permisiva club_photos_storage_select_public con
-- using (bucket_id = 'club-photos') para public): el ANÓNIMO lista el bucket
-- completo con storage.from('club-photos').list(''). Ve las carpetas, que son
-- el id del antro, también de antros NO publicados (borradores como Panic
-- Room), y dentro de ellas los nombres de las fotos, que llevan el nombre
-- original del archivo. Lo mismo un cliente o el dueño de otro antro. Probado
-- en dev: 4 carpetas, 2 de antros no publicados, con sus archivos.
--
-- Arreglo: una RESTRICTIVA de SELECT (se aplica con AND sobre la permisiva
-- abierta) para club-photos: pasa el admin, o la carpeta es de un antro que
-- quien llama puede ver (puede_ver_club: publicado, o su dueño, dueño de su
-- grupo, su staff/RPs). Una ruta sin carpeta de antro (archivo suelto en la
-- raíz) solo la ve el admin.
--
-- Lo que NO cambia:
--  * La galería: las URL públicas (/storage/v1/object/public/…) no pasan por
--    RLS. El catálogo y la ficha siguen mostrando las fotos.
--  * El dueño sigue subiendo y borrando: la carpeta es de su antro, así que
--    la fila nueva pasa este SELECT (el upload la regresa con RETURNING) y el
--    borrado la encuentra.
--  * verificacion-docs no se toca (bucket_id <> 'club-photos').
-- La subconsulta no depende de la fila: Postgres la calcula una vez por
-- consulta (un conjunto con los antros visibles), no una vez por archivo.
-- ============================================================================

create policy club_photos_restrictiva_select on storage.objects
  as restrictive for select to public
  using (
    bucket_id <> 'club-photos'
    or coalesce((select public.current_role_name()) = 'admin', false)
    or coalesce((storage.foldername(name))[1] in (
         select c.id::text from public.clubs c where public.puede_ver_club(c.id)
       ), false)
  );
