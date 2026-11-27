-- ============================================================================
-- AntroApp — Lista negra y política de no-show por antro (noche 4, bloque 4)
-- Fecha: 2026-11-27. Rollback: sql/post-junta-3/40-lista-negra-rollback.sql
-- Prueba (dev): node scripts/dev/probar-lista-negra.mjs
-- Requiere: 00-funciones-club.sql (bandera 'lista_negra'), pase 1 (caja_noches,
-- mesa_cuentas, caja_consumos, grupos, club_fecha_operacion).
--
-- Detrás de la bandera por antro 'lista_negra' (APAGADA por defecto). Con la
-- bandera apagada nada de esto cambia la reserva: el trigger nuevo regresa
-- sin revisar nada y las funciones de gestión responden "no está activa".
--
-- Qué hay:
--   - club_bloqueos: bloqueos MANUALES de un antro por teléfono normalizado
--     (lista_negra_tel: 10 dígitos de México, o todos los dígitos si no es un
--     número de México) y, si se conoce, por cuenta de cliente. Motivo obligatorio,
--     quién y cuándo, vencimiento opcional, desbloqueo con motivo. Nada se
--     borra: el desbloqueo cierra la fila (trigger lista_negra_sin_borrar).
--   - club_noshow_politica: avisar desde N no-shows en M días y, opcional
--     (apagado por defecto), bloquear en automático desde K.
--   - lista_negra_eventos: bitácora (bloqueo, desbloqueo, ver teléfono,
--     cambio de política, tachado). Un desbloqueo también "perdona" los
--     no-shows hasta la última noche terminada, para el bloqueo automático.
--   - Triggers reservations_lista_negra (AFTER INSERT) y
--     reservations_lista_negra_cambio (AFTER UPDATE de teléfono, antro, cuenta
--     o fecha), NUEVOS y aparte: los triggers y políticas que ya tiene
--     reservations no se tocan. Son AFTER a propósito: antes corren las
--     políticas (RLS), los CHECK, el índice único y el límite de reservas sin
--     cuenta (72); solo una reserva que de verdad se guardaría llega a
--     preguntar por la lista. Si el teléfono o la cuenta están bloqueados en
--     ESE antro, rechaza con P0001 (lanzar en un AFTER deshace la fila).
--     Al cliente y al anónimo, un mensaje neutro (sin motivo ni "lista");
--     al RP y al staff, uno más claro, también sin motivo.
--   - Índice reservations_club_tel_fecha (club, teléfono normalizado, fecha)
--     para contar no-shows de un teléfono sin recorrer todo el antro.
--
-- No-show (misma definición que rp_mis_reservas "No llegó" y el cierre de la
-- noche "no_llegaron"): reserva del antro que NO entró (puerta_estado 'entro'
-- o status 'usada'), sin consumo en caja, y cuya noche ya terminó (fecha
-- anterior a la noche operativa del antro, corte 08:00, o caja de esa noche
-- cerrada). Se cuenta por teléfono normalizado y por antro (nunca se mezclan
-- antros), por NOCHES distintas (tres reservas de una noche son un no-show).
-- Para el bloqueo automático solo cuentan las reservas con cuenta de cliente
-- o hechas por un RP: las reservas sin cuenta las puede hacer cualquiera con
-- el teléfono de otro.
--
-- Quién: gestionan (ven motivos, bloquean, desbloquean, cambian la política)
-- el gerente activo del antro, el dueño, el dueño del grupo del antro y el
-- admin. El staff solo ve avisos (cuántos no-shows, "bloqueado") en la
-- lista de la noche, nunca el motivo. El RP solo ve el aviso de no-shows de
-- SUS reservas. Nadie fuera del antro (ni el dueño de otro antro) ve nada.
-- Las tablas no se leen por la API: todo pasa por estas funciones.
-- Tachar (ARCO): lista_negra_tachar, solo admin, cambia motivos por
-- «[tachado]» y lo registra.
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
create table public.club_bloqueos (
  id                 uuid primary key default gen_random_uuid(),
  club_id            uuid not null references public.clubs (id) on delete cascade,
  telefono           text not null check (telefono ~ '^[0-9]{8,15}$'),
  cliente_id         uuid references public.profiles (id) on delete set null,
  nombre             text check (nombre is null or char_length(nombre) <= 80),
  motivo             text not null check (char_length(btrim(motivo)) between 3 and 300),
  bloqueado_por      uuid references public.profiles (id) on delete set null,
  bloqueado_en       timestamptz not null default now(),
  vence_en           timestamptz,
  desbloqueado_por   uuid references public.profiles (id) on delete set null,
  desbloqueado_en    timestamptz,
  motivo_desbloqueo  text check (motivo_desbloqueo is null or char_length(btrim(motivo_desbloqueo)) between 3 and 300),
  check (vence_en is null or vence_en > bloqueado_en),
  check ((desbloqueado_en is null) = (motivo_desbloqueo is null))
);
-- Un solo bloqueo abierto por teléfono y antro.
create unique index club_bloqueos_abierto on public.club_bloqueos (club_id, telefono) where desbloqueado_en is null;
create index club_bloqueos_cliente on public.club_bloqueos (club_id, cliente_id)
  where cliente_id is not null and desbloqueado_en is null;
create index club_bloqueos_club_fecha on public.club_bloqueos (club_id, bloqueado_en desc);

