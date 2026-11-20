-- ============================================================================
-- Rollback de sql/fase2/2026-11-21-inventario-propinas.sql (SOLO DEV).
-- Deja el esquema como estaba antes de fase 2: caja_registrar_pago vuelve a
-- la versión de sql/2026-11-21-caja-idempotencia.sql (sin propina), y se
-- quitan catálogo, movimientos, columnas nuevas, funciones y trigger.
-- OJO: borra los datos de catálogo y propinas de dev (son de prueba).
-- ============================================================================

drop trigger caja_consumos_regresa_existencias on public.caja_consumos;
drop function public.caja_consumo_anulado_regresa_existencias();
drop function public.caja_registrar_consumo_producto(uuid, uuid, int, uuid);
drop function public.producto_ajustar_existencias(uuid, int, text);
drop function public.producto_guardar(uuid, uuid, text, text, bigint, int, boolean, int);
drop function public.caja_registrar_pago(uuid, uuid, text, bigint, text, uuid, bigint, bigint);

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

revoke all on function public.caja_registrar_pago(uuid, uuid, text, bigint, text, uuid, bigint) from public, anon;
grant execute on function public.caja_registrar_pago(uuid, uuid, text, bigint, text, uuid, bigint) to authenticated;

alter table public.caja_pagos drop column propina_centavos;
alter table public.caja_consumos drop column cantidad;
alter table public.caja_consumos drop column producto_id;
drop table public.producto_movimientos;
drop table public.productos;
