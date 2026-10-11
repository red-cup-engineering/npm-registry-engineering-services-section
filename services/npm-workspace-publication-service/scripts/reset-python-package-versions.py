#!/usr/bin/env python3
"""Python descriptor binding for an explicitly selected owned package family.

No dependency installation or inference. TOML supplies identity; edits retain
comments and unrelated text. Backups and byte preconditions permit safe retries.
"""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import time
import tomllib

def version_map(values):
    minor=max([0,*[int(v.split('.')[1]) for v in values if re.match(r'^0\.\d+\.',v)]])
    result={};identities={}
    for value in sorted(values):
        if not re.match(r'^[1-9]\d*\.',value):continue
        release,separator,local=value.partition('+')
        normalized='.'.join(str(int(v)) for v in release.split('.'))+(separator+re.sub(r'[-_]+','.',local).lower() if separator else '')
        if normalized not in identities:minor+=1;identities[normalized]=f'0.{minor}.0'
        result[value]=identities[normalized]
    return result

def transform(text, mappings):
    parsed = tomllib.loads(text)
    project = parsed.get('project', parsed.get('tool', {}).get('poetry', {}))
    selected = mappings.get(project.get('name'), {}).get(project.get('version'))
    if selected:
        section = 'project' if 'project' in parsed else 'tool.poetry'
        pattern = r'(?ms)(^\[' + re.escape(section) + r'\]\s*\n)(.*?)(?=^\[|\Z)'
        def block(match):
            body, count = re.subn(r'(?m)^(\s*version\s*=\s*)([\"\x27])[^\"\x27]+\2', lambda m: m[1]+m[2]+selected+m[2], match[2])
            if count != 1: raise ValueError('expected one project version')
            return match[1]+body
        text, count = re.subn(pattern, block, text)
        if count != 1: raise ValueError('project table not found')
    # uv.lock package tables and exact requirements refer to the same identity.
    def lock_block(match):
        body = match[0]
        record = tomllib.loads(body).get('package', [{}])[0]
        target = mappings.get(record.get('name'), {}).get(record.get('version'))
        if target:
            body = re.sub(r'(?m)^(version\s*=\s*)([\"\x27])[^\"\x27]+\2', lambda m:m[1]+m[2]+target+m[2], body, count=1)
        return body
    text = re.sub(r'(?ms)^\[\[package\]\].*?(?=^\[\[package\]\]|\Z)', lock_block, text)
    for name, versions in mappings.items():
        for old, new in versions.items():
            text = re.sub(r'(?<![\w-])('+re.escape(name)+r'(?:\[[^\]]+\])?\s*(?:==|===)\s*)'+re.escape(old)+r'(?=[\"\x27;,\s]|$)', lambda m:m[1]+new, text)
    tomllib.loads(text)
    return text

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',required=True);parser.add_argument('--names',required=True)
    parser.add_argument('--backup');parser.add_argument('--apply',action='store_true')
    args=parser.parse_args();started=time.monotonic();root=pathlib.Path(args.root).resolve();names=set(args.names.split(','))
    if args.apply and not args.backup:parser.error('--apply requires --backup')
    command=['rg','--files','--hidden','-g','pyproject.toml','-g','uv.lock','-g','!**/node_modules/**','-g','!.git/**','-g','!.tmp/**','-g','!**/.venv/**']
    paths=subprocess.check_output(command,cwd=root,text=True).splitlines();carriers=[];versions={name:set() for name in names}
    for path in paths:
        original=(root/path).read_bytes();text=original.decode();parsed=tomllib.loads(text)
        project=parsed.get('project',parsed.get('tool',{}).get('poetry',{}))
        for record in [project,*parsed.get('package',[])]:
            if record.get('name') in names and isinstance(record.get('version'),str):versions[record['name']].add(record['version'])
        carriers.append((path,original,text))
    mappings={}
    for name, values in versions.items():
        mappings[name]=version_map(values)
    writes=[]
    for path,before,text in carriers:
        after=transform(text,mappings).encode()
        if before==after:continue
        if args.apply:
            backup=pathlib.Path(args.backup)/path;backup.parent.mkdir(parents=True,exist_ok=True)
            try:
                with backup.open('xb') as file:file.write(before)
            except FileExistsError:pass
            target=root/path
            if target.read_bytes()!=before:raise ValueError('concurrent descriptor edit: '+path)
            temporary=target.with_name(target.name+'.version-reset.tmp');temporary.write_bytes(after);temporary.replace(target)
        writes.append({'path':path,'before':hashlib.sha256(before).hexdigest(),'after':hashlib.sha256(after).hexdigest()})
    result={'mappings':mappings,'writes':writes,'metrics':{'changedFiles':len(writes),'applied':args.apply,'elapsedMs':round(1000*(time.monotonic()-started))}}
    if args.apply:
        (pathlib.Path(args.backup)/'python-result.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result if not args.apply else result['metrics']))

if __name__=='__main__':main()
