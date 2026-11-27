-- Rollback de sql/post-junta-3/60-whatsapp-plantillas.sql: quita las
-- plantillas de WhatsApp por antro y la lista de la noche para mensajes.
-- OJO: borra los textos propios de todos los antros y su bitácora (los de
-- fábrica viven en el código). Si hay que conservarlos, respaldarlos antes.
-- Va ANTES del rollback de 40-lista-negra.sql.
begin;
drop function if exists public.clientes_noche(uuid, int);
drop function if exists public.whatsapp_reserva(uuid);
drop function if exists public._clientes_estado(uuid, uuid, date, text, text);
drop function if exists public.whatsapp_plantilla_guardar(uuid, text, text);
drop function if exists public.whatsapp_plantillas(uuid);
drop function if exists public._whatsapp_trabaja(uuid);
drop table if exists public.whatsapp_plantillas_cambios;
drop table if exists public.club_whatsapp_plantillas;
commit;
