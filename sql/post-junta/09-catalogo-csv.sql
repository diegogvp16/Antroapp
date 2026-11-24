-- ============================================================================
-- AntroApp — Importar el catálogo desde un CSV sencillo (fase 2)
-- Fecha: 2026-11-24 (rama post-junta)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO (va en el "pase 2", y
--         solo si se pasa la fase 2).
-- Requiere: sql/fase2/2026-11-21-inventario-propinas.sql (producto_guardar).
-- Rollback: drop function if exists public.producto_importar(uuid, jsonb);
--
-- El gerente (o el dueño) pega o sube un CSV «nombre, categoría, precio,
-- mínimo, existencias». La pantalla lo convierte a filas y llama a esta
-- función: TODO en una transacción (si una fila está mal no entra ninguna y
-- el error dice cuál). Un producto que ya existe (mismo nombre, sin importar
-- mayúsculas) se actualiza: precio, categoría y mínimo; sus existencias NO
-- se tocan (se ajustan con motivo en el catálogo). Un producto nuevo entra
-- con sus existencias iniciales (queda en la bitácora como "alta").
-- ============================================================================
create or replace function public.producto_importar(p_club_id uuid, p_filas jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_fila      jsonb;
  v_i         int := 0;
  v_id        uuid;
  v_creados   int := 0;
  v_actual    int := 0;
begin
  if not public.es_gerente_o_dueno(p_club_id) then
    raise exception 'Solo el gerente o el dueño editan el catálogo' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_filas) <> 'array' or jsonb_array_length(p_filas) = 0 then
    raise exception 'La lista está vacía' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_filas) > 500 then
    raise exception 'Máximo 500 productos por importación' using errcode = 'P0001';
  end if;

  for v_fila in select * from jsonb_array_elements(p_filas) loop
    v_i := v_i + 1;
    begin
      select p.id into v_id from public.productos p
      where p.club_id = p_club_id and lower(trim(p.nombre)) = lower(trim(v_fila ->> 'nombre'));
      perform public.producto_guardar(
        p_club_id, v_id, v_fila ->> 'nombre', v_fila ->> 'categoria',
        (v_fila ->> 'precio_centavos')::bigint,
        coalesce((v_fila ->> 'existencias_minimas')::int, 0),
        true,
        case when v_id is null then coalesce((v_fila ->> 'existencias')::int, 0) else 0 end);
      if v_id is null then v_creados := v_creados + 1; else v_actual := v_actual + 1; end if;
    exception when others then
      raise exception 'Fila %: %', v_i, sqlerrm using errcode = 'P0001';
    end;
  end loop;
  return jsonb_build_object('creados', v_creados, 'actualizados', v_actual);
end;
$$;
revoke all on function public.producto_importar(uuid, jsonb) from public, anon;
grant execute on function public.producto_importar(uuid, jsonb) to authenticated;
