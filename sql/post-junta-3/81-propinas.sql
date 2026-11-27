-- ============================================================================
-- AntroApp — Fase 2, bloque 8: propinas completas (registro por mesa o
-- cuenta, reparto como lo configure el antro y reporte de la noche), detrás
-- de la bandera por antro «propinas» (sql/post-junta-3/00-funciones-club.sql)
-- y de NEXT_PUBLIC_FASE2.
-- Fecha: 2026-11-27. Rollback: sql/post-junta-3/81-propinas-rollback.sql
-- Prueba (dev): node scripts/dev/probar-fase2-completa.mjs
-- Requiere: sql/fase2/2026-11-21-inventario-propinas.sql (caja_pagos.propina_centavos),
--           la caja (2026-11-20-caja-por-mesa.sql) y 00-funciones-club.sql.
--
-- Las propinas van APARTE del consumo y del cobro:
--   - no cambian el saldo de la mesa, ni lo cobrado, ni el cuadre de la mesa
--     o de la noche (caja_cerrar_noche no se toca), ni la comisión del RP;
--   - dos orígenes: la propina que se captura al cobrar (la que ya existía,
--     caja_pagos.propina_centavos) y la propina suelta de esta tabla nueva
--     (caja_propinas: la que dejan en la mesa, o sin mesa: barra, caja).
--
-- Reparto (propinas_config, por antro; sin configuración = 100 % al personal):
--   - pct_rp:   de cada propina de una cuenta con RP ACTIVO, ese % es del RP;
--               sin RP (o con el RP dado de baja), esa parte va al personal;
--   - pct_casa: ese % se queda en la casa;
--   - el resto, al personal de piso que elija el gerente esa noche, en partes
--     iguales (los centavos que sobran, uno a cada quien en orden de nombre).
--     El gerente entra solo si la configuración lo dice (incluye_gerente).
--     Con 0 % al personal, o si el antro no tiene personal que pueda entrar,
--     ese resto va a la casa.
--   - Se reparte con la noche CERRADA (ya no entran propinas). Una vez por
--     noche; para corregir, se anula con motivo y se reparte de nuevo. Se
--     manda la regla que se vio: si cambió, se rechaza.
--   - La propina de un cobro se puede anular sola (propinas_anular_de_cobro),
--     sin tocar el cobro, mientras la noche no se haya repartido.
--
-- Nada se borra: una propina se anula con motivo (trigger propinas_candado,
-- que también cuida que lo guardado sea coherente aunque escriba service_role).
-- Sin redefinir ninguna función existente.
-- ============================================================================
begin;

-- ----------------------------------------------------------------------------
-- 1. Tablas.
-- ----------------------------------------------------------------------------
create table public.caja_propinas (
  id               uuid primary key default gen_random_uuid(),
  club_id          uuid not null references public.clubs (id),
  noche_id         uuid not null references public.caja_noches (id),
  sesion_id        uuid references public.mesa_sesiones (id),     -- null = propina sin mesa
  cuenta_id        uuid references public.mesa_cuentas (id),
  metodo           text not null check (metodo in ('efectivo', 'tarjeta', 'otro')),
  monto_centavos   bigint not null check (monto_centavos between 1 and 100000000),
  nota             text check (char_length(nota) <= 200),
  registrado_por   uuid not null references public.profiles (id),
  registrado_en    timestamptz not null default now(),
  clave_cliente    uuid,
  anulado          boolean not null default false,
  anulado_por      uuid references public.profiles (id),
  anulado_en       timestamptz,
  motivo_anulacion text check (char_length(motivo_anulacion) <= 300),
  check (cuenta_id is null or sesion_id is not null)
);
create unique index caja_propinas_clave on public.caja_propinas (registrado_por, clave_cliente) where clave_cliente is not null;
create index caja_propinas_noche on public.caja_propinas (noche_id);
create index caja_propinas_sesion on public.caja_propinas (sesion_id);

create table public.propinas_config (
  club_id          uuid primary key references public.clubs (id) on delete cascade,
  pct_personal     int not null check (pct_personal between 0 and 100),
  pct_rp           int not null check (pct_rp between 0 and 100),
  pct_casa         int not null check (pct_casa between 0 and 100),
  incluye_gerente  boolean not null default false,
  actualizado_por  uuid references public.profiles (id) on delete set null,
  actualizado_en   timestamptz not null default now(),
  check (pct_personal + pct_rp + pct_casa = 100)
);

create table public.propinas_repartos (
  id               uuid primary key default gen_random_uuid(),
  club_id          uuid not null references public.clubs (id),
  noche_id         uuid not null references public.caja_noches (id),
  total_centavos   bigint not null check (total_centavos >= 0),
  pct_personal     int not null,
  pct_rp           int not null,
  pct_casa         int not null,
  incluye_gerente  boolean not null,
  participantes    uuid[] not null,
  hecho_por        uuid not null references public.profiles (id),
  hecho_en         timestamptz not null default now(),
  anulado          boolean not null default false,
  anulado_por      uuid references public.profiles (id),
  anulado_en       timestamptz,
  motivo_anulacion text check (char_length(motivo_anulacion) <= 300)
);
create unique index propinas_repartos_vigente on public.propinas_repartos (noche_id) where not anulado;

create table public.propinas_reparto_lineas (
  id               uuid primary key default gen_random_uuid(),
  reparto_id       uuid not null references public.propinas_repartos (id),
  club_id          uuid not null references public.clubs (id),
  tipo             text not null check (tipo in ('personal', 'rp', 'casa')),
  profile_id       uuid references public.profiles (id),
  monto_centavos   bigint not null check (monto_centavos >= 0),
  check ((tipo = 'casa') = (profile_id is null))
);
create index propinas_reparto_lineas_reparto on public.propinas_reparto_lineas (reparto_id);

