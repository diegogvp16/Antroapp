-- ============================================================================
-- AntroApp — Configuración por antro: qué ve el RP y regla de comisión
-- Fecha: 2026-11-24 (rama post-junta)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO (va en el "pase 2").
-- Requiere: pase 1 (caja_liquidar_cuenta, rp_progreso_cuota,
--           rp_nivel_visibilidad, es_gerente_o_dueno, club_fecha_operacion).
-- Rollback: sql/post-junta/07-config-rp-rollback.sql
--
-- Lo edita el dueño o el gerente en su panel; queda en una bitácora.
--   1. Qué ve el RP de sus clientes (club_config_rp): solo estado, estado y
--      monto, o estado, monto y botellas (renglones de consumo). Aplica al
--      momento (no es dinero).
--   2. Regla de comisión del antro (reglas_comision, con vigencia):
--        porcentaje  → % del consumo de la cuenta
--        fijo        → $X por reserva que consume
--        cuota       → las primeras N reservas de la semana no pagan; desde
--                      la N+1 cada una paga $X
--      Un cambio vale SIEMPRE desde el lunes siguiente (semana de nómina):
--      nunca retroactivo. La comisión guarda con qué regla se calculó.
--   Compatibilidad: un antro SIN regla nueva sigue con lo de hoy
--   (clubs.comision_*); y la regla personalizada de un RP
--   (rp_comision_overrides) sigue ganando sobre la del antro.
--   El staff no lee estas tablas (deuda 9, para lo nuevo).
-- ============================================================================

create table public.club_config_rp (
  club_id           uuid primary key references public.clubs (id) on delete cascade,
  nivel_visibilidad text not null default 'estado_monto'
                      check (nivel_visibilidad in ('estado', 'estado_monto', 'estado_monto_botellas')),
  actualizado_por   uuid references public.profiles (id),
  actualizado_en    timestamptz not null default now()
);

create table public.reglas_comision (
  id               uuid primary key default gen_random_uuid(),
  club_id          uuid not null references public.clubs (id) on delete cascade,
  tipo             text not null check (tipo in ('porcentaje', 'fijo', 'cuota')),
  cuota            int not null default 0 check (cuota between 0 and 100),
  porcentaje_bp    int check (porcentaje_bp between 1 and 10000),          -- 1000 = 10 %
  monto_centavos   bigint check (monto_centavos between 1 and 10000000),   -- hasta $100,000
  vigente_desde    date not null check (extract(isodow from vigente_desde) = 1),  -- siempre lunes
  vigente_hasta    date,
  creada_por       uuid not null references public.profiles (id),
  creada_en        timestamptz not null default now(),
  check (vigente_hasta is null or vigente_hasta >= vigente_desde),
  check (
    (tipo = 'porcentaje' and porcentaje_bp is not null and monto_centavos is null and cuota = 0) or
    (tipo = 'fijo' and monto_centavos is not null and porcentaje_bp is null and cuota = 0) or
    (tipo = 'cuota' and monto_centavos is not null and porcentaje_bp is null and cuota >= 1)
  )
);
create unique index reglas_comision_una_abierta on public.reglas_comision (club_id) where vigente_hasta is null;
create index reglas_comision_club on public.reglas_comision (club_id, vigente_desde);

create table public.config_rp_cambios (
  id             uuid primary key default gen_random_uuid(),
  club_id        uuid not null references public.clubs (id) on delete cascade,
  que            text not null check (que in ('visibilidad', 'regla_comision')),
  antes          jsonb,
  despues        jsonb not null,
  vigente_desde  date,
  hecho_por      uuid not null references public.profiles (id),
  hecho_en       timestamptz not null default now()
);
create index config_rp_cambios_club on public.config_rp_cambios (club_id, hecho_en desc);

alter table public.commissions add column regla_id uuid references public.reglas_comision (id);

-- RLS: leen admin, dueño y gerente del antro (es_gerente_o_dueno). El staff y
-- el RP no. Nadie escribe directo: solo las funciones de abajo.
alter table public.club_config_rp enable row level security;
alter table public.reglas_comision enable row level security;
alter table public.config_rp_cambios enable row level security;
revoke all on public.club_config_rp, public.reglas_comision, public.config_rp_cambios from public, anon, authenticated;
grant select on public.club_config_rp, public.reglas_comision, public.config_rp_cambios to authenticated;
grant all on public.club_config_rp, public.reglas_comision, public.config_rp_cambios to service_role;
create policy club_config_rp_select on public.club_config_rp for select to authenticated
  using (public.es_gerente_o_dueno(club_id));
