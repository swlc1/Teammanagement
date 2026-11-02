const {test} = require('node:test');
const assert = require('node:assert/strict');
const Sync = require('../sync-engine.js');
function fixture() {
  const store = new Map(); let calls=0;
  const sync = new Sync(async(key,value,base)=>{
    if ((store.get(key)?.version??null)!==base) throw new Error('CONFLICT');
    const version='v'+(++calls);
    if(value===null)store.delete(key);else store.set(key,{version,value});
    return value===null?null:version;
  });
  const put=(key,value,version='v0')=>{store.set(key,{value,version});sync.receive(key,{value,version});};
  return {sync,store,put,calls:()=>calls};
}
test('editing one task does not rewrite unrelated remote records',async()=>{
  const {sync,store,put,calls}=fixture();put('tasks/a',{id:'a',title:'old'});put('tasks/b',{id:'b',title:'other'});
  const next=sync.view();next.set('tasks/a',{id:'a',title:'new'});sync.stage(next);await sync.flush();
  assert.equal(calls(),1);assert.equal(store.get('tasks/b').version,'v0');assert.equal(sync.pending.size,0);
});
test('a concurrent remote edit is rejected and the local draft survives',async()=>{
  const {sync,store,put}=fixture();put('tasks/a',{id:'a',title:'old'});
  const next=sync.view();next.set('tasks/a',{id:'a',title:'mine'});sync.stage(next);
  store.set('tasks/a',{version:'remote',value:{id:'a',title:'theirs'}});
  sync.receive('tasks/a',store.get('tasks/a'));
  await assert.rejects(sync.flush(),/CONFLICT/);
  assert.equal(store.get('tasks/a').value.title,'theirs');assert.equal(sync.view().get('tasks/a').title,'mine');
  sync.discard();assert.equal(sync.view().get('tasks/a').title,'theirs');
});
test('a remote snapshot leaves pending local edits intact',()=>{
  const {sync,put}=fixture();put('tasks/a',{id:'a',title:'old'});
  const next=sync.view();next.set('tasks/a',{id:'a',title:'mine'});sync.stage(next);
  put('tasks/b',{id:'b',title:'new remote'},'v1');
  assert.equal(sync.view().get('tasks/a').title,'mine');assert.equal(sync.view().get('tasks/b').title,'new remote');
});
test('edits arriving during an in-flight save are committed against the new version',async()=>{
  let release;const gate=new Promise(r=>release=r);const saved=[];
  const sync=new Sync(async(key,value,base)=>{if(!saved.length)await gate;saved.push({value,base});return 'v'+saved.length;});
  sync.receive('tasks/a',{version:'v0',value:{id:'a',title:'old'}});
  sync.stage(new Map([['tasks/a',{id:'a',title:'first'}]]));const flushing=sync.flush();
  sync.stage(new Map([['tasks/a',{id:'a',title:'second'}]]));release();await flushing;
  assert.deepEqual(saved.map(s=>s.base),['v0','v1']);assert.equal(saved[1].value.title,'second');assert.equal(sync.pending.size,0);
});
test('failed network writes can be retried without dropping the draft',async()=>{
  let online=false;const sync=new Sync(async()=>{if(!online)throw new Error('offline');return 'v1';});
  sync.stage(new Map([['tasks/a',{id:'a'}]]));await assert.rejects(sync.flush(),/offline/);assert.equal(sync.pending.size,1);
  online=true;await sync.flush();assert.equal(sync.pending.size,0);assert.equal(sync.error,null);
});
test('deletion uses optimistic concurrency and never deletes a changed record',async()=>{
  const {sync,store,put}=fixture();put('tasks/a',{id:'a'});sync.stage(new Map());
  store.set('tasks/a',{version:'v2',value:{id:'a',title:'remote'}});
  await assert.rejects(sync.flush(),/CONFLICT/);assert.equal(store.has('tasks/a'),true);
});
test('closing a session blocks new writes and skips remaining queued operations',async()=>{
  let release;const gate=new Promise(r=>release=r);let calls=0;
  const sync=new Sync(async()=>{calls++;await gate;return 'v1';});
  sync.stage(new Map([['tasks/a',{id:'a'}],['tasks/b',{id:'b'}]]));const flushing=sync.flush();
  sync.close();assert.throws(()=>sync.stage(new Map()),/SYNC_CLOSED/);release();await flushing;assert.equal(calls,1);
});
