-- ============================================================================
-- AntroApp — B8: panel de salud para el admin (/admin/salud)
-- Fecha: 2026-11-25 (rama b-reportes, post-junta-2)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO.
-- Requiere: pase 1 (app_errores, login_intentos, caja_noches,
--           club_fecha_operacion, current_role_name) y pase 2
--           (registro_intentos de post-junta/04, alertas_enviadas de
--           post-junta/11, reglas_comision y commissions.regla_id de
--           post-junta/07). reserva_intentos (post-junta-2/72) es opcional:
--           si no existe, ese bloque sale como null.
-- Rollback: sql/post-junta-2/32-salud-rollback.sql
--
-- Dos funciones de solo lectura, SOLO para el admin (activo y sin
-- contraseña temporal: lo revisa current_role_name):
--   admin_salud()        → jsonb con conteos: login (1 h / 24 h, fallidos,
--                          bloqueos activos con los mismos umbrales que
--                          lib/domain/login.ts y lib/domain/captcha.ts),
--                          registros por IP (con modo degradado), reservas
--                          sin cuenta, alertas enviadas y errores de la app
--                          agrupados.
--   admin_salud_reglas() → un renglón por antro: modo de pago, regla vigente
--                          y programada, RPs con regla propia, comisiones de
--                          la semana y códigos de alerta fijos.
-- Nunca devuelven hashes (email_hash, ip_hash, telefono_hash: sin sal se
-- revierten probando correos o teléfonos conocidos), usuario_id, navegador
-- ni digest. Solo conteos y textos que ya ve el admin.
-- ============================================================================

-- login_intentos y registro_intentos solo tienen índices por hash: contar la
-- última hora o las últimas 24 h recorrería la tabla completa.
create index if not exists login_intentos_creado on public.login_intentos (creado_en desc);
create index if not exists registro_intentos_creado on public.registro_intentos (creado_en desc);

-- ---------------------------------------------------------------------------
-- admin_salud()
-- ---------------------------------------------------------------------------
create or replace function public.admin_salud()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- Mismos valores que lib/domain/login.ts y lib/domain/captcha.ts (la
  -- prueba scripts/dev/probar-salud.mjs los compara: si cambian en un lado
  -- y no en el otro, la prueba falla a propósito).
  c_ventana_min        constant int := 15;
  c_max_correo_ip      constant int := 5;
  c_max_correo         constant int := 30;
  c_max_ip             constant int := 20;
  c_deg_max_correo_ip  constant int := 3;
  c_deg_max_ip         constant int := 8;
  c_registros_hora     constant int := 5;
  c_deg_registros_hora constant int := 2;
  c_reservas_ip_hora   constant int := 20;
  c_reservas_telefono  constant int := 3;

  v_ahora timestamptz := now();
  v_login jsonb;
  v_bloqueos jsonb;
  v_registro jsonb;
  v_reservas jsonb;
  v_alertas jsonb;
  v_errores jsonb;
