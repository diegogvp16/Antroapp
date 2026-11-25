-- ============================================================================
-- AntroApp — Reporte "Cierre de la noche" por antro (B11, carril b-reportes)
-- Fecha: 2026-11-24 (rama b-reportes, desde post-junta-2)
-- Estado: APLICADO Y PROBADO SOLO EN DEV. En producción NO (va en el pase 2).
-- Requiere: pase 1 (caja por mesa, nómina y /grupo, caja idempotencia) y
--           sql/2026-11-21-grupo-conversion.sql con la autorización sin NULL
--           de sql/post-junta/10a (grupo_rendimiento_rp).
-- Rollback: sql/post-junta-2/30-cierre-noche-rollback.sql (solo quita la
--           función; no guarda datos).
--
-- Una sola función de LECTURA, reporte_cierre_noche(club, fecha), que junta
-- en un jsonb todo el cierre de una noche operativa del antro:
--   noche        estado de la caja (abierta / cerrada / sin caja), quién la
--                abrió y la cerró y cuándo; si la noche ya terminó.
--   reservas     total, personas, entraron, en puerta, consumieron, entraron
--                sin consumo, no llegaron y por llegar; y por origen.
--   consumo      total en caja (sin anulados), con y sin reserva, cuentas con
--                consumo y ticket promedio POR CUENTA (igual que /grupo).
--   walk_ins     cuentas sin reserva: número, personas, con consumo y consumo.
--   cobros       cobrado por método (sin anulados) y lo que falta por cobrar.
--   cuadre       el cuadre general guardado al cerrar la noche (contado,
--                diferencia, notas) o null si la noche sigue abierta.
--   anulaciones  consumos y cobros anulados (número y $) y mesas reabiertas.
--   mesas        mesas del antro, mesas usadas, grupos (sesiones) por estado y
--                mesas con más de un grupo.
--   comisiones   comisiones de RP (sin anuladas, también las de $0 por la
--                cuota) y pagos por día de esa noche; cuentas de RP que aún
--                no se cuadran (su comisión todavía no nace).
--   rps          grupo_rendimiento_rp(club, fecha, fecha): la MISMA función
--                de /grupo, solo los RPs con reservas o pagos esa noche.
--
-- Definiciones (las mismas de /grupo y de scripts/verificar-cuadre.mjs, para
-- que las cifras cuadren al centavo):
--   * La noche es la fecha de operación del antro (corte 08:00 en SU zona
--     horaria, club_fecha_operacion). reservations.fecha = p_fecha y la caja
--     es la caja_noches de esa fecha_operacion.
--   * Entró: puerta_estado = 'entro' (o, sin puerta, status = 'usada').
--   * Consumió: la cuenta de la reserva tiene algún consumo no anulado.
--   * La noche "ya terminó" si su fecha es anterior a la noche en curso del
--     antro o si el gerente la cerró en caja. Solo entonces hay "no
--     llegaron"; mientras sigue, quien no ha entrado está "por llegar".
--   * En puerta: parte de "por llegar" (solo con la noche abierta). Si la
--     noche ya terminó, quien se quedó en la puerta cuenta en "no llegaron".
--
-- Acceso (en la base, sin NULL que se cuele): admin, el dueño del antro, el
-- dueño de su grupo y su gerente ACTIVO. Staff, RP, cliente, cuenta sin
-- perfil, dado de baja y contraseña temporal: rechazados (P0001). El staff
-- no ve el reporte porque trae comisiones y pagos a RPs.
-- Sin datos personales de clientes: ni nombres ni teléfonos, solo conteos.
-- Los nombres que salen son del personal (quién abrió o cerró) y de los RPs.
-- ============================================================================

