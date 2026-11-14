// Independent raw-byte fixtures recovered from PR24 a40a8655d656c2ffa8d75d90bdf99f700e1a90c3,
// test/packed-carrier-archive.test.mjs blob8bf787dcabe3d68e815787d577d154a22de6cdca.
// No tar, fixture extraction, npm, filesystem, subprocess or acquisition effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectPackedCarrierArchive } from '../scripts/packed-carrier-archive.mjs';
const BLOCK = 512;
const limits = { members: 100, bytes: 65536, tarBytes: 131072, metadataBytes: 16384 };
const hash = body => createHash('sha256').update(body).digest('hex');
function checksum(header) {
  header.fill(32, 148, 156);
  header.write(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
}
function tarMember(path, body = '', type = '0', edit = () => {}) {
  const data = Buffer.from(body), header = Buffer.alloc(BLOCK);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii'); header.write('0000000\0', 116, 8, 'ascii');
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write(type, 156, 1, 'ascii'); header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
  edit(header); checksum(header);
  return Buffer.concat([header, data, Buffer.alloc((BLOCK - data.length % BLOCK) % BLOCK)]);
}
function paxRecord(key, value) {
  const suffix = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(suffix) + 1;
  while (String(length).length + Buffer.byteLength(suffix) !== length) length = String(length).length + Buffer.byteLength(suffix);
  return `${length}${suffix}`;
}
const manifest = () => tarMember('package/package.json', '{}');
const archive = (...parts) => Buffer.concat([...parts, Buffer.alloc(1024)]);
const inspect = (bytes, override = {}) => inspectPackedCarrierArchive(bytes, { ...limits, ...override });
const rejects = (bytes, code = 'artifact-member-receiving-refused', reason, override) => assert.throws(() => inspect(bytes, override), error => {
  assert.equal(error.code, code); assert.ok(error instanceof TypeError);
  if (reason) assert.equal(error.reason, reason);
  return true;
});
const NAMES = Array.from({ length: 25 }, (_, i) => 'dist/fixture-' + String(i).padStart(2, '0') + '.mjs');
for (const name of NAMES) {
  test('duplicate npm tar member refuses: ' + name, () => rejects(archive(manifest(), tarMember('package/' + name, 'x'), tarMember('package/' + name, 'y')), undefined, 'conflict'));
  test('ordinary npm member exact bytes: ' + name, () => {
    const result = inspect(archive(manifest(), tarMember('package/' + name, 'x')));
    assert.deepEqual(result.members, [
      { path: 'package.json', kind: 'file', bytes: 2, sha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', mode: 420 },
      { path: name, kind: 'file', bytes: 1, sha256: '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881', mode: 420 }
    ]);
    assert.equal(result.manifestText, '{}'); assert.equal(result.parserEndOffset, 3072); assert.equal(result.accountedEndOffset, 3072);
    assert.deepEqual(result.headers[1], { path: 'package/' + name, type: 'File', mode: 420, size: 1 });
  });
}
for (const type of ['1', '2', '3', '4', '6', '7', 'S']) test('special type refuses ' + type, () => rejects(archive(manifest(), tarMember('package/a', '', type)), undefined, 'type'));
for (const type of ['g', 'L', 'K']) test('extension type refuses ' + type, () => rejects(archive(manifest(), tarMember('package/a', '', type)), 'unread-archive-extension', 'extension'));
for (const path of ['../escape', 'package/../escape', 'package/dist/../../escape', 'package/dist\\escape', 'package/dist//escape', 'package/dist/./escape', 'package/dist/escape\nfoo', '/package/a', 'package/'])
  test('unsafe path refuses ' + JSON.stringify(path), () => rejects(archive(manifest(), tarMember(path, 'x'))));
for (const type of ['x', 'X']) test('local PAX ' + type + ' preserves Unicode long path effective size and timestamp keys', () => {
  const name = 'package/' + '日本'.repeat(50) + '.mjs';
  const payload = [['path', name], ['size', '1'], ['mtime', '1.5'], ['atime', ''], ['ctime', '-1']].map(([k,v]) => paxRecord(k,v)).join('');
  const member = tarMember('placeholder', 'x', '0', h => h.write('00000000000\0',124,12));
  const result = inspect(archive(manifest(), tarMember('PaxHeader', payload, type), member));
  assert.equal(result.members[1].path, name.slice(8)); assert.equal(result.members[1].bytes, 1);
  assert.equal(result.members[1].sha256, '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
  assert.equal(result.headers[1].path, name); assert.equal(result.accountedEndOffset, 4096); assert.equal(result.parserEndOffset,4096);
});
for (const [label, payload] of [ ['unknown',paxRecord('path','package/a')+paxRecord('uid','1')], ['duplicate',paxRecord('path','package/a').repeat(2)], ['missing-path',paxRecord('size','1')], ['empty-path',paxRecord('path','')], ['bad-size',paxRecord('path','package/a')+paxRecord('size','01')], ['unsafe-size',paxRecord('path','package/a')+paxRecord('size','9007199254740992')], ['zero-record','0 path=x\n'], ['unterminated','10 path=x!'] ])
 test('PAX grammar refuses ' + label, () => rejects(archive(manifest(), tarMember('PaxHeader',payload,'x'),tarMember('package/a','x')), 'unread-archive-extension','extension'));
test('stacked and orphan PAX refuse', () => {
 const p=tarMember('PaxHeader',paxRecord('path','package/a'),'x');
 rejects(archive(manifest(),p,p,tarMember('package/a')), 'unread-archive-extension','extension');
 rejects(archive(manifest(),p), 'unread-archive-extension','extension');
});
test('PAX override never frames intermediary extension', () => {
 const p=tarMember('PaxHeader',paxRecord('path','package/a')+paxRecord('size','0'),'x');
 rejects(archive(manifest(),p,tarMember('PaxHeader','x','L')), 'unread-archive-extension','extension');
});
test('canonical155 prefix and old NUL regular type are retained', () => {
 const prefix='package/'+ 'a'.repeat(140);
 const result=inspect(archive(manifest(),tarMember('b','x','\0',h=>h.write(prefix,345,155))));
 assert.equal(result.members[1].path,'a'.repeat(140)+'/b'); assert.equal(result.headers[1].type,'File');
});
for (const [label,edit] of [ ['blank-magic',h=>h.fill(0,257,265)], ['old-GNU',h=>h.write('ustar  \0',257,8)], ['version',h=>h.write('01',263,2)], ['reserved',h=>h[500]=1], ['name-NUL-tail',h=>h[99]=1], ['star-times',h=>h.write('00000000001\0',476,12)], ['linkname',h=>h[157]=120], ['partial-octal',h=>h.write('0000644x',100,8)], ['negative-size',h=>h.fill(255,124,136)], ['binary-lead',h=>h[124]=129] ])
 test('noncanonical field refuses ' + label, () => rejects(archive(manifest(),tarMember('package/a','x','0',edit))));
test('safe positive base256 mode and size preserve exact values', () => {
 const result=inspect(archive(manifest(),tarMember('package/a','x','0',h=>{h.fill(0,100,108);h[100]=128;h[106]=1;h[107]=237;h.fill(0,124,136);h[124]=128;h[135]=1;})));
 assert.equal(result.members[1].mode,493);assert.equal(result.members[1].bytes,1);
});
for (const mode of [512,4095,4294967296,4294967716,Number.MAX_SAFE_INTEGER])
 test('raw mode rejects upper bits '+mode,()=> rejects(archive(manifest(),tarMember('package/a','x','0',h=>{h.fill(0,100,108);h[100]=128;let n=BigInt(mode);for(let i=107;i>100;i--){h[i]=Number(n&255n);n>>=8n;}})),undefined,'mode'));
test('binary overflow refuses before conversion',()=>rejects(archive(manifest(),tarMember('package/a','x','0',h=>{h.fill(255,124,136);h[124]=128;})),undefined,'number'));
test('blank ancillary and negative inert mtime accepted',()=>{const result=inspect(archive(manifest(),tarMember('package/a','x','0',h=>{h.fill(0,108,124);h.fill(255,136,148);})));assert.equal(result.members[1].path,'a');});
test('package root directory nested package and slash coercion preserve types',()=>{
 const result=inspect(archive(tarMember('package/','','5'),manifest(),tarMember('package/dir/','','0'),tarMember('package/package/real','x')));
 assert.deepEqual(result.headers.map(h=>h.type),['Directory','File','Directory','File']);assert.equal(result.members[1].path,'package/real');assert.equal(result.accountedEndOffset,4096);
});
for(const type of ['0','5'])test('nonzero raw directory size refuses '+type,()=>rejects(archive(manifest(),tarMember('package/dir/','x',type)),undefined,'number'));
test('directory PAX cannot erase nonzero raw size',()=>rejects(archive(manifest(),tarMember('PaxHeader',paxRecord('path','package/d/')+paxRecord('size','0'),'x'),tarMember('package/d','x','5')),undefined,'number'));
test('file parent conflicts refuse in both orders',()=>{
 for(const parts of [[tarMember('package/a','x'),tarMember('package/a/b','y')],[tarMember('package/a/b','y'),tarMember('package/a','x')]])rejects(archive(manifest(),...parts),undefined,'conflict');
});
test('BOM preserved in manifest and literal member names',()=>{
 const result=inspect(archive(tarMember('package/package.json','\ufeff{}'),tarMember('package/\ufeffname','x')));
 assert.equal(result.manifestText,'\ufeff{}');assert.equal(result.members[0].bytes,5);assert.equal(result.members[0].sha256,hash(Buffer.from('\ufeff{}')));assert.equal(result.members[1].path,'\ufeffname');
});
test('malformed UTF8 and replacement names refuse losslessly',()=>{
 rejects(archive(manifest(),tarMember('package/a','x','0',h=>h[8]=255)),'unread-archive-name-encoding','encoding');
 rejects(archive(manifest(),tarMember('package/\ufffd','x')),'unread-archive-name-encoding','encoding');
 rejects(archive(manifest(),tarMember('PaxHeader',Buffer.from([255]),'x')),'unread-archive-name-encoding','encoding');
 assert.throws(()=>inspect(archive(tarMember('package/package.json',Buffer.from([255])))),e=>e.code==='ERR_ENCODING_INVALID_ENCODED_DATA' && e.reason===undefined);
});
test('checksum truncation EOF tail and absent manifest refuse',()=>{
 const corrupted=manifest();corrupted[0]^=1;rejects(archive(corrupted),undefined,'checksum');
 rejects(archive(manifest()).subarray(0,-1),undefined,'truncated');
 rejects(archive(manifest()).subarray(0,-512),undefined,'eof');
 rejects(Buffer.concat([manifest().subarray(0,512),Buffer.alloc(0)]),undefined,'truncated');
 rejects(Buffer.concat([archive(manifest()),Buffer.alloc(512,1)]),undefined,'tail');
 rejects(archive(tarMember('package/a','x')),undefined,'manifest');
});
test('arbitrary body padding and zero trailing blocks remain digest-neutral members',()=>{
 const part=manifest();part[1023]=9;const result=inspect(Buffer.concat([archive(part),Buffer.alloc(512)]));assert.equal(result.parserEndOffset,2048);assert.equal(result.members[0].sha256,'44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
});
test('member payload expanded and metadata bounds include exact boundary',()=>{
 const bytes=archive(manifest());assert.equal(inspect(bytes,{members:1,bytes:2,tarBytes:2048}).members.length,1);
 rejects(archive(manifest(),tarMember('package/d','','5')),undefined,'limit',{members:1});rejects(bytes,undefined,'limit',{bytes:1});rejects(bytes,undefined,'limit',{tarBytes:2047});
 const payload=paxRecord('path','package/a'),p=archive(manifest(),tarMember('PaxHeader',payload,'x'),tarMember('placeholder','x'));
 assert.equal(inspect(p,{metadataBytes:Buffer.byteLength(payload)}).members[1].path,'a');rejects(p,undefined,'limit',{metadataBytes:Buffer.byteLength(payload)-1});
});

test('exact permission boundary modes0000 and0777 remain unchanged',()=>{
 for(const mode of [0,0o777]){
  const result=inspect(archive(manifest(),tarMember('package/a','x','0',h=>h.write(mode.toString(8).padStart(7,'0')+'\0',100,8))));
  assert.equal(result.members[1].mode,mode);assert.equal(result.headers[1].mode,mode);
 }
});
test('full-width155-byte USTAR prefix is received without truncation',()=>{
 const prefix='package/'+'a'.repeat(147);assert.equal(Buffer.byteLength(prefix),155);
 const result=inspect(archive(manifest(),tarMember('leaf','x','0',h=>h.write(prefix,345,155))));
 assert.equal(result.members[1].path,'a'.repeat(147)+'/leaf');assert.equal(result.headers[1].path,prefix+'/leaf');
});
test('PAX paths beyond4095 bytes preserve deep names and parent-conflict refusal',()=>{
 const name='package/'+'a/'.repeat(2100)+'leaf';assert.ok(Buffer.byteLength(name)>4095);
 const named=(path,body)=>[tarMember('PaxHeader',paxRecord('path',path),'x'),tarMember('placeholder',body)];
 const result=inspect(archive(manifest(),...named(name,'x')));assert.equal(result.members[1].path,name.slice(8));
 for(const parts of [[...named(name,'x'),...named(name+'/child','y')],[...named(name+'/child','y'),...named(name,'x')]])
  rejects(archive(manifest(),...parts),undefined,'conflict');
});
test('PAX effective size crosses512-byte framing boundary independently of raw size',()=>{
 const body='x'.repeat(513),pax=tarMember('PaxHeader',paxRecord('path','package/cross')+paxRecord('size','513'),'x');
 const member=tarMember('placeholder',body,'0',h=>h.write('00000000000\0',124,12));
 const result=inspect(archive(manifest(),pax,member));
 assert.equal(result.members[1].bytes,513);assert.equal(result.members[1].sha256,hash(body));
 assert.equal(result.headers[1].size,513);assert.equal(result.parserEndOffset,4608);assert.equal(result.accountedEndOffset,4608);
});

