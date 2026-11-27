-- ============================================================================
-- AntroApp — Plantillas de WhatsApp y lista de la noche para mensajes
-- (noche 4, bloque 6). Fecha: 2026-11-27.
-- Rollback: sql/post-junta-3/60-whatsapp-plantillas-rollback.sql
-- Prueba (dev): node scripts/dev/probar-lista-negra.mjs (bloque WhatsApp)
-- Requiere: 00-funciones-club.sql (bandera 'whatsapp') y 40-lista-negra.sql
-- (quién gestiona / quién ve avisos, y el conteo de no-shows).
--
-- SIN API de WhatsApp: la app solo arma enlaces wa.me con el texto ya
-- escrito; abrir el enlace no manda nada, la persona revisa y envía desde
-- su propio WhatsApp. Aquí solo se guarda el texto de cada antro.
--
-- Qué hay:
--   - club_whatsapp_plantillas: el texto propio de un antro para
--     'confirmacion', 'recordatorio' y 'no_show'. Sin fila = el texto de
--     fábrica, que vive en el código (lib/domain/whatsapp.ts).
--   - whatsapp_plantillas_cambios: bitácora de cada cambio (texto NULL =
--     se volvió al de fábrica).
--   - whatsapp_plantillas(club): los textos propios, para quien trabaja el
--     antro (staff, gerente y RP activos del antro, dueño, dueño del grupo,
--     admin). Bandera apagada o sin permiso: vacío.
--   - whatsapp_plantilla_guardar(club, tipo, texto): gerente, dueño, dueño
--     del grupo y admin. Valida variables y largo.
--   - whatsapp_reserva(reserva): datos para armar el mensaje de UNA reserva
--     (el RP solo de las suyas; la puerta y los gestores, del antro).
--   - clientes_noche(club, desfase): reservas de una noche para la puerta
--     y los gestores, con su estado (mismo criterio que rp_mis_reservas) y,
--     con 'lista_negra' encendida, los no-shows previos sin motivo.
-- ============================================================================
begin;

create table public.club_whatsapp_plantillas (
  club_id      uuid not null references public.clubs (id) on delete cascade,
  tipo         text not null check (tipo in ('confirmacion', 'recordatorio', 'no_show')),
  texto        text not null check (char_length(btrim(texto)) between 1 and 1000),
  cambiado_por uuid references public.profiles (id) on delete set null,
  cambiado_en  timestamptz not null default now(),
  primary key (club_id, tipo)
);

create table public.whatsapp_plantillas_cambios (
  id         bigint generated always as identity primary key,
  club_id    uuid not null references public.clubs (id) on delete cascade,
  tipo       text not null,
  texto      text,               -- null = volvió al texto de fábrica
  hecho_por  uuid references public.profiles (id) on delete set null,
  hecho_en   timestamptz not null default now()
);
create index whatsapp_plantillas_cambios_club on public.whatsapp_plantillas_cambios (club_id, hecho_en desc);

alter table public.club_whatsapp_plantillas enable row level security;
alter table public.whatsapp_plantillas_cambios enable row level security;
revoke all on public.club_whatsapp_plantillas, public.whatsapp_plantillas_cambios from public, anon, authenticated;
grant all on public.club_whatsapp_plantillas, public.whatsapp_plantillas_cambios to service_role;
revoke all on sequence public.whatsapp_plantillas_cambios_id_seq from public, anon, authenticated;
grant usage, select on sequence public.whatsapp_plantillas_cambios_id_seq to service_role;

-- Trabaja el antro: gestores, o staff/gerente/RP activo del antro. Nunca NULL.
create function public._whatsapp_trabaja(p_club uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    public._lista_negra_ve_avisos(p_club)
    or (auth.uid() is not null
        and not coalesce(public.sesion_sin_acceso(), true)
        and public.current_role_name() = 'rp'
        and public.current_club_id() = p_club
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo)),
    false);
$$;
revoke all on function public._whatsapp_trabaja(uuid) from public, anon, authenticated;
grant execute on function public._whatsapp_trabaja(uuid) to service_role;

