-- ============================================================================
-- AntroApp — Rollback de sql/post-junta-3/20-escaner-respaldo.sql
-- Quita las cuatro funciones del escáner de respaldo y su índice en
-- caja_eventos. No toca datos: las entradas que ya se enviaron quedan como
-- cualquier entrada (reservations) y su evento 'puerta_entrada_diferida' se
-- queda en caja_eventos (no se borra).
-- Antes de correrlo, apagar la bandera escaner_respaldo en todos los antros
-- (la app la consulta; sin estas funciones el escáner de respaldo falla).
-- ============================================================================
begin;

drop function if exists public.boleto_muestra_codigo(text);
drop function if exists public.puerta_entrada_diferida(uuid, uuid, uuid, timestamptz);
drop index if exists public.caja_eventos_puerta_clave;
drop function if exists public.puerta_escanear_codigo(uuid, text, uuid);
drop function if exists public.puerta_escanear_codigo(uuid, text); -- versión del primer borrador
drop function if exists public.puerta_copia_noche(uuid);

commit;
