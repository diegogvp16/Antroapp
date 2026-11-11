-- ============================================================================
-- AntroApp — clubs: quitar la política abierta heredada del demo
-- Fecha: 2026-11-11
-- Estado: YA APLICADO en producción.
--
-- Qué cierra:
--   La política "Acceso abierto demo - clubs" venía del prototipo y dejaba
--   pasar a cualquiera (using true). Como las políticas permisivas se suman
--   con OR, seguía abriendo la tabla aunque ya hubiera políticas buenas por
--   rol y club: un anónimo podía leer TODOS los antros por la API, incluidos
--   los que están en borrador, en revisión, rechazados o sin suscripción.
--
-- Qué deja:
--   El anónimo solo lee antros publicados (verificados y con suscripción
--   activa), igual que el filtro que ya aplica la app en el listado, la
--   ficha y la pantalla de reservar. Las políticas de los usuarios con
--   sesión (dueño, staff, RP, admin) no se tocan.
--
-- Verificado el 11/11/2026 con sesiones reales: el anónimo no puede hacer
-- INSERT, UPDATE ni DELETE, solo ve antros verificados y activos, y la
-- reserva sin cuenta sigue funcionando en un antro verificado. Dueño, staff,
-- RP, cliente y admin siguen funcionando.
-- ============================================================================

begin;
drop policy if exists "Acceso abierto demo - clubs" on public.clubs;
create policy clubs_select_anon_verificados on public.clubs
  for select to anon
  using (estado_verificacion = 'verificado' and suscripcion_activa = true);
commit;