begin
  if not coalesce(public.current_role_name() = 'admin', false) then
    raise exception 'Solo el admin ve la salud de la plataforma.' using errcode = 'P0001';
  end if;

  -- Login: totales y fallidos de la última hora y de 24 h.
  select jsonb_build_object(
    'hora', jsonb_build_object(
      'total', count(*) filter (where l.creado_en >= v_ahora - interval '1 hour'),
      'fallidos', count(*) filter (where l.creado_en >= v_ahora - interval '1 hour' and not l.exito),
      'correos', count(distinct l.email_hash) filter (where l.creado_en >= v_ahora - interval '1 hour'),
      'ips', count(distinct l.ip_hash) filter (where l.creado_en >= v_ahora - interval '1 hour')),
    'dia', jsonb_build_object(
      'total', count(*),
      'fallidos', count(*) filter (where not l.exito),
      'correos', count(distinct l.email_hash),
      'ips', count(distinct l.ip_hash)))
  into v_login
  from public.login_intentos l
  where l.creado_en >= v_ahora - interval '24 hours';

  -- Bloqueos activos (lo que /api/auth/login respondería con 429 ahora):
  --   par correo+IP: fallos de ese correo desde esa IP desde su último éxito;
  --   correo: fallos desde el último éxito, de cualquier IP;
  --   IP: todos los fallos de la ventana.
  -- Todo dentro de la ventana de 15 min. login_intentos no guarda si el
  -- intento fue en modo degradado: se cuentan aparte los que ya estarían
  -- bloqueados con los límites del modo degradado.
  with v as (
    select l.email_hash, l.ip_hash, l.exito, l.creado_en
    from public.login_intentos l
    where l.creado_en >= v_ahora - make_interval(mins => c_ventana_min)
  ),
  par as (
    select x.email_hash, x.ip_hash,
           count(*) filter (where not x.exito and x.creado_en > coalesce(x.ultimo_exito, '-infinity'::timestamptz)) as fallos
    from (select v.*, max(v.creado_en) filter (where v.exito) over (partition by v.email_hash, v.ip_hash) as ultimo_exito from v) x
    group by x.email_hash, x.ip_hash
  ),
  correo as (
    select x.email_hash,
           count(*) filter (where not x.exito and x.creado_en > coalesce(x.ultimo_exito, '-infinity'::timestamptz)) as fallos
    from (select v.*, max(v.creado_en) filter (where v.exito) over (partition by v.email_hash) as ultimo_exito from v) x
    group by x.email_hash
  ),
  ip as (
    select v.ip_hash, count(*) filter (where not v.exito) as fallos from v group by v.ip_hash
  )
  select jsonb_build_object(
    'pares_correo_ip', (select count(*) from par where par.fallos >= c_max_correo_ip),
    'correos', (select count(*) from correo where correo.fallos >= c_max_correo),
    'ips', (select count(*) from ip where ip.fallos >= c_max_ip),
    'pares_correo_ip_degradado', (select count(*) from par where par.fallos >= c_deg_max_correo_ip),
    'ips_degradado', (select count(*) from ip where ip.fallos >= c_deg_max_ip))
  into v_bloqueos;

  -- Registros (post-junta/04): por IP, con modo degradado (sin CAPTCHA
  -- verificado). "Al límite" = la siguiente petición de esa IP sería
  -- rechazada (el conteo ya llegó al máximo de su modo).
  with r as (
    select g.ip_hash, g.tipo, g.degradado, g.creado_en
    from public.registro_intentos g
    where g.creado_en >= v_ahora - interval '24 hours'
  ),
  por_ip_hora as (
    select r.ip_hash, count(*) as n, bool_or(r.degradado) as alguno_degradado
    from r where r.creado_en >= v_ahora - interval '1 hour' group by r.ip_hash
  ),
  por_ip_dia as (
    select r.ip_hash, count(*) as n, count(*) filter (where r.degradado) as degradados
    from r group by r.ip_hash
  )
  select jsonb_build_object(
    'hora', jsonb_build_object(
      'total', (select count(*) from r where r.creado_en >= v_ahora - interval '1 hour'),
      'degradados', (select count(*) from r where r.creado_en >= v_ahora - interval '1 hour' and r.degradado)),
    'dia', jsonb_build_object(
      'total', (select count(*) from r),
      'degradados', (select count(*) from r where r.degradado),
      'ips', (select count(*) from por_ip_dia),
      'ips_con_degradado', (select count(*) from por_ip_dia where por_ip_dia.degradados > 0),
      'por_tipo', coalesce((select jsonb_object_agg(t.tipo, t.n) from (select r.tipo, count(*) as n from r group by r.tipo) t), '{}'::jsonb)),
    'ips_al_limite_hora', (select count(*) from por_ip_hora
                            where por_ip_hora.n >= c_registros_hora
                               or (por_ip_hora.alguno_degradado and por_ip_hora.n >= c_deg_registros_hora)),
    -- Las 10 IPs con más registros en 24 h, sin la IP: solo cuántos y
    -- cuántos de ellos en modo degradado.
    'top_ips_dia', coalesce((select jsonb_agg(jsonb_build_object('registros', t.n, 'degradados', t.degradados) order by t.n desc, t.degradados desc)
                             from (select por_ip_dia.n, por_ip_dia.degradados from por_ip_dia order by por_ip_dia.n desc, por_ip_dia.degradados desc limit 10) t), '[]'::jsonb))
  into v_registro;

  -- Reservas sin cuenta (post-junta-2/72): solo si la tabla existe.
  if to_regclass('public.reserva_intentos') is not null then
    execute $q$
      with r as (
        select x.ip_hash, x.club_id, x.telefono_hash, x.fecha, x.creado_en
        from public.reserva_intentos x
        where x.creado_en >= $1 - interval '24 hours'
      )
      select jsonb_build_object(
        'hora', (select count(*) from r where r.creado_en >= $1 - interval '1 hour'),
        'dia', (select count(*) from r),
        'ips_al_limite_hora', (select count(*) from (select r.ip_hash from r where r.creado_en >= $1 - interval '1 hour'
                                                     group by r.ip_hash having count(*) >= $2) t),
        'telefonos_al_limite', (select count(*) from (select 1 from r group by r.club_id, r.telefono_hash, r.fecha
                                                      having count(*) >= $3) t))
    $q$ into v_reservas using v_ahora, c_reservas_ip_hora, c_reservas_telefono;
  end if;

  -- Alertas por correo enviadas (post-junta/11): la última por tipo.
  select coalesce(jsonb_agg(jsonb_build_object('tipo', t.tipo, 'ultima', t.ultima, 'veces_7d', t.veces) order by t.ultima desc), '[]'::jsonb)
  into v_alertas
  from (
    select a.tipo, max(a.enviado_en) as ultima,
           count(*) filter (where a.enviado_en >= v_ahora - interval '7 days') as veces
    from public.alertas_enviadas a
    group by a.tipo
  ) t;

  -- Errores de la app (7 días), agrupados por mensaje y ruta. El mensaje ya
  -- llega sin teléfonos, correos ni códigos (C8); no salen usuario_id,
  -- navegador, digest ni ip_hash.
  with e as (
    select x.ruta, x.mensaje, x.creado_en
    from public.app_errores x
    where x.creado_en >= v_ahora - interval '7 days'
  ),
  g as (
    select e.mensaje, e.ruta, count(*) as veces,
           count(*) filter (where e.creado_en >= v_ahora - interval '24 hours') as veces_24h,
           max(e.creado_en) as ultimo
    from e group by e.mensaje, e.ruta
  )
  select jsonb_build_object(
    'dia', (select count(*) from e where e.creado_en >= v_ahora - interval '24 hours'),
    'semana', (select count(*) from e),
    'grupos_total', (select count(*) from g),
    'grupos', coalesce((select jsonb_agg(jsonb_build_object('mensaje', left(t.mensaje, 300), 'ruta', left(t.ruta, 200),
                                                         'veces', t.veces, 'veces_24h', t.veces_24h, 'ultimo', t.ultimo)
                                         order by t.veces_24h desc, t.veces desc, t.ultimo desc)
                        from (select * from g order by g.veces_24h desc, g.veces desc, g.ultimo desc limit 40) t), '[]'::jsonb))
  into v_errores;

  return jsonb_build_object(
    'generado_en', v_ahora,
    'umbrales', jsonb_build_object(
      'ventana_minutos', c_ventana_min,
      'max_fallos_correo_ip', c_max_correo_ip,
      'max_fallos_correo', c_max_correo,
      'max_fallos_ip', c_max_ip,
      'degradado_max_fallos_correo_ip', c_deg_max_correo_ip,
      'degradado_max_fallos_ip', c_deg_max_ip,
      'registros_por_ip_hora', c_registros_hora,
      'degradado_registros_por_ip_hora', c_deg_registros_hora,
      'reservas_por_ip_hora', c_reservas_ip_hora,
      'reservas_por_telefono_noche', c_reservas_telefono),
    'login', v_login,
    'bloqueos', v_bloqueos,
    'registro', v_registro,
    'reservas_sin_cuenta', v_reservas,
    'alertas', v_alertas,
    'errores', v_errores);
