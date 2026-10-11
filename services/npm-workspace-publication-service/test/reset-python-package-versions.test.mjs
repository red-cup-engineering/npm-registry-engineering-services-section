import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
test('Python versions share normalized identities and preserve TOML comments and third-party requirements',()=>{
 execFileSync('python3',['-c',`
import runpy
m=runpy.run_path('scripts/reset-python-package-versions.py')
mapping=m['version_map']({'2026.05.11','2026.5.11','0.1.0'})
assert mapping['2026.05.11']==mapping['2026.5.11']=='0.2.0'
text='[project]\\nname = "house"\\nversion = "2026.05.11" # keep\\ndependencies = ["requests==2.0.0"]\\n'
out=m['transform'](text,{'house':mapping})
assert '"0.2.0" # keep' in out and 'requests==2.0.0' in out
lock='version = 1\\n[[package]]\\nname = "house"\\nversion = "2026.5.11"\\n[[package]]\\nname = "requests"\\nversion = "2.0.0"\\n'
out=m['transform'](lock,{'house':mapping})
assert 'version = "0.2.0"' in out and 'version = "2.0.0"' in out
assert m['transform'](out,{'house':mapping})==out
`],{stdio:'pipe',cwd:packageRoot});
});
