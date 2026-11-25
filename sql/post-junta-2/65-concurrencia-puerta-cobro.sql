-- ============================================================================
-- AntroApp — C5 (noche 3): puerta y cobro idempotentes también en paralelo
-- Fecha: 2026-11-25. Rollback: sql/post-junta-2/65-concurrencia-puerta-cobro-rollback.sql
-- Prueba (dev): node scripts/dev/probar-concurrencia-noche3.mjs
--
-- Encontrado con scripts/dev/probar-concurrencia-noche3.mjs (sesiones reales,
-- peticiones a la vez):
--
-- 1) puerta_confirmar_entrada: dos staff confirman la misma reserva a la vez.
--    La entrada se registraba una sola vez (el "for update" de
--    puerta_reserva_para_escribir ya serializa), pero el segundo recibía
--    "Primero escanea el QR", que es falso y confunde en la puerta. Ahora
--    recibe "Esta reserva ya entró a las HH:MM." (hora del antro). Lo mismo
--    en puerta_escanear, que ya decía "Esta reserva ya entró" y ahora
--    agrega la hora.
--
-- 2) caja_registrar_pago: la clave de idempotencia se buscaba ANTES de
--    bloquear la mesa. Con el mismo cobro enviado varias veces a la vez (mala
--    señal + reintento), todos pasaban esa búsqueda sin ver nada, esperaban
--    el candado de la mesa y, al entrar, el primero cobraba y los demás
--    tronaban con "El saldo de la mesa cambió" (el saldo ya incluía su propio
--    cobro). No se cobraba doble, pero el staff veía un error por un cobro
--    que sí entró y podía volver a cobrarlo con otra clave. Ahora la clave se
--    busca otra vez ya con la mesa bloqueada: el reintento devuelve el mismo
--    cobro, sin error. La búsqueda previa (sin candado) se queda para que el
--    reintento tardío con la mesa ya cerrada siga funcionando.
--
-- Sin cambios de firma ni de permisos: create or replace conserva los GRANT
-- y al final se dejan explícitos (solo authenticated, ni public ni anon).
-- caja_registrar_pago va en un bloque "do" porque tiene dos versiones
-- (con o sin la fase 2); se corrige la que exista.
-- Orden en producción: después del SQL del pase 1/2 (noche2:
-- 2026-11-21-caja-idempotencia.sql) y, si se pasa, después de la fase 2 (P11).
-- ============================================================================
begin;

