-- ============================================================================
-- AntroApp — Rollback de 62-clubs-dueno-valido.sql
-- Fecha: 2026-11-25 (rama c-rls). Regresa las expresiones exactas de antes
-- (tomadas de pg_policies en dev). Vuelve a abrir los huecos del 62.
-- ============================================================================

alter policy "clubs insert dueno o admin" on public.clubs
  with check ((dueno_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));

-- La política original de UPDATE no tenía WITH CHECK: se recrea igual.
drop policy "clubs update dueno o admin" on public.clubs;
create policy "clubs update dueno o admin" on public.clubs as permissive for update to authenticated
  using ((dueno_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));

alter policy club_photos_insert_dueno on public.club_photos
  with check ((EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = club_photos.club_id) AND (c.dueno_id = auth.uid())))) OR (current_role_name() = 'admin'::text));
alter policy club_photos_delete_dueno on public.club_photos
  using ((EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = club_photos.club_id) AND (c.dueno_id = auth.uid())))) OR (current_role_name() = 'admin'::text));

alter policy verif_docs_insert on public.verificacion_documentos
  with check ((EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = verificacion_documentos.club_id) AND (c.dueno_id = ( SELECT auth.uid() AS uid))))));
alter policy verif_docs_select on public.verificacion_documentos
  using (((EXISTS ( SELECT 1
   FROM clubs c
  WHERE ((c.id = verificacion_documentos.club_id) AND (c.dueno_id = ( SELECT auth.uid() AS uid))))) OR (( SELECT current_role_name() AS current_role_name) = 'admin'::text)));

alter policy club_photos_restrictiva_insert on storage.objects
  with check (((bucket_id <> 'club-photos'::text) OR (( SELECT current_role_name() AS current_role_name) = 'admin'::text) OR ((storage.foldername(name))[1] IN ( SELECT (c.id)::text AS id
   FROM clubs c
  WHERE (c.dueno_id = ( SELECT auth.uid() AS uid))))));
alter policy club_photos_restrictiva_update on storage.objects
  using (((bucket_id <> 'club-photos'::text) OR (( SELECT current_role_name() AS current_role_name) = 'admin'::text) OR ((storage.foldername(name))[1] IN ( SELECT (c.id)::text AS id
   FROM clubs c
  WHERE (c.dueno_id = ( SELECT auth.uid() AS uid))))))
  with check (((bucket_id <> 'club-photos'::text) OR (( SELECT current_role_name() AS current_role_name) = 'admin'::text) OR ((storage.foldername(name))[1] IN ( SELECT (c.id)::text AS id
   FROM clubs c
  WHERE (c.dueno_id = ( SELECT auth.uid() AS uid))))));
alter policy club_photos_restrictiva_delete on storage.objects
  using (((bucket_id <> 'club-photos'::text) OR (( SELECT current_role_name() AS current_role_name) = 'admin'::text) OR ((storage.foldername(name))[1] IN ( SELECT (c.id)::text AS id
   FROM clubs c
  WHERE (c.dueno_id = ( SELECT auth.uid() AS uid))))));
alter policy verificacion_docs_restrictiva on storage.objects
  using (((bucket_id <> 'verificacion-docs'::text) OR (( SELECT current_role_name() AS current_role_name) = 'admin'::text) OR ((storage.foldername(name))[1] IN ( SELECT (c.id)::text AS id
   FROM clubs c
  WHERE (c.dueno_id = ( SELECT auth.uid() AS uid))))))
  with check (((bucket_id <> 'verificacion-docs'::text) OR (( SELECT current_role_name() AS current_role_name) = 'admin'::text) OR ((storage.foldername(name))[1] IN ( SELECT (c.id)::text AS id
   FROM clubs c
  WHERE (c.dueno_id = ( SELECT auth.uid() AS uid))))));

drop function if exists public.dueno_tiene_club();