end;
$$;
revoke all on function public.admin_salud() from public, anon;
grant execute on function public.admin_salud() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- admin_salud_reglas()
-- Códigos de alerta (fijos; la pantalla los traduce):
--   legacy                 modo 'reserva' sin regla nueva: sigue con
--                          clubs.comision_* (las columnas de antes).
--   sin_regla              además, esas columnas dan $0 (o están vacías) y
--                          hay RPs activos sin regla propia (o ningún RP):
--                          esos RPs no ganan comisión.
--   dia_sin_tarifas        modo 'dia' sin club_dia_tarifas.
--   regla_id_inconsistente comisiones de las últimas 4 semanas que no
--                          guardaron la regla vigente esa noche (y el RP no
--                          tiene regla propia), o que apuntan a una regla que
--                          no era la de ese antro esa noche.
--   noche_sin_cerrar       caja_noches 'abierta' de una noche que ya pasó.
--   pendientes_viejas      comisiones o pagos por día en 'pendiente' de
--                          hace más de 4 semanas.
-- ---------------------------------------------------------------------------
create or replace function public.admin_salud_reglas()
returns table (
  club_id uuid,
  nombre text,
  publicado boolean,
  modo_pago text,
  hoy date,
  semana_desde date,
  regla jsonb,
  programada jsonb,
  rps_activos int,
  rps_con_regla_propia int,
  rps_con_tarifa_dia_propia int,
  tarifas_dia int,
  comisiones_semana int,
  comisiones_semana_en_cero int,
  comision_semana_centavos bigint,
  pagos_dia_semana int,
  pagos_dia_semana_centavos bigint,
  comisiones_inconsistentes int,
  noches_sin_cerrar int,
  pendientes_viejas int,
  alertas text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not coalesce(public.current_role_name() = 'admin', false) then
    raise exception 'Solo el admin ve la salud de la plataforma.' using errcode = 'P0001';
  end if;

  return query
  with b as (
    select c.id, c.nombre, c.pago_rp_modo, c.comision_monto,
           (c.estado_verificacion = 'verificado' and coalesce(c.suscripcion_activa, false)) as pub,
           public.club_fecha_operacion(c.id, now()) as dia
    from public.clubs c
  ),
  b2 as (
    select b.*, public.lunes_de(b.dia) as lunes, public.regla_comision_descripcion(b.id, b.dia) as desc_regla
    from b
  ),
  f as (
    select b2.id, b2.nombre, b2.pub, b2.pago_rp_modo, b2.comision_monto, b2.dia, b2.lunes, b2.desc_regla,
      (select jsonb_build_object('tipo', r.tipo, 'cuota', r.cuota, 'porcentaje_bp', r.porcentaje_bp,
                                 'monto_centavos', r.monto_centavos, 'vigente_desde', r.vigente_desde)
         from public.reglas_comision r
        where r.club_id = b2.id and r.vigente_desde > b2.dia
        order by r.vigente_desde desc limit 1) as prog,
      (select count(*)::int from public.profiles p
        where p.club_id = b2.id and p.role = 'rp' and p.activo is not false) as rps,
      -- Solo RPs activos de ESE antro (el mismo criterio que rps y
      -- rps_sin_propia): así "M con regla propia" es parte de "N activos".
      (select count(distinct o.rp_id)::int from public.rp_comision_overrides o
         join public.profiles p on p.id = o.rp_id
        where o.club_id = b2.id and p.club_id = b2.id and p.role = 'rp' and p.activo is not false) as rps_propia,
      (select count(*)::int from public.profiles p
        where p.club_id = b2.id and p.role = 'rp' and p.activo is not false
          and not exists (select 1 from public.rp_comision_overrides o where o.club_id = b2.id and o.rp_id = p.id)) as rps_sin_propia,
      (select count(distinct o.rp_id)::int from public.rp_dia_tarifa_overrides o
         join public.profiles p on p.id = o.rp_id
        where o.club_id = b2.id and p.club_id = b2.id and p.role = 'rp' and p.activo is not false) as rps_dia_propia,
      (select count(*)::int from public.club_dia_tarifas t where t.club_id = b2.id) as tarifas,
      cs.n as com_n, cs.cero as com_cero, cs.cent as com_cent,
      pd.n as dia_n, pd.cent as dia_cent,
      inc.n as inc_n,
      (select count(*)::int from public.caja_noches n
        where n.club_id = b2.id and n.estado = 'abierta' and n.fecha_operacion < b2.dia) as noches,
      pv.n + pv2.n as viejas
    from b2
    -- Comisiones de RP de la semana operativa (lunes a domingo, por la noche
    -- de la reserva), sin las anuladas.
    left join lateral (
      select count(*)::int as n, count(*) filter (where c.monto = 0)::int as cero,
             coalesce(sum(round(c.monto * 100)), 0)::bigint as cent
      from public.commissions c
      join public.reservations r on r.id = c.reservation_id
      where c.tipo = 'rp' and c.status <> 'anulada'
        and r.club_id = b2.id and r.fecha between b2.lunes and b2.lunes + 6
    ) cs on true
    left join lateral (
      select count(*)::int as n, coalesce(sum(round(p.monto * 100)), 0)::bigint as cent
      from public.rp_pagos_dia p
      where p.club_id = b2.id and p.status <> 'anulada' and p.fecha between b2.lunes and b2.lunes + 6
    ) pd on true
    left join lateral (
      select count(*)::int as n
      from public.commissions c
      join public.reservations r on r.id = c.reservation_id
      where c.tipo = 'rp' and c.status <> 'anulada'
        and r.club_id = b2.id and r.fecha >= b2.dia - 28
        and (
          (c.regla_id is null
            and not exists (select 1 from public.rp_comision_overrides o where o.club_id = b2.id and o.rp_id = c.rp_id)
            and exists (select 1 from public.reglas_comision g
                         where g.club_id = b2.id and g.vigente_desde <= r.fecha
                           and (g.vigente_hasta is null or g.vigente_hasta >= r.fecha)))
          or
          (c.regla_id is not null
            and not exists (select 1 from public.reglas_comision g
                             where g.id = c.regla_id and g.club_id = b2.id and g.vigente_desde <= r.fecha
                               and (g.vigente_hasta is null or g.vigente_hasta >= r.fecha)))
        )
    ) inc on true
    left join lateral (
      select count(*)::int as n
      from public.commissions c
      join public.reservations r on r.id = c.reservation_id
      where c.tipo = 'rp' and c.status = 'pendiente' and r.club_id = b2.id and r.fecha < b2.dia - 28
    ) pv on true
    left join lateral (
      select count(*)::int as n
      from public.rp_pagos_dia p
      where p.club_id = b2.id and p.status = 'pendiente' and p.fecha < b2.dia - 28
    ) pv2 on true
  )
  select f.id, f.nombre::text, f.pub, f.pago_rp_modo::text, f.dia, f.lunes, f.desc_regla, f.prog,
         f.rps, f.rps_propia, f.rps_dia_propia, f.tarifas,
         f.com_n, f.com_cero, f.com_cent, f.dia_n, f.dia_cent,
         f.inc_n, f.noches, f.viejas,
         array_remove(array[
           case when f.pago_rp_modo = 'reserva' and f.desc_regla ->> 'origen' = 'anterior' then 'legacy' end,
           case when f.pago_rp_modo = 'reserva' and f.desc_regla ->> 'origen' = 'anterior'
                     and coalesce(f.comision_monto, 0) = 0
                     and (f.rps_sin_propia > 0 or f.rps = 0) then 'sin_regla' end,
           case when f.pago_rp_modo = 'dia' and f.tarifas = 0 then 'dia_sin_tarifas' end,
           case when f.inc_n > 0 then 'regla_id_inconsistente' end,
           case when f.noches > 0 then 'noche_sin_cerrar' end,
           case when f.viejas > 0 then 'pendientes_viejas' end
         ]::text[], null)
  from f
  order by f.pub desc, f.nombre;
end;
$$;
revoke all on function public.admin_salud_reglas() from public, anon;
grant execute on function public.admin_salud_reglas() to authenticated, service_role;