create function public.whatsapp_plantillas(p_club uuid)
returns table (tipo text, texto text, cambiado_en timestamptz, cambiado_por text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not coalesce(public._whatsapp_trabaja(p_club), false)
     or not coalesce(public.funcion_activa(p_club, 'whatsapp'), false) then
    return;
  end if;
  return query
    select w.tipo, w.texto, w.cambiado_en, p.nombre
    from public.club_whatsapp_plantillas w
    left join public.profiles p on p.id = w.cambiado_por
    where w.club_id = p_club
    order by w.tipo;
end;
$$;
revoke all on function public.whatsapp_plantillas(uuid) from public, anon;
grant execute on function public.whatsapp_plantillas(uuid) to authenticated, service_role;

-- Guardar el texto propio (p_texto NULL = volver al de fábrica). Mismas
-- reglas que validarPlantilla (lib/domain/whatsapp.ts).
create function public.whatsapp_plantilla_guardar(p_club uuid, p_tipo text, p_texto text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_texto text := btrim(p_texto);
begin
  if not coalesce(public._lista_negra_gestiona(p_club), false) then
    raise exception 'Solo el gerente o el dueño cambian los mensajes de este antro.' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(p_club, 'whatsapp'), false) then
    raise exception 'Los mensajes de WhatsApp no están activos en este antro.' using errcode = 'P0001';
  end if;
  if p_tipo is null or p_tipo not in ('confirmacion', 'recordatorio', 'no_show') then
    raise exception 'Ese tipo de mensaje no existe.' using errcode = 'P0001';
  end if;
  if p_texto is null then
    delete from public.club_whatsapp_plantillas where club_id = p_club and tipo = p_tipo;
  else
    if char_length(v_texto) = 0 then
      raise exception 'El mensaje no puede ir vacío.' using errcode = 'P0001';
    end if;
    if char_length(v_texto) > 1000 then
      raise exception 'El mensaje es muy largo (máximo 1000 caracteres).' using errcode = 'P0001';
    end if;
    if regexp_replace(v_texto, '\{(nombre|antro|fecha|hora|personas|enlace_boleto)\}', '', 'g') ~ '[{}]' then
      raise exception 'El mensaje tiene una variable que no existe o una llave suelta. Usa solo {nombre}, {antro}, {fecha}, {hora}, {personas} y {enlace_boleto}.'
        using errcode = 'P0001';
    end if;
    insert into public.club_whatsapp_plantillas (club_id, tipo, texto, cambiado_por)
    values (p_club, p_tipo, v_texto, auth.uid())
    on conflict (club_id, tipo) do update
      set texto = excluded.texto, cambiado_por = excluded.cambiado_por, cambiado_en = now();
  end if;
  insert into public.whatsapp_plantillas_cambios (club_id, tipo, texto, hecho_por)
  values (p_club, p_tipo, case when p_texto is null then null else v_texto end, auth.uid());
end;
$$;
revoke all on function public.whatsapp_plantilla_guardar(uuid, text, text) from public, anon;
grant execute on function public.whatsapp_plantilla_guardar(uuid, text, text) to authenticated, service_role;

-- Estado de una reserva, igual que rp_mis_reservas.
create function public._clientes_estado(p_reserva uuid, p_club uuid, p_fecha date, p_status text, p_puerta text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (select 1 from public.mesa_cuentas mc
                 join public.caja_consumos k on k.cuenta_id = mc.id and not k.anulado
                 where mc.reservation_id = p_reserva and k.monto_centavos > 0) then 'consumio'
    when coalesce(coalesce(p_puerta, case when p_status = 'usada' then 'entro' end) = 'entro', false) then 'llego_sin_consumo'
    when p_fecha < public.club_fecha_operacion(p_club)
         or exists (select 1 from public.caja_noches n
                    where n.club_id = p_club and n.fecha_operacion = p_fecha and n.estado = 'cerrada') then 'no_llego'
    else 'por_llegar'
  end;
$$;
revoke all on function public._clientes_estado(uuid, uuid, date, text, text) from public, anon, authenticated;
grant execute on function public._clientes_estado(uuid, uuid, date, text, text) to service_role;

-- Datos para el mensaje de UNA reserva.
create function public.whatsapp_reserva(p_reserva_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v record;
  v_rp boolean;
begin
  select r.id, r.club_id, r.rp_id, r.source, r.cliente_nombre, r.cliente_telefono, r.fecha, r.personas,
         r.qr_code, r.status, r.puerta_estado, c.nombre as antro, c.horario
    into v
  from public.reservations r
  join public.clubs c on c.id = r.club_id
  where r.id = p_reserva_id;
  if v.id is null then
    raise exception 'No encontramos esa reserva.' using errcode = 'P0001';
  end if;
  v_rp := coalesce(v.source = 'rp' and v.rp_id = auth.uid()
                   and public.current_role_name() = 'rp'
                   and public.current_club_id() = v.club_id
                   and not coalesce(public.sesion_sin_acceso(), true)
                   and exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo), false);
  if not coalesce(v_rp or public._lista_negra_ve_avisos(v.club_id), false) then
    raise exception 'No encontramos esa reserva.' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(v.club_id, 'whatsapp'), false) then
    raise exception 'Los mensajes de WhatsApp no están activos en este antro.' using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'reservation_id', v.id, 'cliente_nombre', v.cliente_nombre, 'cliente_telefono', v.cliente_telefono,
    'fecha', v.fecha, 'personas', v.personas, 'qr_code', v.qr_code, 'antro', v.antro, 'horario', v.horario,
    'estado', public._clientes_estado(v.id, v.club_id, v.fecha, v.status, v.puerta_estado));
