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
-- Arreglo: checks de largo, agregados NOT VALID y VALIDADOS en la misma
-- transacción (validar no bloquea escrituras). Si alguna fila vieja rebasa el
-- límite, el archivo entero falla sin dejar nada. Diagnóstico OBLIGATORIO
-- antes del pase (solo conteos): `node scripts/db/conteos-prod.mjs`, consulta
-- largos_texto, o en el SQL Editor:
--   select count(*) filter (where char_length(nombre) > 120) as nombres,
--          count(*) filter (where char_length(telefono) > 30) as telefonos
--     from public.profiles;
--   select count(*) filter (where char_length(cliente_nombre) > 120) as nombres,
--          count(*) filter (where char_length(cliente_telefono) > 30) as telefonos
--     from public.reservations;
-- Todo debe dar 0. Si no, acortar esas filas antes de aplicar este archivo.
-- ============================================================================
begin;

alter table public.profiles
  add constraint profiles_nombre_largo check (nombre is null or char_length(nombre) <= 120) not valid,
  add constraint profiles_telefono_largo check (telefono is null or char_length(telefono) <= 30) not valid;

alter table public.reservations
  add constraint reservations_cliente_nombre_largo check (cliente_nombre is null or char_length(cliente_nombre) <= 120) not valid,
  add constraint reservations_cliente_telefono_largo check (cliente_telefono is null or char_length(cliente_telefono) <= 30) not valid;

-- Validar en la misma transacción (revisión final de la noche 4): un CHECK
-- NOT VALID se evalúa en CUALQUIER update de la fila, así que una fila vieja
-- más larga que el límite ya no se podría editar (confirmar entrada, asignar
-- mesa, dar de baja). Si hay alguna, el validate falla y TODO este archivo se
-- deshace sin dejar nada a medias: correr el diagnóstico de arriba, acortar
-- esas filas y volver a correrlo. VALIDATE no bloquea escrituras.
-- Producción el 27/11/2026 (scripts/db/conteos-prod.mjs, largos_texto): 0 y 0.
alter table public.profiles validate constraint profiles_nombre_largo;
alter table public.profiles validate constraint profiles_telefono_largo;
alter table public.reservations validate constraint reservations_cliente_nombre_largo;
alter table public.reservations validate constraint reservations_cliente_telefono_largo;

commit;
