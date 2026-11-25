-- ============================================================================
-- AntroApp — C7 parte 2 (noche 3): políticas de caja que se calculan una vez
-- por consulta, y caja_firma_noche sin RLS fila por fila
-- Fecha: 2026-11-25. Rollback: sql/post-junta-2/71-caja-politicas-rapidas-rollback.sql
-- Prueba (dev): node scripts/dev/probar-caja-politicas-rapidas.mjs
--
-- 1) Las 17 políticas de SELECT de caja (y productos de fase 2) decían
--    using ((select public.caja_puede_ver(club_id))). Como club_id es columna
--    de la fila, eso es un SubPlan correlacionado: la función corre por cada
--    fila y dos veces (permisiva y restrictiva). Medido en dev: consumos de
--    una noche con 50 renglones 58 ms con RLS contra 0.09 ms sin RLS.
--    Ahora: club_id in (select public.caja_clubs_visibles()), un conjunto que
--    no depende de la fila y Postgres calcula UNA vez por consulta (hashed
--    SubPlan). caja_clubs_visibles aplica exactamente las mismas reglas que
--    caja_puede_ver (admin; dueño; dueño de grupo; staff o gerente activo de
--    su antro; cuenta con contraseña temporal sin rol: nada). caja_puede_ver
--    se queda igual para las funciones de escritura.
-- 2) caja_firma_noche (la consulta cada 10 s cada dispositivo con la caja
--    abierta) corría con los permisos de quien llama, aplicando RLS fila por
--    fila en 6 tablas. Ahora es SECURITY DEFINER: autoriza UNA vez al inicio
--    con caja_puede_ver (sin permiso devuelve NULL, igual que antes cuando RLS
--    ocultaba todo) y lee sin RLS. Mismo resultado para quien sí puede ver.
-- ============================================================================
begin;

create or replace function public.caja_clubs_visibles()
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_rol text := public.current_role_name();
  v_club uuid;
begin
  if v_uid is null or v_rol is null then
    return;
  end if;
  if v_rol = 'admin' then
    return query select c.id from public.clubs c;
    return;
  end if;
  return query select c.id from public.clubs c where c.dueno_id = v_uid;
  return query
    select gc.club_id
      from public.grupo_miembros m
      join public.grupo_clubs gc on gc.grupo_id = m.grupo_id
     where m.profile_id = v_uid and m.rol_grupo = 'dueno_grupo';
  if v_rol in ('staff', 'gerente')
     and not exists (select 1 from public.profiles p where p.id = v_uid and p.activo is false) then
    v_club := public.current_club_id();
    if v_club is not null then
      return next v_club;
    end if;
  end if;
end;
$$;
revoke all on function public.caja_clubs_visibles() from public, anon;
grant execute on function public.caja_clubs_visibles() to authenticated, service_role;

do $$
declare
  t text;
begin
  foreach t in array array['caja_consumos', 'caja_cuadres', 'caja_eventos', 'caja_noches', 'caja_pagos', 'caja_permisos', 'mesa_cuentas', 'mesa_sesiones'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (club_id in (select public.caja_clubs_visibles()))', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_restrictiva_select', t);
    execute format('create policy %I on public.%I as restrictive for select to public using (club_id in (select public.caja_clubs_visibles()))', t || '_restrictiva_select', t);
  end loop;
  -- productos (fase 2): solo existe si se aplicó el SQL de inventario.
  if to_regclass('public.productos') is not null then
    execute 'drop policy if exists productos_select on public.productos';
    execute 'create policy productos_select on public.productos for select to authenticated using (club_id in (select public.caja_clubs_visibles()))';
  end if;
end $$;

-- caja_firma_noche: mismo cálculo, ahora SECURITY DEFINER y con la
-- autorización UNA vez al inicio. Sin permiso devuelve NULL. create or
-- replace conserva los permisos (authenticated sí, anon no).
create or replace function public.caja_firma_noche(p_club_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when coalesce(public.caja_puede_ver(p_club_id), false) then (
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
    ))
  ) end;
$$;
revoke all on function public.caja_firma_noche(uuid) from public, anon;
grant execute on function public.caja_firma_noche(uuid) to authenticated;

commit;