create policy reglas_comision_select on public.reglas_comision for select to authenticated
  using (public.es_gerente_o_dueno(club_id));
create policy config_rp_cambios_select on public.config_rp_cambios for select to authenticated
  using (public.es_gerente_o_dueno(club_id));

-- Lunes de la semana de una fecha.
create or replace function public.lunes_de(p_fecha date)
returns date
language sql
immutable
set search_path = ''
as $$
  select p_fecha - (extract(isodow from p_fecha)::int - 1);
$$;

-- Regla del antro vigente en una noche (nula si no hay: se usa lo de hoy).
create or replace function public.regla_comision_vigente(p_club uuid, p_fecha date)
returns public.reglas_comision
language sql
stable
security definer
set search_path = ''
as $$
  select r.* from public.reglas_comision r
  where r.club_id = p_club and r.vigente_desde <= p_fecha
    and (r.vigente_hasta is null or r.vigente_hasta >= p_fecha)
  order by r.vigente_desde desc
  limit 1;
$$;
revoke all on function public.regla_comision_vigente(uuid, date) from public, anon, authenticated;

-- Qué ve el RP: lo configurado, o "estado y monto" (lo de hoy).
create or replace function public.rp_nivel_visibilidad(p_club_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select c.nivel_visibilidad from public.club_config_rp c where c.club_id = p_club_id), 'estado_monto');
$$;

