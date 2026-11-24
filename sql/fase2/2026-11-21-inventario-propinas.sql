-- ============================================================================
-- AntroApp — FASE 2 (rama fase2): inventario y propinas
-- Fecha: 2026-11-21
-- Estado: APLICADO Y PROBADO SOLO EN DEV (antroapp-dev). NUNCA en producción
-- sin autorización de Diego. Rollback: sql/fase2/2026-11-21-inventario-propinas-rollback.sql.
-- Requiere: sql/2026-11-20-caja-por-mesa.sql y sql/2026-11-21-caja-idempotencia.sql.
--
-- La app lo usa SOLO con la bandera NEXT_PUBLIC_FASE2=1. Con la bandera
-- apagada nada de esto se llama, y el código anterior sigue igual: las
-- columnas nuevas tienen default y caja_registrar_pago conserva sus
-- parámetros (el nuevo, p_propina_centavos, tiene default 0).
--
-- 1. Catálogo de productos por antro (nombre, categoría, precio, existencias,
--    mínimo para alerta). Lo carga y edita el gerente o el dueño, solo por
--    funciones. Nada se borra: un producto se desactiva.
-- 2. Cada consumo de catálogo descuenta existencias (caja_registrar_consumo_producto),
--    con la misma clave de idempotencia que la caja: un reintento no descuenta
--    dos veces. Anular el consumo las regresa (trigger). Todo queda en la
--    bitácora producto_movimientos.
-- 3. Propina por cobro (caja_pagos.propina_centavos): aparte del monto, así
--    que no cambia el saldo de la mesa, ni lo cobrado del cuadre, ni la
--    comisión del RP (que sale de los consumos).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Tablas.
-- ----------------------------------------------------------------------------
create table public.productos (
  id                 uuid primary key default gen_random_uuid(),
  club_id            uuid not null references public.clubs (id),
  nombre             text not null check (char_length(trim(nombre)) between 1 and 80),
  categoria          text not null check (char_length(trim(categoria)) between 1 and 40),
  precio_centavos    bigint not null check (precio_centavos between 1 and 100000000),
  existencias        int not null default 0,                 -- puede quedar negativa: se vende aunque el conteo esté mal
  existencias_minimas int not null default 0 check (existencias_minimas >= 0),
  activo             boolean not null default true,
  creado_por         uuid references public.profiles (id),
  creado_en          timestamptz not null default now(),
  actualizado_en     timestamptz not null default now()
);
create unique index productos_nombre_unico on public.productos (club_id, lower(trim(nombre)));
create index productos_club on public.productos (club_id);

create table public.producto_movimientos (
  id           uuid primary key default gen_random_uuid(),
  club_id      uuid not null references public.clubs (id),
  producto_id  uuid not null references public.productos (id),
  tipo         text not null check (tipo in ('alta', 'ajuste', 'venta', 'anulacion')),
  cantidad     int not null,                                  -- con signo: venta negativa
  consumo_id   uuid references public.caja_consumos (id),
  motivo       text check (char_length(motivo) <= 300),
  hecho_por    uuid references public.profiles (id),
  hecho_en     timestamptz not null default now()
);
create index producto_movimientos_producto on public.producto_movimientos (producto_id);

alter table public.caja_consumos
  add column producto_id uuid references public.productos (id),
  add column cantidad int check (cantidad between 1 and 999);

alter table public.caja_pagos
  add column propina_centavos bigint not null default 0 check (propina_centavos between 0 and 100000000);


-- ----------------------------------------------------------------------------
-- 2. Acceso: leer con caja_puede_ver (staff, gerente, dueño, admin del antro);
--    escribir, solo por funciones. GRANT explícitos (en dev no hay
--    exposición automática).
-- ----------------------------------------------------------------------------
alter table public.productos enable row level security;
alter table public.producto_movimientos enable row level security;

create policy productos_select on public.productos
  for select to authenticated using ((select public.caja_puede_ver(club_id)));
create policy producto_movimientos_select on public.producto_movimientos
  for select to authenticated using ((select public.es_gerente_o_dueno(club_id)));

