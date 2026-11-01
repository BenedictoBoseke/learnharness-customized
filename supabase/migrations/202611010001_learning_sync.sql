-- Private, immutable library revisions. Run once in the project's SQL Editor.
begin;
create table if not exists public.lh_libraries (
 id uuid primary key default gen_random_uuid(),owner_id uuid not null references auth.users(id) on delete cascade,
 name text not null check(char_length(name) between 1 and 120),head_id uuid,created_at timestamptz not null default now()
);
create table if not exists public.lh_revisions (
 id uuid primary key default gen_random_uuid(),library_id uuid not null references public.lh_libraries(id) on delete cascade,
 owner_id uuid not null references auth.users(id) on delete cascade,parent_id uuid references public.lh_revisions(id),
 operation_id uuid not null,device_id text not null,manifest jsonb not null,created_at timestamptz not null default now(),unique(owner_id,operation_id)
);
create index if not exists lh_revisions_library on public.lh_revisions(library_id,created_at);
alter table public.lh_libraries enable row level security;
alter table public.lh_revisions enable row level security;
drop policy if exists lh_library_read on public.lh_libraries;
create policy lh_library_read on public.lh_libraries for select to authenticated using(owner_id=(select auth.uid()));
drop policy if exists lh_library_create on public.lh_libraries;
create policy lh_library_create on public.lh_libraries for insert to authenticated with check(owner_id=(select auth.uid()) and head_id is null);
drop policy if exists lh_revision_read on public.lh_revisions;
create policy lh_revision_read on public.lh_revisions for select to authenticated using(owner_id=(select auth.uid()));
revoke all on public.lh_libraries,public.lh_revisions from anon,authenticated;
grant select,insert on public.lh_libraries to authenticated;
grant select on public.lh_revisions to authenticated;
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
 if p_device_id is null or char_length(p_device_id)>100 or (p_manifest->'version') is distinct from '1'::jsonb or jsonb_typeof(p_manifest->'entries') is distinct from 'object' or not ((p_manifest->'entries')?'graph/family') then raise exception 'Invalid manifest' using errcode='22023';end if;
 if exists(select 1 from jsonb_each(p_manifest->'entries') e where jsonb_typeof(e.value)<>'string' or e.key !~ '^((chat|job|file|document)/[A-Za-z0-9_-]+|graph/family)$' or (e.value #>> '{}') !~ '^[a-f0-9]{64}$') then raise exception 'Invalid manifest entry' using errcode='22023';end if;
 insert into public.lh_revisions(library_id,owner_id,parent_id,operation_id,device_id,manifest) values(p_library_id,auth.uid(),p_parent_id,p_operation_id,p_device_id,p_manifest) returning * into result;
 update public.lh_libraries set head_id=result.id where id=p_library_id;
 return to_jsonb(result);
end $$;
revoke all on function public.lh_sync_commit(uuid,uuid,uuid,text,jsonb) from public,anon;
grant execute on function public.lh_sync_commit(uuid,uuid,uuid,text,jsonb) to authenticated;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('learnharness-sync','learnharness-sync',false,52428800,array['application/octet-stream'])
 on conflict(id) do update set public=false;
drop policy if exists lh_blob_read on storage.objects;
create policy lh_blob_read on storage.objects for select to authenticated using(bucket_id='learnharness-sync' and (storage.foldername(name))[1]=(select auth.uid()::text));
drop policy if exists lh_blob_create on storage.objects;
create policy lh_blob_create on storage.objects for insert to authenticated with check(bucket_id='learnharness-sync' and (storage.foldername(name))[1]=(select auth.uid()::text) and (storage.filename(name)) ~ '^[a-f0-9]{64}$');
commit;
