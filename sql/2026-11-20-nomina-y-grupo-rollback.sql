-- ============================================================================
-- ROLLBACK de sql/2026-11-20-nomina-y-grupo.sql
-- Vuelve a la nómina de sql/2026-11-20-caja-por-mesa.sql (pendiente/pagada)
-- y quita el panel de grupo. Las comisiones y pagos conservan su status
-- actual (en_revision/validada/anulada siguen siendo válidos en commissions).
-- ============================================================================
drop function if exists public.grupo_resumen(date, date);
drop function if exists public.nomina_cambiar_estado(uuid, uuid, int, int, text, text, text);
drop function if exists public.nomina_transicion_valida(text, text);
drop function if exists public.nomina_semana(uuid, int, int);
drop function if exists public.nomina_semana_mia(int, int);
drop function if exists public.nomina_semana_datos(uuid, date, uuid);
drop function if exists public.nomina_marcar_pagada(uuid, uuid, int, int);

alter table public.rp_pagos_dia drop constraint if exists rp_pagos_dia_status_check;
alter table public.rp_pagos_dia
  drop column if exists estado_cambiado_en,
  drop column if exists estado_cambiado_por,
  drop column if exists motivo_anulacion;
alter table public.commissions
  drop column if exists estado_cambiado_en,
  drop column if exists estado_cambiado_por,
  drop column if exists motivo_anulacion;

