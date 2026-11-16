-- When an Admin changes someone's password, that person's open sessions must
-- end so they sign in again with the new password. Deleting their auth.sessions
-- rows also removes the refresh tokens (cascade), so every device they were
-- signed in on is logged out at its next check. Only the server (service role)
-- may call this; adminUpdateUser checks the caller's rights first.
create or replace function public.revoke_user_sessions(target_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from auth.sessions where user_id = target_id;
end;
$$;

revoke all on function public.revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function public.revoke_user_sessions(uuid) to service_role;
