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
  const STORAGE_ENABLED = false;
  const fileDisabledMessage = '현재 첨부파일 저장을 사용하지 않습니다. 파일은 PC에 별도로 보관하고 내용을 직접 입력해주세요.';
  const oldToast = toast;
  const arrays = ['members','projects','tasks','schedules','meetings','kpis','leave','education','documents','monthlyWork','counseling','auditLogs','accountLogs'];
  const settings = ['platformName','menuConfig','memberOrder','memberMenuPermissions'];
  const menus = {members:'team',projects:'projects',tasks:'tasks',schedules:'calendar',meetings:'meetings',kpis:'performance',leave:'leave',education:'education',documents:'documents',monthlyWork:'reports',counseling:'counseling'};
  let sdk, auth, firestore, storage, engine, userProfile, busy = false, ready = false;
  let unsubscribers = [], lastSettings = '', initializing = false, explicitLogin = false;
  let deletedAccounts = [];
  const clone = v => JSON.parse(JSON.stringify(v));
  const localBackup = safeStorageGet('tmd-db');
  const status = document.createElement('div');
  status.id = 'firebaseStatus'; status.setAttribute('role','status');
  status.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:5000;background:#102c46;color:white;padding:10px 14px;border-radius:8px;max-width:min(560px,95vw);font-size:12px;box-shadow:0 2px 12px #0003';
  status.textContent = 'Firebase 연결 준비 중…'; document.body.appendChild(status);
  function errorMessage(e) {
    if (e?.message === 'CONFLICT') return '다른 사용자가 같은 항목을 변경했습니다. 미저장본을 내려받은 뒤 서버 데이터를 다시 불러오세요.';
    if (/permission-denied|PERMISSION_DENIED/.test(e?.code || e?.message || '')) return '접근 권한이 없습니다. Firestore 규칙과 users 권한 정보를 확인해주세요.';
    if (/email-already-in-use/.test(e?.code || '')) return '이미 등록된 이메일입니다. 다른 이메일을 사용하거나 기존 계정의 비밀번호 재설정을 이용해주세요.';
    if (/weak-password/.test(e?.code || '')) return '인증 서비스의 비밀번호 정책에 맞는 비밀번호를 입력해주세요.';
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
    currentUser=null; db=emptyDb();deletedAccounts=[];
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
    // Rules allow these specific settings documents, not an unrestricted list.
    // Read each permitted path so members never need collection-wide access.
    if(collectionName==='settings') {
      await Promise.all(settings.map(id=>listenSetting(id)));
      return;
    }
    const ref = sdk.query(sdk.collection(firestore,collectionName),...constraints);
    let initial = true;
    await new Promise((resolve,reject) => {
      const timeout=setTimeout(()=>{if(initial){initial=false;reject({userMessage:'서버 응답이 지연되고 있습니다. 연결을 확인한 뒤 다시 로그인해주세요.'});}},20000);
      const unsubscribe = sdk.onSnapshot(ref,{includeMetadataChanges:true}, snapshot => {
        // Transactions must be acknowledged before their new versions enter the baseline.
        if (snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache) return;
        // A cache snapshot can contain all document changes. The following server
        // snapshot may only change metadata and have an empty docChanges().
        // Populate a new session from the full authoritative result first.
        if (initial) {
          for (const document of snapshot.docs) engine?.receive(`${collectionName}/${document.id}`,document.data());
        } else {
          for (const change of snapshot.docChanges()) engine?.receive(`${collectionName}/${change.doc.id}`, change.type === 'removed' ? null : change.doc.data());
        }
        if (initial) {initial=false;clearTimeout(timeout);resolve();}
      }, error => {
        if (initial) {initial=false;clearTimeout(timeout);reject(error);}
        else {oldToast(errorMessage(error));void logout(true);}
      });
      unsubscribers.push(()=>{clearTimeout(timeout);unsubscribe();});
    });
  }
  async function listenSetting(id) {
    let initial=true;
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{if(initial){initial=false;reject({userMessage:'설정을 불러오는 중 응답이 지연되었습니다. 연결을 확인하고 다시 로그인해주세요.'});}},20000);
      const unsubscribe=sdk.onSnapshot(sdk.doc(firestore,'settings',id),{includeMetadataChanges:true},snapshot=>{
        if(snapshot.metadata.hasPendingWrites||snapshot.metadata.fromCache)return;
        engine?.receive(`settings/${id}`,snapshot.exists()?snapshot.data():null);
        if(initial){initial=false;clearTimeout(timeout);resolve();}
      },error=>{
        if(initial){initial=false;clearTimeout(timeout);reject(error);}
        else{oldToast(errorMessage(error));void logout(true);}
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
          const accounts=snapshot.docs.map(d => ({...d.data(),id:d.id,username:d.data().email || (d.id===user.uid ? user.email : d.id)}));
          deletedAccounts=accounts.filter(a=>a.deleted===true);
          db.userAccounts=accounts.filter(a=>a.deleted!==true);
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
      // Signing in only reads data. Missing defaults are persisted on an
      // explicit edit, never as a side effect of authentication.
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
  // Provision on an isolated in-memory Auth instance so the admin stays signed in.
  saveUserAccount = async function(accountId='',values=null) {
    if(!canAdmin())throw {userMessage:'관리자만 계정을 관리할 수 있습니다.'};
    const existing=accountId?accountById(accountId):null;
    if(accountId&&!existing)throw {userMessage:'수정할 계정을 찾을 수 없습니다.'};
    const input=values||{email:$('#firebaseEmail').value,name:$('#firebaseName').value,role:$('#firebaseRole').value,memberId:$('#firebaseMember').value,password:$('#firebasePassword')?.value,confirmPassword:$('#firebasePasswordConfirm')?.value};
    const email=(input.email||'').trim().toLowerCase(),name=(input.name||'').trim(),role=input.role,memberId=input.memberId||null;
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw {userMessage:'실제 로그인 이메일을 입력해주세요.'};
    if(!name||!['admin','leader','member'].includes(role))throw {userMessage:'표시 이름과 권한을 확인해주세요.'};
    if(!existing&&deletedAccounts.some(a=>(a.email||a.username||'').toLowerCase()===email))throw {userMessage:'삭제된 계정의 이메일입니다. 아래 삭제된 계정 목록에서 로그인 권한을 복구해주세요.'};
    if(role!=='admin'&&!db.members.some(m=>m.id===memberId))throw {userMessage:'연결할 팀원정보를 확인해주세요.'};
    if(db.userAccounts.some(x=>x.id!==accountId&&memberId&&x.memberId===memberId))throw {userMessage:'이미 계정이 생성된 팀원입니다.'};
    if(db.userAccounts.some(x=>x.id!==accountId&&(x.email||x.username||'').toLowerCase()===email))throw {userMessage:'이미 사용 중인 이메일입니다.'};
    if(existing) {
      if(email!==(existing.email||existing.username||'').toLowerCase())throw {userMessage:'로그인 이메일 변경에는 계정 소유자의 보안 인증이 필요합니다. 이 화면에서는 표시 이름과 권한을 수정할 수 있습니다.'};
      if(accountId===currentUser.uid&&role!=='admin')throw {userMessage:'현재 관리자의 권한은 변경할 수 없습니다.'};
      await sdk.setDoc(sdk.doc(firestore,'users',accountId),{email,name,role,memberId},{merge:true});
      accountLog('계정수정',{username:email},'표시 이름·권한 수정');return true;
    }
    const password=input.password||'';
    if(password.length<8)throw {userMessage:'초기 비밀번호는 8자 이상 입력해주세요.'};
    if(password!==input.confirmPassword)throw {userMessage:'비밀번호 확인값이 일치하지 않습니다.'};
    const adminUid=auth.currentUser?.uid;
    let accountApp,accountAuth,createdUser,linked=false;
    try {
      accountApp=sdk.initializeApp(config,'account-provision-'+crypto.randomUUID());
      accountAuth=sdk.getAuth(accountApp);
      await sdk.setPersistence(accountAuth,sdk.inMemoryPersistence);
      const credential=await sdk.createUserWithEmailAndPassword(accountAuth,email,password);
      createdUser=credential.user;
      if(auth.currentUser?.uid!==adminUid||!canAdmin())throw {userMessage:'관리자 세션이 변경되었습니다. 다시 로그인해주세요.'};
      await sdk.setDoc(sdk.doc(firestore,'users',createdUser.uid),{email,name,role,memberId,enabled:true,locked:false,createdAt:new Date().toISOString()});
      linked=true;
      accountLog('계정생성',{username:email},'관리자 화면에서 생성');
      return true;
    } catch(error) {
      if(createdUser&&!linked) {
        try {await sdk.deleteUser(createdUser);}
        catch(cleanupError) {throw {userMessage:'계정 인증은 생성됐지만 권한 등록과 자동 취소가 실패했습니다. 같은 이메일로 다시 생성하지 말고 관리자에게 복구를 요청해주세요.'};}
      }
      throw error;
    } finally {
      if(accountAuth)try{await sdk.signOut(accountAuth);}catch(error){}
      if(accountApp)try{await sdk.deleteApp(accountApp);}catch(error){}
    }
  };
  openAccountEditor = function(accountId='',memberId='') {
    if (!canAdmin()) return;
    const a=accountById(accountId),m=db.members.find(x=>x.id===(memberId||a?.memberId));
    modal(a?'계정 수정':'계정 생성',`<p>${a?'표시 이름과 권한을 수정합니다.':'팀원의 이메일과 초기 비밀번호로 로그인 계정을 바로 만듭니다.'}</p><div class="field"><label>로그인 이메일</label><input class="input" type="email" id="firebaseEmail" value="${esc(a?.email||a?.username||m?.email||'')}" ${a?'readonly':''} autocomplete="off"></div>${a?'':`<div class="field"><label>초기 비밀번호</label><input class="input" type="password" id="firebasePassword" autocomplete="new-password" placeholder="8자 이상"></div><div class="field"><label>초기 비밀번호 확인</label><input class="input" type="password" id="firebasePasswordConfirm" autocomplete="new-password"></div>`}<div class="field"><label>표시 이름</label><input class="input" id="firebaseName" value="${esc(a?.name||m?.name||'관리자')}"></div><div class="field"><label>권한</label><select class="input" id="firebaseRole">${['admin','leader','member'].map(r=>`<option value="${r}" ${r===(a?.role||(m?.role==='팀장'?'leader':'member'))?'selected':''}>${{admin:'관리자',leader:'팀장',member:'팀원'}[r]}</option>`).join('')}</select></div><input type="hidden" id="firebaseMember" value="${esc(m?.id||a?.memberId||'')}"><p>비밀번호는 인증 서비스에서 관리하며 이 시스템의 업무 데이터에 저장하지 않습니다. 기존 비밀번호 변경은 재설정 메일을 사용합니다.${a?' 로그인 이메일 변경에는 계정 소유자의 보안 인증이 필요합니다.':''}</p><div id="firebaseAccountError" role="alert" style="color:#bc4138"></div>`,`<button class="primary-btn" id="linkFirebaseAccount">${a?'저장':'계정 생성'}</button>`);
    $('#linkFirebaseAccount').onclick=async()=>{
      const button=$('#linkFirebaseAccount');button.disabled=true;$('#firebaseAccountError').textContent='';
      try {await saveUserAccount(a?.id||'');closeModal();oldToast(a?'계정정보를 수정했습니다.':'로그인 계정을 생성했습니다. 초기 비밀번호를 팀원에게 전달해주세요.');}
      catch(e){$('#firebaseAccountError').textContent=errorMessage(e);button.disabled=false;}
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
  window.deleteLoginAccount=async function(id) {
    if(!canAdmin())return oldToast('관리자만 로그인 계정을 삭제할 수 있습니다.');
    if(id===currentUser.uid)return oldToast('현재 로그인한 관리자 계정은 삭제할 수 없습니다.');
    const account=accountById(id);if(!account)return;
    if(!confirm(`${account.username} 계정의 시스템 로그인 권한과 활성 팀원 연결을 삭제하시겠습니까?\n팀원정보와 기존 업무 기록은 유지합니다. Firebase 인증 계정 자체는 남으며 같은 이메일은 아래 삭제된 계정 목록에서 복구할 수 있습니다.`))return;
    try {
      await sdk.setDoc(sdk.doc(firestore,'users',id),{deleted:true,enabled:false,locked:true,deletedAt:new Date().toISOString()},{merge:true});
      accountLog('계정삭제',account,'시스템 로그인 권한 삭제 · 업무 기록 보존');
      oldToast('계정의 시스템 로그인 권한을 삭제했습니다.');
    }catch(error){oldToast(errorMessage(error));}
  };
  window.restoreLoginAccount=async function(id) {
    if(!canAdmin())return;
    const account=deletedAccounts.find(a=>a.id===id);if(!account)return;
    if(account.role!=='admin'&&!db.members.some(m=>m.id===account.memberId))return oldToast('연결된 팀원정보가 없습니다. 먼저 팀원정보를 복원해주세요.');
    if(account.memberId&&db.userAccounts.some(a=>a.memberId===account.memberId))return oldToast('해당 팀원에게 이미 다른 로그인 계정이 있습니다.');
    if(!confirm(`${account.username} 계정의 시스템 로그인 권한을 복구하시겠습니까? 기존 비밀번호를 그대로 사용하며 사용중지와 잠금이 해제됩니다.`))return;
    try {
      await sdk.setDoc(sdk.doc(firestore,'users',id),{deleted:false,enabled:true,locked:false,restoredAt:new Date().toISOString()},{merge:true});
      accountLog('계정복구',account,'기존 인증 계정의 로그인 권한 복구');oldToast('로그인 권한을 복구했습니다.');
    }catch(error){oldToast(errorMessage(error));}
  };
  openPasswordReset=async function(id) {
    if (!canAdmin()) return;
    const a=accountById(id),email=a?.email||a?.username;
    if (!email?.includes('@')) return oldToast('먼저 계정에 실제 이메일을 등록해주세요.');
    if (!confirm(`${email} 주소로 비밀번호 재설정 메일을 보내시겠습니까?`)) return;
    try {await sdk.sendPasswordResetEmail(auth,email);oldToast('비밀번호 재설정 메일을 요청했습니다.');}
    catch(e) {oldToast(errorMessage(e));}
  };
  resetAccountPassword=async()=>false;
  const oldRenderAccounts=renderAccountManagement;
  renderAccountManagement=function(){
    let html=oldRenderAccounts().replace('팀원별 로그인 아이디, 사용상태, 잠금 및 비밀번호를 관리합니다. 비밀번호는 Salt + SHA-256 해시로 저장됩니다.','관리자가 팀원 계정을 생성하고 표시 이름·권한·사용상태를 관리합니다. 비밀번호 변경은 재설정 메일을 사용합니다.').replaceAll('비밀번호 초기화','재설정 메일').replace('현재 비밀번호는 조회할 수 없으며 관리자도 새 비밀번호 설정 또는 초기화만 가능합니다.','현재 비밀번호는 조회할 수 없습니다. 초기 비밀번호는 계정 생성 시 설정하고 이후 변경은 재설정 메일을 사용합니다.');
    html=html.replace(/(<button\b[^>]*data-account-reset="([^"]+)"[^>]*>[\s\S]*?<\/button>)/g,(button,idAttribute,id)=>id===currentUser.uid?button:button+`<button class="secondary-mini" style="color:#bc4138" data-account-delete="${esc(id)}" title="시스템 로그인 권한 삭제">삭제</button>`);
    html+=`<section class="panel settings-panel wide" style="margin-top:16px"><h3>삭제된 로그인 계정</h3><p>삭제는 이 시스템의 로그인 권한을 회수합니다. Firebase 인증 계정의 영구 삭제는 콘솔에서 처리해야 합니다. 같은 이메일을 다시 사용하려면 아래에서 복구하세요.</p>${deletedAccounts.map(a=>`<div class="account-admin-row"><div><b>${esc(a.name||'사용자')}</b><span>${esc(a.email||a.username||'')}</span></div><button class="secondary-btn" data-account-restore="${esc(a.id)}">로그인 권한 복구</button></div>`).join('')||'<p class="meta">삭제된 계정이 없습니다.</p>'}</section>`;
    return html;
  };
  const oldBindAccounts=bindAccountManagement;
  bindAccountManagement=function(){
    oldBindAccounts();if(!canAdmin()||state.page!=='settings')return;
    $$('[data-account-delete]').forEach(button=>button.onclick=()=>deleteLoginAccount(button.dataset.accountDelete));
    $$('[data-account-restore]').forEach(button=>button.onclick=()=>restoreLoginAccount(button.dataset.accountRestore));
  };
  const oldSettings=renderSettings;
  renderSettings=function(){return `<section class="panel" style="padding:18px;margin-bottom:18px"><h3>Firebase 데이터 관리</h3><p>업무 데이터는 서버에서 공유됩니다. 팀원 계정은 아래 로그인 계정 관리에서 생성합니다.</p><p><b>첨부파일 저장 미사용</b> · 사진·PDF·일반 첨부는 업로드하지 않습니다. 백업 복원 시 첨부파일 제외 여부를 먼저 확인합니다.</p><button class="secondary-btn" onclick="importLocalFirebaseData()">기존 PC 데이터 가져오기</button><p>가져오기는 최초 1회 빈 데이터베이스에서만 가능합니다. 기존 로그인 계정·비밀번호는 가져오지 않습니다.</p></section>`+oldSettings().replace('PC 간 데이터 백업·복원','서버 데이터 백업·복원').replace('현재 PC의 작성값·팀원·권한·업무·월 추진업무 데이터를 다른 PC로 그대로 옮길 수 있습니다.','서버 데이터의 JSON 백업을 내려받거나 백업 내용을 서버에 복원합니다. Authentication 계정과 첨부파일 원본은 별도 관리합니다.').replace('① 기존 PC에서 전체 데이터 백업 → ② JSON 파일 이동 → ③ 새 PC에서 이 HTML 실행 → ④ 관리자 로그인 → ⑤ 백업 데이터 복원','다른 PC에서는 같은 사이트에 로그인하면 서버 데이터를 불러옵니다. 복원은 모든 사용자에게 반영됩니다.').replace('Prototype 기본 역할','Firebase 계정 역할');};
  window.importLocalFirebaseData=async function(){
    if (!canAdmin()) return;
    if (!localBackup) return oldToast('이 브라우저에 기존 데이터가 없습니다. JSON 백업 파일을 복원할 수 있습니다.');
    if (arrays.some(k=>(db[k]||[]).length)) return oldToast('이미 서버 데이터가 있습니다. 중복 가져오기는 허용하지 않습니다.');
    if (!confirm('이 PC에 저장된 기존 데이터를 서버에 가져오시겠습니까? 예제 데이터가 포함되어 있을 수 있으니 먼저 확인해주세요.')) return;
    try {const result=await importData(JSON.parse(localBackup));if(result)oldToast(`기존 데이터를 서버에 저장했습니다.${result.skipped?' 첨부파일 '+result.skipped+'건은 제외했습니다.':''}`);}catch(e){oldToast(errorMessage(e));}
  };
  renderers.settings=renderSettings;
  async function importData(source) {
    if (!Array.isArray(source.members)||!Array.isArray(source.tasks)) throw {userMessage:'올바른 대시보드 백업 파일이 아닙니다.'};
    const clean=emptyDb();arrays.forEach(k=>clean[k]=clone(source[k]||[]));settings.forEach(k=>{if(source[k]!=null)clean[k]=clone(source[k]);});
    // Never put passwords, hashes or the old session into Firestore.
    clean.userAccounts=db.userAccounts;
    if (!STORAGE_ENABLED) {
      let skipped=0;
      for (const item of clean.documents) {
        if(item.fileData||item.filePath){skipped++;item.attachmentOmitted=true;}
        delete item.fileData;delete item.filePath;
      }
      for (const member of clean.members) {
        if(member.photo||member.photoPath){skipped++;member.photoOmitted=true;}
        member.photo='';delete member.photoPath;
      }
      for (const report of clean.monthlyWork) {
        if(report.pdfData||report.pdfPath){
          skipped++;report.attachmentOmitted=true;report.originalAuthoringMode=report.authoringMode||'pdf';
          report.authoringMode='direct';
          if(!report.sections?.length)report.sections=[{category:'첨부파일 안내',content:'PDF 첨부는 복원에서 제외했습니다. 원본 백업 파일에 보관되어 있습니다.'}];
        }
        delete report.pdfData;delete report.pdfPath;
      }
      if(skipped && !confirm(`첨부파일 저장을 사용하지 않아 사진·PDF·일반 첨부 ${skipped}건을 제외하고 업무 데이터를 복원합니다. 제목과 파일명 등 메타데이터는 유지됩니다. 원본 백업 파일은 변경하지 않습니다. 계속하시겠습니까?`))return null;
      db=clean;save();await engine.flush();renderNav();render();return {skipped};
    }
    for (const item of clean.documents) {
      if (item.fileData) {const file=await (await fetch(item.fileData)).blob();item.filePath=await uploadFile(file,item.fileName||'document');delete item.fileData;}
    }
    for (const member of clean.members) {
      if (member.photo?.startsWith('data:')) {const file=await (await fetch(member.photo)).blob();member.photoPath=await uploadFile(file,'profile');member.photo=await sdk.getDownloadURL(sdk.ref(storage,member.photoPath));}
    }
    for (const report of clean.monthlyWork) {
      if(report.pdfData?.startsWith('data:')) {const file=await(await fetch(report.pdfData)).blob();report.pdfPath=await uploadFile(file,report.pdfName||'report.pdf');report.pdfData=await sdk.getDownloadURL(sdk.ref(storage,report.pdfPath));}
    }
    db=clean;save();await engine.flush();renderNav();render();return {skipped:0};
  }
  restoreDashboardBackup=async function(event){
    if (!canAdmin()) return;
    const file=event.target.files?.[0];if(!file)return;
    if (engine.pending.size) return oldToast('미저장 변경사항을 먼저 처리해주세요.');
    if (!confirm('공유 서버 데이터를 백업 내용으로 교체합니다. 다른 사용자에게도 반영됩니다. 먼저 현재 데이터를 백업했는지 확인해주세요. 계속하시겠습니까?')) return;
    try {const payload=JSON.parse(await file.text());const result=await importData(payload.format==='TMD_BACKUP'?payload.data:payload);if(result)oldToast(`백업 내용을 서버에 저장했습니다.${result.skipped?' 첨부파일 '+result.skipped+'건은 제외했습니다.':''}`);}
    catch(e){oldToast(errorMessage(e));}
  };
  dashboardBackupPayload=()=>({format:'TMD_BACKUP',version:'6-firebase',exportedAt:new Date().toISOString(),data:{...clone(db),userAccounts:[]}});
  async function uploadFile(file,name) {
    if (!STORAGE_ENABLED) throw {userMessage:fileDisabledMessage};
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
    if (!STORAGE_ENABLED) return oldToast(fileDisabledMessage);
    const record=db.documents.find(d=>d.id===id);if(!record?.filePath)return oldToast('첨부파일이 없습니다.');
    try {const blob=await sdk.getBlob(sdk.ref(storage,record.filePath));const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=record.fileName||'download';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){oldToast(errorMessage(e));}
  };
  if (!STORAGE_ENABLED) {
    const disabledPreview=event=>{if(event?.target)event.target.value='';oldToast(fileDisabledMessage);};
    previewMemberPhoto=disabledPreview;previewDocumentFile=disabledPreview;previewMonthlyPdf=disabledPreview;
    const oldOpenForm=openForm;
    openForm=function(type,existing){
      oldOpenForm(type,existing);
      if(!['member','document','monthlyWork'].includes(type))return;
      const box=$('#modal');if(!box)return;
      box.querySelectorAll('input[type="file"]').forEach(input=>{input.disabled=true;});
      box.querySelectorAll('input[name="monthlyAuthoringMode"][value="pdf"]').forEach(input=>{input.disabled=true;});
      const note=document.createElement('p');note.textContent=fileDisabledMessage;note.style.cssText='padding:12px;color:#65747c;font-size:12px';box.appendChild(note);
    };
  }
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
    const modules=await Promise.all((STORAGE_ENABLED?['app','auth','firestore','storage']:['app','auth','firestore']).map(product=>import(cdn+`firebase-${product}.js`)));
    sdk=Object.assign({},...modules);
    const app=sdk.initializeApp(config);auth=sdk.getAuth(app);firestore=sdk.getFirestore(app);if(STORAGE_ENABLED)storage=sdk.getStorage(app);
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