-- La propina de un cobro anulada sola (el cobro no se toca: caja_pagos no se
-- modifica). Una fila por cobro; no se borra ni se cambia.
create table public.propinas_cobro_anuladas (
  pago_id          uuid primary key references public.caja_pagos (id),
  club_id          uuid not null references public.clubs (id),
  noche_id         uuid not null references public.caja_noches (id),
  motivo           text not null check (char_length(trim(motivo)) between 3 and 300),
  anulado_por      uuid not null references public.profiles (id),
  anulado_en       timestamptz not null default now()
);
create index propinas_cobro_anuladas_noche on public.propinas_cobro_anuladas (noche_id);


-- ----------------------------------------------------------------------------
-- 2. Candado: nada se borra; una propina o un reparto solo se anulan (una
--    vez, con quién, cuándo y motivo); las líneas no cambian. Al insertar,
--    coherencia de antro, noche, mesa y cuenta.
-- ----------------------------------------------------------------------------
create function public.propinas_candado()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'postgres' and current_setting('antroapp.borrado_pruebas', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'Las propinas no se borran: se anulan con motivo (%)', tg_table_name;
  end if;

  if tg_op = 'INSERT' then
    if tg_table_name = 'caja_propinas' then
      if not exists (select 1 from public.caja_noches n where n.id = new.noche_id and n.club_id = new.club_id) then
        raise exception 'La noche no es de este antro';
      end if;
      if new.sesion_id is not null
         and not exists (select 1 from public.mesa_sesiones s where s.id = new.sesion_id and s.noche_id = new.noche_id) then
        raise exception 'La mesa no es de esta noche';
      end if;
      if new.cuenta_id is not null
         and not exists (select 1 from public.mesa_cuentas c where c.id = new.cuenta_id and c.sesion_id = new.sesion_id) then
        raise exception 'La cuenta no es de esta mesa';
      end if;
      if new.anulado then
        raise exception 'Una propina no nace anulada';
      end if;
    elsif tg_table_name = 'propinas_repartos' then
      if not exists (select 1 from public.caja_noches n where n.id = new.noche_id and n.club_id = new.club_id) then
        raise exception 'La noche no es de este antro';
      end if;
      if new.anulado then
        raise exception 'Un reparto no nace anulado';
      end if;
    elsif tg_table_name = 'propinas_reparto_lineas' then
      if not exists (select 1 from public.propinas_repartos r where r.id = new.reparto_id and r.club_id = new.club_id) then
        raise exception 'La línea no es de este reparto';
      end if;
    elsif tg_table_name = 'propinas_cobro_anuladas' then
      if not exists (select 1 from public.caja_pagos p where p.id = new.pago_id and p.club_id = new.club_id
                       and p.noche_id = new.noche_id and p.propina_centavos > 0) then
        raise exception 'El cobro no es de este antro y noche, o no tiene propina';
      end if;
    end if;
    return new;
  end if;

  -- UPDATE
  if tg_table_name in ('propinas_reparto_lineas', 'propinas_cobro_anuladas') then
    raise exception 'Los registros de % no se modifican', tg_table_name;
  end if;
  if old.anulado then
    raise exception 'Un registro anulado ya no se modifica';
  end if;
  if (to_jsonb(new) - array['anulado', 'anulado_por', 'anulado_en', 'motivo_anulacion'])
     is distinct from (to_jsonb(old) - array['anulado', 'anulado_por', 'anulado_en', 'motivo_anulacion']) then
    raise exception 'Una propina o un reparto no cambian: se anulan con motivo y se registran de nuevo';
  end if;
  if not new.anulado or new.anulado_por is null or new.anulado_en is null
     or char_length(coalesce(trim(new.motivo_anulacion), '')) < 3 then
    raise exception 'La anulación necesita quién, cuándo y motivo';
  end if;
  return new;
end;
$$;
revoke all on function public.propinas_candado() from public, anon, authenticated;

create trigger caja_propinas_candado before insert or update or delete on public.caja_propinas
  for each row execute function public.propinas_candado();
create trigger caja_propinas_sin_truncar before truncate on public.caja_propinas
  for each statement execute function public.propinas_candado();
create trigger propinas_repartos_candado before insert or update or delete on public.propinas_repartos
  for each row execute function public.propinas_candado();
create trigger propinas_repartos_sin_truncar before truncate on public.propinas_repartos
  for each statement execute function public.propinas_candado();
create trigger propinas_reparto_lineas_candado before insert or update or delete on public.propinas_reparto_lineas
  for each row execute function public.propinas_candado();
create trigger propinas_reparto_lineas_sin_truncar before truncate on public.propinas_reparto_lineas
  for each statement execute function public.propinas_candado();
create trigger propinas_cobro_anuladas_candado before insert or update or delete on public.propinas_cobro_anuladas
  for each row execute function public.propinas_candado();
create trigger propinas_cobro_anuladas_sin_truncar before truncate on public.propinas_cobro_anuladas
  for each statement execute function public.propinas_candado();


-- ----------------------------------------------------------------------------
-- 3. Acceso directo: solo lectura. Las propinas sueltas las lee quien ve la
--    caja del antro (para mostrarlas en la mesa); repartos y líneas, solo
--    gerente y dueño. La configuración, solo por funciones. Escribir, solo
--    por funciones.
-- ----------------------------------------------------------------------------
alter table public.caja_propinas enable row level security;
alter table public.propinas_config enable row level security;
alter table public.propinas_repartos enable row level security;
alter table public.propinas_reparto_lineas enable row level security;
alter table public.propinas_cobro_anuladas enable row level security;

create policy caja_propinas_select on public.caja_propinas
  for select to authenticated using ((select public.caja_puede_ver(club_id)));
create policy propinas_repartos_select on public.propinas_repartos
  for select to authenticated using ((select public.es_gerente_o_dueno(club_id)));
create policy propinas_reparto_lineas_select on public.propinas_reparto_lineas
  for select to authenticated using ((select public.es_gerente_o_dueno(club_id)));
create policy propinas_cobro_anuladas_select on public.propinas_cobro_anuladas
  for select to authenticated using ((select public.caja_puede_ver(club_id)));

revoke all on table public.caja_propinas, public.propinas_config, public.propinas_repartos,
  public.propinas_reparto_lineas, public.propinas_cobro_anuladas from public, anon, authenticated;
grant select on table public.caja_propinas, public.propinas_repartos, public.propinas_reparto_lineas,
  public.propinas_cobro_anuladas to authenticated;
grant all on table public.caja_propinas, public.propinas_config, public.propinas_repartos,
  public.propinas_reparto_lineas, public.propinas_cobro_anuladas to service_role;


-- ----------------------------------------------------------------------------
-- 4. Registrar y anular una propina suelta (con mesa y cuenta, o sin mesa).
--    Permisos de la caja: registrar = «cobrar», anular = «anular».
-- ----------------------------------------------------------------------------
create function public.caja_registrar_propina(
  p_noche_id uuid, p_sesion_id uuid, p_cuenta_id uuid, p_metodo text, p_monto_centavos bigint,
  p_nota text default null, p_clave uuid default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_noche public.caja_noches%rowtype;
  v_sesion public.mesa_sesiones%rowtype;
  v_previo public.caja_propinas%rowtype;
  v_vuelta int;
  v_id uuid;
begin
  select * into v_noche from public.caja_noches where id = p_noche_id;
  if not found or not coalesce(public.caja_tiene_permiso(v_noche.club_id, 'cobrar'), false) then
    raise exception 'No tienes permiso para registrar propinas en este antro' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(v_noche.club_id, 'propinas'), false) then
    raise exception 'Las propinas no están activas en este antro.' using errcode = 'P0001';
  end if;

  -- La clave se busca dos veces, como en el cobro (sql/post-junta-2/65):
  -- antes de los candados (reintento tardío) y con la mesa y la noche ya
  -- bloqueadas (el mismo envío varias veces a la vez).
  for v_vuelta in 1..2 loop
    if v_vuelta = 2 then
      if p_sesion_id is not null then
        select * into v_sesion from public.mesa_sesiones where id = p_sesion_id for update;
        if not found or v_sesion.noche_id <> p_noche_id then
          raise exception 'Mesa no encontrada en esta noche' using errcode = 'P0001';
        end if;
        if v_sesion.estado = 'cuadrada' then
          raise exception 'La mesa ya está cuadrada: registra la propina sin mesa' using errcode = 'P0001';
        end if;
      end if;
      select * into v_noche from public.caja_noches where id = p_noche_id for share;
      if v_noche.estado <> 'abierta' then
        raise exception 'La noche ya está cerrada' using errcode = 'P0001';
      end if;
    end if;
    if p_clave is not null then
      select * into v_previo from public.caja_propinas where registrado_por = auth.uid() and clave_cliente = p_clave;
      if found then
        if v_previo.noche_id is distinct from p_noche_id or v_previo.sesion_id is distinct from p_sesion_id
           or v_previo.cuenta_id is distinct from p_cuenta_id or v_previo.metodo is distinct from p_metodo
           or v_previo.monto_centavos is distinct from p_monto_centavos then
          raise exception 'Esa propina ya se había guardado con otros datos. Revisa las propinas de la mesa.' using errcode = 'P0001';
        end if;
        return v_previo.id;
      end if;
    end if;
  end loop;

  if p_metodo is null or p_metodo not in ('efectivo', 'tarjeta', 'otro') then
    raise exception 'Método de pago inválido' using errcode = 'P0001';
  end if;
  if p_monto_centavos is null or p_monto_centavos < 1 or p_monto_centavos > 100000000 then
    raise exception 'Propina inválida' using errcode = 'P0001';
  end if;
  if p_cuenta_id is not null and (p_sesion_id is null
     or not exists (select 1 from public.mesa_cuentas where id = p_cuenta_id and sesion_id = p_sesion_id)) then
    raise exception 'La cuenta no es de esta mesa' using errcode = 'P0001';
  end if;
  if char_length(coalesce(trim(p_nota), '')) > 200 then
    raise exception 'La nota es muy larga (máximo 200 letras)' using errcode = 'P0001';
  end if;

  begin
    insert into public.caja_propinas (club_id, noche_id, sesion_id, cuenta_id, metodo, monto_centavos, nota,
                                      registrado_por, clave_cliente)
    values (v_noche.club_id, p_noche_id, p_sesion_id, p_cuenta_id, p_metodo, p_monto_centavos,
            nullif(trim(p_nota), ''), auth.uid(), p_clave)
    returning id into v_id;
  exception when unique_violation then
    select * into v_previo from public.caja_propinas where registrado_por = auth.uid() and clave_cliente = p_clave;
    if v_previo.noche_id is distinct from p_noche_id or v_previo.sesion_id is distinct from p_sesion_id
       or v_previo.cuenta_id is distinct from p_cuenta_id or v_previo.metodo is distinct from p_metodo
       or v_previo.monto_centavos is distinct from p_monto_centavos then
      raise exception 'Esa propina ya se había guardado con otros datos. Revisa las propinas de la mesa.' using errcode = 'P0001';
    end if;
    return v_previo.id;
  end;

  perform public.caja_evento(v_noche.club_id, p_noche_id, p_sesion_id, 'propina',
    jsonb_build_object('propina_id', v_id, 'monto_centavos', p_monto_centavos, 'metodo', p_metodo));
  return v_id;
end;
$$;

create function public.caja_anular_propina(p_propina_id uuid, p_motivo text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_p public.caja_propinas%rowtype;
  v_noche public.caja_noches%rowtype;
begin
  select * into v_p from public.caja_propinas where id = p_propina_id;
  if not found or not coalesce(public.caja_tiene_permiso(v_p.club_id, 'anular'), false) then
    raise exception 'No tienes permiso para anular' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(v_p.club_id, 'propinas'), false) then
    raise exception 'Las propinas no están activas en este antro.' using errcode = 'P0001';
  end if;
  -- Con la noche abierta o cerrada, mientras no se haya repartido (mismo
  -- candado que el reparto).
  select * into v_noche from public.caja_noches where id = v_p.noche_id for update;
  if exists (select 1 from public.propinas_repartos r where r.noche_id = v_p.noche_id and not r.anulado) then
    raise exception 'Esta noche ya se repartió: anula primero el reparto' using errcode = 'P0001';
  end if;
  select * into v_p from public.caja_propinas where id = p_propina_id for update;
  if p_motivo is null or char_length(trim(p_motivo)) < 3 then
    raise exception 'Escribe el motivo de la anulación' using errcode = 'P0001';
  end if;
  if v_p.anulado then
    raise exception 'La propina ya estaba anulada' using errcode = 'P0001';
  end if;
  update public.caja_propinas
     set anulado = true, anulado_por = auth.uid(), anulado_en = now(), motivo_anulacion = left(trim(p_motivo), 300)
   where id = p_propina_id;
  perform public.caja_evento(v_p.club_id, v_p.noche_id, v_p.sesion_id, 'anular_propina',
    jsonb_build_object('propina_id', p_propina_id, 'monto_centavos', v_p.monto_centavos, 'motivo', trim(p_motivo)));
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. Configuración del reparto.
-- ----------------------------------------------------------------------------
create function public.propinas_config_leer(p_club_id uuid)
returns table (pct_personal int, pct_rp int, pct_casa int, incluye_gerente boolean, por_defecto boolean,
               actualizado_en timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not coalesce(public.caja_puede_ver(p_club_id), false) then
    raise exception 'No puedes ver las propinas de este antro' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(p_club_id, 'propinas'), false) then
    raise exception 'Las propinas no están activas en este antro.' using errcode = 'P0001';
  end if;
  return query
    select coalesce(c.pct_personal, 100), coalesce(c.pct_rp, 0), coalesce(c.pct_casa, 0),
           coalesce(c.incluye_gerente, false), c.club_id is null, c.actualizado_en
      from (select 1) x
      left join public.propinas_config c on c.club_id = p_club_id;
end;
$$;

create function public.propinas_config_guardar(
  p_club_id uuid, p_pct_personal int, p_pct_rp int, p_pct_casa int, p_incluye_gerente boolean default false)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.es_gerente_o_dueno(p_club_id), false) then
    raise exception 'Solo el gerente o el dueño configuran el reparto de propinas' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(p_club_id, 'propinas'), false) then
    raise exception 'Las propinas no están activas en este antro.' using errcode = 'P0001';
  end if;
  if p_pct_personal is null or p_pct_rp is null or p_pct_casa is null
     or least(p_pct_personal, p_pct_rp, p_pct_casa) < 0 or greatest(p_pct_personal, p_pct_rp, p_pct_casa) > 100 then
    raise exception 'Cada porcentaje va de 0 a 100' using errcode = 'P0001';
  end if;
  if p_pct_personal + p_pct_rp + p_pct_casa <> 100 then
    raise exception 'Los porcentajes deben sumar 100 (suman %)', p_pct_personal + p_pct_rp + p_pct_casa using errcode = 'P0001';
  end if;
  insert into public.propinas_config (club_id, pct_personal, pct_rp, pct_casa, incluye_gerente, actualizado_por)
  values (p_club_id, p_pct_personal, p_pct_rp, p_pct_casa, coalesce(p_incluye_gerente, false), auth.uid())
  on conflict (club_id) do update
    set pct_personal = excluded.pct_personal, pct_rp = excluded.pct_rp, pct_casa = excluded.pct_casa,
        incluye_gerente = excluded.incluye_gerente, actualizado_por = excluded.actualizado_por, actualizado_en = now();
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. Anular solo la propina de un cobro (un error de dedo: 5000 por 500). El
--    cobro no cambia (caja_pagos no se modifica): la anulación vive aparte y
--    solo saca esa propina del reparto y de los reportes. Saldo, cuadres,
--    conteo de caja y comisiones quedan igual. Con permiso «anular», con la
--    noche abierta o cerrada, mientras la noche no se haya repartido.
-- ----------------------------------------------------------------------------
create function public.propinas_anular_de_cobro(p_pago_id uuid, p_motivo text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pago public.caja_pagos%rowtype;
begin
  select * into v_pago from public.caja_pagos where id = p_pago_id;
  if not found or not coalesce(public.caja_tiene_permiso(v_pago.club_id, 'anular'), false) then
    raise exception 'No tienes permiso para anular' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(v_pago.club_id, 'propinas'), false) then
    raise exception 'Las propinas no están activas en este antro.' using errcode = 'P0001';
  end if;
  if coalesce(v_pago.propina_centavos, 0) = 0 then
    raise exception 'Ese cobro no tiene propina' using errcode = 'P0001';
  end if;
  if v_pago.anulado then
    raise exception 'El cobro ya está anulado (con todo y su propina)' using errcode = 'P0001';
  end if;
  if p_motivo is null or char_length(trim(p_motivo)) < 3 then
    raise exception 'Escribe el motivo de la anulación' using errcode = 'P0001';
  end if;
  -- Mismo candado que el reparto: o se anula antes, o el reparto ya la ve.
  perform 1 from public.caja_noches where id = v_pago.noche_id for update;
  if exists (select 1 from public.propinas_repartos r where r.noche_id = v_pago.noche_id and not r.anulado) then
    raise exception 'Esta noche ya se repartió: anula primero el reparto' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.propinas_cobro_anuladas a where a.pago_id = p_pago_id) then
    raise exception 'La propina de ese cobro ya estaba anulada' using errcode = 'P0001';
  end if;
  insert into public.propinas_cobro_anuladas (pago_id, club_id, noche_id, motivo, anulado_por)
  values (p_pago_id, v_pago.club_id, v_pago.noche_id, left(trim(p_motivo), 300), auth.uid());
  perform public.caja_evento(v_pago.club_id, v_pago.noche_id, v_pago.sesion_id, 'anular_propina_cobro',
    jsonb_build_object('pago_id', p_pago_id, 'propina_centavos', v_pago.propina_centavos, 'motivo', trim(p_motivo)));
