-- ============================================================================
-- AntroApp — Reportes PDF del dueño: «Reporte de la noche» y «Reporte de la
-- semana» (bloque 7, noche 4, carril n4-reportes)
-- Fecha: 2026-11-27. Rollback: sql/post-junta-3/70-reportes-pdf-rollback.sql
-- (solo quita las 3 funciones; no guarda datos).
-- Estado: APLICADO Y PROBADO SOLO EN DEV. En producción NO.
-- Requiere: sql/post-junta-3/00-funciones-club.sql (funcion_activa) y
--           sql/post-junta-2/30-cierre-noche.sql (reporte_cierre_noche),
--           que a su vez requiere el pase 1 (caja, nómina, /grupo).
-- Prueba (dev): node scripts/dev/probar-reportes-pdf.mjs
--
-- No calcula cifras nuevas: es una capa delgada sobre las fuentes que ya
-- existen, para que el PDF diga exactamente lo mismo que la pantalla:
--   reporte_pdf_noche(club, fecha)   = reporte_cierre_noche(club, fecha)
--                                      + la hora en que se generó (zona del
--                                      antro) y tipo = 'noche'.
--   reporte_pdf_semana(club, lunes)  = las 7 noches de reporte_cierre_noche
--                                      (lunes a domingo, en una sola lectura),
--                                      sus sumas, y el rendimiento por RP de
--                                      grupo_rendimiento_rp(club, lunes, domingo)
--                                      (la misma función de /grupo).
-- Lo que agrega: la bandera por antro y un solo punto de acceso.
--
-- Definiciones de la semana (las mismas de grupo_resumen):
--   * consumo, cobros, comisiones, reservas, personas, cuentas: suma de las
--     7 noches (una cuenta de mesa pertenece a una sola noche, así que la
--     suma de cuentas con consumo = cuentas distintas de la semana).
--   * ticket promedio = consumo total / cuentas con consumo, redondeado al
--     centavo (no es el promedio de los tickets de cada noche).
--   * anulaciones (consumos y cobros anulados, mesas reabiertas): suma de las
--     7 noches, como las cuenta el cierre de cada una.
--   * cuadre: diferencia_centavos = suma de las diferencias de las noches que
--     se cerraron en caja (noches_con_cuadre); las demás no tienen cuadre.
--   * parcial: alguna de las 7 noches no ha terminado (no llega a su corte
--     de las 08:00 en la zona del antro y su caja no está cerrada).
--
-- Acceso (en la base; con coalesce, sin NULL que se cuele): admin, el dueño
-- del antro, el dueño de su grupo y su gerente ACTIVO — los mismos que ya ven
-- el cierre de la noche, /grupo y los exportes con las mismas cifras
-- (comisiones incluidas). Staff, RP, cliente, cuenta sin perfil, dado de
-- baja y contraseña temporal: rechazados (P0001). Anónimo: sin EXECUTE.
-- Y solo con la bandera 'reportes_pdf' encendida para ese antro (o su
-- grupo). La bandera se revisa DESPUÉS del acceso: a quien no tiene acceso
-- no se le dice si el antro la tiene encendida.
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- Autoriza (uso interno): sesión, acceso al antro y bandera encendida.
-- ---------------------------------------------------------------------------
create function public.reporte_pdf_autorizar(p_club_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rol text := public.current_role_name();
begin
  if auth.uid() is null then
    raise exception 'Inicia sesión para ver los reportes.' using errcode = 'P0001';
  end if;
  if p_club_id is null then
    raise exception 'Elige el antro.' using errcode = 'P0001';
  end if;
  if not coalesce(v_rol = 'admin'
          or public.club_es_dueno(p_club_id)
          or public.club_es_dueno_grupo(p_club_id)
          or (v_rol = 'gerente' and p_club_id = public.current_club_id()
              and exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo)), false) then
    raise exception 'No tienes acceso a los reportes de este antro.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.clubs c where c.id = p_club_id) then
    raise exception 'No encontramos ese antro.' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(p_club_id, 'reportes_pdf'), false) then
    raise exception 'Los reportes PDF no están activos para este antro.' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.reporte_pdf_autorizar(uuid) from public, anon, authenticated;
