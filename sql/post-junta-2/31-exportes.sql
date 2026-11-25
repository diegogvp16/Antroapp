-- ============================================================================
-- AntroApp — Exportables CSV de reservas, consumo y comisiones (B4, carril
-- b-reportes)
-- Fecha: 2026-11-24 (rama b-reportes, desde post-junta-2)
-- Estado: APLICADO Y PROBADO SOLO EN DEV. En producción NO (va en el pase 2).
-- Requiere: pase 1 (caja por mesa, nómina y /grupo, grupos de antros con
--           club_es_dueno_grupo, club_fecha_operacion y zona_horaria).
--           No usa columnas de la fase 2 (producto_id, cantidad, propinas) ni
--           regla_id (07-config-rp): se puede aplicar antes o después de ellos.
-- Rollback: sql/post-junta-2/31-exportes-rollback.sql (solo quita funciones;
--           no guarda datos).
--
-- Funciones de LECTURA renglón por renglón para descargar en CSV, por noche o
-- por rango (máximo 93 días, el mismo límite que /grupo):
--   reporte_exportes_info(club)                   nivel de acceso y datos del antro
--   reporte_reservas(club, desde, hasta, cursor)  una fila por reserva
--   reporte_consumos(club, desde, hasta, cursor)  una fila por renglón de caja
--                                                 (también los anulados, marcados)
--   reporte_comisiones(club, desde, hasta, cursor) una fila por comisión de RP
--                                                 o pago por día (también anulados)
--
-- Paginación: la API corta en 1000 filas. Cada función devuelve como mucho
-- p_limite (≤ 1000) filas ordenadas por la columna `orden` (texto que empieza
-- con la noche, luego la hora UTC y el id: único y estable). Para la página
-- siguiente se pasa p_despues = el `orden` de la última fila. Se termina
-- cuando llegan menos filas que el límite. Es por llave (no por OFFSET):
-- nada se repite ni se pierde aunque entren renglones nuevos a media descarga.
--
-- Definiciones (las mismas que reporte_cierre_noche y grupo_resumen, para que
-- las sumas cuadren al centavo):
--   * Noche = reservations.fecha (reservas y comisiones de reserva),
--     caja_noches.fecha_operacion (consumos) y rp_pagos_dia.fecha (pago por
--     día). Las horas salen en la zona horaria DEL ANTRO ("AAAA-MM-DD HH:MM").
--   * Estado de la reserva (los mismos conteos que reporte_cierre_noche, en
--     este orden): consumio (su cuenta tiene algún consumo no anulado) ·
--     llego_sin_consumo · no_llego (la noche ya terminó: fecha anterior a la
--     noche en curso del antro o la caja se cerró; incluye a quien se quedó
--     en la puerta) · en_puerta (solo con la noche abierta) · por_llegar.
--     no_llego = cierre.no_llegaron, en_puerta = cierre.en_puerta y
--     en_puerta + por_llegar = cierre.por_llegar.
--   * Suma de consumos no anulados del rango = grupo_resumen.consumo_centavos
--     = suma de reporte_cierre_noche.consumo.total_centavos por noche.
--   * Suma de comisiones y pagos no anulados = grupo_resumen.comisiones_centavos.
--
-- Acceso (en la base; con coalesce, sin NULL que se cuele):
--   'completo'  dueño del antro o su gerente ACTIVO: teléfono completo.
--   'admin'     admin de la plataforma: teléfono enmascarado (***1234).
--   'grupo'     dueño de grupo que no es dueño de ese antro: sin teléfono.
--   Staff, RP, cliente, cuenta sin perfil, dado de baja, contraseña temporal,
--   dueño o gerente de otro antro: rechazados (P0001). Anónimo: sin EXECUTE.
-- El teléfono se enmascara AQUÍ: el completo nunca sale de la base para
-- quien no le toca. No salen QR, ids de cliente ni correos.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Nivel de acceso a los exportes de un antro (uso interno). NULL = sin acceso.
-- ---------------------------------------------------------------------------
create or replace function public.reporte_nivel_exportes(p_club_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rol text := public.current_role_name();
begin
  if auth.uid() is null or p_club_id is null or v_rol is null then
    return null;
  end if;
  if coalesce(public.club_es_dueno(p_club_id), false) then
    return 'completo';
  end if;
  if coalesce(v_rol = 'gerente'
              and p_club_id = public.current_club_id()
              and exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo), false) then
    return 'completo';
  end if;
  if coalesce(v_rol = 'admin', false) then
    return 'admin';
  end if;
  if coalesce(public.club_es_dueno_grupo(p_club_id), false) then
    return 'grupo';
  end if;
  return null;
end;
$$;

