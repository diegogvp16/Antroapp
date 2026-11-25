-- Diagnóstico de SOLO LECTURA antes de 22-importar-mesas.sql.
-- Mesas con el mismo nombre (sin importar mayúsculas ni espacios de las
-- orillas) dentro de un mismo antro. Si no devuelve filas, se puede aplicar
-- el 22. Si devuelve, renombrar (no borrar) las repetidas desde el panel del
-- dueño o con un UPDATE de numero por id, y volver a correr esto.
-- No muestra datos de personas: solo antro, nombre de mesa y cuántas hay.
select c.nombre as antro,
       t.club_id,
       lower(btrim(t.numero)) as mesa,
       count(*) as repetidas,
       array_agg(t.id order by t.created_at) as ids,
       (select count(*) from public.reservations r where r.mesa_id = any (array_agg(t.id))) as reservas_que_las_usan
from public.club_tables t
join public.clubs c on c.id = t.club_id
group by c.nombre, t.club_id, lower(btrim(t.numero))
having count(*) > 1
order by c.nombre, mesa;