grant execute on function public.reporte_pdf_autorizar(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Reporte de la noche: el cierre de la noche tal cual, más la hora local.
-- ---------------------------------------------------------------------------
create function public.reporte_pdf_noche(p_club_id uuid, p_fecha date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rep  jsonb;
  v_zona text;
begin
  perform public.reporte_pdf_autorizar(p_club_id);
  if p_fecha is null then
    raise exception 'Elige la noche.' using errcode = 'P0001';
  end if;
  -- reporte_cierre_noche vuelve a autorizar a quien llama (auth.uid() no
  -- cambia dentro de una función SECURITY DEFINER) y valida la fecha.
  v_rep := public.reporte_cierre_noche(p_club_id, p_fecha);
  v_zona := coalesce(v_rep -> 'club' ->> 'zona_horaria', 'America/Mexico_City');
  return v_rep || jsonb_build_object(
    'tipo', 'noche',
    'generado_local', to_char(now() at time zone v_zona, 'YYYY-MM-DD HH24:MI'));
end;
$$;

revoke all on function public.reporte_pdf_noche(uuid, date) from public, anon;
grant execute on function public.reporte_pdf_noche(uuid, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Reporte de la semana (lunes a domingo): noche por noche, sumas y RPs.
-- ---------------------------------------------------------------------------
create function public.reporte_pdf_semana(p_club_id uuid, p_lunes date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hoy     date;
  v_c       jsonb;
  v_club    jsonb;
  v_mesas   integer := 0;
  v_noches  jsonb := '[]'::jsonb;
  v_totales jsonb;
  v_rps     jsonb;
  v_zona    text;
  i         integer;
begin
  perform public.reporte_pdf_autorizar(p_club_id);
  if p_lunes is null then
    raise exception 'Elige la semana.' using errcode = 'P0001';
  end if;
  if extract(isodow from p_lunes) <> 1 then
    raise exception 'La semana va de lunes a domingo: elige un lunes.' using errcode = 'P0001';
  end if;
  v_hoy := public.club_fecha_operacion(p_club_id);
  if p_lunes < date '2020-01-01' or v_hoy is null or p_lunes + 6 > v_hoy + 92 then
    raise exception 'Elige una semana entre 2020 y los próximos 3 meses.' using errcode = 'P0001';
  end if;

  for i in 0..6 loop
    v_c := public.reporte_cierre_noche(p_club_id, p_lunes + i);
    if i = 0 then
      v_club := v_c -> 'club';
      v_mesas := coalesce((v_c -> 'mesas' ->> 'mesas_antro')::int, 0);
    end if;
    v_noches := v_noches || jsonb_build_array(jsonb_build_object(
      'fecha',                    v_c -> 'fecha',
      'momento',                  v_c -> 'momento',
      'termino',                  v_c -> 'termino',
      'estado_caja',              v_c -> 'noche' -> 'estado',
      'reservas',                 (v_c -> 'reservas' ->> 'reservas')::int,
      'personas',                 (v_c -> 'reservas' ->> 'personas')::int,
      'entraron',                 (v_c -> 'reservas' ->> 'entraron')::int,
      'consumieron',              (v_c -> 'reservas' ->> 'consumieron')::int,
      'no_llegaron',              (v_c -> 'reservas' ->> 'no_llegaron')::int,
      'por_llegar',               (v_c -> 'reservas' ->> 'por_llegar')::int,
      'cuentas',                  (v_c -> 'walk_ins' ->> 'cuentas_total')::int,
      'cuentas_walk_in',          (v_c -> 'walk_ins' ->> 'cuentas')::int,
      'personas_walk_in',         (v_c -> 'walk_ins' ->> 'personas')::int,
      'mesas_usadas',             (v_c -> 'mesas' ->> 'mesas_usadas')::int,
      'grupos',                   (v_c -> 'mesas' ->> 'grupos')::int,
      'consumo_centavos',         (v_c -> 'consumo' ->> 'total_centavos')::bigint,
      'cuentas_con_consumo',      (v_c -> 'consumo' ->> 'cuentas_con_consumo')::int,
      'ticket_promedio_centavos', (v_c -> 'consumo' ->> 'ticket_promedio_centavos')::bigint,
      'efectivo_centavos',        (v_c -> 'cobros' ->> 'efectivo_centavos')::bigint,
      'tarjeta_centavos',         (v_c -> 'cobros' ->> 'tarjeta_centavos')::bigint,
      'otro_centavos',            (v_c -> 'cobros' ->> 'otro_centavos')::bigint,
      'cobrado_centavos',         (v_c -> 'cobros' ->> 'total_centavos')::bigint,
      'por_cobrar_centavos',      (v_c -> 'cobros' ->> 'por_cobrar_centavos')::bigint,
      'comision_reserva_centavos', (v_c -> 'comisiones' ->> 'comision_centavos')::bigint,
      'pago_dia_centavos',        (v_c -> 'comisiones' ->> 'pago_dia_centavos')::bigint,
      'comisiones_centavos',      (v_c -> 'comisiones' ->> 'total_centavos')::bigint,
      'cuentas_rp_sin_cuadrar',   (v_c -> 'comisiones' ->> 'cuentas_rp_sin_cuadrar')::int,
      'consumos_anulados',        (v_c -> 'anulaciones' ->> 'consumos')::int,
      'consumos_anulados_centavos', (v_c -> 'anulaciones' ->> 'consumos_centavos')::bigint,
      'cobros_anulados',          (v_c -> 'anulaciones' ->> 'cobros')::int,
      'cobros_anulados_centavos', (v_c -> 'anulaciones' ->> 'cobros_centavos')::bigint,
      'mesas_reabiertas',         (v_c -> 'anulaciones' ->> 'mesas_reabiertas')::int,
      -- Cuadre general de la noche (solo si se cerró en caja; si no, null).
      'con_cuadre',               coalesce(jsonb_typeof(v_c -> 'cuadre') = 'object', false),
      'diferencia_centavos',      (v_c -> 'cuadre' ->> 'diferencia_centavos')::bigint));
  end loop;

  select jsonb_build_object(
           'reservas',                  sum((e ->> 'reservas')::int),
           'personas',                  sum((e ->> 'personas')::int),
           'entraron',                  sum((e ->> 'entraron')::int),
           'consumieron',               sum((e ->> 'consumieron')::int),
           'no_llegaron',               sum((e ->> 'no_llegaron')::int),
           'por_llegar',                sum((e ->> 'por_llegar')::int),
           'cuentas',                   sum((e ->> 'cuentas')::int),
           'cuentas_walk_in',           sum((e ->> 'cuentas_walk_in')::int),
           'personas_walk_in',          sum((e ->> 'personas_walk_in')::int),
           'grupos',                    sum((e ->> 'grupos')::int),
           'consumo_centavos',          sum((e ->> 'consumo_centavos')::bigint),
           'cuentas_con_consumo',       sum((e ->> 'cuentas_con_consumo')::int),
           'ticket_promedio_centavos',
             case when sum((e ->> 'cuentas_con_consumo')::int) > 0
                  then round(sum((e ->> 'consumo_centavos')::bigint)::numeric / sum((e ->> 'cuentas_con_consumo')::int))::bigint
                  else 0 end,
           'efectivo_centavos',         sum((e ->> 'efectivo_centavos')::bigint),
           'tarjeta_centavos',          sum((e ->> 'tarjeta_centavos')::bigint),
           'otro_centavos',             sum((e ->> 'otro_centavos')::bigint),
           'cobrado_centavos',          sum((e ->> 'cobrado_centavos')::bigint),
           'por_cobrar_centavos',       sum((e ->> 'por_cobrar_centavos')::bigint),
           'comision_reserva_centavos', sum((e ->> 'comision_reserva_centavos')::bigint),
           'pago_dia_centavos',         sum((e ->> 'pago_dia_centavos')::bigint),
           'comisiones_centavos',       sum((e ->> 'comisiones_centavos')::bigint),
           'cuentas_rp_sin_cuadrar',    sum((e ->> 'cuentas_rp_sin_cuadrar')::int),
           'consumos_anulados',         sum((e ->> 'consumos_anulados')::int),
           'consumos_anulados_centavos', sum((e ->> 'consumos_anulados_centavos')::bigint),
           'cobros_anulados',           sum((e ->> 'cobros_anulados')::int),
           'cobros_anulados_centavos',  sum((e ->> 'cobros_anulados_centavos')::bigint),
           'mesas_reabiertas',          sum((e ->> 'mesas_reabiertas')::int),
           'noches_con_cuadre',         count(*) filter (where (e ->> 'con_cuadre')::boolean),
           'diferencia_centavos',       coalesce(sum((e ->> 'diferencia_centavos')::bigint), 0),
           'noches_con_consumo',        count(*) filter (where (e ->> 'consumo_centavos')::bigint > 0),
           'noches_sin_terminar',       count(*) filter (where not (e ->> 'termino')::boolean))
    into v_totales
  from jsonb_array_elements(v_noches) e;

  select coalesce(jsonb_agg(jsonb_build_object(
           'rp_id', x.rp_id, 'rp_nombre', x.rp_nombre, 'rp_activo', x.rp_activo,
           'reservas', x.reservas, 'por_venir', x.por_venir, 'entraron', x.entraron,
           'consumieron', x.consumieron, 'consumo_centavos', x.consumo_centavos,
           'ticket_centavos', x.ticket_centavos, 'comisiones_centavos', x.comisiones_centavos)
         order by x.consumo_centavos desc, x.rp_nombre), '[]'::jsonb)
    into v_rps
  from public.grupo_rendimiento_rp(p_club_id, p_lunes, p_lunes + 6) x
  where x.reservas > 0 or x.comisiones_centavos > 0;

  v_zona := coalesce(v_club ->> 'zona_horaria', 'America/Mexico_City');
  return jsonb_build_object(
    'version', 1,
    'tipo', 'semana',
    'club', v_club,
    'lunes', p_lunes,
    'domingo', p_lunes + 6,
    'semana_iso', jsonb_build_object('anio', extract(isoyear from p_lunes)::int, 'semana', extract(week from p_lunes)::int),
    'noche_en_curso', v_hoy,
    'parcial', (v_totales ->> 'noches_sin_terminar')::int > 0,
    'mesas_antro', v_mesas,
    'noches', v_noches,
    'totales', v_totales,
    'rps', v_rps,
    'generado_en', now(),
    'generado_local', to_char(now() at time zone v_zona, 'YYYY-MM-DD HH24:MI'));
end;
$$;

revoke all on function public.reporte_pdf_semana(uuid, date) from public, anon;
grant execute on function public.reporte_pdf_semana(uuid, date) to authenticated, service_role;

commit;
