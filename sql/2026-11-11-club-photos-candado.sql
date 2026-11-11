-- ============================================================================
-- AntroApp — Cerrar escritura del bucket 'club-photos'
-- Fecha: 2026-11-11
-- Estado: YA APLICADO en producción.
--
-- ⚠ NOTA (11/11/2026): este SQL SOLO NO BASTÓ. Después de aplicarlo, con
-- sesiones reales, anónimo, cliente y dueño ajeno todavía podían subir y
-- borrar en la carpeta de otro club, porque las políticas abiertas
-- club_photos_storage_insert_open / _delete_open seguían existiendo (las
-- permisivas se suman con OR). Se cerró agregando tres políticas
-- RESTRICTIVAS (club_photos_restrictiva_insert, _update y _delete), cuyo
-- SQL no está en este archivo. Reprobado el mismo día: cerrado.
--
-- Problema verificado el 11/11/2026 con sesiones reales: en 'club-photos'
-- CUALQUIERA (anónimo, cliente, dueño de otro antro) puede subir archivos a
-- la carpeta de cualquier antro y BORRAR sus fotos. Causa: las políticas
-- club_photos_storage_insert_open y club_photos_storage_delete_open están
-- dadas al rol {public}, que incluye anónimos.
--
-- Lo que usa el código (app/dueno/panel/page.tsx, handleUploadPhotos y
-- handleDeletePhoto):
--   * Sube con  storage.from('club-photos').upload(`${club.id}/${uuid}-${nombre}`)
--     -> la primera carpeta del path es SIEMPRE el club_id.
--   * Borra con storage.from('club-photos').remove([photo.storage_path]).
--   * Nunca usa update/upsert, así que no hace falta política de UPDATE.
--   * Solo el panel del DUEÑO sube y borra fotos; staff, gerente y admin no
--     tienen pantalla para eso hoy.
--
-- Estado real del bucket (leído con service role el 11/11/2026):
--   * 5 carpetas, una por antro existente, 3 archivos cada una (15 total).
--   * 15 filas en club_photos; las 15 tienen storage_path que empieza con
--     "{club_id}/" de su propio club; 0 archivos sin fila; 0 filas sin
--     archivo; 0 archivos sueltos en la raíz.
--   => NO hace falta migrar nada: todas las fotos ya están en la carpeta de
--      su club, así que las políticas de abajo no le quitan el acceso a
--      ningún dueño sobre sus fotos actuales.
--
-- Pega TODO de una vez (una sola transacción).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- PASO 0 — DIAGNÓSTICO (solo lectura). Córrelo antes y guarda la salida.
-- ----------------------------------------------------------------------------
select policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
order by permissive, policyname;
-- Revisa que NO haya otra política permisiva (aparte de las 3 de
-- club-photos) cuyo qual/with_check no filtre por bucket_id: esa abriría
-- también este bucket (las permisivas se suman con OR).


-- ----------------------------------------------------------------------------
-- PASO 1 — Reemplazo de políticas
-- ----------------------------------------------------------------------------
begin;

drop policy if exists club_photos_storage_insert_open   on storage.objects;
drop policy if exists club_photos_storage_delete_open   on storage.objects;
drop policy if exists club_photos_storage_select_public on storage.objects;

-- Lectura pública: es el catálogo. (Las URL públicas del bucket funcionan
-- sin política; esta además permite listar y descargar por la API, como hoy.)
create policy club_photos_select_publico on storage.objects
  for select to public
  using (bucket_id = 'club-photos');

-- Subir: solo el dueño del antro dueño de la carpeta, o el admin.
create policy club_photos_insert_dueno_o_admin on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'club-photos'
    and (
      (select public.current_role_name()) = 'admin'
      or (storage.foldername(name))[1] in (
        select c.id::text from public.clubs c
        where c.dueno_id = (select auth.uid())
      )
    )
  );

-- Borrar: mismas reglas.
create policy club_photos_delete_dueno_o_admin on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'club-photos'
    and (
      (select public.current_role_name()) = 'admin'
      or (storage.foldername(name))[1] in (
        select c.id::text from public.clubs c
        where c.dueno_id = (select auth.uid())
      )
    )
  );

commit;


-- ----------------------------------------------------------------------------
-- PASO 2 — VERIFICACIÓN
-- ----------------------------------------------------------------------------
select policyname, permissive, roles, cmd
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname like 'club_photos_%'
order by policyname;
-- Esperado: 3 filas: club_photos_delete_dueno_o_admin (DELETE),
-- club_photos_insert_dueno_o_admin (INSERT), club_photos_select_publico (SELECT).
-- Después, Claude repite la matriz de la tarea 0 (anónimo, cliente, dueño
-- ajeno, dueño, admin) para confirmar.


-- ----------------------------------------------------------------------------
-- NOTA — Migración de carpetas: NO aplica hoy.
-- Si en el futuro aparecen fotos fuera de "{club_id}/", el diagnóstico es:
--   select id, club_id, storage_path from public.club_photos
--   where storage_path not like club_id::text || '/%';
-- y la migración sería, por cada fila: copiar el objeto a
-- "{club_id}/{nombre}" con service role (storage.from('club-photos').move),
-- actualizar club_photos.storage_path y club_photos.url, y borrar el viejo.
-- Se hace desde un script con service role, no desde SQL (mover objetos de
-- Storage con SQL deja el archivo físico donde estaba).
-- ----------------------------------------------------------------------------