create or replace function public.reporte_cierre_noche(p_club_id uuid, p_fecha date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rol      text := public.current_role_name();
  v_club     record;
  v_hoy      date;
  v_noche    record;
  v_noche_id uuid;
  v_termino  boolean;
  v_momento  text;
  v_reservas jsonb;
  v_origen   jsonb;
  v_consumo  jsonb;
  v_walk     jsonb;
  v_cobros   jsonb;
  v_cuadre   jsonb;
  v_anul     jsonb;
  v_mesas    jsonb;
  v_com      jsonb;
  v_rps      jsonb;
  v_nombre_abrio  text;
  v_nombre_cerro  text;
begin
  if auth.uid() is null then
    raise exception 'Inicia sesión para ver el cierre de la noche.' using errcode = 'P0001';
  end if;
  if p_club_id is null or p_fecha is null then
    raise exception 'Elige el antro y la noche.' using errcode = 'P0001';
  end if;
  -- Mismo acceso que grupo_rendimiento_rp (que se llama abajo y vuelve a
  -- autorizar). coalesce: si algo sale NULL, NO pasa.
  if not coalesce(v_rol = 'admin'
          or public.club_es_dueno(p_club_id)
          or public.club_es_dueno_grupo(p_club_id)
          or (v_rol = 'gerente' and p_club_id = public.current_club_id()
              and exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo)), false) then
    raise exception 'No tienes acceso al cierre de este antro.' using errcode = 'P0001';
  end if;

  select c.id, c.nombre, c.zona_horaria into v_club from public.clubs c where c.id = p_club_id;
  if v_club.id is null then
    raise exception 'No encontramos ese antro.' using errcode = 'P0001';
  end if;
  v_hoy := public.club_fecha_operacion(p_club_id);
  if p_fecha < date '2020-01-01' or p_fecha > v_hoy + 92 then
    raise exception 'Elige una noche entre 2020 y los próximos 3 meses.' using errcode = 'P0001';
  end if;

  select n.id, n.estado, n.abierta_por, n.abierta_en, n.cerrada_por, n.cerrada_en
    into v_noche
  from public.caja_noches n
  where n.club_id = p_club_id and n.fecha_operacion = p_fecha;
  v_noche_id := v_noche.id;

  v_termino := p_fecha < v_hoy or coalesce(v_noche.estado = 'cerrada', false);
  v_momento := case when p_fecha > v_hoy then 'futura' when p_fecha = v_hoy then 'en_curso' else 'pasada' end;

  select p.nombre into v_nombre_abrio from public.profiles p where p.id = v_noche.abierta_por;
  select p.nombre into v_nombre_cerro from public.profiles p where p.id = v_noche.cerrada_por;

  -- ---------- Reservas de la noche ----------
  with r as (
    select r.source,
           coalesce(r.personas, 0) as personas,
           coalesce(coalesce(r.puerta_estado, case when r.status = 'usada' then 'entro' end) = 'entro', false) as entro,
           coalesce(r.puerta_estado = 'en_puerta', false) as en_puerta,
           cons.cent is not null as consumio,
           coalesce(cons.cent, 0) as cent
    from public.reservations r
    left join lateral (
      select sum(k.monto_centavos)::bigint as cent
      from public.mesa_cuentas mc
      join public.caja_consumos k on k.cuenta_id = mc.id and not k.anulado
      where mc.reservation_id = r.id
    ) cons on true
    where r.club_id = p_club_id and r.fecha = p_fecha
  ),
  t as (
    select case when grouping(x.source) = 1 then 'total' else coalesce(x.source, 'sin_origen') end as origen,
           count(*)::int as reservas,
           coalesce(sum(x.personas), 0)::int as personas,
           count(*) filter (where x.entro)::int as entraron,
           count(*) filter (where not x.entro and x.en_puerta and not v_termino)::int as en_puerta,
           count(*) filter (where x.consumio)::int as consumieron,
           count(*) filter (where x.entro and not x.consumio)::int as entraron_sin_consumo,
           count(*) filter (where not x.entro and v_termino)::int as no_llegaron,
           count(*) filter (where not x.entro and not v_termino)::int as por_llegar,
           coalesce(sum(x.cent), 0)::bigint as consumo_centavos
    from r x
    group by grouping sets ((x.source), ())
  )
  select
    coalesce((select to_jsonb(t) - 'origen' from t where t.origen = 'total'),
             jsonb_build_object('reservas', 0, 'personas', 0, 'entraron', 0, 'en_puerta', 0, 'consumieron', 0,
                                'entraron_sin_consumo', 0, 'no_llegaron', 0, 'por_llegar', 0, 'consumo_centavos', 0)),
    coalesce((select jsonb_agg(to_jsonb(t) order by t.origen) from t where t.origen in ('organica', 'rp')), '[]'::jsonb)
    into v_reservas, v_origen;

  -- ---------- Consumo en caja (por la noche de la caja) ----------
  select jsonb_build_object(
           'total_centavos',        coalesce(sum(k.monto_centavos), 0)::bigint,
           'con_reserva_centavos',  coalesce(sum(k.monto_centavos) filter (where k.reservation_id is not null), 0)::bigint,
           'sin_reserva_centavos',  coalesce(sum(k.monto_centavos) filter (where k.reservation_id is null), 0)::bigint,
           'cuentas_con_consumo',   count(distinct k.cuenta_id)::int,
           'renglones',             count(*)::int,
           'ticket_promedio_centavos',
             case when count(distinct k.cuenta_id) > 0
                  then round(sum(k.monto_centavos)::numeric / count(distinct k.cuenta_id))::bigint else 0 end)
    into v_consumo
  from public.caja_consumos k
  where k.noche_id = v_noche_id and k.club_id = p_club_id and not k.anulado;

  -- ---------- Cuentas sin reserva (walk-in) ----------
  with c as (
    select mc.id, mc.origen, mc.personas,
           (select sum(k.monto_centavos) from public.caja_consumos k where k.cuenta_id = mc.id and not k.anulado)::bigint as cent
    from public.mesa_cuentas mc
    join public.mesa_sesiones s on s.id = mc.sesion_id
    where s.noche_id = v_noche_id and mc.club_id = p_club_id
  )
  select jsonb_build_object(
           'cuentas_total',   count(*)::int,
           'cuentas_reserva', count(*) filter (where c.origen = 'reserva')::int,
           'cuentas',         count(*) filter (where c.origen = 'walk_in')::int,
           'personas',        coalesce(sum(c.personas) filter (where c.origen = 'walk_in'), 0)::int,
           'con_consumo',     count(*) filter (where c.origen = 'walk_in' and c.cent is not null)::int,
           'consumo_centavos', coalesce(sum(c.cent) filter (where c.origen = 'walk_in'), 0)::bigint)
    into v_walk
  from c;

  -- ---------- Cobros por método (sin anulados) ----------
  select jsonb_build_object(
           'efectivo_centavos', coalesce(sum(p.monto_centavos) filter (where p.metodo = 'efectivo'), 0)::bigint,
           'tarjeta_centavos',  coalesce(sum(p.monto_centavos) filter (where p.metodo = 'tarjeta'), 0)::bigint,
           'otro_centavos',     coalesce(sum(p.monto_centavos) filter (where p.metodo = 'otro'), 0)::bigint,
           'total_centavos',    coalesce(sum(p.monto_centavos), 0)::bigint,
           'cobros',            count(*)::int,
           'por_cobrar_centavos', (v_consumo ->> 'total_centavos')::bigint - coalesce(sum(p.monto_centavos), 0)::bigint)
    into v_cobros
  from public.caja_pagos p
  where p.noche_id = v_noche_id and p.club_id = p_club_id and not p.anulado;

  -- ---------- Cuadre general guardado al cerrar la noche ----------
  select jsonb_build_object(
           'registrado_centavos',       q.registrado_centavos,
           'cobrado_efectivo_centavos', q.cobrado_efectivo_centavos,
           'cobrado_tarjeta_centavos',  q.cobrado_tarjeta_centavos,
           'cobrado_otro_centavos',     q.cobrado_otro_centavos,
           'saldo_sin_cobrar_centavos', q.saldo_sin_cobrar_centavos,
           'contado_efectivo_centavos', q.contado_efectivo_centavos,
           'contado_tarjeta_centavos',  q.contado_tarjeta_centavos,
           'contado_otro_centavos',     q.contado_otro_centavos,
           'diferencia_centavos',       q.diferencia_centavos,
           'notas',                     q.notas,
           'hecho_en',                  q.hecho_en,
           'hecho_por_nombre',          (select p.nombre from public.profiles p where p.id = q.hecho_por))
    into v_cuadre
  from public.caja_cuadres q
  where q.noche_id = v_noche_id and q.tipo = 'noche'
  order by q.hecho_en desc
  limit 1;

  -- ---------- Anulaciones ----------
  select jsonb_build_object(
           'consumos',          (select count(*) from public.caja_consumos k where k.noche_id = v_noche_id and k.anulado)::int,
           'consumos_centavos', (select coalesce(sum(k.monto_centavos), 0) from public.caja_consumos k where k.noche_id = v_noche_id and k.anulado)::bigint,
           'cobros',            (select count(*) from public.caja_pagos p where p.noche_id = v_noche_id and p.anulado)::int,
           'cobros_centavos',   (select coalesce(sum(p.monto_centavos), 0) from public.caja_pagos p where p.noche_id = v_noche_id and p.anulado)::bigint,
           'mesas_reabiertas',  (select count(*) from public.caja_eventos e where e.noche_id = v_noche_id and e.tipo = 'reabrir_mesa')::int)
    into v_anul;

  -- ---------- Mesas y grupos ----------
  with s as (
    select s.mesa_id, s.estado from public.mesa_sesiones s
    where s.noche_id = v_noche_id and s.club_id = p_club_id
  )
  select jsonb_build_object(
           'mesas_antro',       (select count(*) from public.club_tables t where t.club_id = p_club_id)::int,
           'mesas_usadas',      (select count(distinct s.mesa_id) from s)::int,
           'grupos',            (select count(*) from s)::int,
           'grupos_abiertos',   (select count(*) from s where s.estado = 'abierta')::int,
           'grupos_cerrados',   (select count(*) from s where s.estado = 'cerrada')::int,
           'grupos_cuadrados',  (select count(*) from s where s.estado = 'cuadrada')::int,
           'mesas_varios_grupos', (select count(*) from (select s.mesa_id from s group by s.mesa_id having count(*) > 1) m)::int)
    into v_mesas;

  -- ---------- Comisiones y pagos a RPs de esa noche (sin anulados) ----------
  select jsonb_build_object(
           'comisiones',          (select count(*) from public.commissions c join public.reservations r on r.id = c.reservation_id
                                   where c.tipo = 'rp' and c.status <> 'anulada' and r.club_id = p_club_id and r.fecha = p_fecha)::int,
           'comisiones_en_cero',  (select count(*) from public.commissions c join public.reservations r on r.id = c.reservation_id
                                   where c.tipo = 'rp' and c.status <> 'anulada' and r.club_id = p_club_id and r.fecha = p_fecha
                                     and round(c.monto * 100) = 0)::int,
           'comision_centavos',   (select coalesce(sum(round(c.monto * 100)), 0) from public.commissions c join public.reservations r on r.id = c.reservation_id
                                   where c.tipo = 'rp' and c.status <> 'anulada' and r.club_id = p_club_id and r.fecha = p_fecha)::bigint,
           'pagos_dia',           (select count(*) from public.rp_pagos_dia d
                                   where d.status <> 'anulada' and d.club_id = p_club_id and d.fecha = p_fecha)::int,
           'pago_dia_centavos',   (select coalesce(sum(round(d.monto * 100)), 0) from public.rp_pagos_dia d
                                   where d.status <> 'anulada' and d.club_id = p_club_id and d.fecha = p_fecha)::bigint,
           'cuentas_rp_sin_cuadrar', (select count(*) from public.mesa_cuentas mc join public.mesa_sesiones s on s.id = mc.sesion_id
                                   where s.noche_id = v_noche_id and mc.rp_id is not null and mc.reservation_id is not null
                                     and mc.liquidada_en is null)::int)
    into v_com;
  v_com := v_com || jsonb_build_object('total_centavos',
             (v_com ->> 'comision_centavos')::bigint + (v_com ->> 'pago_dia_centavos')::bigint);

  -- ---------- Rendimiento por RP (la función de /grupo, para una noche) ----------
  select coalesce(jsonb_agg(jsonb_build_object(
           'rp_id', x.rp_id, 'rp_nombre', x.rp_nombre, 'rp_activo', x.rp_activo,
           'reservas', x.reservas, 'entraron', x.entraron, 'consumieron', x.consumieron,
           'consumo_centavos', x.consumo_centavos, 'ticket_centavos', x.ticket_centavos,
           'comisiones_centavos', x.comisiones_centavos)
         order by x.consumo_centavos desc, x.rp_nombre), '[]'::jsonb)
    into v_rps
  from public.grupo_rendimiento_rp(p_club_id, p_fecha, p_fecha) x
  where x.reservas > 0 or x.comisiones_centavos > 0;

  return jsonb_build_object(
    'version', 1,
    'club', jsonb_build_object('id', v_club.id, 'nombre', v_club.nombre, 'zona_horaria', v_club.zona_horaria),
    'fecha', p_fecha,
    'noche_en_curso', v_hoy,
    'momento', v_momento,
    'termino', v_termino,
    'noche', jsonb_build_object(
      'estado', coalesce(v_noche.estado, 'sin_caja'),
      'abierta_en', v_noche.abierta_en,
      'abierta_por_nombre', v_nombre_abrio,
      'cerrada_en', v_noche.cerrada_en,
      'cerrada_por_nombre', v_nombre_cerro),
    'reservas', v_reservas,
    'por_origen', v_origen,
    'consumo', v_consumo,
    'walk_ins', v_walk,
    'cobros', v_cobros,
    'cuadre', v_cuadre,
    'anulaciones', v_anul,
    'mesas', v_mesas,
    'comisiones', v_com,
    'rps', v_rps,
    'generado_en', now());
end;
$$;

revoke all on function public.reporte_cierre_noche(uuid, date) from public, anon;
grant execute on function public.reporte_cierre_noche(uuid, date) to authenticated, service_role;