create table public.club_noshow_politica (
  club_id         uuid primary key references public.clubs (id) on delete cascade,
  avisar_desde    integer not null check (avisar_desde between 1 and 20),
  ventana_dias    integer not null check (ventana_dias between 7 and 365),
  bloquear_desde  integer check (bloquear_desde is null or bloquear_desde between 1 and 50),
  cambiado_por    uuid references public.profiles (id) on delete set null,
  cambiado_en     timestamptz not null default now(),
  check (bloquear_desde is null or bloquear_desde >= avisar_desde)
);

create table public.lista_negra_eventos (
  id          bigint generated always as identity primary key,
  club_id     uuid not null references public.clubs (id) on delete cascade,
  tipo        text not null check (tipo in ('bloqueo', 'desbloqueo', 'ver_telefono', 'politica', 'tachado')),
  telefono    text check (telefono is null or telefono ~ '^[0-9]{8,15}$'),
  bloqueo_id  uuid references public.club_bloqueos (id),
  detalle     jsonb not null default '{}'::jsonb,
  hecho_por   uuid references public.profiles (id) on delete set null,
  hecho_en    timestamptz not null default now()
);
create index lista_negra_eventos_club on public.lista_negra_eventos (club_id, hecho_en desc);
create index lista_negra_eventos_tel on public.lista_negra_eventos (club_id, telefono, hecho_en desc)
  where tipo = 'desbloqueo';

-- Sin acceso directo por la API (en producción lo nuevo nace abierto a anon
-- y authenticated: se quita explícito).
alter table public.club_bloqueos enable row level security;
alter table public.club_noshow_politica enable row level security;
alter table public.lista_negra_eventos enable row level security;
revoke all on public.club_bloqueos, public.club_noshow_politica, public.lista_negra_eventos from public, anon, authenticated;
grant all on public.club_bloqueos, public.club_noshow_politica, public.lista_negra_eventos to service_role;
revoke all on sequence public.lista_negra_eventos_id_seq from public, anon, authenticated;
grant usage, select on sequence public.lista_negra_eventos_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- Nada se borra: un bloqueo solo pasa de abierto a desbloqueado, una vez; la
-- bitácora no cambia. Lo único que se permite además es:
--   - que un *_por o el cliente_id queden en NULL (on delete set null al
--     borrar un perfil);
--   - el borrado en cascada al borrar el antro (el antro ya no existe);
--   - tachar motivos con «[tachado]» desde lista_negra_tachar (admin), que
--     enciende antroapp.tachado solo dentro de su transacción.
-- Para limpiar pruebas en dev: el rol postgres (dueño de la base: SQL Editor
-- o DATABASE_URL, nunca la API) con antroapp.borrado_pruebas = 'on'. Existe
-- igual en producción y lo puede usar solo quien tenga esa contraseña.
-- ---------------------------------------------------------------------------
create function public.lista_negra_sin_borrar()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old    jsonb;
  v_new    jsonb;
  v_tachar boolean;
