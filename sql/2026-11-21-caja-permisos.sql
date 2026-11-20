-- ============================================================================
-- AntroApp — Permisos de caja en una sola llamada
-- Fecha: 2026-11-21
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO, hasta el pase.
-- Requiere: sql/2026-11-20-caja-por-mesa.sql (caja_tiene_permiso).
-- Rollback: drop function if exists public.caja_mis_permisos(uuid);
--
-- /staff/caja pedía 8 permisos con 8 llamadas (una por casilla). Esta
-- función devuelve todos en un JSON con la MISMA regla (caja_tiene_permiso).
-- Solo informa a la pantalla: quien hace cumplir sigue siendo cada función.
-- ============================================================================
create or replace function public.caja_mis_permisos(p_club_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_object_agg(p, public.caja_tiene_permiso(p_club_id, p))
  from unnest(array['abrir_mesa', 'registrar_consumo', 'cobrar', 'cerrar_mesa',
                    'reabrir_mesa', 'anular', 'cuadrar_mesa', 'cerrar_noche']) as p;
$$;
revoke all on function public.caja_mis_permisos(uuid) from public, anon;
grant execute on function public.caja_mis_permisos(uuid) to authenticated;
