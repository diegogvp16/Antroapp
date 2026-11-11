-- ============================================================================
-- AntroApp — Verificación de antros: bucket privado + candado de estado
-- Fecha: 2026-10-27
--
-- Contexto verificado contra la base antes de escribir esto:
--   * Las columnas clubs.estado_verificacion / motivo_rechazo / verificado_en
--     y la tabla verificacion_documentos SÍ existen, con RLS correcta.
--   * El bucket 'verificacion-docs' NO existe (solo está 'club-photos').
--   * Un dueño puede hoy hacer UPDATE clubs SET estado_verificacion =
--     'verificado' sobre su propio antro y la base lo acepta. Eso anula la
--     revisión. La PARTE 3 lo cierra.
--
-- Pega TODO el archivo de una vez: va en una sola transacción.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- PARTE 1 — Bucket PRIVADO
-- ----------------------------------------------------------------------------
-- public = false: los archivos no tienen URL pública; solo se leen con una
-- URL firmada (createSignedUrl) o con el service role.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'verificacion-docs',
  'verificacion-docs',
  false,
  10485760, -- 10 MB, igual que valida el cliente
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


-- ----------------------------------------------------------------------------
-- PARTE 2 — Políticas del bucket
-- Los archivos viven en `{club_id}/{tipo}-{uuid}.{ext}`: la primera carpeta
-- del path es el club, y con eso se decide de quién es cada archivo.
-- ----------------------------------------------------------------------------
drop policy if exists verificacion_docs_insert_dueno on storage.objects;
drop policy if exists verificacion_docs_select_dueno on storage.objects;
drop policy if exists verificacion_docs_delete_dueno on storage.objects;
drop policy if exists verificacion_docs_select_admin on storage.objects;

-- El dueño sube solo dentro de la carpeta de SU antro.
create policy verificacion_docs_insert_dueno on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'verificacion-docs'
    and (storage.foldername(name))[1] in (
      select c.id::text from public.clubs c
      where c.dueno_id = (select auth.uid())
    )
  );

-- El dueño ve lo de su antro (para createSignedUrl, si después se usa).
create policy verificacion_docs_select_dueno on storage.objects
  for select to authenticated
  using (
    bucket_id = 'verificacion-docs'
    and (storage.foldername(name))[1] in (
      select c.id::text from public.clubs c
      where c.dueno_id = (select auth.uid())
    )
  );

-- El dueño puede borrar lo de su antro. Lo usa el panel para limpiar un
-- archivo cuando la fila de verificacion_documentos no se pudo guardar.
create policy verificacion_docs_delete_dueno on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'verificacion-docs'
    and (storage.foldername(name))[1] in (
      select c.id::text from public.clubs c
      where c.dueno_id = (select auth.uid())
    )
  );

-- El admin revisa todo.
create policy verificacion_docs_select_admin on storage.objects
  for select to authenticated
  using (
    bucket_id = 'verificacion-docs'
    and (select public.current_role_name()) = 'admin'
  );


-- ----------------------------------------------------------------------------
-- PARTE 3 — Candado del estado de verificación
-- RLS no puede comparar el valor viejo contra el nuevo, así que va en un
-- trigger. Fuera del admin (y del service role), la ÚNICA transición
-- permitida es la que hace el botón "Enviar a revisión":
--     borrador | rechazado  ->  en_revision
-- y solo si ya están los dos documentos requeridos.
-- ----------------------------------------------------------------------------
create or replace function public.clubs_candado_verificacion()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Service role (auth.uid() nulo) y admin: sin restricción.
  if auth.uid() is null or public.current_role_name() = 'admin' then
    return new;
  end if;

  if new.verificado_en is distinct from old.verificado_en
     or new.motivo_rechazo is distinct from old.motivo_rechazo then
    raise exception 'Solo AntroApp puede aprobar o rechazar una verificación.';
  end if;

  if new.estado_verificacion is not distinct from old.estado_verificacion then
    return new;
  end if;

  if not (old.estado_verificacion in ('borrador', 'rechazado')
          and new.estado_verificacion = 'en_revision') then
    raise exception 'No puedes cambiar la verificación de % a %.',
      old.estado_verificacion, new.estado_verificacion;
  end if;

  if not exists (
       select 1 from public.verificacion_documentos
       where club_id = new.id and tipo = 'comprobante_fiscal')
     or not exists (
       select 1 from public.verificacion_documentos
       where club_id = new.id and tipo = 'foto_local') then
    raise exception 'Faltan documentos requeridos para enviar a revisión.';
  end if;

  return new;
end $$;

drop trigger if exists clubs_candado_verificacion on public.clubs;
create trigger clubs_candado_verificacion
  before update on public.clubs
  for each row execute function public.clubs_candado_verificacion();

commit;


-- ============================================================================
-- VERIFICACIÓN (córrelo después)
-- ============================================================================
select id, public, file_size_limit from storage.buckets where id = 'verificacion-docs';
-- Esperado: 1 fila, public = false.

select policyname, cmd from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname like 'verificacion_docs_%'
order by policyname;
-- Esperado: 4 políticas.
