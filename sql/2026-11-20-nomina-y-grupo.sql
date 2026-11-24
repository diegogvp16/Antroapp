-- ============================================================================
-- AntroApp — Nómina semanal con estados y panel de grupo (bloque 4)
-- Fecha: 2026-11-20
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO, hasta el pase.
-- Requiere: sql/2026-11-20-caja-por-mesa.sql.
-- Rollback: sql/2026-11-20-nomina-y-grupo-rollback.sql.
--
-- Nómina: semana lunes a domingo por la NOCHE de la reserva (comisiones) o
-- de la asistencia (pago por día). Estados:
--     pendiente -> en_revision -> validada -> pagada
--     (en_revision y validada pueden regresar un paso)
--     pendiente | en_revision | validada -> anulada (con motivo)
--   pagada y anulada son finales. Solo gerente, dueño o admin cambian
--   estados (es_gerente_o_dueno); el staff no ve sueldos; el dueño de grupo
--   solo lee. Todo cambio deja quién, cuándo y bitácora.
--
-- Panel de grupo: grupo_resumen(desde, hasta) devuelve por antro reservas,
-- entradas, consumo, ticket promedio y comisiones. Solo lectura. El dueño de
-- grupo ve los antros de su grupo (de varias ciudades), el dueño los suyos,
-- el gerente SOLO su antro, el admin todos. Staff, RP y cliente: nada.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Quién y cuándo cambió el estado, y motivo de anulación.
-- ----------------------------------------------------------------------------
alter table public.commissions
  add column estado_cambiado_en  timestamptz,
  add column estado_cambiado_por uuid references public.profiles (id),
  add column motivo_anulacion    text check (char_length(motivo_anulacion) <= 300);

alter table public.rp_pagos_dia
  add column estado_cambiado_en  timestamptz,
  add column estado_cambiado_por uuid references public.profiles (id),
  add column motivo_anulacion    text check (char_length(motivo_anulacion) <= 300),
  add constraint rp_pagos_dia_status_check
    check (status in ('pendiente', 'en_revision', 'validada', 'pagada', 'anulada'));


-- ----------------------------------------------------------------------------
-- 2. Transiciones válidas (función pura, la usan la base y las pruebas).
-- ----------------------------------------------------------------------------
create or replace function public.nomina_transicion_valida(p_desde text, p_hacia text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_desde, p_hacia) in (
    ('pendiente', 'en_revision'), ('en_revision', 'pendiente'),
    ('en_revision', 'validada'),  ('validada', 'en_revision'),
    ('validada', 'pagada'),
    ('pendiente', 'anulada'), ('en_revision', 'anulada'), ('validada', 'anulada'));
$$;


