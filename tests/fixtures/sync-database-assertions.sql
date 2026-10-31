set role authenticated;
set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
insert into public.lh_libraries(id,owner_id,name) values('33333333-3333-4333-8333-333333333333',auth.uid(),'Invented fixture library');
do $$declare a jsonb;b jsonb;begin
 a:=public.lh_sync_commit('33333333-3333-4333-8333-333333333333',null,'44444444-4444-4444-8444-444444444444','pc','{"version":1,"entries":{"graph/family":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}');
 b:=public.lh_sync_commit('33333333-3333-4333-8333-333333333333',null,'44444444-4444-4444-8444-444444444444','pc','{"version":1,"entries":{"graph/family":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}');
 if a->>'id'<>b->>'id' then raise exception 'Idempotency failed';end if;
 if (select count(*) from public.lh_revisions)<>1 then raise exception 'Duplicate revision';end if;
 begin
  perform public.lh_sync_commit('33333333-3333-4333-8333-333333333333',null,'55555555-5555-4555-8555-555555555555','android','{"version":1,"entries":{"graph/family":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}');
  raise exception 'Stale parent accepted';
 exception when serialization_failure then null;end;
 begin
  perform public.lh_sync_commit('33333333-3333-4333-8333-333333333333',(a->>'id')::uuid,'66666666-6666-4666-8666-666666666666','pc','{"entries":{"graph/family":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}');
  raise exception 'Missing version accepted';
 exception when invalid_parameter_value then null;end;
 begin
  perform public.lh_sync_commit('33333333-3333-4333-8333-333333333333',(a->>'id')::uuid,'66666666-6666-4666-8666-666666666666','pc','{"version":2,"entries":{"graph/family":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}');
  raise exception 'Future version accepted';
 exception when invalid_parameter_value then null;end;
 begin
  insert into public.lh_revisions(library_id,owner_id,operation_id,device_id,manifest) values('33333333-3333-4333-8333-333333333333',auth.uid(),gen_random_uuid(),'pc','{}');
  raise exception 'Direct revision write bypassed commit gate';
 exception when insufficient_privilege then null;end;
end $$;
insert into storage.objects(bucket_id,name) values('learnharness-sync','11111111-1111-4111-8111-111111111111/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
set request.jwt.claim.sub='22222222-2222-4222-8222-222222222222';
do $$begin
 if (select count(*) from public.lh_libraries)<>0 or (select count(*) from public.lh_revisions)<>0 or (select count(*) from storage.objects)<>0 then raise exception 'RLS exposed another account';end if;
 begin
  perform public.lh_sync_commit('33333333-3333-4333-8333-333333333333',null,gen_random_uuid(),'other','{"version":1,"entries":{"graph/family":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}');
  raise exception 'Cross-account commit accepted';
 exception when insufficient_privilege then null;end;
 begin
  insert into storage.objects(bucket_id,name) values('learnharness-sync','11111111-1111-4111-8111-111111111111/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  raise exception 'Cross-account blob write accepted';
 exception when insufficient_privilege then null;end;
end $$;
reset role;
select 'PASS: idempotency, revision fencing, future-version rejection, table privileges, account RLS, private blob access' as result;
