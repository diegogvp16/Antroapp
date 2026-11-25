-- ============================================================================
-- AntroApp — Dueño válido para crear y editar antros, documentos y archivos
-- Fecha: 2026-11-25 (rama c-rls, auditoría de RLS)
-- Estado: APLICADO Y PROBADO EN DEV (scripts/dev/auditoria-rls.mjs). En producción NO.
-- Rollback: sql/post-junta-2/62-clubs-dueno-valido-rollback.sql
--
-- Hallazgos (probados con sesión real en dev):
--  1. "clubs insert dueno o admin" solo pide dueno_id = auth.uid(): un
--     CLIENTE, un RP o un staff crean un antro a su nombre directo contra la
--     API (nace en borrador por clubs_candado_insert). Con eso pasan a ser
--     "dueños" (club_es_dueno) de ese antro: suben archivos al bucket público
--     club-photos y mandan documentos de verificación. También en
--     PRODUCCIÓN (misma política). Medio-bajo.
--  2. Un dueño que ya tiene antro crea un segundo antro directo contra la API
--     y rompe su propio /dueno/panel (.maybeSingle) y current_club_id()
--     (deuda 6 de CLAUDE.md). También en PRODUCCIÓN.
--  3. Un dueño con contraseña temporal sin cambiar (alta de antros) edita su
--     antro, sube fotos y documentos y crea otro antro: las políticas de
--     clubs, club_photos, verificacion_documentos y las restrictivas de
--     Storage comparan dueno_id = auth.uid() sin pasar por el rol. Lo mismo
--     un dueño dado de baja (activo = false). Solo post-junta (no aplica a
--     producción hasta que haya contraseñas temporales).
--
-- Arreglo:
--  * INSERT en clubs: admin, o un perfil con rol "dueno" (activo y sin
--    contraseña temporal) a su nombre y SIN otro antro. El auto-registro
--    (/dueno/signup y /api/auth/registro) crea el perfil dueño y luego el
--    antro: sigue funcionando. DECISIÓN para Diego: "un dueño, un antro" en
--    la base (los dueños con varios antros van por grupos y el alta del
--    admin, que no pasa por esta política).
--  * UPDATE en clubs, fotos y documentos: club_es_dueno() (exige rol), que
--    ya usan las funciones nuevas.
--  * Storage: las 4 restrictivas exigen además current_role_name() no nulo.
-- El admin se lee con current_role_name() (respeta baja y contraseña
-- temporal), ya no con "exists profiles role = admin".
-- ============================================================================

create or replace function public.dueno_tiene_club()
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  select exists (select 1 from public.clubs c where c.dueno_id = auth.uid());
$function$;
revoke all on function public.dueno_tiene_club() from public, anon;
grant execute on function public.dueno_tiene_club() to authenticated, service_role;

alter policy "clubs insert dueno o admin" on public.clubs
  with check (coalesce((select public.current_role_name()) = 'admin', false)
    or (dueno_id = (select auth.uid())
        and coalesce((select public.current_role_name()) = 'dueno', false)
        and not (select public.dueno_tiene_club())));

alter policy "clubs update dueno o admin" on public.clubs
  using (coalesce((select public.current_role_name()) = 'admin', false) or public.club_es_dueno(id))
  with check (coalesce((select public.current_role_name()) = 'admin', false) or (dueno_id = (select auth.uid()) and public.club_es_dueno(id)));

alter policy club_photos_insert_dueno on public.club_photos
  with check (public.club_es_dueno(club_id) or coalesce((select public.current_role_name()) = 'admin', false));
alter policy club_photos_delete_dueno on public.club_photos
  using (public.club_es_dueno(club_id) or coalesce((select public.current_role_name()) = 'admin', false));

alter policy verif_docs_insert on public.verificacion_documentos
  with check (public.club_es_dueno(club_id));
alter policy verif_docs_select on public.verificacion_documentos
  using (public.club_es_dueno(club_id) or coalesce((select public.current_role_name()) = 'admin', false));

alter policy club_photos_restrictiva_insert on storage.objects
  with check (bucket_id <> 'club-photos' or coalesce((select public.current_role_name()) = 'admin', false) or ((select public.current_role_name()) is not null and (storage.foldername(name))[1] in (select c.id::text from public.clubs c where c.dueno_id = (select auth.uid()))));
alter policy club_photos_restrictiva_update on storage.objects
  using (bucket_id <> 'club-photos' or coalesce((select public.current_role_name()) = 'admin', false) or ((select public.current_role_name()) is not null and (storage.foldername(name))[1] in (select c.id::text from public.clubs c where c.dueno_id = (select auth.uid()))))
  with check (bucket_id <> 'club-photos' or coalesce((select public.current_role_name()) = 'admin', false) or ((select public.current_role_name()) is not null and (storage.foldername(name))[1] in (select c.id::text from public.clubs c where c.dueno_id = (select auth.uid()))));
alter policy club_photos_restrictiva_delete on storage.objects
  using (bucket_id <> 'club-photos' or coalesce((select public.current_role_name()) = 'admin', false) or ((select public.current_role_name()) is not null and (storage.foldername(name))[1] in (select c.id::text from public.clubs c where c.dueno_id = (select auth.uid()))));
alter policy verificacion_docs_restrictiva on storage.objects
  using (bucket_id <> 'verificacion-docs' or coalesce((select public.current_role_name()) = 'admin', false) or ((select public.current_role_name()) is not null and (storage.foldername(name))[1] in (select c.id::text from public.clubs c where c.dueno_id = (select auth.uid()))))
  with check (bucket_id <> 'verificacion-docs' or coalesce((select public.current_role_name()) = 'admin', false) or ((select public.current_role_name()) is not null and (storage.foldername(name))[1] in (select c.id::text from public.clubs c where c.dueno_id = (select auth.uid()))));
