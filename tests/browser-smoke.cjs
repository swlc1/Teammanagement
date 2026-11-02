const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES,'playwright') : 'playwright');
const root=path.resolve(__dirname,'..');
const fake=`
const records=new Map([['users/admin-uid',{name:'테스트 관리자',email:'admin@example.org',enabled:true,role:'admin'}],['users/member-uid',{name:'테스트 팀원',email:'member@example.org',enabled:true,role:'member',memberId:'u1'}]]);
const listeners=new Set(),authListeners=new Set();let sequence=0;
const authentication={currentUser:null};const secondary=new Map(),authUsers=new Map();
export const browserSessionPersistence={};export const inMemoryPersistence={};
export const initializeApp=(config,name)=>({name:name||"default"});export const getAuth=app=>{if(!app||app.name==="default")return authentication;if(!secondary.has(app.name))secondary.set(app.name,{currentUser:null});return secondary.get(app.name);};export const deleteApp=async app=>secondary.delete(app.name);
export const getFirestore=()=>({});export const getStorage=()=>({});
export const setPersistence=async(auth,persistence)=>{auth.persistence=persistence;};
export const doc=(db,c,id)=>({key:c+'/'+id});
export const collection=(db,c)=>({collection:c});
export const query=(ref,...constraints)=>({...ref,constraints});
export const serverTimestamp=()=>new Date().toISOString();
const snap=(key)=>({id:key.split('/')[1],exists:()=>records.has(key),data:()=>structuredClone(records.get(key))});
export const getDocFromServer=async(ref)=>snap(ref.key);
function notify(){for(const callback of listeners)callback();}
export function onSnapshot(ref,options,next,error){
 if(typeof options==='function'){error=next;next=options;}
 let previous=new Set(),first=true;
 const fire=()=>{try{if(ref.key){next(snap(ref.key));return;}const keys=[...records.keys()].filter(k=>k.startsWith(ref.collection+'/'));const docs=keys.map(k=>snap(k));const changes=keys.map(k=>({type:previous.has(k)?'modified':'added',doc:snap(k)}));for(const key of previous)if(!keys.includes(key))changes.push({type:'removed',doc:{id:key.split('/')[1]}});previous=new Set(keys);const cacheFirst=first&&window.__mock?.cacheFirst;first=false;if(cacheFirst)next({docs,metadata:{fromCache:true,hasPendingWrites:false},docChanges:()=>changes});next({docs,metadata:{fromCache:false,hasPendingWrites:false},docChanges:()=>cacheFirst?[]:changes});}catch(e){error?.(e);}};
 listeners.add(fire);queueMicrotask(fire);return()=>listeners.delete(fire);
}
export const runTransaction=async(db,body)=>{const writes=[];const tx={get:async ref=>snap(ref.key),set:(ref,value)=>writes.push([ref.key,value]),delete:ref=>writes.push([ref.key,null])};await body(tx);for(const [key,value]of writes){if(value===null)records.delete(key);else records.set(key,structuredClone(value));}notify();};
export const setDoc=async(ref,data)=>{if(window.__mock.failProfileWrite&&ref.key.startsWith("users/created-"))throw {code:"permission-denied"};records.set(ref.key,{...records.get(ref.key),...data});notify();};
export const updateDoc=setDoc;
export const signInWithEmailAndPassword=async(auth,email,password)=>{if(password!=='test-password')throw {code:'auth/invalid-credential'};const uid=email==='admin@example.org'?'admin-uid':'member-uid';auth.currentUser={uid,email};for(const cb of authListeners)cb(auth.currentUser);return {user:auth.currentUser};};
export const signOut=async(auth)=>{auth.currentUser=null;if(auth===authentication)for(const cb of authListeners)cb(null);};
export const createUserWithEmailAndPassword=async(auth,email,password)=>{if(authUsers.has(email))throw {code:"auth/email-already-in-use"};const user={uid:"created-"+(++sequence),email};authUsers.set(email,user);auth.currentUser=user;return {user};};
export const deleteUser=async user=>authUsers.delete(user.email);
export const onAuthStateChanged=(auth,cb)=>{authListeners.add(cb);queueMicrotask(()=>cb(auth.currentUser));return()=>authListeners.delete(cb);};
export const sendPasswordResetEmail=async()=>{};
export const ref=(storage,key)=>({key});export const uploadBytes=async()=>{};export const getDownloadURL=async(ref)=>'https://example.org/'+ref.key;export const getBlob=async()=>new Blob(['test']);
window.__mock={records,notify,authUsers,secondary,put:(key,value)=>{records.set(key,{version:'remote-'+(++sequence),value});notify();}};
`;
const server=http.createServer((req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','*');
 if(req.url==='/__sdk.js'){res.setHeader('Content-Type','text/javascript');return res.end(fake);}
 const file=path.join(root,req.url==='/'?'index.html':req.url.split('?')[0]);
 if(!file.startsWith(root)||!fs.existsSync(file)){res.statusCode=404;return res.end();}
 res.setHeader('Content-Type',file.endsWith('.html')?'text/html':'text/javascript');res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try {
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://www.gstatic.com/firebasejs/**',route=>route.fulfill({contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:'export * from "http://127.0.0.1:'+port+'/__sdk.js";'}));
  await page.route('https://fonts.**',route=>route.abort());
  await page.goto('http://127.0.0.1:'+port+'/');
  await page.waitForFunction(()=>document.querySelector('#loginId').type==='email');
  assert.equal(await page.evaluate(()=>db.tasks.length),0);
  await page.fill('#loginId','admin@example.org');await page.fill('#loginPw','wrong');await page.click('#loginForm [type=submit]');
  await page.waitForFunction(()=>document.querySelector('#loginError').textContent.includes('확인해주세요'));
  assert.equal(await page.locator('#loginScreen').isVisible(),true);
  await page.fill('#loginPw','test-password');await page.click('#loginForm [type=submit]');
  await page.waitForFunction(()=>document.querySelector('#loginScreen').style.display==='none');
  await page.waitForFunction(()=>document.querySelector('#firebaseStatus').textContent.includes('서버 저장 완료'));
  assert.equal(await page.evaluate(()=>db.tasks.length),0,'no demo data auto-uploaded');
  assert.equal(await page.evaluate(()=>[...window.__mock.records.keys()].filter(k=>k.startsWith('settings/')).length),0);
  await page.evaluate(()=>{db.members.push({id:'u1',name:'테스트 팀원',role:'팀원',rank:'연구원'});db.tasks.push({id:'t1',title:'공유 업무',assignee:'u1',projectId:null,status:'진행중',priority:'보통',progress:0,start:TODAY,due:TODAY});save();});
  await page.waitForFunction(()=>window.__mock.records.has('tasks/t1'));
  await page.evaluate(()=>go('tasks'));
  assert.ok((await page.locator('body').innerText()).includes('공유 업무'));
  await page.evaluate(()=>{const record=window.__mock.records.get('tasks/t1');window.__mock.put('tasks/t1',{...record.value,title:'다른 PC에서 수정'});});
  await page.waitForFunction(()=>db.tasks.some(t=>t.title==='다른 PC에서 수정'));
  await page.evaluate(()=>go('settings'));
  assert.ok((await page.locator('body').innerText()).includes('관리자가 팀원 계정을 생성'));
  await page.evaluate(()=>openAccountEditor('','u1'));
  await page.waitForSelector('#firebasePassword');assert.equal(await page.locator('#firebaseUid').count(),0);await page.evaluate(()=>closeModal());
  await page.evaluate(()=>logout());await page.waitForFunction(()=>currentUser===null);
  assert.equal(await page.evaluate(()=>db.tasks.length),0,'logout clears server data from memory');
  await page.fill('#loginId','member@example.org');await page.fill('#loginPw','test-password');await page.click('#loginForm [type=submit]');
  await page.waitForFunction(()=>document.querySelector('#loginScreen').style.display==='none');
  assert.equal(await page.evaluate(()=>currentUser.role),'member');
  assert.equal(await page.evaluate(()=>db.counseling.length),0);
  assert.equal(await page.evaluate(()=>canPage('settings')),false);
  assert.ok((await page.locator('body').innerText()).includes('다른 PC에서 수정'));
  assert.deepEqual(errors,[]);
  console.log('PASS: Firebase UI initialization, invalid login, admin login, empty DB, defaults, item write, remote update, settings, UID linking, logout cleanup, member login.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
