-- ============================================================================
-- AntroApp — "Un dueño, un antro" con candado (dos altas a la vez)
-- Fecha: 2026-11-25 (rama c-rls, corrección de la revisión del carril)
-- Estado: APLICADO Y PROBADO EN DEV (scripts/dev/probar-concurrencia-noche3.mjs,
-- caso 6). En producción NO.
-- Rollback: sql/post-junta-2/68-un-antro-por-dueno-candado-rollback.sql
-- Requiere: sql/post-junta-2/62-clubs-dueno-valido.sql (dueno_tiene_club()).
--
-- Hallazgo: el 62 revisa "un dueño, un antro" con una lectura en el WITH
-- CHECK de "clubs insert dueno o admin" (dueno_tiene_club()), sin candado ni
-- índice único. Dos INSERT del mismo dueño a la vez no ven la fila del otro
-- (aún sin confirmar) y pasan los dos: quedan dos antros y /dueno/panel se
-- rompe (deuda 6). Probado en dev con una carrera forzada (dos transacciones
-- abiertas con el JWT del mismo dueño): las dos entraban.
--
-- Arreglo: trigger BEFORE INSERT en clubs que, para una sesión de la API
-- (current_user = authenticated) que no es admin, toma un candado por dueño
-- (pg_advisory_xact_lock) y vuelve a contar ya con el candado. La segunda
-- alta espera a que la primera confirme y entonces ve su antro y se rechaza
-- con un aviso (P0001). Si la primera se deshace, la segunda pasa.
--
-- Alcance, igual que la política del 62 (que solo aplica por la API):
--  * El admin no pasa por el candado (da de alta los antros de un grupo).
--  * Las funciones SECURITY DEFINER (_admin_alta_club_base) y la service role
--    corren como postgres / service_role: no pasan por el candado.
-- La función del trigger es SECURITY INVOKER a propósito: así current_user
-- dice si la llamada viene de la API o de una función de la base.
-- No es un índice único: con uno, el admin tampoco podría darle a un dueño
-- un segundo antro (DECISIÓN 1 para Diego en docs/post-junta-2/c-rls.md).
-- ============================================================================

create or replace function public.clubs_un_antro_por_dueno()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
begin
  if current_user <> 'authenticated' or new.dueno_id is null
     or coalesce(public.current_role_name() = 'admin', false) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('club_dueno|' || new.dueno_id::text, 0));
  -- Con el candado, una lectura nueva ya ve el antro que la otra alta confirmó.
  if coalesce(public.dueno_tiene_club(), false) then
    raise exception 'Ya tienes un antro registrado. Para sumar otro, pídelo al equipo de AntroApp.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$function$;
revoke all on function public.clubs_un_antro_por_dueno() from public, anon;
grant execute on function public.clubs_un_antro_por_dueno() to authenticated, service_role;

drop trigger if exists clubs_un_antro_por_dueno on public.clubs;
create trigger clubs_un_antro_por_dueno
  before insert on public.clubs
  for each row execute function public.clubs_un_antro_por_dueno();
