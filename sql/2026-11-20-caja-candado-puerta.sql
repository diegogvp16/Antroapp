-- ============================================================================
-- AntroApp — Candado de puerta (bloque 21 del diseño de caja)
-- Fecha: 2026-11-20
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO.
-- Requiere: sql/2026-11-20-caja-por-mesa.sql (columnas de puerta).
-- ORDEN EN PRODUCCIÓN: aplicar SOLO después de publicar el código cuyo
-- /staff/panel usa puerta_escanear / puerta_confirmar_entrada. Si se aplica
-- antes, el "Confirmar entrada" de la app vieja (UPDATE directo) deja de
-- funcionar.
-- Rollback: drop trigger reservations_candado_puerta on public.reservations;
--           drop function public.reservations_candado_puerta();
-- ============================================================================

-- ----------------------------------------------------------------------------
-- BLOQUE 21 — Candado: la puerta y el check-in solo por las funciones.
-- Hoy el staff puede hacer UPDATE status = 'usada' directo por la API. Este
-- trigger lo impide para anon y authenticated; las funciones SECURITY
-- DEFINER pasan porque corren como el dueño de la tabla.
-- IMPORTANTE: la función del trigger NO es security definer (si lo fuera,
-- current_user siempre sería el dueño y el candado no serviría).
-- Aplicar SOLO después de cambiar el código de "Confirmar llegada".
-- ----------------------------------------------------------------------------
create or replace function public.reservations_candado_puerta()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'usada' or new.puerta_estado is not null or new.entrada_en is not null
       or new.llegada_tarde is not null or new.en_puerta_en is not null
       or new.en_puerta_por is not null or new.entrada_por is not null then
      raise exception 'Una reserva nueva no puede nacer con datos de puerta';
    end if;
    return new;
  end if;

  if new.puerta_estado    is distinct from old.puerta_estado
     or new.en_puerta_en  is distinct from old.en_puerta_en
     or new.en_puerta_por is distinct from old.en_puerta_por
     or new.entrada_en    is distinct from old.entrada_en
     or new.entrada_por   is distinct from old.entrada_por
     or new.llegada_tarde is distinct from old.llegada_tarde then
    raise exception 'La puerta solo se registra con las funciones de puerta';
  end if;

  if new.status = 'usada' and old.status is distinct from 'usada' then
    raise exception 'El check-in solo se registra con "Confirmar entrada"';
  end if;

  if coalesce(new.se_retiro_sin_consumir, false) and not coalesce(old.se_retiro_sin_consumir, false)
     and coalesce(new.puerta_estado, case when new.status = 'usada' then 'entro' end) is distinct from 'entro' then
    raise exception 'Solo se marca "se retiró sin consumir" a quien entró';
  end if;

  return new;
end;
$$;

create trigger reservations_candado_puerta
  before insert or update on public.reservations
  for each row execute function public.reservations_candado_puerta();


revoke all on function public.reservations_candado_puerta() from public, anon, authenticated;
