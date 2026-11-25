-- ============================================================================
-- AntroApp — Qué ve el RP: candado real del nivel "solo estado" y nivel
-- "estado, monto y botellas" con el catálogo de la fase 2
-- Fecha: 2026-11-24 (rama b-cliente, post-junta-2)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO.
-- Requiere: pase 1 (rp_mis_reservas, soy_rp_dado_de_baja) y
--           sql/post-junta/07-config-rp.sql (club_config_rp,
--           rp_nivel_visibilidad configurable). La fase 2
--           (sql/fase2/2026-11-21-inventario-propinas.sql) es OPCIONAL: esta
--           función revisa al correr si existe.
-- Rollback: sql/post-junta-2/41-rp-visibilidad-rollback.sql
-- ORDEN EN EL PASE: DESPUÉS del código nuevo (app/rp/panel lee su
-- rendimiento con rp_mis_reservas). Con el código viejo, el resumen de
-- «lo que llevas ganado» del RP saldría en ceros.
--
-- 1. FUGA (media): con «solo el estado», el RP todavía leía el consumo de
--    sus clientes directo de la tabla, con la anon key y su sesión:
--      supabase.from('reservations').select('consumo_monto')
--    porque la política permisiva reservations_select_rp_own (rp_id =
--    auth.uid()) le abría la fila completa y el GRANT de tabla incluye
--    consumo_monto. Postgres no tiene RLS por columna y un permiso por
--    columna valdría para todos los roles (staff, gerente, dueño, admin y
--    cliente comparten el rol authenticated), así que se cierra así:
--      el RP ya NO lee reservations directo. Todo lo suyo sale de
--      rp_mis_reservas (security definer), que aplica el nivel del antro.
--    Sigue pudiendo CREAR reservas (reservations_insert_rp, sin cambio:
--    el insert del panel no pide la fila de regreso). Staff, gerente,
--    dueño, admin y cliente no cambian. commissions no cambia: el RP ve su
--    propia comisión (con regla de porcentaje, de ahí se puede deducir el
--    consumo; la pantalla del dueño lo avisa).
-- 2. rp_nivel_visibilidad(club) ya no se puede llamar con sesión: decía la
--    configuración de cualquier antro a cualquier usuario. Solo la usan
--    funciones security definer (corren como su dueño), que no cambian.
-- 3. «Estado, monto y botellas»: los renglones son SOLO los consumos del
--    catálogo (fase 2: caja_consumos.producto_id), agrupados por producto
--    con cantidad, categoría y monto; lo que se capturó como concepto libre
--    se suma aparte en otros_centavos («Otros consumos»). Si la base no
--    tiene la fase 2 (o nadie vende del catálogo), no hay renglones y el
--    nivel se ve igual que «estado y monto». La pantalla, además, solo
--    muestra las botellas con la bandera NEXT_PUBLIC_FASE2 encendida.
--    Cambia el tipo de retorno (columna nueva AL FINAL: otros_centavos), así
--    que es drop + create en la misma transacción. Las 17 columnas de hoy
--    quedan iguales y en el mismo orden; renglones conserva las llaves
--    concepto y monto_centavos (el código viejo la sigue leyendo) y suma
--    producto, categoria y cantidad.
-- ============================================================================

-- 1. El RP deja de leer la tabla directo.
drop policy if exists reservations_select_rp_own on public.reservations;

-- 2. Nadie con sesión pregunta la configuración de un antro por aquí.
revoke all on function public.rp_nivel_visibilidad(uuid) from public, anon, authenticated;

-- 3. Reservas del RP con el nivel del antro.
drop function if exists public.rp_mis_reservas(date, date);

