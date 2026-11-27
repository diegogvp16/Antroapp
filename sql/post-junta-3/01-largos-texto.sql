-- ============================================================================
-- AntroApp — Límite de largo en los textos que controla cualquier usuario
-- Fecha: 2026-11-27 (noche 4). Rollback: sql/post-junta-3/01-largos-texto-rollback.sql
-- Prueba (dev): node scripts/dev/probar-largos-texto.mjs
--
-- Hallazgo (revisión del bloque 7, reproducido en dev con sesión de RP):
-- profiles.nombre no tiene límite y profiles_update_propio deja que cada quien
-- cambie su nombre. Un RP puso un nombre de 20,000 letras: las pantallas que
-- listan personal (caja, nómina, /grupo, reportes) lo dibujan completo y el
-- PDF del dueño tardaba minutos en armarse. Lo mismo con el nombre del
-- cliente en una reserva de cliente o de RP (la del anónimo ya tiene 2–80 por
-- el trigger del 72).
--
-- Arreglo: checks de largo NOT VALID. Valen para TODA fila nueva y para toda
-- edición desde ya; no revisan las filas que ya existen (no hay que leer
-- producción para aplicarlo y no bloquea la tabla mientras se valida).
-- Validarlos después (opcional), en el SQL Editor, primero el diagnóstico:
--   select count(*) filter (where char_length(nombre) > 120) as nombres,
--          count(*) filter (where char_length(telefono) > 30) as telefonos
--     from public.profiles;
--   select count(*) filter (where char_length(cliente_nombre) > 120) as nombres,
--          count(*) filter (where char_length(cliente_telefono) > 30) as telefonos
--     from public.reservations;
--   -- si todo es 0:
--   alter table public.profiles validate constraint profiles_nombre_largo;  (y los demás)
-- ============================================================================
begin;

alter table public.profiles
  add constraint profiles_nombre_largo check (nombre is null or char_length(nombre) <= 120) not valid,
  add constraint profiles_telefono_largo check (telefono is null or char_length(telefono) <= 30) not valid;

alter table public.reservations
  add constraint reservations_cliente_nombre_largo check (cliente_nombre is null or char_length(cliente_nombre) <= 120) not valid,
  add constraint reservations_cliente_telefono_largo check (cliente_telefono is null or char_length(cliente_telefono) <= 30) not valid;

commit;