revoke all on table public.productos, public.producto_movimientos from public, anon, authenticated;
grant select on table public.productos, public.producto_movimientos to authenticated;
grant all on table public.productos, public.producto_movimientos to service_role;


-- ----------------------------------------------------------------------------
-- 3. Catálogo: alta y edición (gerente o dueño) y ajuste de existencias.
-- ----------------------------------------------------------------------------
create function public.producto_guardar(
  p_club_id uuid, p_id uuid, p_nombre text, p_categoria text, p_precio_centavos bigint,
  p_existencias_minimas int default 0, p_activo boolean default true, p_existencias_iniciales int default 0)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.es_gerente_o_dueno(p_club_id) then
    raise exception 'Solo el gerente o el dueño editan el catálogo';
  end if;
  if p_nombre is null or char_length(trim(p_nombre)) = 0 then
    raise exception 'Escribe el nombre del producto';
  end if;
  if p_categoria is null or char_length(trim(p_categoria)) = 0 then
    raise exception 'Escribe la categoría';
  end if;
  if p_precio_centavos is null or p_precio_centavos < 1 or p_precio_centavos > 100000000 then
    raise exception 'Precio inválido';
  end if;
  if coalesce(p_existencias_minimas, 0) < 0 then
    raise exception 'El mínimo no puede ser negativo';
  end if;

  begin
    if p_id is null then
      insert into public.productos (club_id, nombre, categoria, precio_centavos, existencias, existencias_minimas, activo, creado_por)
      values (p_club_id, trim(p_nombre), trim(p_categoria), p_precio_centavos, coalesce(p_existencias_iniciales, 0),
              coalesce(p_existencias_minimas, 0), coalesce(p_activo, true), auth.uid())
      returning id into v_id;
      if coalesce(p_existencias_iniciales, 0) <> 0 then
        insert into public.producto_movimientos (club_id, producto_id, tipo, cantidad, motivo, hecho_por)
        values (p_club_id, v_id, 'alta', p_existencias_iniciales, 'Existencias iniciales', auth.uid());
      end if;
    else
      update public.productos
      set nombre = trim(p_nombre), categoria = trim(p_categoria), precio_centavos = p_precio_centavos,
          existencias_minimas = coalesce(p_existencias_minimas, 0), activo = coalesce(p_activo, true), actualizado_en = now()
      where id = p_id and club_id = p_club_id
      returning id into v_id;
      if v_id is null then
        raise exception 'Producto no encontrado';
      end if;
    end if;
  exception when unique_violation then
    raise exception 'Ya hay un producto con ese nombre';
  end;
  return v_id;
end;
$$;

