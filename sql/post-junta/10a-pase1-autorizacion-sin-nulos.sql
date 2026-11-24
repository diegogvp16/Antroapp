-- ============================================================================
-- AntroApp — Autorización que nunca queda en NULL
-- Fecha: 2026-11-24 (rama post-junta)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO.
-- IMPORTANTE: corrige un hueco ALTO del SQL del PASE 1 (candidato-pase):
--   aplicar en el mismo pase, inmediatamente después de sus funciones.
-- Versión para el PASE 1: las mismas funciones que el 10 menos
-- personal_historial (que no existe hasta post-junta). Aplicar justo después
-- del paso 7b del pase 1. Rollback: sql/post-junta/10a-pase1-autorizacion-sin-nulos-rollback.sql
--
-- En plpgsql, "if not (rol = 'admin' or ...) then raise" NO rechaza cuando
-- la condición da NULL, y da NULL si current_role_name() es nulo: una cuenta
-- de Auth sin perfil (cualquiera la crea con signUp directo a Supabase), un
-- perfil dado de baja o con contraseña temporal. Probado en dev ANTES de
-- este arreglo: una cuenta sin perfil leía nomina_semana y
-- grupo_rendimiento_rp de cualquier antro, y actividad_club.
-- Arreglo mínimo: los ayudantes de autorización devuelven false en vez de
-- NULL (coalesce) y las condiciones en línea van dentro de coalesce(…, false).
-- Cuerpos tomados del catálogo de dev; solo cambian esas líneas.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.caja_tiene_permiso(p_club_id uuid, p_permiso text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_rol text := public.current_role_name();
  v_permitido boolean;
begin
  if auth.uid() is null then
    return false;
  end if;
  if v_rol = 'admin' then
    return true;
  end if;
  if public.club_es_dueno(p_club_id) then
    return true;
  end if;
  -- El dueño de grupo LEE todos sus antros (caja_puede_ver) pero no opera la
  -- caja (decisión 13). Si se decide que sí, basta con:
  --   if public.club_es_dueno_grupo(p_club_id) then return true; end if;
  if v_rol is null or v_rol not in ('staff', 'gerente') or public.current_club_id() is distinct from p_club_id then
    return false;
  end if;
  if exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo is false) then
    return false;
  end if;

  -- 1) Casilla de la persona.
  select cp.permitido into v_permitido
  from public.caja_permisos cp
  where cp.club_id = p_club_id and cp.permiso = p_permiso and cp.profile_id = auth.uid();
  if found then
    return v_permitido;
  end if;

  -- 2) Casilla del rol.
  select cp.permitido into v_permitido
  from public.caja_permisos cp
  where cp.club_id = p_club_id and cp.permiso = p_permiso and cp.rol = v_rol;
  if found then
    return v_permitido;
  end if;

  -- 3) Valores por defecto.
  if v_rol = 'gerente' then
    return true;
  end if;
  return p_permiso in ('puerta', 'abrir_mesa', 'registrar_consumo', 'cobrar', 'cerrar_mesa');
end;
$function$
;

