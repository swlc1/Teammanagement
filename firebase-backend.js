/* Firebase adapter for the existing dashboard. No privileged credentials belong here. */
(async function () {
  'use strict';
  const config = {
    apiKey: 'AIzaSyC0JeHDNbM8ABcH3axe-nVHBvTi4SvLTbY',
    authDomain: 'teammanagement-1a1f2.firebaseapp.com',
    projectId: 'teammanagement-1a1f2',
    storageBucket: 'teammanagement-1a1f2.firebasestorage.app',
    messagingSenderId: '596969395876',
    appId: '1:596969395876:web:adb4a52f170ead225cb831'
  };
  const cdn = 'https://www.gstatic.com/firebasejs/13.1.0/';
  const oldToast = toast;
  const arrays = ['members','projects','tasks','schedules','meetings','kpis','leave','education','documents','monthlyWork','counseling','auditLogs','accountLogs'];
  const settings = ['platformName','menuConfig','memberOrder','memberMenuPermissions'];
  const menus = {members:'team',projects:'projects',tasks:'tasks',schedules:'calendar',meetings:'meetings',kpis:'performance',leave:'leave',education:'education',documents:'documents',monthlyWork:'reports',counseling:'counseling'};
  let sdk, auth, firestore, storage, engine, userProfile, busy = false, ready = false;
  let unsubscribers = [], lastSettings = '', initializing = false, explicitLogin = false;
  const clone = v => JSON.parse(JSON.stringify(v));
  const localBackup = safeStorageGet('tmd-db');
  const status = document.createElement('div');
  status.id = 'firebaseStatus'; status.setAttribute('role','status');
  status.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:5000;background:#102c46;color:white;padding:10px 14px;border-radius:8px;max-width:min(560px,95vw);font-size:12px;box-shadow:0 2px 12px #0003';
  status.textContent = 'Firebase 연결 준비 중…'; document.body.appendChild(status);
  function errorMessage(e) {
    if (e?.message === 'CONFLICT') return '다른 사용자가 같은 항목을 변경했습니다. 미저장본을 내려받은 뒤 서버 데이터를 다시 불러오세요.';
    if (/permission-denied|PERMISSION_DENIED/.test(e?.code || e?.message || '')) return '접근 권한이 없습니다. Firestore 규칙과 users 권한 정보를 확인해주세요.';
    if (/invalid-credential|wrong-password|user-not-found/.test(e?.code || '')) return '이메일 또는 비밀번호를 확인해주세요.';
    if (/too-many-requests/.test(e?.code || '')) return '로그인 요청이 많습니다. 잠시 후 다시 시도해주세요.';
    if (/network-request-failed|unavailable/.test(e?.code || '')) return '서버에 연결할 수 없습니다. 인터넷 연결을 확인해주세요.';
    if (/storage\//.test(e?.code || '')) return '첨부파일 업로드에 실패했습니다. Firebase Storage 활성화와 저장소 규칙을 확인해주세요.';
    return e?.userMessage || '처리에 실패했습니다. 연결 상태와 Firebase 설정을 확인해주세요.';
  }
  function downloadJSON(data, name) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function updateStatus() {
    status.replaceChildren();
    const label = document.createElement('span');
    label.textContent = !ready ? '로그인 후 서버 데이터를 불러옵니다.' : engine?.error ? '미저장 변경사항이 있습니다. ' + errorMessage(engine.error) : engine?.pending.size ? `서버 저장 중 · ${engine.pending.size}건` : 'Firebase 연결됨 · 서버 저장 완료';
    status.appendChild(label);
    if (engine?.error) {
      const add = (text, action) => {const b=document.createElement('button');b.textContent=text;b.style.cssText='margin:6px 5px 0 0;padding:4px 8px;cursor:pointer';b.onclick=action;status.appendChild(b);};
      add('미저장본 다운로드', () => downloadJSON({format:'TMD_UNSAVED',data:clone(db),pending:[...engine.pending]}, 'team-dashboard-unsaved.json'));
      add('다시 저장', () => engine.flush().catch(() => {}));
      add('서버 내용으로 되돌리기', () => {
        if (engine.running) return;
        if (confirm('미저장 변경사항을 버리고 서버 내용으로 되돌리시겠습니까? 먼저 미저장본을 내려받을 수 있습니다.')) engine.discard();
      });
    }
  }
  function emptyDb() {
    const result = {platformName:'Team Management Dashboard',menuConfig:{},memberOrder:[],memberMenuPermissions:{},userAccounts:[]};
    arrays.forEach(k => result[k] = []); return result;
  }
  function flatten() {
    const result = new Map();
    arrays.forEach(k => (db[k] || []).forEach(record => {
      if (!record.id || String(record.id).includes('/')) throw new Error('INVALID_RECORD_ID');
      result.set(`${k}/${record.id}`, clone(record));
    }));
    settings.forEach(k => result.set(`settings/${k}`, clone(db[k] ?? (k === 'platformName' ? 'Team Management Dashboard' : k === 'memberOrder' ? [] : {}))));
    return result;
  }
  function rebuild() {
    if (!engine || initializing) return updateStatus();
    const accounts = db.userAccounts || [];
    const next = emptyDb(); next.userAccounts = accounts;
    for (const [key, value] of engine.view()) {
      const [collection, id] = key.split('/');
      if (collection === 'settings') next[id] = value;
      else if (arrays.includes(collection)) next[collection].push(value);
    }
    for (const key of ['auditLogs','accountLogs']) next[key].sort((a,b) => (b.at || '').localeCompare(a.at || ''));
    db = next;
    updateStatus();
    if (ready && currentUser) {
      const permissionState = JSON.stringify(db.memberMenuPermissions?.[currentUser.memberId] || {});
      if (currentUser.role === 'member' && lastSettings && lastSettings !== permissionState) {
        oldToast('권한이 변경되었습니다. 다시 로그인해주세요.');
        void logout(); return;
      }
      renderNav(); render(); updateSessionUI();
    }
  }
  async function persist(key, value, base) {
    const [collection, id] = key.split('/');
    const ref = sdk.doc(firestore, collection, id);
    const version = crypto.randomUUID();
    await sdk.runTransaction(firestore, async tx => {
      const latest = await tx.get(ref);
      if ((latest.exists() ? latest.data().version : null) !== base) throw new Error('CONFLICT');
      if (value === null) tx.delete(ref);
      else tx.set(ref, {version,value,actorUid:auth.currentUser.uid,updatedAt:sdk.serverTimestamp()});
    });
    return value === null ? null : version;
  }
  function clearSession() {
    ready = false;
    unsubscribers.forEach(fn => fn()); unsubscribers=[];
    engine?.close(); engine=null; userProfile=null;
    currentUser=null; db=emptyDb();
    $('#content').innerHTML='';
    $('.search-results')?.remove();
    window.pendingPhotoData=null;window.pendingDocumentFileData=null;window.pendingMonthlyPdfData=null;
    $('#loginPw').value='';
    document.getElementById('appShell').classList.add('locked');
    document.getElementById('appShell').style.pointerEvents='none';
    document.getElementById('appShell').style.filter='blur(8px)';
    const screen=document.getElementById('loginScreen');screen.classList.remove('hidden');screen.style.display='grid';
    closeModal();closeDrawer();updateStatus();
  }
  async function listen(collectionName, constraints=[]) {
    const ref = sdk.query(sdk.collection(firestore,collectionName),...constraints);
    let initial = true;
    await new Promise((resolve,reject) => {
      const timeout=setTimeout(()=>{if(initial){initial=false;reject({userMessage:'서버 응답이 지연되고 있습니다. 연결을 확인한 뒤 다시 로그인해주세요.'});}},20000);
      const unsubscribe = sdk.onSnapshot(ref,{includeMetadataChanges:true}, snapshot => {
        // Transactions must be acknowledged before their new versions enter the baseline.
        if (snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache) return;
        for (const change of snapshot.docChanges()) engine?.receive(`${collectionName}/${change.doc.id}`, change.type === 'removed' ? null : change.doc.data());
        if (initial) {initial=false;clearTimeout(timeout);resolve();}
      }, error => {
        if (initial) {initial=false;clearTimeout(timeout);reject(error);}
        else {oldToast(errorMessage(error));void logout(true);}
      });
      unsubscribers.push(()=>{clearTimeout(timeout);unsubscribe();});
    });
  }
  async function enter(user) {
    if (busy) return; busy=true; initializing=true;
    try {
      const profileSnap = await sdk.getDocFromServer(sdk.doc(firestore,'users',user.uid));
      if (!profileSnap.exists()) throw {userMessage:'등록된 권한 정보가 없습니다. 관리자에게 계정 연결을 요청해주세요.'};
      userProfile = profileSnap.data();
      if (!userProfile.enabled || userProfile.locked) throw {userMessage:'사용이 중지되었거나 잠긴 계정입니다. 관리자에게 문의해주세요.'};
      if (!['admin','leader','member'].includes(userProfile.role)) throw {userMessage:'계정 역할을 확인해주세요.'};
      if (userProfile.role !== 'admin' && !userProfile.memberId) throw {userMessage:'팀원정보와 연결되지 않은 계정입니다.'};
      currentUser = {id:user.email,accountId:user.uid,uid:user.uid,name:userProfile.name || '사용자',role:userProfile.role,roleLabel:{admin:'시스템 관리자',leader:'팀장',member:'팀원'}[userProfile.role],memberId:userProfile.memberId || null};
      db=emptyDb();
      engine = new TmdRecordSync(persist,rebuild);
      await listen('settings');
      initializing=false;rebuild();initializing=true;
      const plans=arrays.filter(k => k==='auditLogs' ? currentUser.role!=='member' : k==='accountLogs' ? canAdmin() : k==='counseling' ? canManage() : canPage(menus[k]));
      await Promise.all(plans.map(k => listen(k)));
      if (canAdmin()) {
        const query = sdk.collection(firestore,'users');
        unsubscribers.push(sdk.onSnapshot(query,snapshot => {
          db.userAccounts=snapshot.docs.map(d => ({...d.data(),id:d.id,username:d.data().email || (d.id===user.uid ? user.email : d.id)}));
          if (ready) render();
        }, e => oldToast(errorMessage(e))));
      } else db.userAccounts=[{...userProfile,id:user.uid,username:user.email}];
      // The profile is authoritative; role and enable changes revoke the current UI session.
      unsubscribers.push(sdk.onSnapshot(sdk.doc(firestore,'users',user.uid),snap => {
        const p=snap.exists()?snap.data():null;
        if (!p || !p.enabled || p.locked || p.role!==userProfile.role || p.memberId!==userProfile.memberId) {
          oldToast('계정 권한이 변경되었습니다. 다시 로그인해주세요.');void logout(true);
        }
      }));
      initializing=false; rebuild();
      if (currentUser.role!=='admin' && !db.members.some(m=>m.id===currentUser.memberId)) {
        const own=await sdk.getDocFromServer(sdk.doc(firestore,'members',currentUser.memberId));
        if (!own.exists()) throw {userMessage:'연결된 팀원정보가 없습니다. 관리자에게 문의해주세요.'};
        engine.receive(`members/${currentUser.memberId}`,own.data());rebuild();
      }
      lastSettings=JSON.stringify(db.memberMenuPermissions?.[currentUser.memberId]||{});
      ready=true; state.page='home';
      if (canAdmin() && settings.some(k=>!engine.server.has(`settings/${k}`))) {save();await engine.flush();}
      const screen=$('#loginScreen');screen.classList.add('hidden');screen.style.display='none';
      const shell=$('#appShell');shell.classList.remove('locked');shell.style.pointerEvents='';shell.style.filter='';
      $('#loginPw').value='';$('#loginError').textContent='';
      renderNav();render();updateSessionUI();updateStatus();
      $('#breadcrumb').textContent='홈 대시보드';
    } catch (e) {clearSession();await sdk.signOut(auth);throw e;}
    finally {busy=false;initializing=false;}
  }
  // Disable all legacy local account provisioning and local session persistence.
  ensureAccountData = async function () {};
  ensureV3Data = function () {};
  save = function () {
    if (!ready || !engine || !currentUser) return;
    try {engine.stage(flatten());void engine.flush().catch(e=>oldToast(errorMessage(e)));}
    catch(e) {oldToast(errorMessage(e));}
  };
  toast = function(message) {
    oldToast(engine?.pending.size && /저장|등록|수정|삭제|변경|복원/.test(message) ? message + ' (서버 반영 중)' : message);
  };
  login = async function (email,password) {
    explicitLogin=true;
    try {const credential=await sdk.signInWithEmailAndPassword(auth,email.trim(),password);
      await enter(credential.user);return true;
    } finally {explicitLogin=false;}
  };
  logout = async function(force=false) {
    if (!force && engine?.pending.size && !confirm('서버에 저장하지 못한 변경사항이 있습니다. 미저장본을 내려받지 않고 로그아웃하시겠습니까?')) return;
    // End listeners before signOut so no old user's data survives.
    clearSession();await sdk.signOut(auth);
  };
  audit = function(action,menu,target='') {
    if (!ready || !canManage()) return;
    db.auditLogs.unshift({id:crypto.randomUUID(),user:currentUser.name,role:currentUser.roleLabel,action,menu,target,at:new Date().toISOString()});save();
  };
  accountLog = function(action,account,detail='') {
    if (!ready || !canAdmin()) return;
    db.accountLogs.unshift({id:crypto.randomUUID(),actor:currentUser.name,action,username:account?.username||'',detail,at:new Date().toISOString()});save();
  };
  repairStoredData = function () {oldToast('서버 데이터는 로그인 화면에서 초기화하지 않습니다. 관리자에게 문의해주세요.');};
  // Real account credentials stay in Authentication. The dashboard only links UID and role.
  openAccountEditor = function(accountId='',memberId='') {
    if (!canAdmin()) return;
    const a=accountById(accountId);
    const m=db.members.find(x=>x.id===(memberId||a?.memberId));
    modal(a?'Firebase 계정 연결 수정':'Firebase 계정 연결',`<p>먼저 Firebase Authentication에서 이메일 계정을 만드세요. 생성된 사용자 UID를 입력하면 이 팀원과 연결됩니다.</p><div class="field"><label>사용자 UID</label><input class="input" id="firebaseUid" value="${esc(a?.id||'')}" ${a?'readonly':''}></div><div class="field"><label>로그인 이메일</label><input class="input" type="email" id="firebaseEmail" value="${esc(a?.email||a?.username||m?.email||'')}"></div><div class="field"><label>표시 이름</label><input class="input" id="firebaseName" value="${esc(a?.name||m?.name||'관리자')}"></div><div class="field"><label>권한</label><select class="input" id="firebaseRole">${['admin','leader','member'].map(r=>`<option value="${r}" ${r===(a?.role||(m?.role==='팀장'?'leader':'member'))?'selected':''}>${{admin:'관리자',leader:'팀장',member:'팀원'}[r]}</option>`).join('')}</select></div><input type="hidden" id="firebaseMember" value="${esc(m?.id||a?.memberId||'')}"><p>이메일 주소 변경은 Authentication에서도 별도로 처리해야 합니다. 비밀번호는 이 화면에 저장하지 않습니다.</p>`,`<button class="primary-btn" id="linkFirebaseAccount">저장</button>`);
    $('#linkFirebaseAccount').onclick=async()=>{
      const button=$('#linkFirebaseAccount');button.disabled=true;
      try {
        const uid=$('#firebaseUid').value.trim(), email=$('#firebaseEmail').value.trim(), role=$('#firebaseRole').value, member=$('#firebaseMember').value||null;
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid) || !email.includes('@')) throw {userMessage:'UID와 이메일을 확인해주세요.'};
        if (role!=='admin'&&!member) throw {userMessage:'팀원정보에서 연결할 팀원을 선택해주세요.'};
        if (uid===currentUser.uid && role!=='admin') throw {userMessage:'현재 관리자의 권한은 변경할 수 없습니다.'};
        if (db.userAccounts.some(x=>x.id!==uid&&member&&x.memberId===member)) throw {userMessage:'이미 다른 계정과 연결된 팀원입니다.'};
        if (!a && db.userAccounts.some(x=>x.id===uid)) throw {userMessage:'이미 연결된 UID입니다. 해당 계정을 수정해주세요.'};
        await sdk.setDoc(sdk.doc(firestore,'users',uid),{email,name:$('#firebaseName').value.trim()||m?.name||'사용자',role,memberId:member,enabled:a?.enabled!==false,locked:!!a?.locked},{merge:true});
        closeModal();oldToast('Firebase 계정 연결을 저장했습니다.');
      } catch(e) {oldToast(errorMessage(e));button.disabled=false;}
    };
  };
  async function toggleAccount(id,field) {
    if (!canAdmin()) return;
    const a=accountById(id);if (!a) return;
    if (id===currentUser.uid) return oldToast('현재 관리자는 사용중지하거나 잠글 수 없습니다.');
    const next=!a[field];
    if (!confirm('계정의 '+(field==='enabled'?'사용 상태':'잠금 상태')+'를 변경하시겠습니까?')) return;
    try {await sdk.updateDoc(sdk.doc(firestore,'users',id),{[field]:next});oldToast('계정 상태를 변경했습니다.');}
    catch(e) {oldToast(errorMessage(e));}
  }
  toggleUserAccount=id=>toggleAccount(id,'enabled');
  toggleAccountLock=id=>toggleAccount(id,'locked');
  openPasswordReset=async function(id) {
    if (!canAdmin()) return;
    const a=accountById(id),email=a?.email||a?.username;
    if (!email?.includes('@')) return oldToast('먼저 계정에 실제 이메일을 등록해주세요.');
    if (!confirm(`${email} 주소로 비밀번호 재설정 메일을 보내시겠습니까?`)) return;
    try {await sdk.sendPasswordResetEmail(auth,email);oldToast('비밀번호 재설정 메일을 요청했습니다.');}
    catch(e) {oldToast(errorMessage(e));}
  };
  saveUserAccount=async()=>false;
  resetAccountPassword=async()=>false;
  const oldRenderAccounts=renderAccountManagement;
  renderAccountManagement=function(){return oldRenderAccounts().replace('팀원별 로그인 아이디, 사용상태, 잠금 및 비밀번호를 관리합니다. 비밀번호는 Salt + SHA-256 해시로 저장됩니다.','Firebase 이메일 계정과 팀원정보를 연결합니다. 비밀번호는 Firebase Authentication에서 관리합니다.').replaceAll('계정 생성','계정 연결').replaceAll('비밀번호 초기화','재설정 메일');};
  const oldSettings=renderSettings;
  renderSettings=function(){return `<section class="panel" style="padding:18px;margin-bottom:18px"><h3>Firebase 데이터 관리</h3><p>업무 데이터는 서버에서 공유됩니다. 계정은 Authentication 사용자 UID로 연결합니다.</p><button class="secondary-btn" onclick="importLocalFirebaseData()">기존 PC 데이터 가져오기</button><p>가져오기는 최초 1회 빈 데이터베이스에서만 가능합니다. 기존 로그인 계정·비밀번호는 가져오지 않습니다.</p></section>`+oldSettings().replace('PC 간 데이터 백업·복원','서버 데이터 백업·복원').replace('현재 PC의 작성값·팀원·권한·업무·월 추진업무 데이터를 다른 PC로 그대로 옮길 수 있습니다.','서버 데이터의 JSON 백업을 내려받거나 백업 내용을 서버에 복원합니다. Authentication 계정과 첨부파일 원본은 별도 관리합니다.').replace('① 기존 PC에서 전체 데이터 백업 → ② JSON 파일 이동 → ③ 새 PC에서 이 HTML 실행 → ④ 관리자 로그인 → ⑤ 백업 데이터 복원','다른 PC에서는 같은 사이트에 로그인하면 서버 데이터를 불러옵니다. 복원은 모든 사용자에게 반영됩니다.').replace('Prototype 기본 역할','Firebase 계정 역할');};
  window.importLocalFirebaseData=async function(){
    if (!canAdmin()) return;
    if (!localBackup) return oldToast('이 브라우저에 기존 데이터가 없습니다. JSON 백업 파일을 복원할 수 있습니다.');
    if (arrays.some(k=>(db[k]||[]).length)) return oldToast('이미 서버 데이터가 있습니다. 중복 가져오기는 허용하지 않습니다.');
    if (!confirm('이 PC에 저장된 기존 데이터를 서버에 가져오시겠습니까? 예제 데이터가 포함되어 있을 수 있으니 먼저 확인해주세요.')) return;
    try {await importData(JSON.parse(localBackup));oldToast('기존 데이터를 서버에 저장했습니다.');}catch(e){oldToast(errorMessage(e));}
  };
  renderers.settings=renderSettings;
  async function importData(source) {
    if (!Array.isArray(source.members)||!Array.isArray(source.tasks)) throw {userMessage:'올바른 대시보드 백업 파일이 아닙니다.'};
    const clean=emptyDb();arrays.forEach(k=>clean[k]=clone(source[k]||[]));settings.forEach(k=>{if(source[k]!=null)clean[k]=clone(source[k]);});
    // Never put passwords, hashes or the old session into Firestore.
    clean.userAccounts=db.userAccounts;
    for (const item of clean.documents) {
      if (item.fileData) {const file=await (await fetch(item.fileData)).blob();item.filePath=await uploadFile(file,item.fileName||'document');delete item.fileData;}
    }
    for (const member of clean.members) {
      if (member.photo?.startsWith('data:')) {const file=await (await fetch(member.photo)).blob();member.photoPath=await uploadFile(file,'profile');member.photo=await sdk.getDownloadURL(sdk.ref(storage,member.photoPath));}
    }
    for (const report of clean.monthlyWork) {
      if(report.pdfData?.startsWith('data:')) {const file=await(await fetch(report.pdfData)).blob();report.pdfPath=await uploadFile(file,report.pdfName||'report.pdf');report.pdfData=await sdk.getDownloadURL(sdk.ref(storage,report.pdfPath));}
    }
    db=clean;save();await engine.flush();renderNav();render();
  }
  restoreDashboardBackup=async function(event){
    if (!canAdmin()) return;
    const file=event.target.files?.[0];if(!file)return;
    if (engine.pending.size) return oldToast('미저장 변경사항을 먼저 처리해주세요.');
    if (!confirm('공유 서버 데이터를 백업 내용으로 교체합니다. 다른 사용자에게도 반영됩니다. 먼저 현재 데이터를 백업했는지 확인해주세요. 계속하시겠습니까?')) return;
    try {const payload=JSON.parse(await file.text());await importData(payload.format==='TMD_BACKUP'?payload.data:payload);oldToast('백업 내용을 서버에 저장했습니다.');}
    catch(e){oldToast(errorMessage(e));}
  };
  dashboardBackupPayload=()=>({format:'TMD_BACKUP',version:'6-firebase',exportedAt:new Date().toISOString(),data:{...clone(db),userAccounts:[]}});
  async function uploadFile(file,name) {
    if (file.size>10*1024*1024) throw {userMessage:'첨부파일은 10MB 이하로 업로드해주세요.'};
    const path=`uploads/${auth.currentUser.uid}/${crypto.randomUUID()}-${name.replace(/[^A-Za-z0-9._가-힣-]/g,'_')}`;
    await sdk.uploadBytes(sdk.ref(storage,path),file);return path;
  }
  const oldSaveDocument=saveDocument;
  saveDocument=async function(id='') {
    try {
      let path;
      if (window.pendingDocumentFileData) {const blob=await (await fetch(window.pendingDocumentFileData)).blob();path=await uploadFile(blob,window.pendingDocumentFileName||'document');window.pendingDocumentFileData='';}
      const old=db.documents.find(d=>d.id===id);
      // Attach the path before save() stages the record.
      const previousSave=save;
      save=function(){const item=id?db.documents.find(d=>d.id===id):db.documents[db.documents.length-1];if(item){item.filePath=window.pendingDocumentFileRemoved?'':path||old?.filePath||'';delete item.fileData;}previousSave();};
      try {oldSaveDocument(id);} finally {save=previousSave;}
    }catch(e){oldToast(errorMessage(e));}
  };
  downloadDocumentFile=async function(id){
    const record=db.documents.find(d=>d.id===id);if(!record?.filePath)return oldToast('첨부파일이 없습니다.');
    try {const blob=await sdk.getBlob(sdk.ref(storage,record.filePath));const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=record.fileName||'download';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){oldToast(errorMessage(e));}
  };
  const oldSaveMember=saveMember;
  saveMember=async function(id='') {
    if (!canAdmin()) return oldToast('팀원정보와 직책은 관리자가 변경할 수 있습니다.');
    try {
      const old=db.members.find(m=>m.id===id);let photoPath=old?.photoPath||'';
      if(window.pendingPhotoData?.startsWith('data:')) {const blob=await (await fetch(window.pendingPhotoData)).blob();photoPath=await uploadFile(blob,'profile');window.pendingPhotoData=await sdk.getDownloadURL(sdk.ref(storage,photoPath));}
      else window.pendingPhotoData=window.pendingPhotoRemoved?'':old?.photo||'';
      if(window.pendingPhotoRemoved)photoPath='';
      const previousSave=save;
      save=function(){const item=id?db.members.find(m=>m.id===id):db.members[db.members.length-1];if(item)item.photoPath=photoPath;previousSave();};
      try {oldSaveMember(id);}finally{save=previousSave;}
      oldToast('직책과 로그인 권한은 별도입니다. 권한은 관리자 설정의 계정 연결에서 변경해주세요.');
    }catch(e){oldToast(errorMessage(e));}
  };
  const oldSaveMonthly=saveMonthlyWork;
  saveMonthlyWork=async function(id='') {
    try {
      let path;
      if(window.pendingMonthlyPdfData?.startsWith('data:')) {const file=await(await fetch(window.pendingMonthlyPdfData)).blob();path=await uploadFile(file,window.pendingMonthlyPdfName||'report.pdf');window.pendingMonthlyPdfData=await sdk.getDownloadURL(sdk.ref(storage,path));}
      const existing=db.monthlyWork.find(x=>x.id===id),previousSave=save;
      save=function(){const item=id?db.monthlyWork.find(x=>x.id===id):db.monthlyWork[db.monthlyWork.length-1];if(item)item.pdfPath=item.authoringMode==='pdf'?(path||existing?.pdfPath||''):'';previousSave();};
      try{oldSaveMonthly(id);}finally{save=previousSave;}
    }catch(e){oldToast(errorMessage(e));}
  };
  window.addEventListener('beforeunload',event=>{if(engine?.pending.size){event.preventDefault();event.returnValue='';}});
  window.addEventListener('online',()=>{if(engine?.pending.size)void engine.flush().catch(()=>{});});
  try {
    const modules=await Promise.all(['app','auth','firestore','storage'].map(product=>import(cdn+`firebase-${product}.js`)));
    sdk=Object.assign({},...modules);
    const app=sdk.initializeApp(config);auth=sdk.getAuth(app);firestore=sdk.getFirestore(app);storage=sdk.getStorage(app);
    auth.languageCode='ko';await sdk.setPersistence(auth,sdk.browserSessionPersistence);
    // Fresh server data only. Keep legacy localStorage untouched for explicit migration.
    db=emptyDb();await init();
    const id=$('#loginId');id.type='email';id.placeholder='이메일';id.autocomplete='username';
    const label=id.closest('label');if(label){for(const node of label.childNodes)if(node.nodeType===3&&node.textContent.trim())node.textContent='이메일 ';}
    $('.demo-accounts')?.remove();$('.login-repair')?.remove();
    const remember=$('#rememberMe');if(remember)remember.closest('label')?.remove();
    const form=$('#loginForm');
    form.onsubmit=async event=>{
      event.preventDefault();const button=form.querySelector('[type="submit"]');button.disabled=true;$('#loginError').textContent='로그인 및 서버 데이터 확인 중…';
      try {await login(id.value,$('#loginPw').value);}catch(e){$('#loginError').textContent=errorMessage(e);}finally{button.disabled=false;}
    };
    const reset=document.createElement('button');reset.type='button';reset.className='login-repair';reset.textContent='비밀번호 재설정';reset.onclick=async()=>{
      if(!id.value.includes('@'))return $('#loginError').textContent='이메일을 먼저 입력해주세요.';
      try {await sdk.sendPasswordResetEmail(auth,id.value.trim());$('#loginError').textContent='등록된 이메일의 재설정 안내를 확인해주세요.';}catch(e){$('#loginError').textContent=errorMessage(e);}
    };form.appendChild(reset);
    sdk.onAuthStateChanged(auth,user=>{
      if (!user) {if(ready)clearSession();return;}
      if (!explicitLogin&&!busy&&!ready)void enter(user).catch(e=>$('#loginError').textContent=errorMessage(e));
    });
    updateStatus();
  } catch(e) {
    console.error('FIREBASE_INIT',e);status.textContent='Firebase 연결에 실패했습니다. 새로고침해주세요.';
    $('#loginError').textContent=errorMessage(e);
    $('#loginForm').onsubmit=event=>{event.preventDefault();$('#loginError').textContent='Firebase 연결 실패로 로그인할 수 없습니다. 새로고침해주세요.';};
  }
})();