create or replace function public.nomina_semana_datos(p_club_id uuid, p_lunes date, p_rp_id uuid)
returns table (
  rp_id                       uuid,
  rp_nombre                   text,
  rp_activo                   boolean,
  reservas_entraron           int,
  comisiones                  int,
  comision_pendiente_centavos bigint,
  comision_pagada_centavos    bigint,
  dias_asistidos              int,
  dia_pendiente_centavos      bigint,
  dia_pagada_centavos         bigint,
  total_pendiente_centavos    bigint,
  total_pagado_centavos       bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with
  com as (
    select c.rp_id,
           count(*)::int as n,
           coalesce(sum(round(c.monto * 100)) filter (where c.status <> 'pagada'), 0)::bigint as pend,
           coalesce(sum(round(c.monto * 100)) filter (where c.status = 'pagada'), 0)::bigint as pag
    from public.commissions c
    join public.reservations r on r.id = c.reservation_id
    where c.tipo = 'rp' and r.club_id = p_club_id and c.status <> 'anulada'
      and r.fecha between p_lunes and p_lunes + 6
    group by c.rp_id
  ),
  dia as (
    select d.rp_id,
           count(*)::int as n,
           coalesce(sum(round(d.monto * 100)) filter (where d.status <> 'pagada'), 0)::bigint as pend,
           coalesce(sum(round(d.monto * 100)) filter (where d.status = 'pagada'), 0)::bigint as pag
    from public.rp_pagos_dia d
    where d.club_id = p_club_id and d.status <> 'anulada' and d.fecha between p_lunes and p_lunes + 6
    group by d.rp_id
  ),
  res as (
    select r.rp_id,
           count(*) filter (where coalesce(r.puerta_estado, case when r.status = 'usada' then 'entro' end)
                                  is not distinct from 'entro')::int as entraron
    from public.reservations r
    where r.club_id = p_club_id and r.source = 'rp' and r.rp_id is not null
      and r.fecha between p_lunes and p_lunes + 6
    group by r.rp_id
  ),
  rps as (
    select p.id from public.profiles p where p.role = 'rp' and p.club_id = p_club_id
    union select com.rp_id from com
    union select dia.rp_id from dia
    union select res.rp_id from res
  )
  select rps.id,
         p.nombre,
         coalesce(p.activo, true),
         coalesce(res.entraron, 0),
         coalesce(com.n, 0),
         coalesce(com.pend, 0),
         coalesce(com.pag, 0),
         coalesce(dia.n, 0),
         coalesce(dia.pend, 0),
         coalesce(dia.pag, 0),
         coalesce(com.pend, 0) + coalesce(dia.pend, 0),
         coalesce(com.pag, 0) + coalesce(dia.pag, 0)
  from rps
  left join public.profiles p on p.id = rps.id
  left join com on com.rp_id = rps.id
  left join dia on dia.rp_id = rps.id
  left join res on res.rp_id = rps.id
  where rps.id is not null
    and (p_rp_id is null or rps.id = p_rp_id)
  order by p.nombre;
$$;

create or replace function public.nomina_semana(p_club_id uuid, p_anio int, p_semana int)
returns table (
  rp_id uuid, rp_nombre text, rp_activo boolean, reservas_entraron int,
  comisiones int, comision_pendiente_centavos bigint, comision_pagada_centavos bigint,
  dias_asistidos int, dia_pendiente_centavos bigint, dia_pagada_centavos bigint,
  total_pendiente_centavos bigint, total_pagado_centavos bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (public.es_gerente_o_dueno(p_club_id) or public.club_es_dueno_grupo(p_club_id)) then
    raise exception 'Solo el gerente o el dueño ven la nómina';
  end if;
  return query
    select * from public.nomina_semana_datos(p_club_id, public.nomina_lunes_iso(p_anio, p_semana), null);
end;
$$;

create or replace function public.nomina_semana_mia(p_anio int, p_semana int)
returns table (
  rp_id uuid, rp_nombre text, rp_activo boolean, reservas_entraron int,
  comisiones int, comision_pendiente_centavos bigint, comision_pagada_centavos bigint,
  dias_asistidos int, dia_pendiente_centavos bigint, dia_pagada_centavos bigint,
  total_pendiente_centavos bigint, total_pagado_centavos bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.current_club_id();
begin
  if auth.uid() is null or public.current_role_name() is distinct from 'rp' or v_club is null then
    raise exception 'Solo para RPs';
  end if;
  if exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo is false) then
    raise exception 'Tu cuenta está desactivada';
  end if;
  return query
    select * from public.nomina_semana_datos(v_club, public.nomina_lunes_iso(p_anio, p_semana), auth.uid());
end;
$$;

create or replace function public.nomina_marcar_pagada(p_club_id uuid, p_rp_id uuid, p_anio int, p_semana int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lunes date := public.nomina_lunes_iso(p_anio, p_semana);
  v_com int;
  v_dia int;
begin
  if not public.es_gerente_o_dueno(p_club_id) then
    raise exception 'Solo el gerente o el dueño marcan la nómina como pagada';
  end if;

  with marcadas as (
    update public.commissions c
    set status = 'pagada', pagada_en = now(), pagada_por = auth.uid(), updated_at = now()
    from public.reservations r
    where r.id = c.reservation_id
      and c.tipo = 'rp' and c.rp_id = p_rp_id and c.status not in ('pagada', 'anulada')
      and r.club_id = p_club_id and r.fecha between v_lunes and v_lunes + 6
    returning c.id
  )
  select count(*) into v_com from marcadas;

  with marcadas as (
    update public.rp_pagos_dia d
    set status = 'pagada', pagada_en = now(), pagada_por = auth.uid()
    where d.rp_id = p_rp_id and d.club_id = p_club_id and d.status not in ('pagada', 'anulada')
      and d.fecha between v_lunes and v_lunes + 6
    returning d.id
  )
  select count(*) into v_dia from marcadas;

  perform public.caja_evento(p_club_id, null, null, 'nomina_marcar_pagada',
    jsonb_build_object('rp_id', p_rp_id, 'anio', p_anio, 'semana', p_semana,
                       'comisiones', v_com, 'pagos_dia', v_dia));
  return jsonb_build_object('comisiones', v_com, 'pagos_dia', v_dia);
end;
$$;

revoke all on function public.nomina_semana_datos(uuid, date, uuid) from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'public.nomina_semana(uuid, int, int)',
    'public.nomina_semana_mia(int, int)',
    'public.nomina_marcar_pagada(uuid, uuid, int, int)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