create function public.producto_ajustar_existencias(p_producto_id uuid, p_cantidad int, p_motivo text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p public.productos%rowtype;
begin
  select * into v_p from public.productos where id = p_producto_id for update;
  if not found or not public.es_gerente_o_dueno(v_p.club_id) then
    raise exception 'Producto no encontrado';
  end if;
  if p_cantidad is null or p_cantidad = 0 or abs(p_cantidad) > 100000 then
    raise exception 'Cantidad inválida';
  end if;
  if p_motivo is null or char_length(trim(p_motivo)) < 3 then
    raise exception 'Escribe el motivo del ajuste';
  end if;
  update public.productos set existencias = existencias + p_cantidad, actualizado_en = now() where id = p_producto_id;
  insert into public.producto_movimientos (club_id, producto_id, tipo, cantidad, motivo, hecho_por)
  values (v_p.club_id, v_p.id, 'ajuste', p_cantidad, trim(p_motivo), auth.uid());
  return v_p.existencias + p_cantidad;
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. Consumo de catálogo: monto y concepto los pone la base (precio del
--    catálogo), descuenta existencias, idempotente por clave.
-- ----------------------------------------------------------------------------
create function public.caja_registrar_consumo_producto(
  p_cuenta_id uuid, p_producto_id uuid, p_cantidad int, p_clave uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cuenta public.mesa_cuentas%rowtype;
  v_sesion public.mesa_sesiones%rowtype;
  v_prod public.productos%rowtype;
  v_previo public.caja_consumos%rowtype;
  v_id uuid;
begin
  if p_clave is not null then
    select * into v_previo from public.caja_consumos where registrado_por = auth.uid() and clave_cliente = p_clave;
    if found then
      if v_previo.cuenta_id is distinct from p_cuenta_id or v_previo.producto_id is distinct from p_producto_id
         or v_previo.cantidad is distinct from p_cantidad then
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
  if p_cantidad is null or p_cantidad < 1 or p_cantidad > 999 then
    raise exception 'Cantidad inválida';
  end if;
  -- El producto se bloquea: dos ventas simultáneas descuentan bien.
  select * into v_prod from public.productos where id = p_producto_id for update;
  if not found or v_prod.club_id <> v_sesion.club_id then
    raise exception 'Producto no encontrado en este antro';
  end if;
  if not v_prod.activo then
    raise exception 'Ese producto ya no se vende';
  end if;

  begin
    insert into public.caja_consumos (club_id, noche_id, sesion_id, mesa_id, cuenta_id, reservation_id, rp_id,
                                      monto_centavos, concepto, registrado_por, clave_cliente, producto_id, cantidad)
    values (v_sesion.club_id, v_sesion.noche_id, v_sesion.id, v_sesion.mesa_id, v_cuenta.id,
            v_cuenta.reservation_id, v_cuenta.rp_id, v_prod.precio_centavos * p_cantidad,
            left(p_cantidad || ' × ' || v_prod.nombre, 120), auth.uid(), p_clave, v_prod.id, p_cantidad)
    returning id into v_id;
  exception when unique_violation then
    select * into v_previo from public.caja_consumos where registrado_por = auth.uid() and clave_cliente = p_clave;
    return v_previo.id;
  end;

  update public.productos set existencias = existencias - p_cantidad, actualizado_en = now() where id = v_prod.id;
  insert into public.producto_movimientos (club_id, producto_id, tipo, cantidad, consumo_id, hecho_por)
  values (v_prod.club_id, v_prod.id, 'venta', -p_cantidad, v_id, auth.uid());
  return v_id;
end;
$$;

-- Anular un consumo de catálogo regresa sus existencias (una vez: el
-- trigger caja_sin_borrar ya impide anular dos veces).
create function public.caja_consumo_anulado_regresa_existencias()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.anulado and not old.anulado and new.producto_id is not null then
    update public.productos set existencias = existencias + new.cantidad, actualizado_en = now() where id = new.producto_id;
    insert into public.producto_movimientos (club_id, producto_id, tipo, cantidad, consumo_id, motivo, hecho_por)
    values (new.club_id, new.producto_id, 'anulacion', new.cantidad, new.id, new.motivo_anulacion, new.anulado_por);
  end if;
  return new;
end;
$$;
revoke all on function public.caja_consumo_anulado_regresa_existencias() from public, anon, authenticated;

create trigger caja_consumos_regresa_existencias
  after update of anulado on public.caja_consumos
  for each row execute function public.caja_consumo_anulado_regresa_existencias();


-- ----------------------------------------------------------------------------
-- 5. Propina en el cobro. Misma función de la caja con un parámetro más
--    (default 0). La propina NO entra al saldo ni a lo cobrado: va aparte.
-- ----------------------------------------------------------------------------
drop function public.caja_registrar_pago(uuid, uuid, text, bigint, text, uuid, bigint);

create function public.caja_registrar_pago(
  p_sesion_id uuid, p_cuenta_id uuid, p_metodo text, p_monto_centavos bigint, p_referencia text default null,
  p_clave uuid default null, p_saldo_esperado bigint default null, p_propina_centavos bigint default 0)
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
$$;


-- ----------------------------------------------------------------------------
-- 6. Quién puede llamar.
-- ----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.producto_guardar(uuid, uuid, text, text, bigint, int, boolean, int)',
    'public.producto_ajustar_existencias(uuid, int, text)',
    'public.caja_registrar_consumo_producto(uuid, uuid, int, uuid)',
    'public.caja_registrar_pago(uuid, uuid, text, bigint, text, uuid, bigint, bigint)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;
