set role authenticated;
set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
do $$declare library uuid;parent uuid;commit jsonb;begin
 insert into public.lh_libraries(owner_id,name) values(auth.uid(),'Subject v2 fixture') returning id into library;
 commit:=public.lh_sync_commit(library,null,gen_random_uuid(),'pc','{"version":2,"entries":{"graph/family":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","workspace/ws_a":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}');
 parent:=(commit->>'id')::uuid;
 if commit->'manifest'->>'version'<>'2' then raise exception 'V2 workspace rejected';end if;
 begin
  perform public.lh_sync_commit(library,parent,gen_random_uuid(),'pc','{"version":1,"entries":{"graph/family":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","workspace/ws_a":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}');
  raise exception 'V1 workspace accepted';
 exception when invalid_parameter_value then null;end;
 begin
  perform public.lh_sync_commit(library,parent,gen_random_uuid(),'pc','{"version":3,"entries":{"graph/family":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}');
  raise exception 'Future protocol accepted';
 exception when invalid_parameter_value then null;end;
 begin
  perform public.lh_sync_commit(library,parent,gen_random_uuid(),'pc','{"entries":{"graph/family":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}');
  raise exception 'Missing version accepted';
 exception when invalid_parameter_value then null;end;
end $$;
reset role;
select 'PASS: additive v2 workspace support; v1 workspace, missing and future version rejection' as result;