-- Descripción de la regla en vigor (nueva o la de hoy), para la bitácora y la pantalla.
create or replace function public.regla_comision_descripcion(p_club uuid, p_fecha date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_r public.reglas_comision;
  v_c public.clubs%rowtype;
begin
  v_r := public.regla_comision_vigente(p_club, p_fecha);
  if v_r.id is not null then
    return jsonb_build_object('origen', 'regla', 'id', v_r.id, 'tipo', v_r.tipo, 'cuota', v_r.cuota,
      'porcentaje_bp', v_r.porcentaje_bp, 'monto_centavos', v_r.monto_centavos, 'vigente_desde', v_r.vigente_desde);
  end if;
  select * into v_c from public.clubs where id = p_club;
  -- Lo de hoy: desbloqueo D = la D-ésima ya paga, o sea cuota N = D − 1.
  return jsonb_build_object('origen', 'anterior',
    'tipo', case when coalesce(v_c.comision_desbloqueo_reservas, 0) > 1 then 'cuota'
                 when v_c.comision_tipo = 'porcentaje' then 'porcentaje' else 'fijo' end,
    'cuota', greatest(coalesce(v_c.comision_desbloqueo_reservas, 0) - 1, 0),
    'porcentaje_bp', case when v_c.comision_tipo = 'porcentaje' then round(v_c.comision_monto * 100)::int end,
    'monto_centavos', case when v_c.comision_tipo = 'fijo' then round(v_c.comision_monto * 100)::bigint end,
    'modo_pago', v_c.pago_rp_modo);
end;
$$;
revoke all on function public.regla_comision_descripcion(uuid, date) from public, anon, authenticated;

-- Configuración completa para la pantalla del dueño o gerente.
create or replace function public.config_rp_actual(p_club uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hoy date;
  v_prog public.reglas_comision;
begin
  if not public.es_gerente_o_dueno(p_club) then
    raise exception 'Solo el dueño o el gerente ven la configuración de los RPs.' using errcode = 'P0001';
  end if;
  v_hoy := public.club_fecha_operacion(p_club, now());
  select * into v_prog from public.reglas_comision
  where club_id = p_club and vigente_desde > v_hoy order by vigente_desde desc limit 1;
  return jsonb_build_object(
    'nivel_visibilidad', public.rp_nivel_visibilidad(p_club),
    'modo_pago', (select pago_rp_modo from public.clubs where id = p_club),
    'vigente', public.regla_comision_descripcion(p_club, v_hoy),
    'programada', case when v_prog.id is null then null else jsonb_build_object(
      'tipo', v_prog.tipo, 'cuota', v_prog.cuota, 'porcentaje_bp', v_prog.porcentaje_bp,
      'monto_centavos', v_prog.monto_centavos, 'vigente_desde', v_prog.vigente_desde) end,
    'siguiente_lunes', public.lunes_de(v_hoy) + 7,
    'rps_con_regla_propia', (select count(*) from public.rp_comision_overrides o where o.club_id = p_club));
end;
$$;
revoke all on function public.config_rp_actual(uuid) from public, anon;
grant execute on function public.config_rp_actual(uuid) to authenticated;

create or replace function public.config_rp_cambiar_visibilidad(p_club uuid, p_nivel text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_antes text;
begin
  if not public.es_gerente_o_dueno(p_club) then
    raise exception 'Solo el dueño o el gerente cambian lo que ven los RPs.' using errcode = 'P0001';
  end if;
  if p_nivel not in ('estado', 'estado_monto', 'estado_monto_botellas') then
    raise exception 'Opción inválida.' using errcode = 'P0001';
  end if;
  v_antes := public.rp_nivel_visibilidad(p_club);
  if v_antes = p_nivel then
    return;
  end if;
  insert into public.club_config_rp (club_id, nivel_visibilidad, actualizado_por, actualizado_en)
  values (p_club, p_nivel, auth.uid(), now())
  on conflict (club_id) do update set nivel_visibilidad = excluded.nivel_visibilidad,
    actualizado_por = excluded.actualizado_por, actualizado_en = excluded.actualizado_en;
  insert into public.config_rp_cambios (club_id, que, antes, despues, vigente_desde, hecho_por)
  values (p_club, 'visibilidad', to_jsonb(v_antes), to_jsonb(p_nivel), public.club_fecha_operacion(p_club, now()), auth.uid());
end;
$$;
revoke all on function public.config_rp_cambiar_visibilidad(uuid, text) from public, anon;
grant execute on function public.config_rp_cambiar_visibilidad(uuid, text) to authenticated;

-- Cambia la regla del antro DESDE EL LUNES SIGUIENTE. Si ya había un cambio
-- programado (todavía no vigente), lo reemplaza.
create or replace function public.config_rp_cambiar_regla(
  p_club uuid, p_tipo text, p_cuota int, p_porcentaje_bp int, p_monto_centavos bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_hoy     date;
  v_desde   date;
  v_abierta public.reglas_comision;
  v_antes   jsonb;
  v_id      uuid;
begin
  if not public.es_gerente_o_dueno(p_club) then
    raise exception 'Solo el dueño o el gerente cambian la regla de pago de los RPs.' using errcode = 'P0001';
  end if;
  if p_tipo = 'porcentaje' and (p_porcentaje_bp is null or p_porcentaje_bp not between 1 and 10000) then
    raise exception 'El porcentaje va de 0.01 %% a 100 %%.' using errcode = 'P0001';
  elsif p_tipo in ('fijo', 'cuota') and (p_monto_centavos is null or p_monto_centavos not between 1 and 10000000) then
    raise exception 'El monto va de $0.01 a $100,000.' using errcode = 'P0001';
  elsif p_tipo = 'cuota' and (p_cuota is null or p_cuota not between 1 and 100) then
    raise exception 'La cuota va de 1 a 100 reservas.' using errcode = 'P0001';
  elsif p_tipo not in ('porcentaje', 'fijo', 'cuota') then
    raise exception 'Tipo de regla inválido.' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('regla_comision|' || p_club::text, 0));
  v_hoy := public.club_fecha_operacion(p_club, now());
  v_desde := public.lunes_de(v_hoy) + 7;
  v_antes := coalesce(
    (select jsonb_build_object('tipo', r.tipo, 'cuota', r.cuota, 'porcentaje_bp', r.porcentaje_bp,
       'monto_centavos', r.monto_centavos, 'vigente_desde', r.vigente_desde, 'programada', true)
     from public.reglas_comision r where r.club_id = p_club and r.vigente_desde >= v_desde),
    public.regla_comision_descripcion(p_club, v_hoy));

  -- Lo programado (aún no vigente) se reemplaza; lo vigente se cierra el domingo.
  delete from public.reglas_comision where club_id = p_club and vigente_desde >= v_desde;
  select * into v_abierta from public.reglas_comision where club_id = p_club and vigente_hasta is null for update;
  if v_abierta.id is not null then
    update public.reglas_comision set vigente_hasta = v_desde - 1 where id = v_abierta.id;
  end if;
  insert into public.reglas_comision (club_id, tipo, cuota, porcentaje_bp, monto_centavos, vigente_desde, creada_por)
  values (p_club, p_tipo,
          case when p_tipo = 'cuota' then p_cuota else 0 end,
          case when p_tipo = 'porcentaje' then p_porcentaje_bp end,
          case when p_tipo in ('fijo', 'cuota') then p_monto_centavos end,
          v_desde, auth.uid())
  returning id into v_id;

  insert into public.config_rp_cambios (club_id, que, antes, despues, vigente_desde, hecho_por)
  values (p_club, 'regla_comision', v_antes,
          jsonb_build_object('tipo', p_tipo, 'cuota', case when p_tipo = 'cuota' then p_cuota else 0 end,
            'porcentaje_bp', case when p_tipo = 'porcentaje' then p_porcentaje_bp end,
            'monto_centavos', case when p_tipo in ('fijo', 'cuota') then p_monto_centavos end),
          v_desde, auth.uid());
  return jsonb_build_object('regla_id', v_id, 'vigente_desde', v_desde);
end;
$$;
revoke all on function public.config_rp_cambiar_regla(uuid, text, int, int, bigint) from public, anon;
grant execute on function public.config_rp_cambiar_regla(uuid, text, int, int, bigint) to authenticated;

-- Bitácora con nombres, para la pantalla.
create or replace function public.config_rp_historial(p_club uuid)
returns table (hecho_en timestamptz, que text, antes jsonb, despues jsonb, vigente_desde date, quien text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.es_gerente_o_dueno(p_club) then
    raise exception 'Solo el dueño o el gerente ven estos cambios.' using errcode = 'P0001';
  end if;
  return query
    select c.hecho_en, c.que, c.antes, c.despues, c.vigente_desde, p.nombre
    from public.config_rp_cambios c join public.profiles p on p.id = c.hecho_por
    where c.club_id = p_club order by c.hecho_en desc limit 50;
end;
$$;
revoke all on function public.config_rp_historial(uuid) from public, anon;
grant execute on function public.config_rp_historial(uuid) to authenticated;

-- Liquidación de la cuenta: igual que antes, pero si el antro tiene regla
-- nueva vigente para ESA noche (y el RP no tiene regla propia), la usa.
create or replace function public.caja_liquidar_cuenta(p_cuenta_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cuenta public.mesa_cuentas%rowtype;
  v_res public.reservations%rowtype;
  v_club public.clubs%rowtype;
  v_regla public.reglas_comision;
  v_fecha date;
  v_lunes date;
  v_base bigint;
  v_tipo text;
  v_monto numeric;
  v_desbloqueo int;
  v_conteo int;
  v_centavos bigint;
  v_propia boolean;
begin
  select * into v_cuenta from public.mesa_cuentas where id = p_cuenta_id for update;
  if not found or v_cuenta.liquidada_en is not null then
    return;
  end if;

  select coalesce(sum(monto_centavos), 0) into v_base
  from public.caja_consumos where cuenta_id = v_cuenta.id and not anulado;

  if v_base > 0 and v_cuenta.reservation_id is not null then
    select * into v_res from public.reservations where id = v_cuenta.reservation_id;
    select * into v_club from public.clubs where id = v_cuenta.club_id;
    select n.fecha_operacion into v_fecha
    from public.mesa_sesiones s join public.caja_noches n on n.id = s.noche_id
    where s.id = v_cuenta.sesion_id;
    v_lunes := v_fecha - (extract(isodow from v_fecha)::int - 1);

    if v_res.source = 'rp' and v_cuenta.rp_id is not null and v_club.pago_rp_modo = 'reserva' then
      select o.comision_tipo, o.comision_monto, o.comision_desbloqueo_reservas
        into v_tipo, v_monto, v_desbloqueo
      from public.rp_comision_overrides o
      where o.club_id = v_club.id and o.rp_id = v_cuenta.rp_id;
      v_propia := found;
      if not v_propia then
        v_regla := public.regla_comision_vigente(v_club.id, v_fecha);
        if v_regla.id is null then
          v_tipo := v_club.comision_tipo;
          v_monto := v_club.comision_monto;
          v_desbloqueo := v_club.comision_desbloqueo_reservas;
        end if;
      end if;

      perform pg_advisory_xact_lock(hashtextextended(v_cuenta.rp_id::text || '|' || v_lunes::text, 0));
      select count(*) into v_conteo
      from public.commissions c
      join public.reservations r on r.id = c.reservation_id
      where c.tipo = 'rp' and c.rp_id = v_cuenta.rp_id and r.club_id = v_club.id
        and c.status <> 'anulada'
        and r.fecha between v_lunes and v_lunes + 6;

      if v_regla.id is not null then
        -- Regla nueva: cuota N = las primeras N de la semana no pagan.
        v_centavos := case v_regla.tipo
          when 'porcentaje' then round(v_base * v_regla.porcentaje_bp / 10000.0)
          when 'fijo' then v_regla.monto_centavos
          else case when v_conteo < v_regla.cuota then 0 else v_regla.monto_centavos end
        end;
      else
        -- Lo de hoy (desbloqueo D: la D-ésima ya paga).
        v_centavos := case
          when (v_conteo + 1) < coalesce(v_desbloqueo, 0) then 0
          when v_tipo = 'fijo' then round(coalesce(v_monto, 0) * 100)
          else round(v_base * coalesce(v_monto, 0) / 100)
        end;
      end if;

      insert into public.commissions (reservation_id, rp_id, tipo, monto, status, regla_id)
      values (v_res.id, v_cuenta.rp_id, 'rp', round(v_centavos / 100.0, 2), 'pendiente', v_regla.id)
      on conflict (reservation_id) do nothing;
    end if;

    update public.reservations set consumo_monto = round(v_base / 100.0, 2) where id = v_res.id;
  end if;

  update public.mesa_cuentas set liquidada_en = now() where id = v_cuenta.id;
end;
$$;

-- Progreso de la cuota del RP: con regla nueva vigente hoy (sin regla
-- propia del RP) usa esa; si no, lo de hoy. Se devuelve con la convención
-- que ya usa el panel: "cuota" = número de la primera reserva que paga.
create or replace function public.rp_progreso_cuota()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rp     uuid := auth.uid();
  v_club   uuid := public.current_club_id();
  v_modo   text;
  v_tipo   text;
  v_monto  numeric;
  v_n      int;
  v_lunes  date;
  v_llevas int;
  v_hoy    date;
  v_regla  public.reglas_comision;
begin
  if v_rp is null or public.current_role_name() is distinct from 'rp' or v_club is null then
    raise exception 'Solo para RPs';
  end if;
  if exists (select 1 from public.profiles p where p.id = v_rp and p.activo is false) then
    raise exception 'Tu cuenta está desactivada';
  end if;
  select c.pago_rp_modo into v_modo from public.clubs c where c.id = v_club;
  v_hoy := public.club_fecha_operacion(v_club, now());
  select o.comision_tipo, o.comision_monto, o.comision_desbloqueo_reservas
    into v_tipo, v_monto, v_n
  from public.rp_comision_overrides o
  where o.club_id = v_club and o.rp_id = v_rp;
  if not found then
    v_regla := public.regla_comision_vigente(v_club, v_hoy);
    if v_regla.id is not null then
      v_tipo := 'fijo';
      v_monto := v_regla.monto_centavos / 100.0;
      v_n := case when v_regla.tipo = 'cuota' then v_regla.cuota + 1 else 0 end;
    else
      select c.comision_tipo, c.comision_monto, c.comision_desbloqueo_reservas
        into v_tipo, v_monto, v_n
      from public.clubs c where c.id = v_club;
    end if;
  end if;

  if v_modo is distinct from 'reserva' or coalesce(v_n, 0) <= 1 then
    return jsonb_build_object('tiene_cuota', false);
  end if;

  v_lunes := v_hoy - (extract(isodow from v_hoy)::int - 1);
  select count(*) into v_llevas
  from public.commissions c join public.reservations r on r.id = c.reservation_id
  where c.tipo = 'rp' and c.rp_id = v_rp and r.club_id = v_club and c.status <> 'anulada'
    and r.fecha between v_lunes and v_lunes + 6;

  return jsonb_build_object(
    'tiene_cuota', true,
    'cuota', v_n,
    'llevas', v_llevas,
    'semana_desde', v_lunes,
    'semana_hasta', v_lunes + 6,
    'tipo', v_tipo,
    'monto', v_monto,
    'siguiente_paga', (v_llevas + 1) >= v_n);
end;
$$;
