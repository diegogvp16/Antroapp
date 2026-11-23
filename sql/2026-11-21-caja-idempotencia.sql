-- ============================================================================
-- AntroApp — Caja: reintentos sin duplicar y cobros sin pisarse
-- Fecha: 2026-11-21 (noche 2, rama noche2)
-- Estado: APLICADO Y PROBADO SOLO EN DEV (antroapp-dev). En producción NO.
-- Va DESPUÉS de sql/2026-11-20-caja-por-mesa.sql (y de lo demás del pase).
-- Rollback: sql/2026-11-21-caja-idempotencia-rollback.sql.
--
-- Problema que resuelve (mala señal en el antro, varios staff a la vez):
--   1. Reintento: el staff toca "Agregar consumo" o "Cobrar", la base guarda
--      el movimiento, pero la respuesta se pierde por la señal. La app ve un
--      error, el staff vuelve a tocar y el movimiento queda DOBLE.
--   2. Dos staff cobran la misma mesa al mismo tiempo: los dos ven el saldo
--      de $1,000 y los dos cobran $1,000. La mesa queda sobrepagada y ya no
--      se puede cerrar hasta anular uno.
--
-- Solución:
--   1. Llave de idempotencia: la app manda una clave (uuid) por movimiento y
--      la repite en cada reintento. Si esa clave ya existe para quien llama,
--      la función devuelve el movimiento que ya estaba (no inserta otro). Si
--      la clave llega con otros datos (otra cuenta, otro monto), lo rechaza.
--   2. Saldo esperado al cobrar: la app manda el saldo que el staff tiene en
--      pantalla. Con la mesa bloqueada (for update), si el saldo real ya es
--      otro, el cobro se rechaza con un mensaje claro y la app se actualiza.
--
--   3. Firma de la noche (sección 5): la caja revisa cada 10 s si algo
--      cambió con una consulta mínima, y solo entonces vuelve a leer todo.
--
-- Compatibilidad: los parámetros nuevos tienen default null. Quien llame
-- como antes (código de desarrollo, pruebas existentes) sigue funcionando
-- igual, sin la protección nueva.
--
-- Nada se borra: las columnas nuevas no cambian después del INSERT (el
-- trigger caja_sin_borrar ya impide modificar cualquier campo que no sea de
-- anulación).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Columnas e índices únicos. La unicidad es por quien registra: la clave
--    de otro usuario no estorba ni se puede "apartar".
-- ----------------------------------------------------------------------------
alter table public.caja_consumos add column clave_cliente uuid;
alter table public.caja_pagos    add column clave_cliente uuid;

create unique index caja_consumos_clave_cliente
  on public.caja_consumos (registrado_por, clave_cliente) where clave_cliente is not null;
create unique index caja_pagos_clave_cliente
  on public.caja_pagos (registrado_por, clave_cliente) where clave_cliente is not null;


-- ----------------------------------------------------------------------------
-- 2. caja_registrar_consumo con p_clave.
--    Cambia la firma: se borra la anterior (los GRANT se dan de nuevo abajo).
-- ----------------------------------------------------------------------------
drop function public.caja_registrar_consumo(uuid, bigint, text);