end;
$$;
revoke all on function public.whatsapp_reserva(uuid) from public, anon;
grant execute on function public.whatsapp_reserva(uuid) to authenticated, service_role;

-- Reservas de una noche (desfase: 0 = esta noche operativa del antro,
-- 1 = mañana, -1 = anoche; de -7 a 7). Para la puerta y los gestores.
-- Teléfono y QR solo con 'whatsapp' encendida (para los enlaces); no-shows y
-- "bloqueado" solo con 'lista_negra' encendida. Las dos apagadas: error.
create function public.clientes_noche(p_club uuid, p_desfase int default 0)
returns table (reservation_id uuid, fecha date, cliente_nombre text, cliente_telefono text, personas int,
               source text, rp_nombre text, qr_code text, estado text, no_shows int, aviso boolean, bloqueado boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_wa    boolean;
  v_ln    boolean;
  v_fecha date;
  v_pol   record;
begin
  if not coalesce(public._lista_negra_ve_avisos(p_club), false) then
    raise exception 'No tienes acceso a las reservas de este antro.' using errcode = 'P0001';
  end if;
  v_wa := coalesce(public.funcion_activa(p_club, 'whatsapp'), false);
  v_ln := coalesce(public.funcion_activa(p_club, 'lista_negra'), false);
  if not coalesce(v_wa or v_ln, false) then
    raise exception 'Esta función no está activa en este antro.' using errcode = 'P0001';
  end if;
  if p_desfase is null or p_desfase not between -7 and 7 then
    raise exception 'Elige una noche de la última o la próxima semana.' using errcode = 'P0001';
  end if;
  v_fecha := public.club_fecha_operacion(p_club) + p_desfase;
  select * into v_pol from public._lista_negra_politica(p_club);

  return query
    with res as (
      select r.id, r.fecha, r.cliente_nombre, r.cliente_telefono, r.personas, r.source, r.rp_id, r.qr_code,
             r.status, r.puerta_estado, r.cliente_id, r.created_at, public.lista_negra_tel(r.cliente_telefono) as tel
      from public.reservations r
      where r.club_id = p_club and r.fecha = v_fecha
    ),
    -- Solo los teléfonos de esa noche, uno por uno por el índice
    -- reservations_club_tel_fecha (no se recorre todo el antro).
    ns as (
      select x.telefono, x.no_shows, x.cuentan
      from (select distinct res.tel from res where res.tel is not null and v_ln) t
      cross join lateral public._lista_negra_noshows(p_club, public.club_fecha_operacion(p_club) - v_pol.ventana_dias, t.tel) x
    )
    select r.id, r.fecha, r.cliente_nombre,
           case when v_wa then r.cliente_telefono end,
           r.personas, r.source, p.nombre,
           case when v_wa then r.qr_code end,
           public._clientes_estado(r.id, p_club, r.fecha, r.status, r.puerta_estado),
           case when v_ln then coalesce(ns.no_shows, 0) end,
           case when v_ln then coalesce(ns.no_shows, 0) >= v_pol.avisar_desde end,
           case when v_ln then coalesce(public._lista_negra_manual(p_club, r.tel, r.cliente_id), false)
                               or coalesce(v_pol.bloquear_desde is not null and ns.cuentan >= v_pol.bloquear_desde, false) end
    from res r
    left join public.profiles p on p.id = r.rp_id
    left join ns on ns.telefono = r.tel
    order by r.cliente_nombre, r.created_at;
end;
$$;
revoke all on function public.clientes_noche(uuid, int) from public, anon;
grant execute on function public.clientes_noche(uuid, int) to authenticated, service_role;

commit;