begin
  if current_user = 'postgres' and current_setting('antroapp.borrado_pruebas', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    -- Cascada desde clubs: cuando corre, el antro ya se borró.
    if not exists (select 1 from public.clubs c where c.id = old.club_id) then
      return old;
    end if;
    raise exception 'En la lista negra nada se borra: se desbloquea con motivo (%)', tg_table_name;
  end if;
  if tg_op = 'TRUNCATE' then
    raise exception 'En la lista negra nada se borra: se desbloquea con motivo (%)', tg_table_name;
  end if;

  v_old := to_jsonb(old);
  v_new := to_jsonb(new);
  v_tachar := coalesce(current_setting('antroapp.tachado', true) = 'on', false);
  if tg_table_name = 'lista_negra_eventos' then
    if v_tachar and (v_new - array['hecho_por', 'detalle']) = (v_old - array['hecho_por', 'detalle'])
       and (new.detalle - 'motivo') = (old.detalle - 'motivo')
       and coalesce(new.detalle ->> 'motivo', '[tachado]') = '[tachado]'
       and new.hecho_por is not distinct from old.hecho_por then
      return new;
    end if;
    if (v_new - 'hecho_por') is distinct from (v_old - 'hecho_por')
       or (new.hecho_por is not null and new.hecho_por is distinct from old.hecho_por) then
      raise exception 'La bitácora de la lista negra no se modifica';
    end if;
    return new;
  end if;

  -- club_bloqueos. Tachado: motivo y motivo de desbloqueo a «[tachado]»,
  -- nombre a NULL; nada más.
  if v_tachar then
    if (new.motivo is distinct from old.motivo and new.motivo <> '[tachado]')
       or (new.motivo_desbloqueo is distinct from old.motivo_desbloqueo and new.motivo_desbloqueo is distinct from '[tachado]')
       or (new.nombre is distinct from old.nombre and new.nombre is not null) then
      raise exception 'Solo se puede tachar';
    end if;
    v_old := v_old - array['motivo', 'motivo_desbloqueo', 'nombre'];
    v_new := v_new - array['motivo', 'motivo_desbloqueo', 'nombre'];
  end if;
  if (v_new - array['bloqueado_por', 'desbloqueado_por', 'cliente_id', 'desbloqueado_en', 'motivo_desbloqueo'])
       is distinct from (v_old - array['bloqueado_por', 'desbloqueado_por', 'cliente_id', 'desbloqueado_en', 'motivo_desbloqueo'])
     or (new.bloqueado_por is not null and new.bloqueado_por is distinct from old.bloqueado_por)
     or (new.cliente_id is not null and new.cliente_id is distinct from old.cliente_id) then
    raise exception 'Un bloqueo no se edita: se desbloquea con motivo y se crea otro';
  end if;
  if old.desbloqueado_en is not null then
    if new.desbloqueado_en is distinct from old.desbloqueado_en
       or (new.motivo_desbloqueo is distinct from old.motivo_desbloqueo and not v_tachar)
       or (new.desbloqueado_por is not null and new.desbloqueado_por is distinct from old.desbloqueado_por) then
      raise exception 'Ese bloqueo ya se cerró';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.lista_negra_sin_borrar() from public, anon, authenticated;

create trigger club_bloqueos_sin_borrar before update or delete on public.club_bloqueos
  for each row execute function public.lista_negra_sin_borrar();
create trigger club_bloqueos_sin_truncar before truncate on public.club_bloqueos
  for each statement execute function public.lista_negra_sin_borrar();
create trigger lista_negra_eventos_sin_borrar before update or delete on public.lista_negra_eventos
  for each row execute function public.lista_negra_sin_borrar();
create trigger lista_negra_eventos_sin_truncar before truncate on public.lista_negra_eventos
  for each statement execute function public.lista_negra_sin_borrar();

-- ---------------------------------------------------------------------------
-- Ayudantes internos (no se llaman desde la API)
-- ---------------------------------------------------------------------------

-- Clave del teléfono (igual que claveTelefono en lib/domain/whatsapp.ts):
-- se toman solo los dígitos y, si es un número de México en una forma
-- conocida (10 dígitos; 52+10; 521+10; 044/045+10; 01+10), sus 10 dígitos.
-- Cualquier otra cosa de 8 a 15 dígitos se queda COMPLETA (no se recorta:
-- recortar a "los últimos 10" dejaba esquivar un bloqueo agregando dígitos).
-- Menos de 8 o más de 15: NULL.
-- EXECUTE para anon y authenticated: lo necesita el índice por expresión de
-- reservations (Postgres revisa el permiso de la función al insertar). Es
-- pura (IMMUTABLE, sin leer tablas, sin SECURITY DEFINER): llamarla por la
-- API solo devuelve los dígitos de lo que uno mismo manda.
create function public.lista_negra_tel(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when d ~ '^[0-9]{10}$' then d
    when d ~ '^52[0-9]{10}$' then substr(d, 3)
    when d ~ '^521[0-9]{10}$' then substr(d, 4)
    when d ~ '^04[45][0-9]{10}$' then substr(d, 4)
    when d ~ '^01[0-9]{10}$' then substr(d, 3)
    when char_length(d) between 8 and 15 then d
  end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x;
$$;
revoke all on function public.lista_negra_tel(text) from public;
grant execute on function public.lista_negra_tel(text) to anon, authenticated, service_role;

-- Para contar no-shows de un teléfono sin recorrer todas las reservas del
-- antro (se usa en cada reserva si el bloqueo automático está encendido).
create index reservations_club_tel_fecha
  on public.reservations (club_id, public.lista_negra_tel(cliente_telefono), fecha);

create function public._lista_negra_mascara(p_tel text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_tel is null then null else '***' || right(p_tel, 4) end;
$$;
revoke all on function public._lista_negra_mascara(text) from public, anon, authenticated;
grant execute on function public._lista_negra_mascara(text) to service_role;

-- Gestiona la lista de un antro: gerente activo de ESE antro, dueño, dueño
-- del grupo del antro o admin. Nunca NULL.
create function public._lista_negra_gestiona(p_club uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    auth.uid() is not null
    and not coalesce(public.sesion_sin_acceso(), true)
    and (public.current_role_name() = 'admin'
         or public.club_es_dueno(p_club)
         or public.club_es_dueno_grupo(p_club)
         or (public.current_role_name() = 'gerente' and public.current_club_id() = p_club
             and exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo))),
    false);
$$;
revoke all on function public._lista_negra_gestiona(uuid) from public, anon, authenticated;
grant execute on function public._lista_negra_gestiona(uuid) to service_role;

-- Trabaja la puerta del antro (avisos sin motivo): lo anterior o staff
-- activo de ESE antro. Nunca NULL.
create function public._lista_negra_ve_avisos(p_club uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    public._lista_negra_gestiona(p_club)
    or (auth.uid() is not null
        and not coalesce(public.sesion_sin_acceso(), true)
        and public.current_role_name() in ('staff', 'gerente')
        and public.current_club_id() = p_club
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo)),
    false);
$$;
revoke all on function public._lista_negra_ve_avisos(uuid) from public, anon, authenticated;
grant execute on function public._lista_negra_ve_avisos(uuid) to service_role;

-- Política vigente (o la de fábrica: avisar desde 2 en 90 días, sin
-- bloqueo automático).
create function public._lista_negra_politica(p_club uuid, out avisar_desde int, out ventana_dias int,
                                             out bloquear_desde int, out propia boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p.avisar_desde, 2), coalesce(p.ventana_dias, 90), p.bloquear_desde, p.club_id is not null
  from (select 1) x
  left join public.club_noshow_politica p on p.club_id = p_club;
$$;
revoke all on function public._lista_negra_politica(uuid) from public, anon, authenticated;
grant execute on function public._lista_negra_politica(uuid) to service_role;

-- No-shows de un antro desde una noche, por teléfono normalizado (p_tel NULL
-- = todos). Definición en el encabezado.
--   no_shows = NOCHES distintas sin llegar (cualquier reserva);
--   cuentan  = noches distintas que cuentan para el bloqueo automático: solo
--              reservas de RP o de cliente con cuenta, y posteriores al
--              último desbloqueo (detalle.perdona_hasta, la última noche que
--              ya había terminado al desbloquear).
-- Con p_tel el filtro va por el índice reservations_club_tel_fecha (SQL
-- dinámico: así el plan usa el valor real y no un "p_tel is null or …").
create function public._lista_negra_noshows(p_club uuid, p_desde date, p_tel text)
returns table (telefono text, no_shows int, cuentan int, ultima_fecha date, ultimo_nombre text,
               ultima_reserva uuid, cliente_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hoy date := public.club_fecha_operacion(p_club);
begin
  return query execute format($q$
    with base as (
      select r.id, r.fecha, r.cliente_nombre, r.cliente_id, r.created_at, r.source,
             public.lista_negra_tel(r.cliente_telefono) as tel
      from public.reservations r
      where r.club_id = $1
        and r.fecha >= $2
        and r.fecha <= $3
        %s
        and not coalesce(coalesce(r.puerta_estado, case when r.status = 'usada' then 'entro' end) = 'entro', false)
        and (r.fecha < $3
             or exists (select 1 from public.caja_noches n
                        where n.club_id = $1 and n.fecha_operacion = r.fecha and n.estado = 'cerrada'))
        and not exists (select 1 from public.mesa_cuentas mc
                        join public.caja_consumos k on k.cuenta_id = mc.id and not k.anulado
                        where mc.reservation_id = r.id and k.monto_centavos > 0)
    ),
    ns as (
      select b.* from base b where b.tel is not null
    ),
    perdon as (
      select e.telefono, max((e.detalle ->> 'perdona_hasta')::date) as hasta
      from public.lista_negra_eventos e
      where e.club_id = $1 and e.tipo = 'desbloqueo' and e.telefono in (select tel from ns)
      group by e.telefono
    )
    select ns.tel,
           count(distinct ns.fecha)::int,
           (count(distinct ns.fecha) filter (where (ns.source = 'rp' or ns.cliente_id is not null)
                                               and (pd.hasta is null or ns.fecha > pd.hasta)))::int,
           max(ns.fecha),
           (array_agg(ns.cliente_nombre order by ns.fecha desc, ns.created_at desc))[1],
           (array_agg(ns.id order by ns.fecha desc, ns.created_at desc))[1],
           (array_agg(ns.cliente_id order by ns.fecha desc, ns.created_at desc) filter (where ns.cliente_id is not null))[1]
    from ns
    left join perdon pd on pd.telefono = ns.tel
    group by ns.tel
  $q$, case when p_tel is null then '' else 'and public.lista_negra_tel(r.cliente_telefono) = $4' end)
  using p_club, p_desde, v_hoy, p_tel;
end;
$$;
revoke all on function public._lista_negra_noshows(uuid, date, text) from public, anon, authenticated;
grant execute on function public._lista_negra_noshows(uuid, date, text) to service_role;

-- ¿Bloqueo automático? Solo si la política lo tiene encendido.
create function public._lista_negra_auto(p_club uuid, p_tel text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pol record;
  v_n   int;
begin
  if p_tel is null then
    return false;
  end if;
  select * into v_pol from public._lista_negra_politica(p_club);
  if v_pol.bloquear_desde is null then
    return false;
  end if;
  select coalesce(max(x.cuentan), 0) into v_n
  from public._lista_negra_noshows(p_club, public.club_fecha_operacion(p_club) - v_pol.ventana_dias, p_tel) x;
  return coalesce(v_n >= v_pol.bloquear_desde, false);
end;
$$;
revoke all on function public._lista_negra_auto(uuid, text) from public, anon, authenticated;
grant execute on function public._lista_negra_auto(uuid, text) to service_role;

-- Bloqueo manual abierto y vigente (por teléfono o por cuenta). p_tel es la
-- clave de lista_negra_tel.
create function public._lista_negra_manual(p_club uuid, p_tel text, p_cliente uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1 from public.club_bloqueos b
    where b.club_id = p_club
      and b.desbloqueado_en is null
      and (b.vence_en is null or b.vence_en > now())
      and ((p_tel is not null and b.telefono = p_tel)
           -- Un número que no es de México (dígitos de más o de menos) y que
           -- CONTIENE uno bloqueado cuenta como ese: "+52 1 331 999 8877 1"
           -- no esquiva el bloqueo de 3319998877.
           or (p_tel is not null and p_tel !~ '^[0-9]{10}$' and b.telefono ~ '^[0-9]{10}$'
               and strpos(p_tel, b.telefono) > 0)
           or (p_cliente is not null and b.cliente_id = p_cliente))), false);
$$;
revoke all on function public._lista_negra_manual(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public._lista_negra_manual(uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Triggers nuevos en reservations (AFTER INSERT y AFTER UPDATE de teléfono,
-- antro, cuenta o fecha). AFTER: antes ya pasaron RLS, CHECK, el índice
-- único y el límite de reservas sin cuenta; una inserción que de todos
-- modos se rechazaría no llega aquí (no sirve para probar teléfonos).
-- SECURITY DEFINER: corre para anon y authenticated, que no pueden ejecutar
-- funcion_activa ni leer club_bloqueos. Solo lo que llega por la API
-- (claims anon/authenticated): la service role y postgres (scripts) pasan
-- igual que hoy.
-- ---------------------------------------------------------------------------
create function public.reservations_lista_negra()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Rol del JWT (nunca NULL: sin claims queda '' y pasa como hoy).
  v_jwt_rol text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '');
  v_tel text;
begin
  if coalesce(v_jwt_rol not in ('anon', 'authenticated'), true) or new.club_id is null then
    return null;
  end if;
  -- Un cambio que no toca el teléfono (normalizado), el antro, la cuenta ni
  -- la noche no se vuelve a revisar.
  if tg_op = 'UPDATE'
     and public.lista_negra_tel(old.cliente_telefono) is not distinct from public.lista_negra_tel(new.cliente_telefono)
     and old.club_id is not distinct from new.club_id
     and old.cliente_id is not distinct from new.cliente_id
     and old.fecha is not distinct from new.fecha then
    return null;
  end if;
  -- Bandera apagada: la reserva sigue exactamente como hoy.
  if not coalesce(public.funcion_activa(new.club_id, 'lista_negra'), false) then
    return null;
  end if;

  v_tel := public.lista_negra_tel(new.cliente_telefono);
  if coalesce(public._lista_negra_manual(new.club_id, v_tel, new.cliente_id), false)
     or coalesce(public._lista_negra_auto(new.club_id, v_tel), false) then
    if tg_op = 'UPDATE' then
      raise exception 'Ese cliente no puede reservar en este antro por ahora (lo revisa el gerente).'
        using errcode = 'P0001';
    end if;
    if v_jwt_rol = 'authenticated' and coalesce(public.current_role_name() = 'rp', false) then
      raise exception 'Este cliente no puede reservar en este antro por ahora. Si crees que es un error, habla con tu gerente.'
        using errcode = 'P0001';
    end if;
    -- Neutro: no dice "bloqueado", ni motivo, ni desde cuándo.
    raise exception 'No pudimos apartar tu lugar en este antro. Comunícate directamente con el antro.'
      using errcode = 'P0001';
  end if;
  return null;
end;
$$;
revoke all on function public.reservations_lista_negra() from public, anon, authenticated;

create trigger reservations_lista_negra after insert on public.reservations
  for each row execute function public.reservations_lista_negra();
create trigger reservations_lista_negra_cambio
  after update of cliente_telefono, club_id, cliente_id, fecha on public.reservations
  for each row
  when (old.cliente_telefono is distinct from new.cliente_telefono or old.club_id is distinct from new.club_id
        or old.cliente_id is distinct from new.cliente_id or old.fecha is distinct from new.fecha)
  execute function public.reservations_lista_negra();

-- ---------------------------------------------------------------------------
-- Funciones para la app
-- ---------------------------------------------------------------------------

-- Revisión común de las funciones de gestión.
create function public._lista_negra_exigir(p_club uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not coalesce(public._lista_negra_gestiona(p_club), false) then
    raise exception 'No tienes acceso a la lista de clientes de este antro.' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(p_club, 'lista_negra'), false) then
    raise exception 'La lista negra no está activa en este antro.' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public._lista_negra_exigir(uuid) from public, anon, authenticated;
grant execute on function public._lista_negra_exigir(uuid) to service_role;

-- Política del antro (gestores).
create function public.lista_negra_politica(p_club uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform public._lista_negra_exigir(p_club);
  select * into v from public._lista_negra_politica(p_club);
  return jsonb_build_object('avisar_desde', v.avisar_desde, 'ventana_dias', v.ventana_dias,
                            'bloquear_desde', v.bloquear_desde, 'propia', v.propia);
end;
$$;
revoke all on function public.lista_negra_politica(uuid) from public, anon;
grant execute on function public.lista_negra_politica(uuid) to authenticated, service_role;

create function public.lista_negra_politica_guardar(p_club uuid, p_avisar_desde int, p_ventana_dias int,
                                                    p_bloquear_desde int)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_antes record;
begin
  perform public._lista_negra_exigir(p_club);
  if p_avisar_desde is null or p_avisar_desde not between 1 and 20 then
    raise exception 'El aviso va de 1 a 20 no-shows.' using errcode = 'P0001';
  end if;
  if p_ventana_dias is null or p_ventana_dias not between 7 and 365 then
    raise exception 'La ventana va de 7 a 365 días.' using errcode = 'P0001';
  end if;
  if p_bloquear_desde is not null and (p_bloquear_desde not between 1 and 50 or p_bloquear_desde < p_avisar_desde) then
    raise exception 'El bloqueo automático va de 1 a 50 no-shows y no puede ser menor que el aviso.' using errcode = 'P0001';
  end if;
  select * into v_antes from public._lista_negra_politica(p_club);
  insert into public.club_noshow_politica (club_id, avisar_desde, ventana_dias, bloquear_desde, cambiado_por)
  values (p_club, p_avisar_desde, p_ventana_dias, p_bloquear_desde, auth.uid())
  on conflict (club_id) do update
    set avisar_desde = excluded.avisar_desde, ventana_dias = excluded.ventana_dias,
        bloquear_desde = excluded.bloquear_desde, cambiado_por = excluded.cambiado_por, cambiado_en = now();
  insert into public.lista_negra_eventos (club_id, tipo, detalle, hecho_por)
  values (p_club, 'politica',
          jsonb_build_object(
            'antes', jsonb_build_object('avisar_desde', v_antes.avisar_desde, 'ventana_dias', v_antes.ventana_dias,
                                        'bloquear_desde', v_antes.bloquear_desde),
            'despues', jsonb_build_object('avisar_desde', p_avisar_desde, 'ventana_dias', p_ventana_dias,
                                          'bloquear_desde', p_bloquear_desde)),
          auth.uid());
end;
$$;
revoke all on function public.lista_negra_politica_guardar(uuid, int, int, int) from public, anon;
grant execute on function public.lista_negra_politica_guardar(uuid, int, int, int) to authenticated, service_role;

-- Bloquear: por teléfono escrito o desde una reserva del antro (toma su
-- teléfono y, si la hizo un cliente con cuenta, su cuenta). p_dias NULL =
-- sin vencimiento. p_nombre: nombre de referencia (solo con teléfono escrito).
create function public.lista_negra_bloquear(p_club uuid, p_telefono text, p_reserva_id uuid,
                                            p_motivo text, p_dias int, p_nombre text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tel     text;
  v_cliente uuid;
  v_nombre  text;
  v_id      uuid;
  v_motivo  text := btrim(coalesce(p_motivo, ''));
begin
  perform public._lista_negra_exigir(p_club);
  if char_length(v_motivo) not between 3 and 300 then
    raise exception 'Escribe el motivo (de 3 a 300 letras). Solo lo ven los gerentes y el dueño.' using errcode = 'P0001';
  end if;
  if p_dias is not null and p_dias not between 1 and 730 then
    raise exception 'El vencimiento va de 1 a 730 días (o sin vencimiento).' using errcode = 'P0001';
  end if;
  if p_reserva_id is not null then
    select public.lista_negra_tel(r.cliente_telefono), r.cliente_id, left(btrim(r.cliente_nombre), 80)
      into v_tel, v_cliente, v_nombre
    from public.reservations r
    where r.id = p_reserva_id and r.club_id = p_club;
    if not found then
      raise exception 'No encontramos esa reserva en este antro.' using errcode = 'P0001';
    end if;
  else
    v_tel := public.lista_negra_tel(p_telefono);
    v_nombre := nullif(left(btrim(coalesce(p_nombre, '')), 80), '');
  end if;
  if v_tel is null then
    raise exception 'Escribe un teléfono de 10 dígitos (o completo, con lada, si no es de México).' using errcode = 'P0001';
  end if;

  -- Un candado por antro y teléfono (bloque 9, C5 «D1»): sin él, dos
  -- bloqueos del mismo teléfono a la vez pasaban los dos el «if exists» y el
  -- segundo chocaba en el índice único (veía «Eso ya está registrado»). Con
  -- el candado el segundo espera y recibe el aviso claro de abajo.
  perform pg_advisory_xact_lock(hashtextextended('lista_negra|' || p_club::text || '|' || v_tel, 0));
  -- Un bloqueo vencido que sigue abierto se cierra (queda en el historial).
  update public.club_bloqueos b
     set desbloqueado_en = b.vence_en, motivo_desbloqueo = 'Venció.'
   where b.club_id = p_club and b.telefono = v_tel and b.desbloqueado_en is null
     and b.vence_en is not null and b.vence_en <= now();
  if exists (select 1 from public.club_bloqueos b
             where b.club_id = p_club and b.telefono = v_tel and b.desbloqueado_en is null) then
    raise exception 'Ese teléfono ya está bloqueado en este antro.' using errcode = 'P0001';
  end if;

  insert into public.club_bloqueos (club_id, telefono, cliente_id, nombre, motivo, bloqueado_por, vence_en)
  values (p_club, v_tel, v_cliente, v_nombre, v_motivo, auth.uid(),
          case when p_dias is not null then now() + make_interval(days => p_dias) end)
  returning id into v_id;
  insert into public.lista_negra_eventos (club_id, tipo, telefono, bloqueo_id, detalle, hecho_por)
  values (p_club, 'bloqueo', v_tel, v_id, jsonb_build_object('motivo', v_motivo, 'dias', p_dias), auth.uid());
  return v_id;
end;
$$;
revoke all on function public.lista_negra_bloquear(uuid, text, uuid, text, int, text) from public, anon;
grant execute on function public.lista_negra_bloquear(uuid, text, uuid, text, int, text) to authenticated, service_role;

-- Desbloquear: cierra el bloqueo manual abierto (si hay) y "perdona" los
-- no-shows anteriores para el bloqueo automático. Por id del bloqueo o
-- desde una reserva del antro (lista de no-show).
create function public.lista_negra_desbloquear(p_club uuid, p_bloqueo_id uuid, p_reserva_id uuid, p_motivo text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tel    text;
  v_motivo text := btrim(coalesce(p_motivo, ''));
  v_manual uuid;
  v_auto   boolean;
  v_hoy    date;
  v_hasta  date;
begin
  perform public._lista_negra_exigir(p_club);
  if char_length(v_motivo) not between 3 and 300 then
    raise exception 'Escribe el motivo del desbloqueo (de 3 a 300 letras).' using errcode = 'P0001';
  end if;
  -- Última noche que ya terminó: la de hoy si su caja está cerrada, si no
  -- la anterior. Los no-shows hasta esa noche dejan de contar (con ">").
  v_hoy := public.club_fecha_operacion(p_club);
  v_hasta := case when exists (select 1 from public.caja_noches n
                               where n.club_id = p_club and n.fecha_operacion = v_hoy and n.estado = 'cerrada')
                  then v_hoy else v_hoy - 1 end;
  if p_bloqueo_id is not null then
    select b.telefono into v_tel from public.club_bloqueos b where b.id = p_bloqueo_id and b.club_id = p_club;
  elsif p_reserva_id is not null then
    select public.lista_negra_tel(r.cliente_telefono) into v_tel
    from public.reservations r where r.id = p_reserva_id and r.club_id = p_club;
  end if;
  if v_tel is null then
    raise exception 'No encontramos ese bloqueo en este antro.' using errcode = 'P0001';
  end if;

  select b.id into v_manual from public.club_bloqueos b
  where b.club_id = p_club and b.telefono = v_tel and b.desbloqueado_en is null
    and (b.vence_en is null or b.vence_en > now())
  for update;
  v_auto := coalesce(public._lista_negra_auto(p_club, v_tel), false);
  if v_manual is null and not v_auto then
    raise exception 'Ese cliente no está bloqueado.' using errcode = 'P0001';
  end if;
  if v_manual is not null then
    update public.club_bloqueos
       set desbloqueado_en = now(), desbloqueado_por = auth.uid(), motivo_desbloqueo = v_motivo
     where id = v_manual;
  end if;
  insert into public.lista_negra_eventos (club_id, tipo, telefono, bloqueo_id, detalle, hecho_por)
  values (p_club, 'desbloqueo', v_tel, v_manual,
          jsonb_build_object('motivo', v_motivo, 'manual', v_manual is not null, 'automatico', v_auto,
                             'perdona_hasta', v_hasta), auth.uid());
end;
$$;
revoke all on function public.lista_negra_desbloquear(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.lista_negra_desbloquear(uuid, uuid, uuid, text) to authenticated, service_role;

-- Bloqueos del antro (gestores). Teléfono enmascarado; el completo, aparte
-- y con registro (lista_negra_ver_telefono).
create function public.lista_negra_bloqueos(p_club uuid, p_historial boolean default false)
returns table (id uuid, telefono_mascara text, nombre text, motivo text, con_cuenta boolean,
               bloqueado_por text, bloqueado_en timestamptz, vence_en timestamptz, estado text,
               desbloqueado_por text, desbloqueado_en timestamptz, motivo_desbloqueo text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public._lista_negra_exigir(p_club);
  return query
    select b.id, public._lista_negra_mascara(b.telefono), b.nombre, b.motivo, b.cliente_id is not null,
           pb.nombre, b.bloqueado_en, b.vence_en,
           case when b.desbloqueado_en is not null and b.motivo_desbloqueo = 'Venció.' and b.desbloqueado_por is null
                  then 'vencido'
                when b.desbloqueado_en is not null then 'desbloqueado'
                when b.vence_en is not null and b.vence_en <= now() then 'vencido'
                else 'activo' end,
           pd.nombre, b.desbloqueado_en, b.motivo_desbloqueo
    from public.club_bloqueos b
    left join public.profiles pb on pb.id = b.bloqueado_por
    left join public.profiles pd on pd.id = b.desbloqueado_por
    where b.club_id = p_club
      and (coalesce(p_historial, false)
           or (b.desbloqueado_en is null and (b.vence_en is null or b.vence_en > now())))
    order by b.bloqueado_en desc
    limit 500;
end;
$$;
revoke all on function public.lista_negra_bloqueos(uuid, boolean) from public, anon;
grant execute on function public.lista_negra_bloqueos(uuid, boolean) to authenticated, service_role;

-- Teléfono completo de un bloqueo, solo a pedido y con registro.
create function public.lista_negra_ver_telefono(p_club uuid, p_bloqueo_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tel text;
begin
  perform public._lista_negra_exigir(p_club);
  select b.telefono into v_tel from public.club_bloqueos b where b.id = p_bloqueo_id and b.club_id = p_club;
  if v_tel is null then
    raise exception 'No encontramos ese bloqueo en este antro.' using errcode = 'P0001';
  end if;
  insert into public.lista_negra_eventos (club_id, tipo, telefono, bloqueo_id, hecho_por)
  values (p_club, 'ver_telefono', v_tel, p_bloqueo_id, auth.uid());
  return v_tel;
end;
$$;
revoke all on function public.lista_negra_ver_telefono(uuid, uuid) from public, anon;
grant execute on function public.lista_negra_ver_telefono(uuid, uuid) to authenticated, service_role;

-- No-shows del antro en la ventana de la política (gestores).
create function public.lista_negra_noshows(p_club uuid)
returns table (ref_reserva uuid, telefono_mascara text, nombre text, no_shows int, cuentan int,
               ultima_fecha date, aviso boolean, bloqueado_manual boolean, bloqueado_auto boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pol record;
begin
  perform public._lista_negra_exigir(p_club);
  select * into v_pol from public._lista_negra_politica(p_club);
  return query
    select x.ultima_reserva, public._lista_negra_mascara(x.telefono), x.ultimo_nombre, x.no_shows, x.cuentan,
           x.ultima_fecha, x.no_shows >= v_pol.avisar_desde,
           public._lista_negra_manual(p_club, x.telefono, null),
           coalesce(v_pol.bloquear_desde is not null and x.cuentan >= v_pol.bloquear_desde, false)
    from public._lista_negra_noshows(p_club, public.club_fecha_operacion(p_club) - v_pol.ventana_dias, null) x
    order by x.no_shows desc, x.ultima_fecha desc
    limit 500;
end;
$$;
revoke all on function public.lista_negra_noshows(uuid) from public, anon;
grant execute on function public.lista_negra_noshows(uuid) to authenticated, service_role;

-- Historial (bitácora) del antro (gestores).
create function public.lista_negra_historial(p_club uuid, p_limite int default 100)
returns table (tipo text, telefono_mascara text, detalle jsonb, hecho_por text, hecho_en timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public._lista_negra_exigir(p_club);
  return query
    select e.tipo, public._lista_negra_mascara(e.telefono), e.detalle, p.nombre, e.hecho_en
    from public.lista_negra_eventos e
    left join public.profiles p on p.id = e.hecho_por
    where e.club_id = p_club
    order by e.hecho_en desc, e.id desc
    limit least(greatest(coalesce(p_limite, 100), 1), 500);
end;
$$;
revoke all on function public.lista_negra_historial(uuid, int) from public, anon;
grant execute on function public.lista_negra_historial(uuid, int) to authenticated, service_role;

-- Aviso de no-shows de UNA reserva (por id o por QR). Sin motivo, sin datos
-- de otros antros. Puede pedirlo: el RP dueño de la reserva, el staff y el
-- gerente del antro, el dueño, el dueño del grupo y el admin. "bloqueado"
-- solo para la puerta y los gestores (al RP le llega NULL). Bandera
-- apagada o sin permiso: {"activa": false}, sin error (no revela nada).
create function public.lista_negra_aviso(p_reserva_id uuid default null, p_qr text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_r      record;
  v_pol    record;
  v_n      int;
  v_puerta boolean;
  v_rp     boolean;
begin
  if auth.uid() is null then
    return jsonb_build_object('activa', false);
  end if;
  select r.id, r.club_id, r.rp_id, r.source, r.cliente_telefono, r.cliente_id into v_r
  from public.reservations r
  where (p_reserva_id is not null and r.id = p_reserva_id)
     or (p_reserva_id is null and p_qr is not null and r.qr_code = p_qr)
  limit 1;
  if v_r.id is null then
    return jsonb_build_object('activa', false);
  end if;
  v_puerta := coalesce(public._lista_negra_ve_avisos(v_r.club_id), false);
  v_rp := coalesce(v_r.source = 'rp' and v_r.rp_id = auth.uid()
                   and public.current_role_name() = 'rp'
                   and public.current_club_id() = v_r.club_id
                   and not coalesce(public.sesion_sin_acceso(), true), false);
  if not coalesce(v_puerta or v_rp, false) or not coalesce(public.funcion_activa(v_r.club_id, 'lista_negra'), false) then
    return jsonb_build_object('activa', false);
  end if;
  select * into v_pol from public._lista_negra_politica(v_r.club_id);
  select coalesce(max(x.no_shows), 0) into v_n
  from public._lista_negra_noshows(v_r.club_id, public.club_fecha_operacion(v_r.club_id) - v_pol.ventana_dias,
                                   public.lista_negra_tel(v_r.cliente_telefono)) x
  where public.lista_negra_tel(v_r.cliente_telefono) is not null;
  return jsonb_build_object(
    'activa', true,
    'no_shows', v_n,
    'ventana_dias', v_pol.ventana_dias,
    'aviso', v_n >= v_pol.avisar_desde,
    'bloqueado', case when v_puerta then
                   coalesce(public._lista_negra_manual(v_r.club_id, public.lista_negra_tel(v_r.cliente_telefono), v_r.cliente_id), false)
                   or coalesce(public._lista_negra_auto(v_r.club_id, public.lista_negra_tel(v_r.cliente_telefono)), false)
                 end);
end;
$$;
revoke all on function public.lista_negra_aviso(uuid, text) from public, anon;
grant execute on function public.lista_negra_aviso(uuid, text) to authenticated, service_role;

-- Tachar (derecho de cancelación u oposición, o un motivo con datos que no
-- debía llevar): solo el admin. Cambia el motivo y el motivo de desbloqueo
-- de ese bloqueo por «[tachado]», quita el nombre de referencia y tacha el
-- motivo en la bitácora de ese teléfono en ese antro. El teléfono se queda
-- (sin él el bloqueo no sirve); para quitarlo, desbloquear y, si hace falta,
-- borrar a mano como postgres. Queda registrado (tipo 'tachado').
create function public.lista_negra_tachar(p_bloqueo_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_b public.club_bloqueos%rowtype;
begin
  if not coalesce(public.current_role_name() = 'admin', false) then
    raise exception 'Solo el admin de AntroApp puede tachar un motivo.' using errcode = 'P0001';
  end if;
  select * into v_b from public.club_bloqueos where id = p_bloqueo_id for update;
  if not found then
    raise exception 'No encontramos ese bloqueo.' using errcode = 'P0001';
  end if;
  perform set_config('antroapp.tachado', 'on', true);
  update public.club_bloqueos
     set motivo = '[tachado]',
         motivo_desbloqueo = case when motivo_desbloqueo is null or motivo_desbloqueo = 'Venció.' then motivo_desbloqueo
                                  else '[tachado]' end,
         nombre = null
   where id = p_bloqueo_id;
  update public.lista_negra_eventos
     set detalle = jsonb_set(detalle, '{motivo}', '"[tachado]"')
   where club_id = v_b.club_id and telefono = v_b.telefono and detalle ? 'motivo';
  perform set_config('antroapp.tachado', 'off', true);
  insert into public.lista_negra_eventos (club_id, tipo, telefono, bloqueo_id, hecho_por)
  values (v_b.club_id, 'tachado', v_b.telefono, p_bloqueo_id, auth.uid());
end;
$$;
revoke all on function public.lista_negra_tachar(uuid) from public, anon;
grant execute on function public.lista_negra_tachar(uuid) to authenticated, service_role;

commit;