create or replace function public.puerta_escanear(p_qr text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_id uuid;
  v_res public.reservations%rowtype;
  v_zona text;
begin
  select id into v_id from public.reservations where qr_code = trim(p_qr);
  if v_id is null then
    raise exception 'Reserva no encontrada en tu antro';
  end if;
  v_res := public.puerta_reserva_para_escribir(v_id);

  if coalesce(v_res.puerta_estado, case when v_res.status = 'usada' then 'entro' end)
     is not distinct from 'entro' then
    select c.zona_horaria into v_zona from public.clubs c where c.id = v_res.club_id;
    raise exception 'Esta reserva ya entró%.',
      coalesce(' a las ' || to_char(v_res.entrada_en at time zone coalesce(v_zona, 'America/Mexico_City'), 'HH24:MI'), '');
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
$function$;

create or replace function public.puerta_confirmar_entrada(p_reservation_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_res public.reservations%rowtype;
  v_zona text;
begin
  -- Bloquea la reserva ("for update"): dos confirmaciones a la vez se
  -- forman, y la segunda ya ve la entrada de la primera.
  v_res := public.puerta_reserva_para_escribir(p_reservation_id);
  if coalesce(v_res.puerta_estado, case when v_res.status = 'usada' then 'entro' end)
     is not distinct from 'entro' then
    select c.zona_horaria into v_zona from public.clubs c where c.id = v_res.club_id;
    raise exception 'Esta reserva ya entró%.',
      coalesce(' a las ' || to_char(v_res.entrada_en at time zone coalesce(v_zona, 'America/Mexico_City'), 'HH24:MI'), '');
  end if;
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
$function$;


-- caja_registrar_pago existe en dos versiones según si se pasó la fase 2
-- (sql/fase2/2026-11-21-inventario-propinas.sql, que agrega p_propina_centavos
-- y la columna caja_pagos.propina_centavos). Se corrige la que haya.
-- OJO: si la fase 2 se pasa DESPUÉS de este archivo, su create function
-- vuelve a poner la versión sin el arreglo: hay que correr este 65 otra vez.
do $bloque$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'caja_pagos' and column_name = 'propina_centavos') then
    execute $f8$
create or replace function public.caja_registrar_pago(p_sesion_id uuid, p_cuenta_id uuid, p_metodo text, p_monto_centavos bigint, p_referencia text default null::text, p_clave uuid default null::uuid, p_saldo_esperado bigint default null::bigint, p_propina_centavos bigint default 0)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_sesion public.mesa_sesiones%rowtype;
  v_previo public.caja_pagos%rowtype;
  v_t record;
  v_saldo bigint;
  v_id uuid;
  v_vuelta int;
begin
  -- La clave se busca dos veces: antes del candado (reintento tardío con la
  -- mesa ya cerrada) y otra vez con la mesa bloqueada (el mismo cobro
  -- enviado varias veces a la vez: el primero entra y los demás, al pasar el
  -- candado, ya lo ven y devuelven el mismo, en vez de "el saldo cambió").
  for v_vuelta in 1..2 loop
    if v_vuelta = 2 then
      v_sesion := public.caja_sesion_para_escribir(p_sesion_id, 'abierta');
    end if;
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
  end loop;

  if not coalesce(public.caja_tiene_permiso(v_sesion.club_id, 'cobrar'), false) then
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
    -- La misma clave ya usada (en otra mesa o con otros datos): no se cobra.
    select * into v_previo from public.caja_pagos
    where registrado_por = auth.uid() and clave_cliente = p_clave;
    if v_previo.sesion_id is distinct from p_sesion_id or v_previo.monto_centavos is distinct from p_monto_centavos
       or v_previo.metodo is distinct from p_metodo or v_previo.propina_centavos is distinct from coalesce(p_propina_centavos, 0) then
      raise exception 'Ese cobro ya se había guardado con otros datos. Revisa los cobros de la mesa.';
    end if;
    return v_previo.id;
  end;
  return v_id;
end;
$function$
$f8$;
    execute 'revoke all on function public.caja_registrar_pago(uuid, uuid, text, bigint, text, uuid, bigint, bigint) from public, anon';
    execute 'grant execute on function public.caja_registrar_pago(uuid, uuid, text, bigint, text, uuid, bigint, bigint) to authenticated';
  else
    execute $f7$
create or replace function public.caja_registrar_pago(
  p_sesion_id uuid, p_cuenta_id uuid, p_metodo text, p_monto_centavos bigint, p_referencia text default null,
  p_clave uuid default null, p_saldo_esperado bigint default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_sesion public.mesa_sesiones%rowtype;
  v_previo public.caja_pagos%rowtype;
  v_t record;
  v_saldo bigint;
  v_id uuid;
  v_vuelta int;
begin
  -- La clave se busca dos veces: antes del candado (reintento tardío con la
  -- mesa ya cerrada) y otra vez con la mesa bloqueada (el mismo cobro
  -- enviado varias veces a la vez: el primero entra y los demás, al pasar el
  -- candado, ya lo ven y devuelven el mismo, en vez de "el saldo cambió").
  for v_vuelta in 1..2 loop
    if v_vuelta = 2 then
      v_sesion := public.caja_sesion_para_escribir(p_sesion_id, 'abierta');
    end if;
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
  end loop;

  if not coalesce(public.caja_tiene_permiso(v_sesion.club_id, 'cobrar'), false) then
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
$function$
$f7$;
    execute 'revoke all on function public.caja_registrar_pago(uuid, uuid, text, bigint, text, uuid, bigint) from public, anon';
    execute 'grant execute on function public.caja_registrar_pago(uuid, uuid, text, bigint, text, uuid, bigint) to authenticated';
  end if;
end
$bloque$;

revoke all on function public.puerta_escanear(text) from public, anon;
grant execute on function public.puerta_escanear(text) to authenticated;
revoke all on function public.puerta_confirmar_entrada(uuid) from public, anon;
grant execute on function public.puerta_confirmar_entrada(uuid) to authenticated;

commit;