create function public.caja_registrar_consumo(
  p_cuenta_id uuid, p_monto_centavos bigint, p_concepto text default null, p_clave uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cuenta public.mesa_cuentas%rowtype;
  v_sesion public.mesa_sesiones%rowtype;
  v_previo public.caja_consumos%rowtype;
  v_id uuid;
begin
  -- Reintento: si esta clave ya se guardó para quien llama, se devuelve lo
  -- que ya estaba, aunque la mesa haya cambiado de estado después.
  if p_clave is not null then
    select * into v_previo from public.caja_consumos
    where registrado_por = auth.uid() and clave_cliente = p_clave;
    if found then
      if v_previo.cuenta_id is distinct from p_cuenta_id or v_previo.monto_centavos is distinct from p_monto_centavos then
        raise exception 'Ese consumo ya se había guardado con otros datos. Revisa el consumo de la mesa.';
      end if;
      return v_previo.id;
    end if;
  end if;

  select * into v_cuenta from public.mesa_cuentas where id = p_cuenta_id;
  if not found then
    raise exception 'Cuenta no encontrada';
  end if;
  v_sesion := public.caja_sesion_para_escribir(v_cuenta.sesion_id, 'abierta');
  if not public.caja_tiene_permiso(v_sesion.club_id, 'registrar_consumo') then
    raise exception 'No tienes permiso para registrar consumos';
  end if;
  if p_monto_centavos is null or p_monto_centavos < 1 or p_monto_centavos > 100000000 then
    raise exception 'Monto inválido';
  end if;

  begin
    insert into public.caja_consumos (club_id, noche_id, sesion_id, mesa_id, cuenta_id, reservation_id, rp_id,
                                      monto_centavos, concepto, registrado_por, clave_cliente)
    values (v_sesion.club_id, v_sesion.noche_id, v_sesion.id, v_sesion.mesa_id, v_cuenta.id,
            v_cuenta.reservation_id, v_cuenta.rp_id, p_monto_centavos, nullif(trim(p_concepto), ''), auth.uid(), p_clave)
    returning id into v_id;
  exception when unique_violation then
    -- Dos envíos idénticos al mismo tiempo: el segundo esperó el candado de
    -- la mesa y encuentra el primero.
    select * into v_previo from public.caja_consumos
    where registrado_por = auth.uid() and clave_cliente = p_clave;
    if v_previo.cuenta_id is distinct from p_cuenta_id or v_previo.monto_centavos is distinct from p_monto_centavos then
      raise exception 'Ese consumo ya se había guardado con otros datos. Revisa el consumo de la mesa.';
    end if;
    return v_previo.id;
  end;
  return v_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- 3. caja_registrar_pago con p_clave y p_saldo_esperado.
-- ----------------------------------------------------------------------------
drop function public.caja_registrar_pago(uuid, uuid, text, bigint, text);

create function public.caja_registrar_pago(
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
$$;


-- ----------------------------------------------------------------------------
-- 4. Quién puede llamar (igual que antes: solo con sesión).
-- ----------------------------------------------------------------------------
revoke all on function public.caja_registrar_consumo(uuid, bigint, text, uuid) from public, anon;
grant execute on function public.caja_registrar_consumo(uuid, bigint, text, uuid) to authenticated;
revoke all on function public.caja_registrar_pago(uuid, uuid, text, bigint, text, uuid, bigint) from public, anon;
grant execute on function public.caja_registrar_pago(uuid, uuid, text, bigint, text, uuid, bigint) to authenticated;


-- ----------------------------------------------------------------------------
-- 5. Firma de la noche: un texto corto que cambia cuando cambia algo de la
--    caja (consumos, cobros, anulaciones, mesas, cuentas, cuadres, entradas
--    por la puerta). La pantalla de caja la pide cada 10 s y solo vuelve a
--    leer todo si cambió: con mala señal son ~0.5 KB en lugar de ~75 KB.
--    SECURITY INVOKER: corre con los permisos de quien llama (RLS), así que
--    solo resume lo que esa persona ya puede ver. No devuelve datos.
-- ----------------------------------------------------------------------------
create function public.caja_firma_noche(p_club_id uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  with f as (
    select public.club_fecha_operacion(p_club_id) as fecha
  ), n as (
    select id, estado from public.caja_noches
    where club_id = p_club_id and fecha_operacion = (select fecha from f)
  )
  select md5(concat_ws('|',
    (select fecha::text from f),
    (select id::text || estado from n),
    (select count(*) || ':' || count(*) filter (where anulado) || ':' || coalesce(max(registrado_en)::text, '') || ':' || coalesce(max(anulado_en)::text, '')
       from public.caja_consumos where noche_id = (select id from n)),
    (select count(*) || ':' || count(*) filter (where anulado) || ':' || coalesce(max(registrado_en)::text, '') || ':' || coalesce(max(anulado_en)::text, '')
       from public.caja_pagos where noche_id = (select id from n)),
    (select coalesce(string_agg(id::text || estado, ',' order by id), '')
       from public.mesa_sesiones where noche_id = (select id from n)),
    (select count(*) || ':' || coalesce(max(c.creada_en)::text, '')
       from public.mesa_cuentas c join public.mesa_sesiones s on s.id = c.sesion_id where s.noche_id = (select id from n)),
    (select count(*)::text from public.caja_cuadres where noche_id = (select id from n)),
    (select count(*) || ':' || coalesce(max(entrada_en)::text, '')
       from public.reservations
       where club_id = p_club_id and fecha = (select fecha from f) and (status = 'usada' or puerta_estado = 'entro')),
    (select count(*)::text from public.club_tables where club_id = p_club_id)
  ));
$$;
revoke all on function public.caja_firma_noche(uuid) from public, anon;
grant execute on function public.caja_firma_noche(uuid) to authenticated;
