-- Additive protocol v2 support. Install before enabling subject sync; update both devices.
begin;
create or replace function public.lh_sync_commit(p_library_id uuid,p_parent_id uuid,p_operation_id uuid,p_device_id text,p_manifest jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare library public.lh_libraries; previous public.lh_revisions; result public.lh_revisions;
begin
 if auth.uid() is null then raise exception 'Sign in required' using errcode='42501';end if;
 select * into library from public.lh_libraries where id=p_library_id and owner_id=auth.uid() for update;
 if not found then raise exception 'Library not found' using errcode='42501';end if;
 select * into previous from public.lh_revisions where owner_id=auth.uid() and operation_id=p_operation_id;
 if found then
  if previous.library_id<>p_library_id or previous.parent_id is distinct from p_parent_id or previous.manifest<>p_manifest or previous.device_id<>p_device_id then raise exception 'Operation identity reuse' using errcode='22023';end if;
  return to_jsonb(previous);
 end if;
 if library.head_id is distinct from p_parent_id then raise exception 'LH_REVISION_CONFLICT' using errcode='40001';end if;
 if p_device_id is null or char_length(p_device_id)>100 or not coalesce((p_manifest->'version') in ('1'::jsonb,'2'::jsonb),false) or jsonb_typeof(p_manifest->'entries') is distinct from 'object' or not ((p_manifest->'entries')?'graph/family') then raise exception 'Invalid manifest' using errcode='22023';end if;
 if exists(select 1 from jsonb_each(p_manifest->'entries') e where jsonb_typeof(e.value)<>'string' or (e.key !~ '^((chat|job|file|document)/[A-Za-z0-9_-]+|graph/family)$' and not ((p_manifest->'version')='2'::jsonb and e.key ~ '^workspace/[A-Za-z0-9_-]+$')) or (e.value #>> '{}') !~ '^[a-f0-9]{64}$') then raise exception 'Invalid manifest entry' using errcode='22023';end if;
 insert into public.lh_revisions(library_id,owner_id,parent_id,operation_id,device_id,manifest) values(p_library_id,auth.uid(),p_parent_id,p_operation_id,p_device_id,p_manifest) returning * into result;
 update public.lh_libraries set head_id=result.id where id=p_library_id;
 return to_jsonb(result);
end $$;
revoke all on function public.lh_sync_commit(uuid,uuid,uuid,text,jsonb) from public,anon;
grant execute on function public.lh_sync_commit(uuid,uuid,uuid,text,jsonb) to authenticated;
commit;
