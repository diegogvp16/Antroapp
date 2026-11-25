-- ============================================================================
-- AntroApp — Rollback de sql/post-junta-2/65-concurrencia-puerta-cobro.sql
-- Regresa puerta_escanear, puerta_confirmar_entrada y caja_registrar_pago a la
-- versión de antes del 65:
--   - las dos de puerta y la de pago CON propina (fase 2): copiadas del
--     catálogo de dev el 25/11/2026 con pg_get_functiondef;
--   - la de pago SIN propina (sin fase 2, como producción): la de
--     sql/2026-11-21-caja-idempotencia.sql, tal cual.
-- Sin cambios de firma: los GRANT se conservan (se dejan explícitos).
-- ============================================================================
begin;

CREATE OR REPLACE FUNCTION public.puerta_escanear(p_qr text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
  v_res public.reservations%rowtype;
begin
  select id into v_id from public.reservations where qr_code = trim(p_qr);
  if v_id is null then
    raise exception 'Reserva no encontrada en tu antro';
  end if;
  v_res := public.puerta_reserva_para_escribir(v_id);

  if coalesce(v_res.puerta_estado, case when v_res.status = 'usada' then 'entro' end)
     is not distinct from 'entro' then
    raise exception 'Esta reserva ya entró';
  end if;

  if v_res.puerta_estado is null then
    update public.reservations
    set puerta_estado = 'en_puerta', en_puerta_en = now(), en_puerta_por = auth.uid()
    where id = v_res.id
    returning * into v_res;
    perform public.caja_evento(v_res.club_id, null, null, 'puerta_escanear',
      jsonb_build_object('reservation_id', v_res.id));
  end if;

  return jsonb_build_object(
    'reservation_id', v_res.id,
    'cliente_nombre', v_res.cliente_nombre,
    'personas', v_res.personas,
    'source', v_res.source,
    'rp_nombre', (select p.nombre from public.profiles p where p.id = v_res.rp_id),
    'puerta_estado', v_res.puerta_estado);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.puerta_confirmar_entrada(p_reservation_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_res public.reservations%rowtype;
begin
  v_res := public.puerta_reserva_para_escribir(p_reservation_id);
  if v_res.puerta_estado is distinct from 'en_puerta' then
    raise exception 'Primero escanea el QR';
  end if;

  update public.reservations
  set puerta_estado = 'entro',
      status = 'usada',
      entrada_en = now(),
      entrada_por = auth.uid(),
      llegada_tarde = public.puerta_es_tarde(v_res.club_id, v_res.fecha, now())
  where id = v_res.id;

  perform public.caja_evento(v_res.club_id, null, null, 'puerta_confirmar_entrada',
    jsonb_build_object('reservation_id', v_res.id));
end;
$function$
;

do $bloque$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'caja_pagos' and column_name = 'propina_centavos') then
    execute $f8$
CREATE OR REPLACE FUNCTION public.caja_registrar_pago(p_sesion_id uuid, p_cuenta_id uuid, p_metodo text, p_monto_centavos bigint, p_referencia text DEFAULT NULL::text, p_clave uuid DEFAULT NULL::uuid, p_saldo_esperado bigint DEFAULT NULL::bigint, p_propina_centavos bigint DEFAULT 0)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_sesion public.mesa_sesiones%rowtype;
  v_previo public.caja_pagos%rowtype;
  v_t record;
  v_saldo bigint;
  v_id uuid;
begin
  if p_clave is not null then
    select * into v_previo from public.caja_pagos
    where registrado_por = auth.uid() and clave_cliente = p_clave;
    if found then
      if v_previo.sesion_id is distinct from p_sesion_id or v_previo.monto_centavos is distinct from p_monto_centavos
         or v_previo.metodo is distinct from p_metodo or v_previo.propina_centavos is distinct from coalesce(p_propina_centavos, 0) then
        raise exception 'Ese cobro ya se había guardado con otros datos. Revisa los cobros de la mesa.';
      end if;
      return v_previo.id;
    end if;
  end if;

  v_sesion := public.caja_sesion_para_escribir(p_sesion_id, 'abierta');
  if not public.caja_tiene_permiso(v_sesion.club_id, 'cobrar') then
    raise exception 'No tienes permiso para cobrar';
  end if;
  if p_metodo is null or p_metodo not in ('efectivo', 'tarjeta', 'otro') then
    raise exception 'Método de pago inválido';
  end if;
  if p_monto_centavos is null or p_monto_centavos < 1 or p_monto_centavos > 100000000 then
    raise exception 'Monto inválido';
  end if;
  if coalesce(p_propina_centavos, 0) < 0 or coalesce(p_propina_centavos, 0) > 100000000 then
    raise exception 'Propina inválida';
  end if;
  if p_cuenta_id is not null
     and not exists (select 1 from public.mesa_cuentas where id = p_cuenta_id and sesion_id = p_sesion_id) then
    raise exception 'La cuenta no es de esta mesa';
  end if;

  if p_saldo_esperado is not null then
    select * into v_t from public.caja_totales_sesion(p_sesion_id);
    v_saldo := v_t.registrado - (v_t.efectivo + v_t.tarjeta + v_t.otro);
    if v_saldo <> p_saldo_esperado then
      raise exception 'El saldo de la mesa cambió mientras cobrabas (ahora es $%). Revisa y vuelve a cobrar.',
        to_char(v_saldo / 100.0, 'FM999,999,990.00');
    end if;
  end if;

  begin
    insert into public.caja_pagos (club_id, noche_id, sesion_id, cuenta_id, metodo, monto_centavos, referencia,
                                   registrado_por, clave_cliente, propina_centavos)
    values (v_sesion.club_id, v_sesion.noche_id, v_sesion.id, p_cuenta_id, p_metodo, p_monto_centavos,
            nullif(trim(p_referencia), ''), auth.uid(), p_clave, coalesce(p_propina_centavos, 0))
    returning id into v_id;
  exception when unique_violation then
    select * into v_previo from public.caja_pagos
    where registrado_por = auth.uid() and clave_cliente = p_clave;
    return v_previo.id;
  end;
  return v_id;
end;
$function$
$f8$;
  else
    execute $f7$
create or replace function public.caja_registrar_pago(
  p_sesion_id uuid, p_cuenta_id uuid, p_metodo text, p_monto_centavos bigint, p_referencia text default null,
  p_clave uuid default null, p_saldo_esperado bigint default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sesion public.mesa_sesiones%rowtype;
  v_previo public.caja_pagos%rowtype;
  v_t record;
  v_saldo bigint;
  v_id uuid;
begin
  if p_clave is not null then
    select * into v_previo from public.caja_pagos
    where registrado_por = auth.uid() and clave_cliente = p_clave;
    if found then
      if v_previo.sesion_id is distinct from p_sesion_id or v_previo.monto_centavos is distinct from p_monto_centavos
         or v_previo.metodo is distinct from p_metodo then
        raise exception 'Ese cobro ya se había guardado con otros datos. Revisa los cobros de la mesa.';
      end if;
      return v_previo.id;
    end if;
  end if;

  v_sesion := public.caja_sesion_para_escribir(p_sesion_id, 'abierta');
  if not public.caja_tiene_permiso(v_sesion.club_id, 'cobrar') then
    raise exception 'No tienes permiso para cobrar';
  end if;
  if p_metodo is null or p_metodo not in ('efectivo', 'tarjeta', 'otro') then
    raise exception 'Método de pago inválido';
  end if;
  if p_monto_centavos is null or p_monto_centavos < 1 or p_monto_centavos > 100000000 then
    raise exception 'Monto inválido';
  end if;
  if p_cuenta_id is not null
     and not exists (select 1 from public.mesa_cuentas where id = p_cuenta_id and sesion_id = p_sesion_id) then
    raise exception 'La cuenta no es de esta mesa';
  end if;

  -- La mesa ya está bloqueada (caja_sesion_para_escribir hace for update):
  -- nadie más registra en ella hasta que esto termine.
  if p_saldo_esperado is not null then
    select * into v_t from public.caja_totales_sesion(p_sesion_id);
    v_saldo := v_t.registrado - (v_t.efectivo + v_t.tarjeta + v_t.otro);
    if v_saldo <> p_saldo_esperado then
      raise exception 'El saldo de la mesa cambió mientras cobrabas (ahora es $%). Revisa y vuelve a cobrar.',
        to_char(v_saldo / 100.0, 'FM999,999,990.00');
    end if;
  end if;

  begin
    insert into public.caja_pagos (club_id, noche_id, sesion_id, cuenta_id, metodo, monto_centavos, referencia,
                                   registrado_por, clave_cliente)
    values (v_sesion.club_id, v_sesion.noche_id, v_sesion.id, p_cuenta_id, p_metodo, p_monto_centavos,
            nullif(trim(p_referencia), ''), auth.uid(), p_clave)
    returning id into v_id;
  exception when unique_violation then
    select * into v_previo from public.caja_pagos
    where registrado_por = auth.uid() and clave_cliente = p_clave;
    if v_previo.sesion_id is distinct from p_sesion_id or v_previo.monto_centavos is distinct from p_monto_centavos
       or v_previo.metodo is distinct from p_metodo then
      raise exception 'Ese cobro ya se había guardado con otros datos. Revisa los cobros de la mesa.';
    end if;
    return v_previo.id;
  end;
  return v_id;
end;
$$
$f7$;
  end if;
end
$bloque$;

revoke all on function public.puerta_escanear(text) from public, anon;
grant execute on function public.puerta_escanear(text) to authenticated;
revoke all on function public.puerta_confirmar_entrada(uuid) from public, anon;
grant execute on function public.puerta_confirmar_entrada(uuid) to authenticated;

commit;
