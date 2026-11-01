from pathlib import Path
import hashlib,json,shutil,zipfile
root=Path(__file__).resolve().parent.parent
server=root/'.next/standalone'
assert (server/'server.js').is_file(),'Run next build and scripts/build-server.mjs first'
mobile=server/'mobile';mobile.mkdir(exist_ok=True)
for name in ['bootstrap.mjs','android-headless.mjs','android-headless.d.mts','host-bridge.js','mobile.css','migrate-legacy.mjs','RUNTIME-PROVENANCE.json']:
    shutil.copy2(root/'mobile'/name,mobile/name)
licenses=server/'ANDROID-LICENSES';licenses.mkdir(exist_ok=True)
shutil.copy2(root/'LICENSE',licenses/'LearnHarness-AGPL-3.0.txt')
assets=root/'android/app/src/main/assets';assets.mkdir(parents=True,exist_ok=True)
archive=assets/'server.zip';count=0;size=0
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for p in sorted(server.rglob('*')):
        if not p.is_file():continue
        rel=p.relative_to(server)
        if rel.parts[0] in {'android','data','dist','.git','.runtime-cache'}:raise RuntimeError('Unexpected build/private payload '+str(rel))
        if p.name in {'auth.json','learnharness-sync-auth.json','document-grants.json','.env','.env.local','chatgpt-credentials.json','github-copilot-credentials.json','xai-credentials.json'}:raise RuntimeError('Private state in server payload '+str(rel))
        if p.suffix.lower() in {'.node','.dll','.exe','.pdb'}:continue
        z.write(p,rel.as_posix());count+=1;size+=p.stat().st_size
    z.writestr('ANDROID-PORT.json',json.dumps({'upstreamVersion':'0.4.1','customVersion':json.loads((root/'package.json').read_text(encoding='utf-8'))['version'],'sharedSource':True,'headless':'Android native adapter','features':['progress-sync','linked-markdown','subject-folders','android-usability']}))
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    assert any(n.endswith('providers/data/amazon-bedrock.json') for n in z.namelist()),'Provider runtime data missing'
digest=hashlib.sha256(archive.read_bytes()).hexdigest();(assets/'server.sha256').write_text(digest+'\n')
print(json.dumps({'files':count,'uncompressedBytes':size,'zipBytes':archive.stat().st_size,'sha256':digest}))
