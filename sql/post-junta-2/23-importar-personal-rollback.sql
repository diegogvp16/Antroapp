-- Rollback de sql/post-junta-2/23-importar-personal.sql.
-- Deja invitacion_aceptar como en el 21 (sin teléfono), quita las funciones
-- del lote, la bitácora de lotes y las columnas telefono y lote_id de
-- invitaciones. Las invitaciones que se crearon por lote se QUEDAN (siguen
-- siendo invitaciones normales; solo pierden el teléfono y la marca de lote).

drop function if exists public.invitaciones_importar(uuid, text, uuid, jsonb);
drop function if exists public.invitaciones_emitir_tokens_lote(uuid);
drop function if exists public.telefono_mx_10(text);

create or replace function public.invitacion_aceptar(p_token text, p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v        public.invitaciones%rowtype;
  v_correo text;
  v_creado timestamptz;
  v_meta   jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' or p_user_id is null then
    raise exception 'Esta invitación no existe o ya no sirve.' using errcode = 'P0001';
  end if;
  select * into v from public.invitaciones
  where token_hash = sha256(convert_to(p_token, 'UTF8'))
  for update;
  if not found then
    raise exception 'Esta invitación no existe o ya no sirve.' using errcode = 'P0001';
  end if;
  if v.aceptada_en is not null then
    raise exception 'Esta invitación ya se usó. Inicia sesión con tu correo.' using errcode = 'P0001';
  end if;
  if v.revocada_en is not null then
    raise exception 'Esta invitación fue cancelada. Pide una nueva a quien te invitó.' using errcode = 'P0001';
  end if;
  if v.expira_en <= now() then
    raise exception 'Esta invitación venció. Pide que te la reenvíen.' using errcode = 'P0001';
  end if;

  -- La cuenta tiene que ser la que el servidor acaba de crear PARA esta
  -- invitación: mismo correo, marcada con su id y de hace menos de 10
  -- minutos. Nunca se liga una cuenta que ya existía.
  select lower(u.email), u.created_at, coalesce(u.raw_app_meta_data, '{}'::jsonb)
    into v_correo, v_creado, v_meta
  from auth.users u where u.id = p_user_id;
  if not found or v_correo is distinct from v.correo
     or v_creado < now() - interval '10 minutes'
     or (v_meta ->> 'invitacion_id') is distinct from v.id::text then
    raise exception 'La cuenta no corresponde a esta invitación.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.profiles p where p.id = p_user_id) then
    raise exception 'La cuenta no corresponde a esta invitación.' using errcode = 'P0001';
  end if;

  insert into public.profiles (id, nombre, role, club_id, activo)
  values (p_user_id, v.nombre, v.rol, v.club_id, true);
  update public.invitaciones set aceptada_en = now(), aceptada_por = p_user_id where id = v.id;
  return jsonb_build_object('rol', v.rol, 'club_id', v.club_id, 'correo', v.correo);
end;
$$;

revoke all on function public.invitacion_aceptar(text, uuid) from public, anon, authenticated;
grant execute on function public.invitacion_aceptar(text, uuid) to service_role;

drop index if exists public.invitaciones_lote;
alter table public.invitaciones drop column if exists lote_id, drop column if exists telefono;
drop table if exists public.invitacion_lotes;

notify pgrst, 'reload schema';