end;
$$;


-- ----------------------------------------------------------------------------
-- 7. Cálculo del reparto (interno).
-- ----------------------------------------------------------------------------
-- Cada propina de la noche (cobros y sueltas, también las anuladas) con su RP:
--   - rp_cuenta: el RP de su cuenta. Si la propina es de la mesa (sin cuenta,
--     como la del cobro de la caja) y la mesa tiene UNA sola cuenta, es de
--     esa cuenta; con varias cuentas no se adivina.
--   - rp_id: el RP que cobra su parte: rp_cuenta, salvo que esté dado de baja
--     (activo = false): entonces no hay parte de RP y va al personal.
create function public.propinas_detalle(p_noche_id uuid)
returns table (origen text, id uuid, sesion_id uuid, cuenta_id uuid, rp_cuenta uuid, rp_id uuid, metodo text,
               monto_centavos bigint, nota text, registrado_por uuid, registrado_en timestamptz, anulado boolean,
               motivo_anulacion text)
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    select 'cobro'::text as origen, p.id, p.sesion_id, p.cuenta_id, p.metodo, p.propina_centavos as monto,
           null::text as nota, p.registrado_por, p.registrado_en,
           (p.anulado or a.pago_id is not null) as anulado,
           case when p.anulado then 'Cobro anulado: ' || coalesce(p.motivo_anulacion, '') else a.motivo end as motivo
      from public.caja_pagos p
      left join public.propinas_cobro_anuladas a on a.pago_id = p.id
     where p.noche_id = p_noche_id and p.propina_centavos > 0
    union all
    select 'suelta', t.id, t.sesion_id, t.cuenta_id, t.metodo, t.monto_centavos, t.nota, t.registrado_por,
           t.registrado_en, t.anulado, t.motivo_anulacion
      from public.caja_propinas t
     where t.noche_id = p_noche_id
  ), con_rp as (
    select b.*,
           case when b.cuenta_id is not null then (select c.rp_id from public.mesa_cuentas c where c.id = b.cuenta_id)
                when b.sesion_id is null then null
                else (select (array_agg(mc.rp_id))[1] from public.mesa_cuentas mc
                       where mc.sesion_id = b.sesion_id having count(*) = 1) end as rp_cuenta
      from base b
  )
  select x.origen, x.id, x.sesion_id, x.cuenta_id, x.rp_cuenta,
         case when x.rp_cuenta is not null
                   and exists (select 1 from public.profiles pf where pf.id = x.rp_cuenta and pf.activo is not false)
              then x.rp_cuenta end,
         x.metodo, x.monto, x.nota, x.registrado_por, x.registrado_en, x.anulado, x.motivo
    from con_rp x;
