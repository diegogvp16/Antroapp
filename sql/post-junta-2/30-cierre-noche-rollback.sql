-- Rollback de sql/post-junta-2/30-cierre-noche.sql.
-- La función solo lee: quitarla no borra ni cambia datos. La pantalla
-- /grupo/noche responde "El cierre de la noche todavía no está disponible".
drop function if exists public.reporte_cierre_noche(uuid, date);