-- ----------------------------------------------------------------------------
-- 3. Cambiar de estado la semana de un RP (comisiones y pagos por día que
--    estén en p_desde). Devuelve cuántos movió de cada uno.
-- ----------------------------------------------------------------------------
create or replace function public.nomina_cambiar_estado(
  p_club_id uuid, p_rp_id uuid, p_anio int, p_semana int,
  p_desde text, p_hacia text, p_motivo text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lunes date := public.nomina_lunes_iso(p_anio, p_semana);
  v_motivo text := nullif(trim(coalesce(p_motivo, '')), '');
  v_com int;
  v_dia int;
begin
  if not public.es_gerente_o_dueno(p_club_id) then
    raise exception 'Solo el gerente o el dueño cambian la nómina';
  end if;
  if not public.nomina_transicion_valida(p_desde, p_hacia) then
    raise exception 'No se puede pasar de % a %', p_desde, p_hacia;
  end if;
  if p_hacia = 'anulada' and char_length(coalesce(v_motivo, '')) < 3 then
    raise exception 'Escribe el motivo de la anulación';
  end if;

  with movidas as (
    update public.commissions c
    set status = p_hacia,
        estado_cambiado_en = now(), estado_cambiado_por = auth.uid(), updated_at = now(),
        pagada_en  = case when p_hacia = 'pagada' then now() else c.pagada_en end,
        pagada_por = case when p_hacia = 'pagada' then auth.uid() else c.pagada_por end,
        motivo_anulacion = case when p_hacia = 'anulada' then v_motivo else c.motivo_anulacion end
    from public.reservations r
    where r.id = c.reservation_id
      and c.tipo = 'rp' and c.rp_id = p_rp_id and c.status = p_desde
      and r.club_id = p_club_id and r.fecha between v_lunes and v_lunes + 6
    returning c.id
  )
  select count(*) into v_com from movidas;

  with movidas as (
    update public.rp_pagos_dia d
    set status = p_hacia,
        estado_cambiado_en = now(), estado_cambiado_por = auth.uid(),
        pagada_en  = case when p_hacia = 'pagada' then now() else d.pagada_en end,
        pagada_por = case when p_hacia = 'pagada' then auth.uid() else d.pagada_por end,
        motivo_anulacion = case when p_hacia = 'anulada' then v_motivo else d.motivo_anulacion end
    where d.rp_id = p_rp_id and d.club_id = p_club_id and d.status = p_desde
      and d.fecha between v_lunes and v_lunes + 6
    returning d.id
  )
  select count(*) into v_dia from movidas;

  perform public.caja_evento(p_club_id, null, null, 'nomina_cambiar_estado',
    jsonb_build_object('rp_id', p_rp_id, 'anio', p_anio, 'semana', p_semana,
                       'desde', p_desde, 'hacia', p_hacia, 'motivo', v_motivo,
                       'comisiones', v_com, 'pagos_dia', v_dia));
  return jsonb_build_object('comisiones', v_com, 'pagos_dia', v_dia);
end;
$$;

-- Compatibilidad: marcar pagada = pasar de validada a pagada.
create or replace function public.nomina_marcar_pagada(p_club_id uuid, p_rp_id uuid, p_anio int, p_semana int)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.nomina_cambiar_estado(p_club_id, p_rp_id, p_anio, p_semana, 'validada', 'pagada', null);
$$;


-- ----------------------------------------------------------------------------
-- 4. Reporte de la semana: una fila por RP con montos por estado.
--    Cambia el tipo de retorno: se borran y recrean las tres funciones.
-- ----------------------------------------------------------------------------
drop function if exists public.nomina_semana(uuid, int, int);
drop function if exists public.nomina_semana_mia(int, int);
drop function if exists public.nomina_semana_datos(uuid, date, uuid);

create function public.nomina_semana_datos(p_club_id uuid, p_lunes date, p_rp_id uuid)
returns table (
  rp_id                  uuid,
  rp_nombre              text,
  rp_activo              boolean,
  reservas_entraron      int,
  comisiones             int,       -- sin anuladas
  dias_asistidos         int,       -- sin anulados
  comision_centavos      bigint,    -- sin anuladas
  dia_centavos           bigint,    -- sin anulados
  pendiente_centavos     bigint,
  en_revision_centavos   bigint,
  validada_centavos      bigint,
  pagada_centavos        bigint,
  anulada_centavos       bigint,
  total_centavos         bigint     -- todo lo no anulado
)
language sql
stable
security definer
set search_path = ''
as $$
  with
  mov as (
    select c.rp_id, 'com'::text as tipo, c.status, round(c.monto * 100)::bigint as cent
    from public.commissions c
    join public.reservations r on r.id = c.reservation_id
    where c.tipo = 'rp' and r.club_id = p_club_id and r.fecha between p_lunes and p_lunes + 6
    union all
    select d.rp_id, 'dia', d.status, round(d.monto * 100)::bigint
    from public.rp_pagos_dia d
    where d.club_id = p_club_id and d.fecha between p_lunes and p_lunes + 6
  ),
  agg as (
    select m.rp_id,
      count(*) filter (where m.tipo = 'com' and m.status <> 'anulada')::int as comisiones,
      count(*) filter (where m.tipo = 'dia' and m.status <> 'anulada')::int as dias,
      coalesce(sum(m.cent) filter (where m.tipo = 'com' and m.status <> 'anulada'), 0)::bigint as com_c,
      coalesce(sum(m.cent) filter (where m.tipo = 'dia' and m.status <> 'anulada'), 0)::bigint as dia_c,
      coalesce(sum(m.cent) filter (where m.status = 'pendiente'), 0)::bigint as pend,
      coalesce(sum(m.cent) filter (where m.status = 'en_revision'), 0)::bigint as rev,
      coalesce(sum(m.cent) filter (where m.status = 'validada'), 0)::bigint as val,
      coalesce(sum(m.cent) filter (where m.status = 'pagada'), 0)::bigint as pag,
      coalesce(sum(m.cent) filter (where m.status = 'anulada'), 0)::bigint as anu
    from mov m group by m.rp_id
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
    union select agg.rp_id from agg
    union select res.rp_id from res
  )
  select rps.id, p.nombre, coalesce(p.activo, true),
         coalesce(res.entraron, 0), coalesce(agg.comisiones, 0), coalesce(agg.dias, 0),
         coalesce(agg.com_c, 0), coalesce(agg.dia_c, 0),
         coalesce(agg.pend, 0), coalesce(agg.rev, 0), coalesce(agg.val, 0),
         coalesce(agg.pag, 0), coalesce(agg.anu, 0),
         coalesce(agg.com_c, 0) + coalesce(agg.dia_c, 0)
  from rps
  left join public.profiles p on p.id = rps.id
  left join agg on agg.rp_id = rps.id
  left join res on res.rp_id = rps.id
  where rps.id is not null
    and (p_rp_id is null or rps.id = p_rp_id)
  order by p.nombre;
$$;

create function public.nomina_semana(p_club_id uuid, p_anio int, p_semana int)
returns table (
  rp_id uuid, rp_nombre text, rp_activo boolean, reservas_entraron int,
  comisiones int, dias_asistidos int, comision_centavos bigint, dia_centavos bigint,
  pendiente_centavos bigint, en_revision_centavos bigint, validada_centavos bigint,
  pagada_centavos bigint, anulada_centavos bigint, total_centavos bigint)
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

create function public.nomina_semana_mia(p_anio int, p_semana int)
returns table (
  rp_id uuid, rp_nombre text, rp_activo boolean, reservas_entraron int,
  comisiones int, dias_asistidos int, comision_centavos bigint, dia_centavos bigint,
  pendiente_centavos bigint, en_revision_centavos bigint, validada_centavos bigint,
  pagada_centavos bigint, anulada_centavos bigint, total_centavos bigint)
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


-- ----------------------------------------------------------------------------
-- 5. Panel de grupo: resumen por antro en un rango de noches (máx. 93 días).
-- ----------------------------------------------------------------------------
create or replace function public.grupo_resumen(p_desde date, p_hasta date)
returns table (
  club_id                   uuid,
  nombre                    text,
  ciudad                    text,
  zona_horaria              text,
  publicado                 boolean,
  reservas                  int,
  entraron                  int,
  cuentas_con_consumo       int,
  consumo_centavos          bigint,
  ticket_promedio_centavos  bigint,
  comisiones_centavos       bigint,
  noches_cerradas           int
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rol text := public.current_role_name();
begin
  if auth.uid() is null then
    raise exception 'Inicia sesión';
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 93 then
    raise exception 'Rango de fechas inválido (máximo 93 días)';
  end if;

  return query
  with mis as (
    select c.id, c.nombre, c.ciudad, c.zona_horaria,
           (c.estado_verificacion = 'verificado' and c.suscripcion_activa) as publicado
    from public.clubs c
    where v_rol = 'admin'
       or public.club_es_dueno(c.id)
       or public.club_es_dueno_grupo(c.id)
       or (v_rol = 'gerente' and c.id = public.current_club_id()
           and exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo))
  ),
  res as (
    select r.club_id, count(*)::int as n,
           count(*) filter (where coalesce(r.puerta_estado, case when r.status = 'usada' then 'entro' end)
                                  is not distinct from 'entro')::int as entraron
    from public.reservations r
    where r.club_id in (select id from mis) and r.fecha between p_desde and p_hasta
    group by r.club_id
  ),
  con as (
    select k.club_id, count(distinct k.cuenta_id)::int as cuentas, sum(k.monto_centavos)::bigint as cent
    from public.caja_consumos k
    join public.caja_noches n on n.id = k.noche_id
    where k.club_id in (select id from mis) and not k.anulado
      and n.fecha_operacion between p_desde and p_hasta
    group by k.club_id
  ),
  com as (
    select x.club_id, sum(x.cent)::bigint as cent from (
      select r.club_id, round(c.monto * 100)::bigint as cent
      from public.commissions c join public.reservations r on r.id = c.reservation_id
      where c.tipo = 'rp' and c.status <> 'anulada'
        and r.club_id in (select id from mis) and r.fecha between p_desde and p_hasta
      union all
      select d.club_id, round(d.monto * 100)::bigint
      from public.rp_pagos_dia d
      where d.status <> 'anulada' and d.club_id in (select id from mis) and d.fecha between p_desde and p_hasta
    ) x group by x.club_id
  ),
  noc as (
    select n.club_id, count(*) filter (where n.estado = 'cerrada')::int as cerradas
    from public.caja_noches n
    where n.club_id in (select id from mis) and n.fecha_operacion between p_desde and p_hasta
    group by n.club_id
  )
  select mis.id, mis.nombre, mis.ciudad, mis.zona_horaria, mis.publicado,
         coalesce(res.n, 0), coalesce(res.entraron, 0),
         coalesce(con.cuentas, 0), coalesce(con.cent, 0),
         case when coalesce(con.cuentas, 0) > 0 then round(con.cent::numeric / con.cuentas)::bigint else 0 end,
         coalesce(com.cent, 0), coalesce(noc.cerradas, 0)
  from mis
  left join res on res.club_id = mis.id
  left join con on con.club_id = mis.id
  left join com on com.club_id = mis.id
  left join noc on noc.club_id = mis.id
  order by mis.ciudad nulls last, mis.nombre;
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. Quién puede llamar qué.
-- ----------------------------------------------------------------------------
revoke all on function public.nomina_semana_datos(uuid, date, uuid) from public, anon, authenticated;
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.nomina_transicion_valida(text, text)',
    'public.nomina_cambiar_estado(uuid, uuid, int, int, text, text, text)',
    'public.nomina_marcar_pagada(uuid, uuid, int, int)',
    'public.nomina_semana(uuid, int, int)',
    'public.nomina_semana_mia(int, int)',
    'public.grupo_resumen(date, date)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
