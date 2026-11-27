-- ============================================================================
-- AntroApp — Fase 2, bloque 8: inventario completo (entradas, mermas,
-- conteos, historial y reporte de la noche), detrás de la bandera por antro
-- «inventario» (sql/post-junta-3/00-funciones-club.sql) y de NEXT_PUBLIC_FASE2.
-- Fecha: 2026-11-27. Rollback: sql/post-junta-3/80-inventario-rollback.sql
-- Prueba (dev): node scripts/dev/probar-fase2-completa.mjs
-- Requiere: sql/fase2/2026-11-21-inventario-propinas.sql (productos y
--           producto_movimientos), sql/post-junta/09-catalogo-csv.sql y
--           sql/post-junta-3/00-funciones-club.sql (funcion_activa).
--
-- Lo que ya había (fase 2) se queda igual y NO se redefine ninguna función:
--   - producto_guardar / producto_importar / producto_ajustar_existencias;
--   - caja_registrar_consumo_producto (la venta descuenta existencias);
--   - el trigger que las regresa al anular el consumo.
-- Esas funciones NO revisan la bandera (otras pruebas de dev las usan sin
-- ella). La pantalla solo las ofrece con la bandera encendida.
--
-- Lo nuevo (solo gerente o dueño del antro, y solo con la bandera encendida):
--   - inventario_entrada: llegó mercancía (con costo y referencia opcionales);
--   - inventario_merma: se rompió, se derramó… (con motivo);
--   - inventario_conteo: conteo físico; guarda la diferencia contra lo que se
--     veía al empezar a contar (con motivo si la hay) sin absorber ventas hechas mientras tanto;
--   - inventario_historial: movimientos de un producto con el saldo después
--     de cada uno;
--   - inventario_reporte_noche: por producto, lo vendido, anulado, entradas,
--     mermas y conteos de una noche operativa.
-- Las tres de escritura tienen clave de idempotencia (un reintento con mala
-- señal no mueve dos veces) y bloquean el producto (dos movimientos a la vez
-- suman bien). Toda existencia sale de la bitácora: existencias = suma de
-- producto_movimientos.cantidad.
-- ============================================================================
begin;

-- ----------------------------------------------------------------------------
-- 1. Bitácora: tipos nuevos y columnas.
-- ----------------------------------------------------------------------------
alter table public.producto_movimientos drop constraint producto_movimientos_tipo_check;
alter table public.producto_movimientos add constraint producto_movimientos_tipo_check
  check (tipo in ('alta', 'ajuste', 'venta', 'anulacion', 'entrada', 'merma', 'conteo'));

alter table public.producto_movimientos
  add column costo_centavos bigint check (costo_centavos between 0 and 100000000),  -- entrada: costo total (opcional)
  add column referencia text check (char_length(referencia) <= 120),                -- entrada: factura o proveedor
  add column contado int check (contado between 0 and 1000000),                     -- conteo: lo que se contó
  add column clave_cliente uuid,                                                     -- idempotencia
  -- Orden real de aplicación: cada movimiento entra con el producto
  -- bloqueado, así que este número sigue el orden en que cambió el saldo.
  add column orden bigint generated always as identity;

create unique index producto_movimientos_clave on public.producto_movimientos (hecho_por, clave_cliente)
  where clave_cliente is not null;
create index producto_movimientos_club_hecho on public.producto_movimientos (club_id, hecho_en desc);

revoke all on sequence public.producto_movimientos_orden_seq from public, anon, authenticated;
grant usage, select on sequence public.producto_movimientos_orden_seq to service_role;


-- ----------------------------------------------------------------------------
-- 2. Ayudante: producto bloqueado para escribir. Primero quién llama, luego
--    la bandera. No se expone a la API.
-- ----------------------------------------------------------------------------
create function public.inventario_producto_para_escribir(p_producto_id uuid)
returns public.productos
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p public.productos%rowtype;
begin
  select * into v_p from public.productos where id = p_producto_id for update;
  if not found or not coalesce(public.es_gerente_o_dueno(v_p.club_id), false) then
    raise exception 'Producto no encontrado' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(v_p.club_id, 'inventario'), false) then
    raise exception 'El inventario no está activo en este antro.' using errcode = 'P0001';
  end if;
  return v_p;