CREATE OR REPLACE FUNCTION public.caja_configurar_permiso(p_club_id uuid, p_permiso text, p_rol text, p_profile_id uuid, p_permitido boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not coalesce(public.current_role_name() = 'admin' or public.club_es_dueno(p_club_id), false) then
    raise exception 'Solo el dueño o el admin configuran permisos de caja';
  end if;
  if (p_rol is null) = (p_profile_id is null) then
    raise exception 'Indica un rol o una persona, no los dos';
  end if;
  if p_profile_id is not null and not exists (
       select 1 from public.profiles
       where id = p_profile_id and club_id = p_club_id and role in ('staff', 'gerente')) then
    raise exception 'La persona no es staff ni gerente de este antro';
  end if;

  if p_rol is not null then
    insert into public.caja_permisos (club_id, permiso, rol, permitido, actualizado_por)
    values (p_club_id, p_permiso, p_rol, p_permitido, auth.uid())
    on conflict (club_id, permiso, rol) where rol is not null
    do update set permitido = excluded.permitido, actualizado_por = auth.uid(), actualizado_en = now();
  else
    insert into public.caja_permisos (club_id, permiso, profile_id, permitido, actualizado_por)
    values (p_club_id, p_permiso, p_profile_id, p_permitido, auth.uid())
    on conflict (club_id, permiso, profile_id) where profile_id is not null
    do update set permitido = excluded.permitido, actualizado_por = auth.uid(), actualizado_en = now();
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.grupo_rendimiento_rp(p_club_id uuid, p_desde date, p_hasta date)
 RETURNS TABLE(rp_id uuid, rp_nombre text, rp_activo boolean, reservas integer, por_venir integer, entraron integer, consumieron integer, consumo_centavos bigint, ticket_centavos bigint, comisiones_centavos bigint, noches_cerradas_reservas integer, noches_cerradas_consumieron integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_rol text := public.current_role_name();
  v_hoy date;
begin
  if auth.uid() is null then
    raise exception 'Inicia sesión';
  end if;
  if not coalesce(v_rol = 'admin'
          or public.club_es_dueno(p_club_id)
          or public.club_es_dueno_grupo(p_club_id)
          or (v_rol = 'gerente' and p_club_id = public.current_club_id()
              and exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo)), false) then
    raise exception 'No tienes acceso a este antro';
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 93 then
    raise exception 'Rango de fechas inválido (máximo 93 días)';
  end if;
  v_hoy := public.club_fecha_operacion(p_club_id);

  return query
  with res as (
    select r.rp_id, count(*)::int as n,
           count(*) filter (where r.fecha > v_hoy)::int as por_venir,
           count(*) filter (where coalesce(r.puerta_estado, case when r.status = 'usada' then 'entro' end)
                                  is not distinct from 'entro')::int as entraron,
           count(*) filter (where exists (
             select 1 from public.mesa_cuentas mc join public.caja_consumos k on k.cuenta_id = mc.id
             where mc.reservation_id = r.id and not k.anulado))::int as consumieron,
           count(*) filter (where (r.fecha < v_hoy or exists (select 1 from public.caja_noches nc where nc.club_id = r.club_id and nc.fecha_operacion = r.fecha and nc.estado = 'cerrada')))::int as cerradas,
           count(*) filter (where (r.fecha < v_hoy or exists (select 1 from public.caja_noches nc where nc.club_id = r.club_id and nc.fecha_operacion = r.fecha and nc.estado = 'cerrada')) and exists (
             select 1 from public.mesa_cuentas mc join public.caja_consumos k on k.cuenta_id = mc.id
             where mc.reservation_id = r.id and not k.anulado))::int as consumieron_cerradas
    from public.reservations r
    where r.club_id = p_club_id and r.source = 'rp' and r.rp_id is not null
      and r.fecha between p_desde and p_hasta
    group by r.rp_id
  ),
  con as (
    -- Consumo de las cuentas que vienen de reservas del RP en el rango.
    select r.rp_id, sum(k.monto_centavos)::bigint as cent
    from public.reservations r
    join public.mesa_cuentas mc on mc.reservation_id = r.id
    join public.caja_consumos k on k.cuenta_id = mc.id and not k.anulado
    where r.club_id = p_club_id and r.source = 'rp' and r.rp_id is not null
      and r.fecha between p_desde and p_hasta
    group by r.rp_id
  ),
  com as (
    select x.rp_id, sum(x.cent)::bigint as cent from (
      select c.rp_id, round(c.monto * 100)::bigint as cent
      from public.commissions c join public.reservations r on r.id = c.reservation_id
      where c.tipo = 'rp' and c.status <> 'anulada' and r.club_id = p_club_id
        and r.fecha between p_desde and p_hasta
      union all
      select d.rp_id, round(d.monto * 100)::bigint
      from public.rp_pagos_dia d
      where d.status <> 'anulada' and d.club_id = p_club_id and d.fecha between p_desde and p_hasta
    ) x group by x.rp_id
  ),
  rps as (
    select p.id from public.profiles p where p.role = 'rp' and p.club_id = p_club_id
    union select res.rp_id from res
    union select com.rp_id from com
  )
  select rps.id, p.nombre, coalesce(p.activo, true),
         coalesce(res.n, 0), coalesce(res.por_venir, 0), coalesce(res.entraron, 0), coalesce(res.consumieron, 0),
         coalesce(con.cent, 0),
         case when coalesce(res.consumieron, 0) > 0 then round(coalesce(con.cent, 0)::numeric / res.consumieron)::bigint else 0 end,
         coalesce(com.cent, 0),
         coalesce(res.cerradas, 0), coalesce(res.consumieron_cerradas, 0)
  from rps
  left join public.profiles p on p.id = rps.id
  left join res on res.rp_id = rps.id
  left join con on con.rp_id = rps.id
  left join com on com.rp_id = rps.id
  where rps.id is not null
  order by coalesce(con.cent, 0) desc, p.nombre;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.es_gerente_o_dueno(p_club_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_rol text := public.current_role_name();
begin
  if auth.uid() is null then
    return false;
  end if;
  if v_rol = 'admin' or public.club_es_dueno(p_club_id) then
    return true;
  end if;
  return coalesce(v_rol = 'gerente'
     and public.current_club_id() = p_club_id
     and not exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo is false), false);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.caja_puede_ver(p_club_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_rol text := public.current_role_name();
begin
  if v_rol = 'admin' then
    return true;
  end if;
  if public.club_es_dueno(p_club_id) or public.club_es_dueno_grupo(p_club_id) then
    return true;
  end if;
  return coalesce(v_rol in ('staff', 'gerente') and public.current_club_id() = p_club_id
    and not exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo is false), false);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.puede_ver_club(p_club_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_rol text := public.current_role_name();
begin
  if exists (select 1 from public.clubs c
             where c.id = p_club_id and c.estado_verificacion = 'verificado' and c.suscripcion_activa) then
    return true;
  end if;
  if v_rol = 'admin' then
    return true;
  end if;
  if public.club_es_dueno(p_club_id) or public.club_es_dueno_grupo(p_club_id) then
    return true;
  end if;
  return coalesce(v_rol in ('staff', 'gerente', 'rp') and public.current_club_id() = p_club_id, false);
end;
$function$
;



