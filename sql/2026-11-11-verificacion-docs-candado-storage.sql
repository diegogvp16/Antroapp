-- ============================================================================
-- AntroApp — Candado RESTRICTIVO para el bucket 'verificacion-docs'
-- Fecha: 2026-11-11
--
-- Problema verificado con la prueba del 11/11/2026: CUALQUIER usuario con
-- sesión (otro dueño, un cliente) puede listar, descargar, firmar URL, subir
-- y BORRAR archivos de 'verificacion-docs' de cualquier antro. El anónimo no.
--
-- Causa probable: hay otra política PERMISIVA en storage.objects (seguramente
-- de 'club-photos') que no filtra por bucket_id. Las políticas permisivas se
-- suman con OR, así que las 4 de verificacion_docs_* no alcanzan a cerrar.
--
-- Arreglo: una política RESTRICTIVA. Las restrictivas se combinan con AND con
-- todas las demás, así que esta manda sin importar qué otras existan. Solo
-- afecta a 'verificacion-docs'; para cualquier otro bucket deja pasar.
--
-- Pega TODO de una vez.
--
-- Estado: YA APLICADO en producción el 11/11/2026, junto con el borrado de
-- las 3 políticas permisivas viejas que eran la causa (verif_docs_upload,
-- verif_docs_read y verif_docs_delete_own). Ese borrado se agrega abajo
-- para que quede registrado; el texto exacto que se corrió no se guardó,
-- pero el efecto es el mismo. Verificado después con sesiones reales:
-- solo el dueño de cada carpeta y el admin acceden al bucket.
-- ============================================================================

begin;

-- Políticas viejas, demasiado abiertas (dejaban a cualquier usuario con
-- sesión leer, subir y borrar en todo el bucket).
drop policy if exists verif_docs_upload     on storage.objects;
drop policy if exists verif_docs_read       on storage.objects;
drop policy if exists verif_docs_delete_own on storage.objects;

drop policy if exists verificacion_docs_restrictiva on storage.objects;

create policy verificacion_docs_restrictiva on storage.objects
  as restrictive
  for all
  to public
  using (
    bucket_id <> 'verificacion-docs'
    or (select public.current_role_name()) = 'admin'
    or (storage.foldername(name))[1] in (
      select c.id::text from public.clubs c
      where c.dueno_id = (select auth.uid())
    )
  )
  with check (
    bucket_id <> 'verificacion-docs'
    or (select public.current_role_name()) = 'admin'
    or (storage.foldername(name))[1] in (
      select c.id::text from public.clubs c
      where c.dueno_id = (select auth.uid())
    )
  );

commit;

-- ============================================================================
-- DIAGNÓSTICO (córrelo después y pásame el resultado)
-- Muestra TODAS las políticas de storage.objects, para encontrar la que deja
-- pasar a cualquiera. Probablemente también afecta a 'club-photos'.
-- ============================================================================
select policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
order by permissive, policyname;
