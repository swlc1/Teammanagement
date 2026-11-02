const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {webcrypto}=require('node:crypto');
const root=path.resolve(__dirname,'..');
function element(){
  return {style:{},dataset:{},value:'',textContent:'',innerHTML:'',children:[],childNodes:[],classList:{add(){},remove(){},toggle(){},contains(){return false;}},setAttribute(){},appendChild(el){this.children.push(el);return el;},replaceChildren(){this.children=[];},querySelector(){return element();},querySelectorAll(){return [];},closest(){return null;},remove(){},focus(){},click(){},addEventListener(){}};
}
async function fixture(){
  const nodes=new Map();const get=s=>{if(!nodes.has(s))nodes.set(s,element());return nodes.get(s);};
  const document={readyState:'complete',body:element(),documentElement:element(),querySelector:get,querySelectorAll:()=>[],getElementById:id=>get('#'+id),createElement:element,addEventListener(){}};
  const storage=new Map();
  const context=vm.createContext({document,console,Intl,Date,TextEncoder,Uint8Array,ArrayBuffer,URL,Blob,crypto:webcrypto,structuredClone,setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,confirm:()=>true,location:{protocol:'http:'},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},matchMedia:()=>({matches:false}),addEventListener(){}});
  vm.runInContext('window=globalThis;',context);
  const fake=fs.readFileSync(path.join(__dirname,'browser-smoke.cjs'),'utf8').split('const fake=`')[1].split('`;\nconst server=')[0];
  const names=[...fake.matchAll(/export (?:const|function) (\w+)/g)].map(m=>m[1]);
  const sdk=vm.runInContext('(function(){'+fake.replaceAll('export ','')+';return {'+names.join(',')+'};})()',context);
  context.__loadSdk=async()=>sdk;
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const script=html.slice(html.indexOf('<script>/*')+8,html.lastIndexOf('</script>\n<script src="sync-engine.js"'));
  vm.runInContext(script,context);
  vm.runInContext(`let rendered='';render=function(){if(!currentUser)return;rendered=(renderers[state.page]||renderers.home)();};renderNav=function(){};updateSessionUI=function(){};`,context);
  vm.runInContext(fs.readFileSync(path.join(root,'sync-engine.js'),'utf8'),context);
  await vm.runInContext(fs.readFileSync(path.join(root,'firebase-backend.js'),'utf8').replaceAll('import(','__loadSdk('),context);
  const run=source=>vm.runInContext(source,context);
  return {run,sdk,context,get};
}
test('adapter uses Firebase authentication, starts empty, saves records and renders remote updates',async()=>{
  const {run,get}=await fixture();
  assert.equal(run('db.tasks.length'),0);
  await assert.rejects(run("login('admin@example.org','wrong')"));
  assert.equal(run('currentUser'),null);
  await run("login('admin@example.org','test-password')");
  assert.equal(run('currentUser.role'),'admin');
  assert.equal(get('#loginScreen').style.display,'none');
  assert.equal(run('db.tasks.length'),0);
  assert.equal(run("[...__mock.records.keys()].filter(k=>k.startsWith('settings/')).length"),4);
  run("Object.entries(renderers).forEach(([page,view])=>{if(canPage(page)){state.page=page;view();}});state.page='home';");
  run("db.members.push({id:'u1',name:'테스트 팀원',role:'팀원',rank:'연구원'});db.tasks.push({id:'t1',title:'공유 업무',assignee:'u1',status:'진행중',progress:0,start:TODAY,due:TODAY,priority:'보통'});save();");
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(run("__mock.records.get('tasks/t1').value.title"),'공유 업무');
  run("state.page='tasks';render();");assert.ok(run('rendered').includes('공유 업무'));
  run("__mock.put('tasks/t1',{...__mock.records.get('tasks/t1').value,title:'원격 수정'});");
  assert.equal(run('db.tasks[0].title'),'원격 수정');assert.ok(run('rendered').includes('원격 수정'));
  run("state.page='settings';render();");assert.ok(run('rendered').includes('Firebase 계정'));
  await run('logout()');assert.equal(run('currentUser'),null);assert.equal(run('db.tasks.length'),0);
  await run("login('member@example.org','test-password')");
  assert.equal(run('currentUser.role'),'member');assert.equal(run("canPage('settings')"),false);
  assert.equal(run('db.counseling.length'),0);assert.equal(run('db.tasks[0].title'),'원격 수정');
  await run('logout()');
});
test('missing profile fails closed without exposing dashboard data',async()=>{
  const {run,get}=await fixture();run("__mock.records.delete('users/member-uid')");
  await assert.rejects(run("login('member@example.org','test-password')"));
  assert.equal(run('currentUser'),null);assert.equal(get('#loginScreen').style.display,'grid');
  assert.equal(run('db.tasks.length'),0);
});
