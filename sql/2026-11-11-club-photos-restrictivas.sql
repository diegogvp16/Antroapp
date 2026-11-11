-- ============================================================================
-- AntroApp — club-photos: políticas RESTRICTIVAS de escritura
-- Fecha: 2026-11-11
-- Estado: YA APLICADO en producción (copia tal cual de lo que se corrió).
--
-- Qué cierra:
--   La escritura en el bucket 'club-photos' (subir, sobrescribir y borrar)
--   queda solo para el dueño del antro dueño de la carpeta ({club_id}/...)
--   o el admin, AUNQUE sigan existiendo políticas permisivas abiertas.
--
-- Por qué restrictivas:
--   Las políticas permisivas se suman con OR: con que una sola deje pasar,
--   pasa. Las viejas club_photos_storage_insert_open y
--   club_photos_storage_delete_open (rol public, incluye anónimos) siguen
--   existiendo y por eso sql/2026-11-11-club-photos-candado.sql solo no
--   bastó. Las restrictivas se aplican con AND sobre TODAS las demás, así
--   que mandan sin importar qué permisivas haya. Para cualquier otro bucket
--   dejan pasar (bucket_id <> 'club-photos').
--
-- La lectura no se toca: el bucket es público (catálogo).
--
-- Verificado el 11/11/2026 con sesiones reales: anónimo, cliente y dueño
-- ajeno no pueden subir, sobrescribir ni borrar en la carpeta de otro club;
-- el dueño sí desde /dueno/panel; el admin sí; la lectura pública y las
-- fotos del listado y de la ficha siguen funcionando.
-- ============================================================================

create policy club_photos_restrictiva_insert on storage.objects
  as restrictive for insert to public
  with check (
    bucket_id <> 'club-photos'
    or (select public.current_role_name()) = 'admin'
    or (storage.foldername(name))[1] in (
      select c.id::text from public.clubs c
      where c.dueno_id = (select auth.uid())
    )
  );

create policy club_photos_restrictiva_delete on storage.objects
  as restrictive for delete to public
  using (
    bucket_id <> 'club-photos'
    or (select public.current_role_name()) = 'admin'
    or (storage.foldername(name))[1] in (
      select c.id::text from public.clubs c
      where c.dueno_id = (select auth.uid())
    )
  );

create policy club_photos_restrictiva_update on storage.objects
  as restrictive for update to public
  using (
    bucket_id <> 'club-photos'
    or (select public.current_role_name()) = 'admin'
    or (storage.foldername(name))[1] in (
      select c.id::text from public.clubs c
      where c.dueno_id = (select auth.uid())
    )
  )
  with check (
    bucket_id <> 'club-photos'
    or (select public.current_role_name()) = 'admin'
    or (storage.foldername(name))[1] in (
      select c.id::text from public.clubs c
      where c.dueno_id = (select auth.uid())
    )
  );