revoke all on function public.reporte_nivel_exportes(uuid) from public, anon, authenticated;
grant execute on function public.reporte_nivel_exportes(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Autoriza y valida (uso interno): sesión, acceso, antro, rango y cursor.
-- Devuelve el nivel o lanza P0001 con un mensaje para la pantalla.
-- ---------------------------------------------------------------------------
create or replace function public.reporte_exportes_autorizar(
  p_club_id uuid, p_desde date, p_hasta date, p_despues text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_nivel text;
  v_hoy   date;
begin
  if auth.uid() is null then
    raise exception 'Inicia sesión para descargar reportes.' using errcode = 'P0001';
  end if;
  if p_club_id is null then
    raise exception 'Elige el antro.' using errcode = 'P0001';
  end if;
  v_nivel := public.reporte_nivel_exportes(p_club_id);
  if v_nivel is null then
    raise exception 'No tienes acceso a los reportes de este antro.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.clubs c where c.id = p_club_id) then
    raise exception 'No encontramos ese antro.' using errcode = 'P0001';
  end if;
  if p_desde is null or p_hasta is null then
    raise exception 'Elige la fecha de inicio y la de fin.' using errcode = 'P0001';
  end if;
  if p_hasta < p_desde then
    raise exception 'La fecha de inicio no puede ser después de la fecha de fin.' using errcode = 'P0001';
  end if;
  if p_hasta - p_desde > 93 then
    raise exception 'El rango máximo es de 93 días.' using errcode = 'P0001';
  end if;
  -- Sin zona (no debería pasar) se toma la noche de México: el tope no queda en NULL.
  v_hoy := coalesce(public.club_fecha_operacion(p_club_id), ((now() at time zone 'America/Mexico_City') - interval '8 hours')::date);
  if p_desde < date '2020-01-01' or p_hasta > v_hoy + 92 then
    raise exception 'Elige noches entre 2020 y los próximos 3 meses.' using errcode = 'P0001';
  end if;
  if p_despues is not null and p_despues !~ '^\d{4}-\d{2}-\d{2}\|' then
    raise exception 'Página inválida: vuelve a empezar la descarga.' using errcode = 'P0001';
  end if;
  -- "2026-13-45|..." pasa el patrón pero no es fecha: aviso claro, no error 22008.
  if p_despues is not null then
    begin
      perform split_part(p_despues, '|', 1)::date;
    exception when others then
      raise exception 'Página inválida: vuelve a empezar la descarga.' using errcode = 'P0001';
    end;
  end if;
  return v_nivel;
end;
$$;

revoke all on function public.reporte_exportes_autorizar(uuid, date, date, text) from public, anon, authenticated;
grant execute on function public.reporte_exportes_autorizar(uuid, date, date, text) to service_role;

-- ---------------------------------------------------------------------------
-- Teléfono según el nivel (uso interno).
-- ---------------------------------------------------------------------------
create or replace function public.reporte_telefono(p_telefono text, p_nivel text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_nivel = 'completo' then nullif(btrim(p_telefono), '')
    when p_nivel = 'admin' and length(regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g')) >= 4
      then '***' || right(regexp_replace(p_telefono, '\D', '', 'g'), 4)
    else null
  end;
$$;

revoke all on function public.reporte_telefono(text, text) from public, anon, authenticated;
grant execute on function public.reporte_telefono(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Info para la pantalla: nivel, qué teléfono verá y datos del antro.
-- ---------------------------------------------------------------------------
create or replace function public.reporte_exportes_info(p_club_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_nivel text;
  v_club  record;
begin
  if auth.uid() is null then
    raise exception 'Inicia sesión para descargar reportes.' using errcode = 'P0001';
  end if;
  v_nivel := public.reporte_nivel_exportes(p_club_id);
  if v_nivel is null then
    raise exception 'No tienes acceso a los reportes de este antro.' using errcode = 'P0001';
  end if;
  select c.id, c.nombre, c.zona_horaria into v_club from public.clubs c where c.id = p_club_id;
  if v_club.id is null then
    raise exception 'No encontramos ese antro.' using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'nivel', v_nivel,
    'telefono', case v_nivel when 'completo' then 'completo' when 'admin' then 'enmascarado' else 'sin_telefono' end,
    'club', jsonb_build_object('id', v_club.id, 'nombre', v_club.nombre, 'zona_horaria', v_club.zona_horaria),
    'noche_en_curso', public.club_fecha_operacion(p_club_id),
    'max_dias', 93,
    'limite_pagina', 1000);
end;
$$;

revoke all on function public.reporte_exportes_info(uuid) from public, anon;
grant execute on function public.reporte_exportes_info(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Reservas: una fila por reserva del rango.
-- ---------------------------------------------------------------------------
create or replace function public.reporte_reservas(
  p_club_id uuid, p_desde date, p_hasta date, p_despues text default null, p_limite integer default 1000)
returns table(
  orden text,
  folio text,
  noche date,
  creada_local text,
  cliente_nombre text,
  telefono text,
  personas integer,
  origen text,
  rp_nombre text,
  estado text,
  entrada_local text,
  llegada_tarde boolean,
  mesa text,
  consumo_centavos bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_nivel  text := public.reporte_exportes_autorizar(p_club_id, p_desde, p_hasta, p_despues);
  v_zona   text;
  v_hoy    date;
  v_lim    integer := least(greatest(coalesce(p_limite, 1000), 1), 1000);
  v_desde  date := greatest(p_desde, coalesce(split_part(p_despues, '|', 1)::date, p_desde));
begin
  select c.zona_horaria into v_zona from public.clubs c where c.id = p_club_id;
  v_hoy := public.club_fecha_operacion(p_club_id);

  return query
  with r as (
    select x.*,
           to_char(x.fecha, 'YYYY-MM-DD') || '|' ||
           to_char(coalesce(x.created_at, 'epoch'::timestamptz) at time zone 'UTC', 'YYYYMMDDHH24MISSUS') || '|' || x.id::text as k
    from public.reservations x
    where x.club_id = p_club_id and x.fecha between v_desde and p_hasta
  )
  select r.k,
         left(r.id::text, 8),
         r.fecha,
         to_char(r.created_at at time zone v_zona, 'YYYY-MM-DD HH24:MI'),
         r.cliente_nombre,
         public.reporte_telefono(r.cliente_telefono, v_nivel),
         r.personas,
         r.source,
         rp.nombre,
         case
           when coalesce(con.n, 0) > 0 then 'consumio'
           when coalesce(coalesce(r.puerta_estado, case when r.status = 'usada' then 'entro' end) = 'entro', false) then 'llego_sin_consumo'
           -- Noche terminada antes que "en puerta": quien se quedó en la
           -- puerta de una noche que ya acabó no llegó (igual que el cierre).
           when r.fecha < v_hoy or coalesce(n.estado = 'cerrada', false) then 'no_llego'
           when coalesce(r.puerta_estado = 'en_puerta', false) then 'en_puerta'
           else 'por_llegar'
         end,
         to_char(r.entrada_en at time zone v_zona, 'YYYY-MM-DD HH24:MI'),
         coalesce(r.llegada_tarde, false),
         t.numero,
         coalesce(con.cent, 0)::bigint
  from r
  left join public.profiles rp on rp.id = r.rp_id
  left join public.mesa_cuentas mc on mc.reservation_id = r.id
  left join public.mesa_sesiones s on s.id = mc.sesion_id
  left join public.club_tables t on t.id = s.mesa_id
  left join lateral (
    select count(*)::int as n, sum(k.monto_centavos)::bigint as cent
    from public.caja_consumos k
    where k.cuenta_id = mc.id and not k.anulado
  ) con on true
  left join public.caja_noches n on n.club_id = p_club_id and n.fecha_operacion = r.fecha
  where p_despues is null or r.k > p_despues
  order by r.k
  limit v_lim;
end;
$$;

revoke all on function public.reporte_reservas(uuid, date, date, text, integer) from public, anon;
grant execute on function public.reporte_reservas(uuid, date, date, text, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Consumo en caja: una fila por renglón (anulados incluidos y marcados).
-- ---------------------------------------------------------------------------
create or replace function public.reporte_consumos(
  p_club_id uuid, p_desde date, p_hasta date, p_despues text default null, p_limite integer default 1000)
returns table(
  orden text,
  noche date,
  hora_local text,
  mesa text,
  grupo integer,
  cuenta text,
  origen_cuenta text,
  folio_reserva text,
  rp_nombre text,
  concepto text,
  monto_centavos bigint,
  anulado boolean,
  motivo_anulacion text,
  anulado_local text,
  registrado_por text,
  anulado_por text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_nivel  text := public.reporte_exportes_autorizar(p_club_id, p_desde, p_hasta, p_despues);
  v_zona   text;
  v_lim    integer := least(greatest(coalesce(p_limite, 1000), 1), 1000);
  v_desde  date := greatest(p_desde, coalesce(split_part(p_despues, '|', 1)::date, p_desde));
begin
  select c.zona_horaria into v_zona from public.clubs c where c.id = p_club_id;

  return query
  with noches as (
    select n.id, n.fecha_operacion
    from public.caja_noches n
    where n.club_id = p_club_id and n.fecha_operacion between v_desde and p_hasta
  ),
  ses as (
    select s.id, s.mesa_id,
           row_number() over (partition by s.noche_id, s.mesa_id order by s.abierta_en, s.id)::int as num
    from public.mesa_sesiones s
    where s.noche_id in (select id from noches) and s.club_id = p_club_id
  ),
  k as (
    select x.*, nn.fecha_operacion,
           to_char(nn.fecha_operacion, 'YYYY-MM-DD') || '|' ||
           to_char(x.registrado_en at time zone 'UTC', 'YYYYMMDDHH24MISSUS') || '|' || x.id::text as llave
    from public.caja_consumos x
    join noches nn on nn.id = x.noche_id
    where x.club_id = p_club_id
  )
  select k.llave,
         k.fecha_operacion,
         to_char(k.registrado_en at time zone v_zona, 'YYYY-MM-DD HH24:MI'),
         t.numero,
         ses.num,
         mc.cliente_nombre,
         mc.origen,
         left(k.reservation_id::text, 8),
         rp.nombre,
         k.concepto,
         k.monto_centavos,
         k.anulado,
         k.motivo_anulacion,
         to_char(k.anulado_en at time zone v_zona, 'YYYY-MM-DD HH24:MI'),
         reg.nombre,
         anu.nombre
  from k
  left join ses on ses.id = k.sesion_id
  left join public.club_tables t on t.id = k.mesa_id
  left join public.mesa_cuentas mc on mc.id = k.cuenta_id
  left join public.profiles rp on rp.id = coalesce(k.rp_id, mc.rp_id)
  left join public.profiles reg on reg.id = k.registrado_por
  left join public.profiles anu on anu.id = k.anulado_por
  where p_despues is null or k.llave > p_despues
  order by k.llave
  limit v_lim;
end;
$$;

revoke all on function public.reporte_consumos(uuid, date, date, text, integer) from public, anon;
grant execute on function public.reporte_consumos(uuid, date, date, text, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comisiones de RP (por reserva) y pagos por día de asistencia, con su estado.
-- Las anuladas se incluyen y se marcan; no cuentan en las sumas.
-- El bono de plataforma (tipo 'plataforma') no entra.
-- ---------------------------------------------------------------------------
create or replace function public.reporte_comisiones(
  p_club_id uuid, p_desde date, p_hasta date, p_despues text default null, p_limite integer default 1000)
returns table(
  orden text,
  noche date,
  tipo text,
  rp_nombre text,
  rp_activo boolean,
  folio_reserva text,
  cliente_nombre text,
  consumo_base_centavos bigint,
  posicion_dia integer,
  monto_centavos bigint,
  estado text,
  creada_local text,
  pagada_local text,
  motivo_anulacion text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_nivel  text := public.reporte_exportes_autorizar(p_club_id, p_desde, p_hasta, p_despues);
  v_zona   text;
  v_lim    integer := least(greatest(coalesce(p_limite, 1000), 1), 1000);
  v_desde  date := greatest(p_desde, coalesce(split_part(p_despues, '|', 1)::date, p_desde));
begin
  select c.zona_horaria into v_zona from public.clubs c where c.id = p_club_id;

  return query
  with x as (
    select 'reserva'::text as tipo, r.fecha, c.created_at, c.id, c.rp_id, r.id as rid, r.cliente_nombre,
           round(c.monto * 100)::bigint as cent, c.status, c.pagada_en, c.motivo_anulacion, null::integer as posicion
    from public.commissions c
    join public.reservations r on r.id = c.reservation_id
    where c.tipo = 'rp' and r.club_id = p_club_id and r.fecha between v_desde and p_hasta
    union all
    select 'dia'::text, d.fecha, d.created_at, d.id, d.rp_id, null::uuid, null::text,
           round(d.monto * 100)::bigint, d.status, d.pagada_en, d.motivo_anulacion, d.posicion
    from public.rp_pagos_dia d
    where d.club_id = p_club_id and d.fecha between v_desde and p_hasta
  ),
  y as (
    select x.*,
           to_char(x.fecha, 'YYYY-MM-DD') || '|' || x.tipo || '|' ||
           to_char(x.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS') || '|' || x.id::text as llave
    from x
  )
  select y.llave,
         y.fecha,
         y.tipo,
         rp.nombre,
         rp.activo,
         left(y.rid::text, 8),
         y.cliente_nombre,
         case when y.rid is not null then (
           select coalesce(sum(k.monto_centavos), 0)::bigint
           from public.mesa_cuentas mc
           join public.caja_consumos k on k.cuenta_id = mc.id and not k.anulado
           where mc.reservation_id = y.rid) end,
         y.posicion,
         y.cent,
         y.status,
         to_char(y.created_at at time zone v_zona, 'YYYY-MM-DD HH24:MI'),
         to_char(y.pagada_en at time zone v_zona, 'YYYY-MM-DD HH24:MI'),
         y.motivo_anulacion
  from y
  left join public.profiles rp on rp.id = y.rp_id
  where p_despues is null or y.llave > p_despues
  order by y.llave
  limit v_lim;
end;
$$;

revoke all on function public.reporte_comisiones(uuid, date, date, text, integer) from public, anon;
grant execute on function public.reporte_comisiones(uuid, date, date, text, integer) to authenticated, service_role;
