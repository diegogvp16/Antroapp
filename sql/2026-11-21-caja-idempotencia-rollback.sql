-- ============================================================================
-- Rollback de sql/2026-11-21-caja-idempotencia.sql
-- Deja caja_registrar_consumo y caja_registrar_pago exactamente como en
-- sql/2026-11-20-caja-por-mesa.sql y quita las columnas clave_cliente.
-- Va ANTES del rollback de caja-por-mesa (orden inverso del pase).
-- ============================================================================

drop function public.caja_registrar_consumo(uuid, bigint, text, uuid);
drop function public.caja_registrar_pago(uuid, uuid, text, bigint, text, uuid, bigint);

create function public.caja_registrar_consumo(
  p_cuenta_id uuid, p_monto_centavos bigint, p_concepto text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cuenta public.mesa_cuentas%rowtype;
  v_sesion public.mesa_sesiones%rowtype;
  v_id uuid;
begin
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

  insert into public.caja_consumos (club_id, noche_id, sesion_id, mesa_id, cuenta_id, reservation_id, rp_id,
                                    monto_centavos, concepto, registrado_por)
  values (v_sesion.club_id, v_sesion.noche_id, v_sesion.id, v_sesion.mesa_id, v_cuenta.id,
          v_cuenta.reservation_id, v_cuenta.rp_id, p_monto_centavos, nullif(trim(p_concepto), ''), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create function public.caja_registrar_pago(
  p_sesion_id uuid, p_cuenta_id uuid, p_metodo text, p_monto_centavos bigint, p_referencia text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sesion public.mesa_sesiones%rowtype;
  v_id uuid;
begin
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

  insert into public.caja_pagos (club_id, noche_id, sesion_id, cuenta_id, metodo, monto_centavos, referencia, registrado_por)
  values (v_sesion.club_id, v_sesion.noche_id, v_sesion.id, p_cuenta_id, p_metodo, p_monto_centavos,
          nullif(trim(p_referencia), ''), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.caja_registrar_consumo(uuid, bigint, text) from public, anon;
grant execute on function public.caja_registrar_consumo(uuid, bigint, text) to authenticated;
revoke all on function public.caja_registrar_pago(uuid, uuid, text, bigint, text) from public, anon;
grant execute on function public.caja_registrar_pago(uuid, uuid, text, bigint, text) to authenticated;

drop index public.caja_consumos_clave_cliente;
drop index public.caja_pagos_clave_cliente;
alter table public.caja_consumos drop column clave_cliente;
alter table public.caja_pagos    drop column clave_cliente;
