-- Rollback de sql/post-junta-2/71-caja-politicas-rapidas.sql: políticas de caja
-- con caja_puede_ver(club_id) por fila y caja_firma_noche con los permisos de
-- quien llama (las versiones de sql/2026-11-20-caja-por-mesa.sql,
-- sql/2026-11-21-caja-idempotencia.sql y de la fase 2).
begin;

do $$
declare
  t text;
begin
  foreach t in array array['caja_consumos', 'caja_cuadres', 'caja_eventos', 'caja_noches', 'caja_pagos', 'caja_permisos', 'mesa_cuentas', 'mesa_sesiones'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.caja_puede_ver(club_id)))', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_restrictiva_select', t);
    execute format('create policy %I on public.%I as restrictive for select to public using ((select public.caja_puede_ver(club_id)))', t || '_restrictiva_select', t);
  end loop;
  if to_regclass('public.productos') is not null then
    execute 'drop policy if exists productos_select on public.productos';
    execute 'create policy productos_select on public.productos for select to authenticated using ((select public.caja_puede_ver(club_id)))';
  end if;
end $$;

create or replace function public.caja_firma_noche(p_club_id uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  with f as (
    select public.club_fecha_operacion(p_club_id) as fecha
  ), n as (
    select id, estado from public.caja_noches
    where club_id = p_club_id and fecha_operacion = (select fecha from f)
  )
  select md5(concat_ws('|',
    (select fecha::text from f),
    (select id::text || estado from n),
    (select count(*) || ':' || count(*) filter (where anulado) || ':' || coalesce(max(registrado_en)::text, '') || ':' || coalesce(max(anulado_en)::text, '')
       from public.caja_consumos where noche_id = (select id from n)),
    (select count(*) || ':' || count(*) filter (where anulado) || ':' || coalesce(max(registrado_en)::text, '') || ':' || coalesce(max(anulado_en)::text, '')
       from public.caja_pagos where noche_id = (select id from n)),
    (select coalesce(string_agg(id::text || estado, ',' order by id), '')
       from public.mesa_sesiones where noche_id = (select id from n)),
    (select count(*) || ':' || coalesce(max(c.creada_en)::text, '')
       from public.mesa_cuentas c join public.mesa_sesiones s on s.id = c.sesion_id where s.noche_id = (select id from n)),
    (select count(*)::text from public.caja_cuadres where noche_id = (select id from n)),
    (select count(*) || ':' || coalesce(max(entrada_en)::text, '')
       from public.reservations
       where club_id = p_club_id and fecha = (select fecha from f) and (status = 'usada' or puerta_estado = 'entro')),
    (select count(*)::text from public.club_tables where club_id = p_club_id)
  ));
$$;

drop function if exists public.caja_clubs_visibles();

commit;