$$;
revoke all on function public.propinas_detalle(uuid) from public, anon, authenticated;
grant execute on function public.propinas_detalle(uuid) to service_role;

-- Las vigentes (lo que se reparte).
create function public.propinas_de_noche(p_noche_id uuid)
returns table (origen text, id uuid, sesion_id uuid, cuenta_id uuid, rp_id uuid, metodo text, monto_centavos bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select d.origen, d.id, d.sesion_id, d.cuenta_id, d.rp_id, d.metodo, d.monto_centavos
    from public.propinas_detalle(p_noche_id) d
   where not d.anulado;
$$;
revoke all on function public.propinas_de_noche(uuid) from public, anon, authenticated;
grant execute on function public.propinas_de_noche(uuid) to service_role;

-- Por propina: la parte del RP (si tiene RP activo), la de la casa y el
-- resto para el personal. Se redondea hacia abajo y lo que sobra es del
-- personal, así que las tres partes suman siempre la propina exacta.
create function public.propinas_partes(p_noche_id uuid, p_pct_rp int, p_pct_casa int)
returns table (rp_id uuid, rp bigint, casa bigint, personal bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select t.rp_id,
         case when t.rp_id is null then 0 else (t.monto_centavos * p_pct_rp) / 100 end,
         (t.monto_centavos * p_pct_casa) / 100,
         t.monto_centavos
           - case when t.rp_id is null then 0 else (t.monto_centavos * p_pct_rp) / 100 end
           - (t.monto_centavos * p_pct_casa) / 100
    from public.propinas_de_noche(p_noche_id) t;
$$;
revoke all on function public.propinas_partes(uuid, int, int) from public, anon, authenticated;
grant execute on function public.propinas_partes(uuid, int, int) to service_role;

-- La regla vigente del antro (sin configuración: 100 % al personal).
create function public.propinas_regla(p_club_id uuid)
returns table (pct_personal int, pct_rp int, pct_casa int, incluye_gerente boolean, por_defecto boolean,
               actualizado_en timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(c.pct_personal, 100), coalesce(c.pct_rp, 0), coalesce(c.pct_casa, 0),
         coalesce(c.incluye_gerente, false), c.club_id is null, c.actualizado_en
    from (select 1) x
    left join public.propinas_config c on c.club_id = p_club_id;
$$;
revoke all on function public.propinas_regla(uuid) from public, anon, authenticated;
grant execute on function public.propinas_regla(uuid) to service_role;

-- Líneas del reparto.
--   - p_pct_* / p_incluye_gerente: la regla que vio quien reparte. Si se
--     mandan y la regla ya cambió, se rechaza (otro gerente la cambió).
--   - Participantes: personal activo del antro (staff; y gerente solo si la
--     regla lo incluye), sin repetir.
--   - Lo del personal va a la casa si la regla da 0 % al personal (entonces
--     no se elige a nadie) o si el antro no tiene a nadie que pueda entrar.
--     Si hay personal y no se eligió a nadie, se rechaza.
create function public.propinas_calcular(p_noche_id uuid, p_participantes uuid[],
  p_pct_personal int default null, p_pct_rp int default null, p_pct_casa int default null,
  p_incluye_gerente boolean default null)
returns table (tipo text, profile_id uuid, nombre text, monto_centavos bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_noche public.caja_noches%rowtype;
  v_cfg record;
  v_part uuid[];
  v_personal bigint;
  v_n int;
  v_validos int;
  v_elegibles int;
  v_a_casa boolean := false;
begin
  select * into v_noche from public.caja_noches n where n.id = p_noche_id;
  if not found or not coalesce(public.es_gerente_o_dueno(v_noche.club_id), false) then
    raise exception 'Solo el gerente o el dueño reparten las propinas' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(v_noche.club_id, 'propinas'), false) then
    raise exception 'Las propinas no están activas en este antro.' using errcode = 'P0001';
  end if;
  select * into v_cfg from public.propinas_regla(v_noche.club_id);
  if p_pct_personal is not null or p_pct_rp is not null or p_pct_casa is not null or p_incluye_gerente is not null then
    if (p_pct_personal, p_pct_rp, p_pct_casa, p_incluye_gerente)
       is distinct from (v_cfg.pct_personal, v_cfg.pct_rp, v_cfg.pct_casa, v_cfg.incluye_gerente) then
      raise exception 'La regla del reparto cambió (ahora: % %% personal, % %% RP, % %% casa%). Revisa y vuelve a calcular.',
        v_cfg.pct_personal, v_cfg.pct_rp, v_cfg.pct_casa, case when v_cfg.incluye_gerente then ', con gerente' else '' end
        using errcode = 'P0001';
    end if;
  end if;

  v_part := case when v_cfg.pct_personal = 0 then '{}'::uuid[] else coalesce(p_participantes, '{}') end;
  v_n := coalesce(cardinality(v_part), 0);
  if v_n > 0 and (select count(distinct u) from unnest(v_part) u) <> v_n then
    raise exception 'Hay personas repetidas en el reparto' using errcode = 'P0001';
  end if;
  select count(*) filter (where pf.id = any (v_part)), count(*) into v_validos, v_elegibles
    from public.profiles pf
   where pf.club_id = v_noche.club_id and pf.activo is not false
     and (pf.role = 'staff' or (pf.role = 'gerente' and v_cfg.incluye_gerente));
  if v_validos <> v_n then
    raise exception 'Solo entra al reparto el personal activo de este antro%',
      case when v_cfg.incluye_gerente then '' else ' (el gerente, solo si la configuración lo incluye)' end using errcode = 'P0001';
  end if;

  select coalesce(sum(x.personal), 0) into v_personal
    from public.propinas_partes(p_noche_id, v_cfg.pct_rp, v_cfg.pct_casa) x;
  if v_personal > 0 and v_n = 0 then
    if v_cfg.pct_personal = 0 or v_elegibles = 0 then
      v_a_casa := true;
    else
      raise exception 'Elige al menos a una persona del personal para repartir' using errcode = 'P0001';
    end if;
  end if;

  return query
    select 'rp'::text, x.rp_id, pf.nombre, sum(x.rp)::bigint
      from public.propinas_partes(p_noche_id, v_cfg.pct_rp, v_cfg.pct_casa) x
      left join public.profiles pf on pf.id = x.rp_id
     where x.rp_id is not null and x.rp > 0
     group by x.rp_id, pf.nombre;
  return query
    select 'casa'::text, null::uuid, 'La casa'::text,
           (sum(x.casa) + case when v_a_casa then v_personal else 0 end)::bigint
      from public.propinas_partes(p_noche_id, v_cfg.pct_rp, v_cfg.pct_casa) x
    having sum(x.casa) + case when v_a_casa then v_personal else 0 end > 0;
  if v_n > 0 then
    return query
      select 'personal'::text, o.id, o.nombre,
             (v_personal / v_n + case when o.k <= v_personal % v_n then 1 else 0 end)::bigint
        from (select pf.id, pf.nombre, row_number() over (order by pf.nombre, pf.id) as k
                from public.profiles pf where pf.id = any (v_part)) o;
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- 8. Repartir (noche cerrada, una vez) y anular el reparto. Se manda la regla
--    que se vio: si otro gerente la cambió entre «Ver cómo queda» y
--    «Repartir», se rechaza en vez de guardar otro reparto.
-- ----------------------------------------------------------------------------
create function public.propinas_repartir(p_noche_id uuid, p_participantes uuid[], p_total_visto bigint,
  p_pct_personal int, p_pct_rp int, p_pct_casa int, p_incluye_gerente boolean)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_noche public.caja_noches%rowtype;
  v_previo public.propinas_repartos%rowtype;
  v_cfg record;
  v_part uuid[];
  v_total bigint;
  v_id uuid;
begin
  select * into v_noche from public.caja_noches where id = p_noche_id;
  if not found or not coalesce(public.es_gerente_o_dueno(v_noche.club_id), false) then
    raise exception 'Solo el gerente o el dueño reparten las propinas' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(v_noche.club_id, 'propinas'), false) then
    raise exception 'Las propinas no están activas en este antro.' using errcode = 'P0001';
  end if;
  if p_pct_personal is null or p_pct_rp is null or p_pct_casa is null or p_incluye_gerente is null then
    raise exception 'Falta la regla del reparto que revisaste. Vuelve a calcular.' using errcode = 'P0001';
  end if;
  -- Un reparto a la vez por noche (y contra las anulaciones de propinas).
  select * into v_noche from public.caja_noches where id = p_noche_id for update;
  if v_noche.estado <> 'cerrada' then
    raise exception 'Primero cierra la noche: el reparto se hace cuando ya no entran propinas' using errcode = 'P0001';
  end if;

  select * into v_cfg from public.propinas_regla(v_noche.club_id);
  v_part := case when v_cfg.pct_personal = 0 then '{}'::uuid[] else coalesce(p_participantes, '{}') end;
  select coalesce(sum(t.monto_centavos), 0) into v_total from public.propinas_de_noche(p_noche_id) t;
  select * into v_previo from public.propinas_repartos where noche_id = p_noche_id and not anulado;
  if found then
    -- Reintento del mismo reparto: se devuelve el que ya estaba.
    if v_previo.total_centavos = v_total and p_total_visto is not distinct from v_total
       and (v_previo.pct_personal, v_previo.pct_rp, v_previo.pct_casa, v_previo.incluye_gerente)
           = (p_pct_personal, p_pct_rp, p_pct_casa, p_incluye_gerente)
       and (select array_agg(u order by u) from unnest(v_previo.participantes) u)
           is not distinct from (select array_agg(u order by u) from unnest(v_part) u) then
      return v_previo.id;
    end if;
    raise exception 'Esta noche ya se repartió. Anula el reparto para hacerlo de nuevo.' using errcode = 'P0001';
  end if;
  if (p_pct_personal, p_pct_rp, p_pct_casa, p_incluye_gerente)
     is distinct from (v_cfg.pct_personal, v_cfg.pct_rp, v_cfg.pct_casa, v_cfg.incluye_gerente) then
    raise exception 'La regla del reparto cambió (ahora: % %% personal, % %% RP, % %% casa%). Revisa y vuelve a calcular.',
      v_cfg.pct_personal, v_cfg.pct_rp, v_cfg.pct_casa, case when v_cfg.incluye_gerente then ', con gerente' else '' end
      using errcode = 'P0001';
  end if;
  if v_total = 0 then
    raise exception 'No hay propinas que repartir esta noche' using errcode = 'P0001';
  end if;
  if p_total_visto is distinct from v_total then
    raise exception 'Las propinas cambiaron (ahora suman $%). Revisa y vuelve a repartir.',
      to_char(v_total / 100.0, 'FM999,999,990.00') using errcode = 'P0001';
  end if;

  insert into public.propinas_repartos (club_id, noche_id, total_centavos, pct_personal, pct_rp, pct_casa, incluye_gerente,
                                        participantes, hecho_por)
  values (v_noche.club_id, p_noche_id, v_total, v_cfg.pct_personal, v_cfg.pct_rp, v_cfg.pct_casa, v_cfg.incluye_gerente,
          v_part, auth.uid())
  returning id into v_id;

  insert into public.propinas_reparto_lineas (reparto_id, club_id, tipo, profile_id, monto_centavos)
  select v_id, v_noche.club_id, l.tipo, l.profile_id, l.monto_centavos
    from public.propinas_calcular(p_noche_id, v_part, p_pct_personal, p_pct_rp, p_pct_casa, p_incluye_gerente) l;

  if (select coalesce(sum(l.monto_centavos), 0) from public.propinas_reparto_lineas l where l.reparto_id = v_id) <> v_total then
    raise exception 'El reparto no cuadra con el total de propinas' using errcode = 'P0001';
  end if;

  perform public.caja_evento(v_noche.club_id, p_noche_id, null, 'repartir_propinas',
    jsonb_build_object('reparto_id', v_id, 'total_centavos', v_total, 'participantes', cardinality(v_part)));
  return v_id;
end;
$$;

create function public.propinas_anular_reparto(p_reparto_id uuid, p_motivo text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_r public.propinas_repartos%rowtype;
begin
  select * into v_r from public.propinas_repartos where id = p_reparto_id;
  if not found or not coalesce(public.es_gerente_o_dueno(v_r.club_id), false) then
    raise exception 'Reparto no encontrado' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(v_r.club_id, 'propinas'), false) then
    raise exception 'Las propinas no están activas en este antro.' using errcode = 'P0001';
  end if;
  perform 1 from public.caja_noches where id = v_r.noche_id for update;
  select * into v_r from public.propinas_repartos where id = p_reparto_id for update;
  if p_motivo is null or char_length(trim(p_motivo)) < 3 then
    raise exception 'Escribe el motivo de la anulación' using errcode = 'P0001';
  end if;
  if v_r.anulado then
    raise exception 'El reparto ya estaba anulado' using errcode = 'P0001';
  end if;
  update public.propinas_repartos
     set anulado = true, anulado_por = auth.uid(), anulado_en = now(), motivo_anulacion = left(trim(p_motivo), 300)
   where id = p_reparto_id;
  perform public.caja_evento(v_r.club_id, v_r.noche_id, null, 'anular_reparto_propinas',
    jsonb_build_object('reparto_id', p_reparto_id, 'motivo', trim(p_motivo)));
end;
$$;


-- ----------------------------------------------------------------------------
-- 9. Reporte de la noche (gerente o dueño): totales por forma de pago, por
--    mesa y por origen (cobro o suelta: la propina del cobro también se puede
--    guardar por la API con la bandera apagada; aquí se ve aparte), cada
--    propina con su RP, los RPs dados de baja cuya parte va al personal, el
--    personal que puede entrar al reparto y el reparto vigente.
-- ----------------------------------------------------------------------------
create function public.propinas_reporte_noche(p_club_id uuid, p_fecha date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_noche public.caja_noches%rowtype;
  v_cfg record;
  v_reparto public.propinas_repartos%rowtype;
  v_config jsonb;
begin
  if not coalesce(public.es_gerente_o_dueno(p_club_id), false) then
    raise exception 'Solo el gerente o el dueño ven el reporte de propinas' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(p_club_id, 'propinas'), false) then
    raise exception 'Las propinas no están activas en este antro.' using errcode = 'P0001';
  end if;
  if p_fecha is null then
    raise exception 'Elige la noche' using errcode = 'P0001';
  end if;
  select * into v_cfg from public.propinas_regla(p_club_id);
  v_config := jsonb_build_object('pct_personal', v_cfg.pct_personal, 'pct_rp', v_cfg.pct_rp, 'pct_casa', v_cfg.pct_casa,
                                 'incluye_gerente', v_cfg.incluye_gerente, 'por_defecto', v_cfg.por_defecto,
                                 'actualizado_en', v_cfg.actualizado_en);

  select * into v_noche from public.caja_noches where club_id = p_club_id and fecha_operacion = p_fecha;
  if not found then
    return jsonb_build_object('fecha', p_fecha, 'noche_id', null, 'estado', null, 'total_centavos', 0,
      'por_metodo', jsonb_build_object('efectivo', 0, 'tarjeta', 0, 'otro', 0), 'por_mesa', '[]'::jsonb,
      'por_origen', jsonb_build_object('cobro', 0, 'cobro_n', 0, 'suelta', 0, 'suelta_n', 0),
      'propinas', '[]'::jsonb, 'rp_de_baja', '[]'::jsonb, 'personal', '[]'::jsonb, 'reparto', null, 'config', v_config);
  end if;
  select * into v_reparto from public.propinas_repartos where noche_id = v_noche.id and not anulado;

  return jsonb_build_object(
    'fecha', p_fecha,
    'noche_id', v_noche.id,
    'estado', v_noche.estado,
    'total_centavos', (select coalesce(sum(t.monto_centavos), 0) from public.propinas_de_noche(v_noche.id) t),
    'por_metodo', (select jsonb_build_object(
        'efectivo', coalesce(sum(t.monto_centavos) filter (where t.metodo = 'efectivo'), 0),
        'tarjeta', coalesce(sum(t.monto_centavos) filter (where t.metodo = 'tarjeta'), 0),
        'otro', coalesce(sum(t.monto_centavos) filter (where t.metodo = 'otro'), 0))
      from public.propinas_de_noche(v_noche.id) t),
    'por_origen', (select jsonb_build_object(
        'cobro', coalesce(sum(t.monto_centavos) filter (where t.origen = 'cobro'), 0),
        'cobro_n', count(*) filter (where t.origen = 'cobro'),
        'suelta', coalesce(sum(t.monto_centavos) filter (where t.origen = 'suelta'), 0),
        'suelta_n', count(*) filter (where t.origen = 'suelta'))
      from public.propinas_de_noche(v_noche.id) t),
    'por_mesa', coalesce((select jsonb_agg(jsonb_build_object('sesion_id', m.sesion_id, 'mesa', m.mesa, 'total_centavos', m.total)
                                   order by m.mesa nulls last)
        from (select t.sesion_id, ct.numero as mesa, sum(t.monto_centavos) as total
                from public.propinas_de_noche(v_noche.id) t
                left join public.mesa_sesiones s on s.id = t.sesion_id
                left join public.club_tables ct on ct.id = s.mesa_id
               group by t.sesion_id, ct.numero) m), '[]'::jsonb),
    'propinas', coalesce((select jsonb_agg(jsonb_build_object(
          'id', d.id, 'origen', d.origen, 'sesion_id', d.sesion_id, 'mesa', ct.numero, 'cuenta', mc.cliente_nombre,
          'rp', rp.nombre, 'rp_de_baja', case when d.rp_cuenta is not null and d.rp_id is null then rpc.nombre end,
          'metodo', d.metodo, 'monto_centavos', d.monto_centavos, 'nota', d.nota,
          'registrado_por', pf.nombre, 'registrado_en', d.registrado_en, 'anulado', d.anulado,
          'motivo_anulacion', d.motivo_anulacion)
          order by d.registrado_en, d.id)
        from public.propinas_detalle(v_noche.id) d
        left join public.mesa_sesiones s on s.id = d.sesion_id
        left join public.club_tables ct on ct.id = s.mesa_id
        left join public.mesa_cuentas mc on mc.id = d.cuenta_id
        left join public.profiles rp on rp.id = d.rp_id
        left join public.profiles rpc on rpc.id = d.rp_cuenta
        left join public.profiles pf on pf.id = d.registrado_por), '[]'::jsonb),
    'rp_de_baja', coalesce((select jsonb_agg(distinct pf.nombre)
        from public.propinas_detalle(v_noche.id) d join public.profiles pf on pf.id = d.rp_cuenta
       where not d.anulado and d.rp_cuenta is not null and d.rp_id is null), '[]'::jsonb),
    'personal', coalesce((select jsonb_agg(jsonb_build_object('id', pf.id, 'nombre', pf.nombre, 'rol', pf.role,
          'trabajo', exists (select 1 from public.caja_consumos k where k.noche_id = v_noche.id and k.registrado_por = pf.id)
                  or exists (select 1 from public.caja_pagos k where k.noche_id = v_noche.id and k.registrado_por = pf.id)
                  or exists (select 1 from public.caja_propinas k where k.noche_id = v_noche.id and k.registrado_por = pf.id)
                  or exists (select 1 from public.mesa_sesiones k where k.noche_id = v_noche.id and k.abierta_por = pf.id))
          order by pf.nombre)
        from public.profiles pf
       where pf.club_id = p_club_id and pf.activo is not false
         and (pf.role = 'staff' or (pf.role = 'gerente' and v_cfg.incluye_gerente))), '[]'::jsonb),
    'reparto', case when v_reparto.id is null then null else jsonb_build_object(
        'id', v_reparto.id, 'total_centavos', v_reparto.total_centavos, 'hecho_en', v_reparto.hecho_en,
        'hecho_por', (select pf.nombre from public.profiles pf where pf.id = v_reparto.hecho_por),
        'pct_personal', v_reparto.pct_personal, 'pct_rp', v_reparto.pct_rp, 'pct_casa', v_reparto.pct_casa,
        'lineas', coalesce((select jsonb_agg(jsonb_build_object('tipo', l.tipo, 'profile_id', l.profile_id,
                       'nombre', coalesce(pf.nombre, 'La casa'), 'monto_centavos', l.monto_centavos)
                       order by l.tipo, pf.nombre)
            from public.propinas_reparto_lineas l left join public.profiles pf on pf.id = l.profile_id
           where l.reparto_id = v_reparto.id), '[]'::jsonb)) end,
    'config', v_config);
end;
$$;


-- ----------------------------------------------------------------------------
-- 10. Quién puede llamar.
-- ----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.caja_registrar_propina(uuid, uuid, uuid, text, bigint, text, uuid)',
    'public.caja_anular_propina(uuid, text)',
    'public.propinas_anular_de_cobro(uuid, text)',
    'public.propinas_config_leer(uuid)',
    'public.propinas_config_guardar(uuid, int, int, int, boolean)',
    'public.propinas_calcular(uuid, uuid[], int, int, int, boolean)',
    'public.propinas_repartir(uuid, uuid[], bigint, int, int, int, boolean)',
    'public.propinas_anular_reparto(uuid, text)',
    'public.propinas_reporte_noche(uuid, date)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end;
$$;

commit;