end;
$$;
revoke all on function public.inventario_producto_para_escribir(uuid) from public, anon, authenticated;
grant execute on function public.inventario_producto_para_escribir(uuid) to service_role;

-- Reintento: si la clave ya se usó para quien llama, devuelve el movimiento
-- (o error si fue con otros datos). Null si es nueva.
create function public.inventario_movimiento_previo(p_clave uuid, p_producto_id uuid, p_tipo text, p_cantidad int, p_contado int)
returns public.producto_movimientos
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m public.producto_movimientos%rowtype;
begin
  if p_clave is null then
    return null;
  end if;
  select * into v_m from public.producto_movimientos where hecho_por = auth.uid() and clave_cliente = p_clave;
  if not found then
    return null;
  end if;
  if v_m.producto_id is distinct from p_producto_id or v_m.tipo is distinct from p_tipo
     or (p_tipo <> 'conteo' and v_m.cantidad is distinct from p_cantidad)
     or (p_tipo = 'conteo' and v_m.contado is distinct from p_contado) then
    raise exception 'Ese movimiento ya se había guardado con otros datos. Revisa el historial del producto.' using errcode = 'P0001';
  end if;
  return v_m;
end;
$$;
revoke all on function public.inventario_movimiento_previo(uuid, uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.inventario_movimiento_previo(uuid, uuid, text, int, int) to service_role;


-- ----------------------------------------------------------------------------
-- 3. Entradas, mermas y conteos. Devuelven las existencias después.
-- ----------------------------------------------------------------------------
create function public.inventario_entrada(
  p_producto_id uuid, p_cantidad int, p_costo_centavos bigint default null,
  p_referencia text default null, p_clave uuid default null)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_p public.productos%rowtype;
  v_previo public.producto_movimientos%rowtype;
begin
  v_p := public.inventario_producto_para_escribir(p_producto_id);
  v_previo := public.inventario_movimiento_previo(p_clave, p_producto_id, 'entrada', p_cantidad, null);
  if v_previo.id is not null then
    return v_p.existencias;
  end if;
  if p_cantidad is null or p_cantidad < 1 or p_cantidad > 100000 then
    raise exception 'Cantidad inválida (de 1 a 100,000)' using errcode = 'P0001';
  end if;
  if p_costo_centavos is not null and (p_costo_centavos < 0 or p_costo_centavos > 100000000) then
    raise exception 'Costo inválido' using errcode = 'P0001';
  end if;
  if char_length(coalesce(trim(p_referencia), '')) > 120 then
    raise exception 'La referencia es muy larga (máximo 120 letras)' using errcode = 'P0001';
  end if;

  update public.productos set existencias = existencias + p_cantidad, actualizado_en = now() where id = v_p.id;
  insert into public.producto_movimientos (club_id, producto_id, tipo, cantidad, motivo, costo_centavos, referencia,
                                           clave_cliente, hecho_por)
  values (v_p.club_id, v_p.id, 'entrada', p_cantidad, 'Entrada de mercancía', p_costo_centavos,
          nullif(trim(p_referencia), ''), p_clave, auth.uid());
  return v_p.existencias + p_cantidad;
end;
$$;

create function public.inventario_merma(p_producto_id uuid, p_cantidad int, p_motivo text, p_clave uuid default null)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_p public.productos%rowtype;
  v_previo public.producto_movimientos%rowtype;
begin
  v_p := public.inventario_producto_para_escribir(p_producto_id);
  v_previo := public.inventario_movimiento_previo(p_clave, p_producto_id, 'merma', -p_cantidad, null);
  if v_previo.id is not null then
    return v_p.existencias;
  end if;
  if p_cantidad is null or p_cantidad < 1 or p_cantidad > 100000 then
    raise exception 'Cantidad inválida (de 1 a 100,000)' using errcode = 'P0001';
  end if;
  if p_motivo is null or char_length(trim(p_motivo)) < 3 then
    raise exception 'Escribe el motivo de la merma' using errcode = 'P0001';
  end if;
  if char_length(trim(p_motivo)) > 300 then
    raise exception 'El motivo es muy largo (máximo 300 letras)' using errcode = 'P0001';
  end if;

  update public.productos set existencias = existencias - p_cantidad, actualizado_en = now() where id = v_p.id;
  insert into public.producto_movimientos (club_id, producto_id, tipo, cantidad, motivo, clave_cliente, hecho_por)
  values (v_p.club_id, v_p.id, 'merma', -p_cantidad, trim(p_motivo), p_clave, auth.uid());
  return v_p.existencias - p_cantidad;
end;
$$;

-- Conteo físico. La diferencia queda en la bitácora (puede ser 0: «se contó
-- y cuadró»); con diferencia, el motivo es obligatorio.
--
-- p_existencias_vistas: lo que decía el sistema cuando se empezó a contar
-- (la pantalla lo manda). Si mientras tanto hubo ventas, anulaciones u otros
-- movimientos, NO se absorben en la diferencia: las existencias quedan en
-- contado + (actual − vistas) y la diferencia es contado − vistas. Sin ese
-- dato (null) el conteo es absoluto: las existencias quedan en lo contado.
create function public.inventario_conteo(p_producto_id uuid, p_contado int, p_motivo text default null,
  p_clave uuid default null, p_existencias_vistas int default null)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_p public.productos%rowtype;
  v_previo public.producto_movimientos%rowtype;
  v_base int;
  v_dif int;
  v_movidos int;
  v_motivo text;
begin
  v_p := public.inventario_producto_para_escribir(p_producto_id);
  v_previo := public.inventario_movimiento_previo(p_clave, p_producto_id, 'conteo', null, p_contado);
  if v_previo.id is not null then
    return v_p.existencias;
  end if;
  if p_contado is null or p_contado < 0 or p_contado > 1000000 then
    raise exception 'Conteo inválido (de 0 a 1,000,000)' using errcode = 'P0001';
  end if;
  if p_existencias_vistas is not null and abs(p_existencias_vistas) > 1000000 then
    raise exception 'Existencias vistas inválidas' using errcode = 'P0001';
  end if;
  -- Contra qué se compara lo contado: lo que se veía al empezar (o lo actual).
  v_base := coalesce(p_existencias_vistas, v_p.existencias);
  v_movidos := v_p.existencias - v_base;
  v_dif := p_contado - v_base;
  if v_dif <> 0 and (p_motivo is null or char_length(trim(p_motivo)) < 3) then
    raise exception 'El conteo no coincide (diferencia de %): escribe el motivo', v_dif using errcode = 'P0001';
  end if;
  if char_length(coalesce(trim(p_motivo), '')) > 250 then
    raise exception 'El motivo es muy largo (máximo 250 letras)' using errcode = 'P0001';
  end if;
  v_motivo := coalesce(nullif(trim(p_motivo), ''), 'Conteo sin diferencia')
    || case when v_movidos <> 0
            then format(' (mientras se contaba hubo %s %s: se respetaron)', abs(v_movidos),
                        case when v_movidos < 0 then 'salidas' else 'entradas' end)
            else '' end;

  update public.productos set existencias = existencias + v_dif, actualizado_en = now() where id = v_p.id;
  insert into public.producto_movimientos (club_id, producto_id, tipo, cantidad, motivo, contado, clave_cliente, hecho_por)
  values (v_p.club_id, v_p.id, 'conteo', v_dif, v_motivo, p_contado, p_clave, auth.uid());
  return v_p.existencias + v_dif;
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. Historial de un producto, del más reciente al más viejo, con el saldo
--    que quedó después de cada movimiento.
-- ----------------------------------------------------------------------------
create function public.inventario_historial(p_producto_id uuid, p_limite int default 100)
returns table (id uuid, tipo text, cantidad int, existencias_despues int, motivo text, referencia text,
               costo_centavos bigint, contado int, concepto text, hecho_por_nombre text, hecho_en timestamptz,
               fecha_operacion date)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_p public.productos%rowtype;
begin
  select * into v_p from public.productos pr where pr.id = p_producto_id;
  if not found or not coalesce(public.es_gerente_o_dueno(v_p.club_id), false) then
    raise exception 'Producto no encontrado' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(v_p.club_id, 'inventario'), false) then
    raise exception 'El inventario no está activo en este antro.' using errcode = 'P0001';
  end if;
  return query
    select m.id, m.tipo, m.cantidad,
           (v_p.existencias - coalesce(sum(m.cantidad) over (order by m.orden desc
                                       rows between unbounded preceding and 1 preceding), 0))::int,
           m.motivo, m.referencia, m.costo_centavos, m.contado, k.concepto, pf.nombre, m.hecho_en,
           public.club_fecha_operacion(m.club_id, m.hecho_en)
      from public.producto_movimientos m
      left join public.caja_consumos k on k.id = m.consumo_id
      left join public.profiles pf on pf.id = m.hecho_por
     where m.producto_id = p_producto_id
     order by m.orden desc
     limit greatest(1, least(coalesce(p_limite, 100), 500));
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. Reporte de inventario de una noche operativa (corte 08:00 del antro):
--    vendido (cantidad y dinero), anulado, entradas, mermas y diferencias de
--    conteo/ajuste, con las existencias de ahora.
-- ----------------------------------------------------------------------------
create function public.inventario_reporte_noche(p_club_id uuid, p_fecha date)
returns table (producto_id uuid, nombre text, categoria text, activo boolean, vendidos int, vendido_centavos bigint,
               anulados int, entradas int, mermas int, diferencias int, existencias int, existencias_minimas int)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not coalesce(public.es_gerente_o_dueno(p_club_id), false) then
    raise exception 'Solo el gerente o el dueño ven el inventario' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(p_club_id, 'inventario'), false) then
    raise exception 'El inventario no está activo en este antro.' using errcode = 'P0001';
  end if;
  if p_fecha is null then
    raise exception 'Elige la noche' using errcode = 'P0001';
  end if;
  return query
    with ventas as (
      select k.producto_id,
             coalesce(sum(k.cantidad) filter (where not k.anulado), 0)::int as vendidos,
             coalesce(sum(k.monto_centavos) filter (where not k.anulado), 0)::bigint as vendido_centavos,
             coalesce(sum(k.cantidad) filter (where k.anulado), 0)::int as anulados
        from public.caja_consumos k
        join public.caja_noches n on n.id = k.noche_id
       where n.club_id = p_club_id and n.fecha_operacion = p_fecha and k.producto_id is not null
       group by k.producto_id
    ), movs as (
      select m.producto_id,
             coalesce(sum(m.cantidad) filter (where m.tipo in ('entrada', 'alta')), 0)::int as entradas,
             coalesce(-sum(m.cantidad) filter (where m.tipo = 'merma'), 0)::int as mermas,
             coalesce(sum(m.cantidad) filter (where m.tipo in ('conteo', 'ajuste')), 0)::int as diferencias
        from public.producto_movimientos m
       where m.club_id = p_club_id
         and m.hecho_en >= ((p_fecha + time '08:00') at time zone (select c.zona_horaria from public.clubs c where c.id = p_club_id))
         and m.hecho_en <  (((p_fecha + 1) + time '08:00') at time zone (select c.zona_horaria from public.clubs c where c.id = p_club_id))
       group by m.producto_id
    )
    select p.id, p.nombre, p.categoria, p.activo,
           coalesce(v.vendidos, 0), coalesce(v.vendido_centavos, 0::bigint), coalesce(v.anulados, 0),
           coalesce(mv.entradas, 0), coalesce(mv.mermas, 0), coalesce(mv.diferencias, 0),
           p.existencias, p.existencias_minimas
      from public.productos p
      left join ventas v on v.producto_id = p.id
      left join movs mv on mv.producto_id = p.id
     where p.club_id = p_club_id
       and (p.activo or v.producto_id is not null or mv.producto_id is not null)
     order by p.categoria, p.nombre;
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. Quién puede llamar (en producción lo nuevo nace abierto a anon).
-- ----------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.inventario_entrada(uuid, int, bigint, text, uuid)',
    'public.inventario_merma(uuid, int, text, uuid)',
    'public.inventario_conteo(uuid, int, text, uuid, int)',
    'public.inventario_historial(uuid, int)',
    'public.inventario_reporte_noche(uuid, date)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end;
$$;

commit;