create function public.rp_mis_reservas(p_desde date, p_hasta date)
returns table (
  reservation_id      uuid,
  cliente_nombre      text,
  cliente_telefono    text,
  fecha               date,
  personas            int,
  estado              text,
  mesa                text,
  consumo_centavos    bigint,   -- nulo si el nivel no incluye el monto
  renglones           jsonb,    -- nulo si el nivel no incluye las botellas (o no hay fase 2)
  creada_en           timestamptz,
  llego_en            timestamptz,
  sentado_en          timestamptz,
  primer_consumo_en   timestamptz,
  cuadrada_en         timestamptz,
  comision_centavos   bigint,
  comision_estado     text,
  nivel               text,
  otros_centavos      bigint    -- con botellas: lo que no salió del catálogo
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rp       uuid := auth.uid();
  v_club     uuid := public.current_club_id();
  v_nivel    text;
  v_hoy      date;
  v_botellas jsonb;
begin
  if v_rp is null or public.current_role_name() is distinct from 'rp' or v_club is null then
    raise exception 'Solo para RPs';
  end if;
  if exists (select 1 from public.profiles p where p.id = v_rp and p.activo is false) then
    raise exception 'Tu cuenta está desactivada';
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 62 then
    raise exception 'Rango de fechas inválido (máximo 62 días)';
  end if;
  v_nivel := public.rp_nivel_visibilidad(v_club);
  v_hoy := public.club_fecha_operacion(v_club, now());

  -- Botellas: solo con el catálogo de la fase 2 en la base. Se arma con SQL
  -- dinámico para que la función exista y corra igual sin la fase 2.
  if v_nivel = 'estado_monto_botellas'
     and to_regclass('public.productos') is not null
     and exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.caja_consumos'::regclass
                   and a.attname = 'producto_id' and not a.attisdropped) then
    execute $q$
      with cta as (
        select distinct on (c.reservation_id) c.reservation_id, c.id as cuenta_id
        from public.mesa_cuentas c
        join public.reservations r on r.id = c.reservation_id
        where r.rp_id = $1 and r.club_id = $2 and r.source = 'rp' and r.fecha between $3 and $4
        order by c.reservation_id, c.creada_en
      ),
      prod as (
        select k.cuenta_id, p.nombre, p.categoria,
               sum(k.cantidad)::int as cantidad,
               sum(k.monto_centavos)::bigint as cent,
               min(k.registrado_en) as primero
        from public.caja_consumos k
        join public.productos p on p.id = k.producto_id
        where k.cuenta_id in (select cuenta_id from cta) and not k.anulado and k.producto_id is not null
        group by k.cuenta_id, k.producto_id, p.nombre, p.categoria
      ),
      otros as (
        select k.cuenta_id, sum(k.monto_centavos)::bigint as cent
        from public.caja_consumos k
        where k.cuenta_id in (select cuenta_id from cta) and not k.anulado and k.producto_id is null
        group by k.cuenta_id
      )
      select coalesce(jsonb_object_agg(cta.cuenta_id::text, jsonb_build_object(
               'items', coalesce((select jsonb_agg(jsonb_build_object(
                          'concepto', x.cantidad || ' × ' || x.nombre,
                          'producto', x.nombre, 'categoria', x.categoria,
                          'cantidad', x.cantidad, 'monto_centavos', x.cent) order by x.primero, x.nombre)
                        from prod x where x.cuenta_id = cta.cuenta_id), '[]'::jsonb),
               'otros', coalesce((select o.cent from otros o where o.cuenta_id = cta.cuenta_id), 0))), '{}'::jsonb)
      from cta
    $q$ into v_botellas using v_rp, v_club, p_desde, p_hasta;
  end if;

  return query
  with
  res as (
    select r.* from public.reservations r
    where r.rp_id = v_rp and r.club_id = v_club and r.source = 'rp'
      and r.fecha between p_desde and p_hasta
  ),
  cta as (
    select distinct on (c.reservation_id)
           c.reservation_id, c.id as cuenta_id, c.creada_en, s.cuadrada_en, t.numero as mesa
    from public.mesa_cuentas c
    join public.mesa_sesiones s on s.id = c.sesion_id
    join public.club_tables t on t.id = s.mesa_id
    where c.reservation_id in (select id from res)
    order by c.reservation_id, c.creada_en
  ),
  con as (
    select k.cuenta_id,
           coalesce(sum(k.monto_centavos) filter (where not k.anulado), 0)::bigint as cent,
           min(k.registrado_en) filter (where not k.anulado) as primero
    from public.caja_consumos k
    where k.cuenta_id in (select cuenta_id from cta)
    group by k.cuenta_id
  ),
  noc as (
    select n.fecha_operacion, n.estado from public.caja_noches n
    where n.club_id = v_club and n.fecha_operacion between p_desde and p_hasta
  )
  select r.id, r.cliente_nombre, r.cliente_telefono, r.fecha, r.personas,
         case
           when coalesce(con.cent, 0) > 0 then 'consumio'
           when coalesce(r.puerta_estado, case when r.status = 'usada' then 'entro' end) = 'entro' then 'llego_sin_consumo'
           when noc.estado = 'cerrada' or r.fecha < v_hoy then 'no_llego'
           else 'por_llegar'
         end,
         cta.mesa,
         case when v_nivel in ('estado_monto', 'estado_monto_botellas') then coalesce(con.cent, 0) end,
         case when v_botellas is not null then coalesce(v_botellas -> (cta.cuenta_id::text) -> 'items', '[]'::jsonb) end,
         r.created_at, r.entrada_en, cta.creada_en, con.primero, cta.cuadrada_en,
         round(cm.monto * 100)::bigint, cm.status, v_nivel,
         case when v_botellas is not null then coalesce((v_botellas -> (cta.cuenta_id::text) ->> 'otros')::bigint, 0) end
  from res r
  left join cta on cta.reservation_id = r.id
  left join con on con.cuenta_id = cta.cuenta_id
  left join noc on noc.fecha_operacion = r.fecha
  left join public.commissions cm on cm.reservation_id = r.id and cm.tipo = 'rp'
  order by r.fecha desc, r.created_at desc;
end;
$$;

-- Mismos permisos que hoy: solo con sesión (la función revisa que sea RP).
revoke all on function public.rp_mis_reservas(date, date) from public, anon;
grant execute on function public.rp_mis_reservas(date, date) to authenticated;
