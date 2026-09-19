'use strict';
// Shared by the website and the packaged desktop view. No credentials live here.
var OPS={outbox:null,verified:false,raw:null,storageError:'',started:false,scope:'',paintScheduled:false,claims:[],cacheTimer:null,modelDay:'',modelSource:'',tasks:[],smsStates:new Map(),diagnostics:{},base:null,needsRebase:false,identityReady:false,verification:null,verifyTimer:null,readback:null};
const cloneOperation=value=>JSON.parse(JSON.stringify(value));
const operationScope=()=>GAS_URL+'|sheet='+String(CFG.sheetId||'');
const operationKey=b=>`${b.time}|${b.name}|${b.phone}`;
const operationCacheKey=()=>`coconara-reservation-cache-v2:${encodeURIComponent(operationScope())}:${localDay()}`;
const operationTasks=()=>OPS.tasks;
function indexOperationTasks(tasks){
  const before=new Set(OPS.tasks.filter(t=>operationState(t)==='cancelled').map(t=>t.id));
  if((tasks||[]).some(t=>operationState(t)==='cancelled'&&!before.has(t.id)))OPS.needsRebase=true;
  OPS.tasks=tasks||[];OPS.smsStates=new Map();
  for(const task of OPS.tasks){if(task.day!==localDay()||['confirmed','cancelled'].includes(operationState(task)))continue;
    for(const effect of task.effects||[]){if(effect.kind!=='sms')continue;
      for(const key of effect.keys||[effect.key])OPS.smsStates.set(key+'::'+effect.label,operationState(task));
    }
  }
}
function operationError(message){const error=new Error(message);error.code='OPERATION_UNCERTAIN';return error;}
function isPendingOperation(task){return task.day===localDay() && !['cancelled'].includes(task.state||task.status);}
function operationState(task){return task.state||task.status;}
function operationIdentityMap(tasks=operationTasks()){
  const parent=new Map();
  const root=key=>{if(!parent.has(key))parent.set(key,key);while(parent.get(key)!==key)key=parent.get(key);return key;};
  for(const task of tasks){
    if(task.day!==localDay()||(operationState(task)==='cancelled'&&task.cursor===0))continue;
    // List order contains EVERY customer's key. It is never customer lineage.
    for(const effect of task.effects||[])if(effect.kind==='booking'&&effect.keys?.length){
      const first=root(effect.keys[0]);for(const key of effect.keys)parent.set(root(key),first);
    }
  }
  return key=>parent.has(key)?root(key):key;
}
function taskTarget(task){
  const effect=(task.effects||[]).find(e=>['booking','walkin','walkin-delete','sms'].includes(e.kind));
  const first=task.steps[0];
  if(first.key==='__order__wait'||task.effects?.some(e=>e.kind==='order'))return '__order__wait';
  return effect?.keys?.[0]||effect?.key||first.key||task.entity;
}
function findOperationBooking(keys){return [...bookings,...newBookings].find(b=>keys.includes(operationKey(b)));}
function findOperationWalkin(key){return walkinList.find(w=>`walkin|${w.phone}|${w.time}`===key);}
function operationTargetPresent(task){
  const effects=task.effects||[];
  if(!effects.some(e=>e.kind==='booking'||(e.kind==='sms'&&!e.walkin)))return true;
  const identity=operationIdentityMap(),entity=identity(taskTarget(task)),keys=new Set();
  let creating=false;
  for(const related of operationTasks().filter(isPendingOperation))if(identity(taskTarget(related))===entity){
    for(const e of related.effects||[])if(e.kind==='booking'||(e.kind==='sms'&&!e.walkin)){
      for(const key of e.keys||[])keys.add(key);
      if(e.create&&operationState(related)!=='confirmed')creating=true;
    }
  }
  return creating||[...(OPS.base?.bookings||[]),...(OPS.base?.newBookings||[])].some(b=>keys.has(operationKey(b)));
}
function bookingEffect(key,patch,options={}){
  const row=findOperationBooking([key,...(options.keys||[])]);
  return {...options,kind:'booking',keys:[key,...(options.keys||[])],patch,row:row?cloneOperation(row):options.row};
}
function effectsForBody(body){
  if(body.action==='setStatus'){
    if(body.key==='__order__wait')return [{kind:'order',keys:body.meta?.orderKeys||[]}];
    const patch={};if(body.status!==undefined){patch.done=body.status==='done';patch.movedToWait=true;}
    if(body.meta?.memo!==undefined)patch.memo=body.meta.memo;
    if(body.meta?.origTime!==undefined)patch.origTime=body.meta.origTime;
    if(body.meta?.sentSms)patch.sentSMS=body.meta.sentSms;
    if(body.key.startsWith('walkin|'))return [{kind:'walkin',key:body.key,patch:{...patch,...(body.meta?.sentSms?{sentSms:body.meta.sentSms}:{})}}];
    return [bookingEffect(body.key,patch)];
  }
  if(body.action==='markClaimSeen')return [{kind:'claim',type:body.type,orderNo:String(body.orderNo)}];
  if(body.action==='saveOpMemos')return [{kind:'opMemos',value:body.memos}];
  if(body.action==='saveSmsConfig')return [{kind:'smsConfig',settings:body.settings,memos:body.memos}];
  if(body.action==='setFleet')return [{kind:'fleet',vehicle:body.vehicle,values:body}];
  if(body.action==='deleteStatus' && body.key.startsWith('walkin|'))return [{kind:'walkin-delete',key:body.key}];
  return [];
}
function applyOperationEffects(){
  // Always project from the last server base. Applying A→B→C repeatedly to an
  // already projected C used to create an extra A/B row during queue changes.
  if(OPS.base){const base=cloneOperation(OPS.base);({bookings,newBookings,walkinList,doneOrder,walkinDoneOrder,waitCustomOrder}=base);}
  const tasks=operationTasks().filter(isPendingOperation);
  const identity=operationIdentityMap(tasks);
  const aliases=new Map(),entities=new Map();
  for(const task of tasks){
    const entity=identity(taskTarget(task)),keys=aliases.get(entity)||new Set();
    for(const e of task.effects||[])if(e.kind==='booking')for(const key of e.keys||[])keys.add(key);
    aliases.set(entity,keys);
  }
  for(const [entity,keys] of aliases)entities.set(entity,findOperationBooking([...keys]));
  for(const b of [...bookings,...newBookings]){b.sending={};b.operationState='';}
  for(const w of walkinList){w.sending={};w.operationState='';}
  for(const task of tasks){
    const state=operationState(task),entity=identity(taskTarget(task));
    for(const effect of task.effects||[]){
      if(effect.kind==='booking'){
        let b=entities.get(entity)||findOperationBooking(effect.keys);
        // Snapshots on edits are recovery records, never evidence of a current
        // reservation. Only an explicit, not-yet-confirmed addition creates a row.
        if(!b && effect.create && (state!=='confirmed'||!OPS.raw||OPS.rawAt<=Number(task.finishedAt||task.updatedAt)) && effect.row){b={...cloneOperation(effect.row),id:nextId++};(b.isNew?newBookings:bookings).push(b);}
        if(!b)continue;
        entities.set(entity,b);
        if(effect.remove){bookings=bookings.filter(x=>x!==b);newBookings=newBookings.filter(x=>x!==b);continue;}
        const sent={...(b.sentSMS||{}),...(effect.patch?.sentSMS||{})};Object.assign(b,cloneOperation(effect.patch||{}));b.sentSMS=sent;
        if(state!=='confirmed')b.operationState=state;
      }else if(effect.kind==='walkin'){
        let w=findOperationWalkin(effect.key);
        if(!w){const [,phone,time]=effect.key.split('|');w={id:walkinNextId++,phone,time,done:false,sentSms:{}};walkinList.push(w);}
        const sent={...(w.sentSms||{}),...(effect.patch?.sentSms||{})};Object.assign(w,cloneOperation(effect.patch||{}));w.sentSms=sent;
        if(state!=='confirmed')w.operationState=state;
      }else if(effect.kind==='walkin-delete')walkinList=walkinList.filter(w=>`walkin|${w.phone}|${w.time}`!==effect.key);
      else if(effect.kind==='sms'){
        const b=effect.walkin?findOperationWalkin(effect.key):(entities.get(entity)||findOperationBooking(effect.keys));
        if(!b)continue;
        const completed=state==='confirmed'||Number(task.nextStep||task.cursor||0)>0;
        if(completed){const prop=effect.walkin?'sentSms':'sentSMS';b[prop]={...(b[prop]||{}),[effect.label]:true};}
        else{b.sending=b.sending||{};b.sending[effect.label]=state;}
      }else if(effect.kind==='order'){
        waitCustomOrder=effect.keys.map(key=>findOperationBooking([key])?.id).filter(id=>id!==undefined);
      }else if(effect.kind==='opMemos')opMemos=cloneOperation(effect.value);
      else if(effect.kind==='smsConfig'){
        for(const setting of effect.settings||[]){const s=smsSettings.find(x=>String(x.id)===String(setting.id));if(s)Object.assign(s,setting);}
        memos=(effect.memos||[]).map(m=>({...m,id:parseInt(String(m.id).replace('memo',''),10)||memoNextId++}));syncSmsToMain();
      }else if(effect.kind==='fleet'){
        const prefix={pa:'pa',o:'o',ko:'ko'}[effect.vehicle]||effect.vehicle;
        for(const [field,value] of Object.entries(effect.values)){const el=document.getElementById(`fl-${prefix}-${field==='remain'?'rem':field}`);if(el && Number.isFinite(value))el.value=value;}
      }
    }
  }
  const all=[...bookings,...newBookings];
  preserveConfirmedCancelledSms();
  doneOrder=[...new Set([...doneOrder.filter(id=>all.some(b=>b.id===id&&b.done)),...all.filter(b=>b.done).map(b=>b.id)])];
  walkinDoneOrder=[...new Set([...walkinDoneOrder.filter(id=>walkinList.some(w=>w.id===id&&w.done)),...walkinList.filter(w=>w.done).map(w=>w.id)])];
}
function rememberCoreBase(){
  OPS.base={...(OPS.base||{}),...cloneOperation({bookings,newBookings,walkinList,doneOrder,walkinDoneOrder,waitCustomOrder})};
}
function rebaseOperationModel(){
  if(!OPS.base)return;
  const base=cloneOperation(OPS.base);
  ({bookings,newBookings,walkinList,doneOrder,walkinDoneOrder,waitCustomOrder}=base);
  if(base.opMemos)opMemos=base.opMemos;
  if(base.memos)memos=base.memos;
  if(base.smsSettings){smsSettings.splice(0,smsSettings.length,...base.smsSettings);syncSmsToMain();}
  preserveConfirmedCancelledSms();
}
function preserveConfirmedCancelledSms(){
  // Cancelling a remainder must not erase a confirmed SMS delivery.
  for(const task of operationTasks().filter(t=>t.day===localDay()&&operationState(t)==='cancelled'&&t.cursor>0)){
    for(const e of task.effects||[])if(e.kind==='sms'){
      const b=e.walkin?findOperationWalkin(e.key):findOperationBooking(e.keys);
      if(b){const prop=e.walkin?'sentSms':'sentSMS';b[prop]={...(b[prop]||{}),[e.label]:true};}
    }
  }
}
function saveOperationCache(){
  if(!OPS.started||OPS.modelDay!==localDay()||OPS.modelSource!==operationScope())return;
  try{
    const model={version:2,base:OPS.base,day:localDay(),scope:operationScope(),lastSuccess:CORE.lastSuccess,bookings,newBookings,doneOrder,waitCustomOrder,nextId,walkinList,walkinNextId,walkinDoneOrder,opMemos,opMemoNextId};
    localStorage.setItem(operationCacheKey(),JSON.stringify(model));
  }catch(error){OPS.storageError='이 브라우저에 작업을 저장할 공간이 부족합니다. 저장 대기 목록을 확인해 주세요.';}
}
function restoreOperationCache(){
  try{
    const cached=JSON.parse(localStorage.getItem(operationCacheKey())||'null');
    if(!cached||cached.version!==2||cached.day!==localDay()||cached.scope!==operationScope())return;
    if(![cached.bookings,cached.newBookings,cached.walkinList].every(Array.isArray))return;
    const validBooking=b=>isRecord(b)&&Number.isFinite(b.id)&&['time','name','phone'].every(k=>typeof b[k]==='string')&&Array.isArray(b.vehicles)&&b.vehicles.every(v=>isRecord(v)&&typeof v.code==='string'&&Number.isFinite(Number(v.qty)));
    if(![...cached.bookings,...cached.newBookings].every(validBooking)||!cached.walkinList.every(w=>isRecord(w)&&Number.isFinite(w.id)&&typeof w.phone==='string'&&typeof w.time==='string'))throw new Error('INVALID_CACHE');
    bookings=cached.bookings;newBookings=cached.newBookings;walkinList=cached.walkinList;
    doneOrder=cached.doneOrder||[];waitCustomOrder=cached.waitCustomOrder||[];walkinDoneOrder=cached.walkinDoneOrder||[];
    nextId=Math.max(10000,cached.nextId||0,...[...bookings,...newBookings].map(b=>b.id+1));
    walkinNextId=Math.max(9000,cached.walkinNextId||0,...walkinList.map(w=>w.id+1));
    opMemos=cached.opMemos||[];opMemoNextId=cached.opMemoNextId||1;
    if(cached.base&&[cached.base.bookings,cached.base.newBookings,cached.base.walkinList,cached.base.doneOrder,cached.base.walkinDoneOrder,cached.base.waitCustomOrder].every(Array.isArray)&&[...cached.base.bookings,...cached.base.newBookings].every(validBooking))OPS.base=cached.base;else rememberCoreBase();
    CORE.lastSuccess=cached.lastSuccess||0;CORE.lastDate=localDay();CORE.error='마지막 저장 목록 사용 중';OPS.verified=!!cached.lastSuccess;
  }catch(error){OPS.storageError='저장한 예약 목록을 읽지 못했습니다. 서버 목록을 다시 확인합니다.';}
}
function operationsChanged(){
  if(OPS.paintScheduled)return;OPS.paintScheduled=true;
  queueMicrotask(()=>{OPS.paintScheduled=false;ensureOperationContext();if(OPS.needsRebase){OPS.needsRebase=false;rebaseOperationModel();}applyOperationEffects();saveOperationCache();render();renderWalkinTbl();paintOperationQueue();paintClaims();});
}
function ensureOperationContext(){
  if(OPS.modelDay===localDay()&&OPS.modelSource===operationScope())return;
  const sourceChanged=OPS.modelSource!==operationScope();
  OPS.modelDay=localDay();OPS.modelSource=operationScope();OPS.verified=false;OPS.raw=null;OPS.claims=[];OPS.base=null;
  CORE.lastSuccess=0;CORE.lastDate='';CORE.generation++;CORE.error='새 날짜·연결의 예약을 확인합니다';
  bookings=[];newBookings=[];walkinList=[];doneOrder=[];walkinDoneOrder=[];waitCustomOrder=[];bulkSelected.clear();opMemos=[];
  if(sourceChanged&&OPS.outbox){OPS.outbox.dispose();createOperationOutbox();}
  restoreOperationCache();restoreSupportingCache();if(!OPS.base)rememberCoreBase();render();renderWalkinTbl();paintClaims();
}
function createOperationOutbox(){
  OPS.scope=operationScope();
  const dispatchUrl=GAS_URL,scope=OPS.scope;
  OPS.tasks=[];OPS.smsStates=new Map();OPS.identityReady=false;
  OPS.outbox=CoconaraOutbox.create({storage:localStorage,scope:OPS.scope,day:localDay,lock:navigator.locks,
    canSend:()=>OPS.identityReady && OPS.verified && scope===operationScope() && OPS.modelDay===localDay() && !_settingsApplying && navigator.onLine!==false,
    canDispatch:task=>!!OPS.raw && operationTargetPresent(task),
    verify:(body,task)=>verifyOperationStep(body,task,OPS.readback),
    independentOfUncertain:(next,previous)=>previous.steps[previous.cursor]?.action==='sendSms' && next.steps.every(body=>body.action==='setStatus' && body.key===previous.steps.find(step=>step.action==='setStatus')?.key && !body.meta?.sentSms),
    send:async(body)=>{
      _writesPending++;_writeRevision++;netPaint();
      try{return await fetchT(dispatchUrl,{method:'POST',body:JSON.stringify(body)},CFG.timeoutMs,diagnostic=>{
        if(diagnostic.phase==='complete'||diagnostic.code!=='OK'){
          try{const key='coconara-operation-diagnostics',history=JSON.parse(localStorage.getItem(key)||'[]');
            history.push({at:new Date().toISOString(),action:body.action,phase:diagnostic.phase,code:diagnostic.code,status:diagnostic.status,elapsedMs:diagnostic.elapsedMs});
            localStorage.setItem(key,JSON.stringify(history.slice(-100)));
          }catch(_){}
        }
      });}
      finally{_writesPending--;_writeRevision++;_writeQuietUntil=Date.now()+500;netPaint();scheduleOperationVerification();}
    },onChange:(tasks,diagnostics)=>{if(OPS.scope!==scope)return;OPS.diagnostics=diagnostics||{};if(tasks)indexOperationTasks(tasks);operationsChanged();}});
  indexOperationTasks(OPS.outbox.list());
  const identity=operationIdentityMap();
  OPS.outbox.migrateEntities(task=>task.day===localDay()?identity(taskTarget(task)):task.entity).then(()=>{
    if(OPS.scope!==scope)return;OPS.identityReady=true;OPS.outbox.flush();scheduleOperationVerification();
  }).catch(()=>{OPS.storageError='기존 작업을 안전하게 정리하지 못했습니다. 원본 기록은 보존돼 있습니다.';paintOperationQueue();});
}
async function flushOperations(){if(OPS.outbox)await OPS.outbox.flush();}
function enqueueOperation(steps,options={}){
  if(_settingsApplying)throw operationError('연결 설정을 적용하는 동안 잠시 기다려 주세요.');
  ensureOperationContext();
  if(!OPS.outbox||OPS.scope!==operationScope())throw operationError('연결 설정을 먼저 확인해 주세요.');
  const effects=options.effects||steps.flatMap(effectsForBody);
  const proposedEntity=options.entity||steps[0].key||steps[0].phone||steps[0].action;
  const entity=operationIdentityMap()(proposedEntity);
  let entry;
  try{entry=OPS.outbox.enqueue(steps,{label:options.label||steps[0].action,entity,effects});}
  catch(error){OPS.storageError='작업을 이 컴퓨터에 저장하지 못했습니다. 저장 공간을 확인해 주세요.';paintOperationQueue();throw error;}
  _writeRevision++;applyOperationEffects();saveOperationCache();render();renderWalkinTbl();paintOperationQueue();
  return entry.promise.then(result=>{
    if(result.status==='confirmed'||result.state==='confirmed'){scheduleAuxiliaryRefresh(effects);return result.results?.at(-1)||{ok:true};}
    throw operationError(result.status==='cancelled'?'작업을 취소했습니다.':'전송 결과 확인이 필요합니다. 저장 대기 목록에서 확인해 주세요.');
  });
}
gasPost=function(body,opt={}){return enqueueOperation([body],opt);};
coreWritable=function(){if(OPS.started)ensureOperationContext();return !_settingsApplying;};
checkDay=function(){ensureOperationContext();setDate();};
applyReservationReadOnlyControls=function(){
  // Connectivity never locks the whole operating screen. Individual pending SMS
  // buttons are disabled by their own state, not by a global DOM scan.
  const root=document.getElementById('page-resv');if(root)root.dataset.readonly='false';
};
corePaint=function(){
  paintReadDiagnostics();
  const text=document.getElementById('sync-pill-txt');if(text)text.textContent=CORE.error?'조회 지연':(_loadingCore?'조회 중':'갱신 완료');
  const meter=document.getElementById('operation-last-read');if(meter)meter.textContent=CORE.lastSuccess?new Date(CORE.lastSuccess).toLocaleString('ko-KR'):'아직 없음';
  const add=document.getElementById('add-booking-button');if(add)add.disabled=!!_settingsApplying;
  for(const id of ['page-resv','page-sms','claim-banner']){const el=document.getElementById(id);if(el){el.removeAttribute('inert');el.removeAttribute('aria-disabled');}}
  const retry=document.getElementById('reservation-retry');if(retry)retry.disabled=!!_loadingCore;
  if(CORE.fleetLoaded)document.querySelectorAll('.fleet-panel input').forEach(el=>{el.disabled=!!_settingsApplying;});
};

// Three read slots and one bounded auxiliary lane are independent of writes.
let _auxChain=Promise.resolve();const _auxReads=new Map();
gasGet=function(action,params={},opt={}){
  const url=GAS_URL,query=new URLSearchParams({action,...params});
  const native=window.coconaraReservation;
  const timeout=READ_ACTIONS.includes(action)?Number(opt.timeout||CFG.timeoutMs):Math.min(Number(opt.timeout)||15000,15000);
  const run=async()=>{
    if(native?.read && (native.readActions||READ_ACTIONS).includes(action) && !Object.keys(params).length){
      const result=await native.read({url,action,timeoutMs:timeout});
      if(!result.ok)throw Object.assign(new Error(result.error||'시트 연결 오류'),{code:result.diagnostic?.code});
      return result.data;
    }
    return fetchT(`${url}?${query}`,{},timeout,raw=>{
    opt.onDiagnostic?.(raw,raw.code!=='OK'?'failed':(raw.phase==='complete'?'success':'pending'),0);
    });
  };
  if(READ_ACTIONS.includes(action)||opt.fresh)return run();
  const key=url+'?'+query;if(_auxReads.has(key))return _auxReads.get(key);
  // Balance providers can be slow; their reads never occupy the memo/fleet lane.
  const balance=['getSolapiBalance','getNaverAdBalance'].includes(action);
  const promise=balance?run():_auxChain.then(run,run);if(!balance)_auxChain=promise.catch(()=>{});_auxReads.set(key,promise);
  promise.finally(()=>_auxReads.delete(key)).catch(()=>{});return promise;
};
const originalFetchCore=fetchCore;
fetchCore=async function(priority){
  if(!window.coconaraReservation?.read)return originalFetchCore(priority);
  const attempt=++_readAttempt;
  CORE.readDiagnostics=READ_ACTIONS.map(action=>({action,state:'pending',phase:'headers',code:'OK',startedAt:Date.now(),timeoutMs:CFG.timeoutMs}));
  const responses=await Promise.allSettled(READ_ACTIONS.map(async action=>{
    const result=await window.coconaraReservation.read({url:GAS_URL,action,timeoutMs:CFG.timeoutMs});
    noteReadDiagnostic(attempt,action,result.diagnostic||{},result.ok?'success':'failed',Date.now());
    if(!result.ok)throw Object.assign(new Error(result.error||'시트 연결 오류'),{code:result.diagnostic?.code});
    try{validateCore({dataB:action==='getBookings'?result.data:{bookings:[]},dataN:action==='getNew'?result.data:{newBookings:[]},dataS:action==='getStatus'?result.data:{statusMap:{}}});}
    catch(error){noteReadDiagnostic(attempt,action,{...result.diagnostic,phase:'validation',code:'INVALID_PAYLOAD'},'failed',Date.now());throw error;}
    return result.data;
  }));
  const failed=responses.find(r=>r.status==='rejected');if(failed)throw failed.reason;
  const payload={dataB:responses[0].value,dataN:responses[1].value,dataS:responses[2].value};validateCore(payload);return payload;
};
const originalApplyCore=applyCore;
applyCore=function(payload){
  OPS.raw=cloneOperation(payload);OPS.rawAt=Date.now();originalApplyCore(payload);rememberCoreBase();OPS.verified=true;
  applyOperationEffects();saveOperationCache();render();renderWalkinTbl();
};
const originalLoadCore=loadBookingsFromGAS;
loadBookingsFromGAS=function(options){
  ensureOperationContext();const readAt=Date.now();
  return originalLoadCore(options).then(async ok=>{applyOperationEffects();render();renderWalkinTbl();if(ok){OPS.verified=true;OPS.readback={...OPS.raw,scope:operationScope(),day:localDay(),readAt};saveOperationCache();await OPS.outbox.verifyPending();reconcileOperations();flushOperations();}return ok;});
};
canAutoRead=function(){
  const active=document.activeElement;
  return !document.hidden && !_settingsApplying && !_loadingCore && !_writesPending && Date.now()>=_writeQuietUntil && Date.now()-LAST_TOUCH>=1500 && !(active && active.id!=='search-input' && !active.readOnly && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
};
function containsOperationValue(actual,expected){
  if(expected&&typeof expected==='object'&&!Array.isArray(expected))return !!actual&&Object.entries(expected).every(([key,value])=>containsOperationValue(actual[key],value));
  return JSON.stringify(actual)===JSON.stringify(expected);
}
function verifyOperationStep(body,task,snapshot){
  if(!snapshot||snapshot.scope!==operationScope()||snapshot.day!==task.day||snapshot.readAt<task.updatedAt)return false;
  const state=snapshot.dataS;
  const matches=(rows,time,name,phone)=>Array.isArray(rows)?rows.filter(r=>r.time===time&&r.name===name&&r.phone===phone):null;
  if(body.action==='setStatus')return !!state && (body.status===undefined||state.statusMap?.[body.key]===body.status) && (body.meta===undefined||containsOperationValue(state.metaMap?.[body.key]||{},body.meta));
  if(body.action==='deleteStatus')return !!state&&!Object.hasOwn(state.statusMap,body.key)&&!Object.hasOwn(state.metaMap||{},body.key);
  if(body.action==='migrateStatusKey'){
    // The cell edit precedes this stage. No old status/meta means there is
    // nothing left to migrate; never infer success while the old key remains.
    return !!state&&!Object.hasOwn(state.statusMap,body.oldKey)&&!Object.hasOwn(state.metaMap||{},body.oldKey);
  }
  if(body.action==='updateBookingCell'){
    const rows=body.sheet==='new'?snapshot.dataN?.newBookings:snapshot.dataB?.bookings;
    const keys={time:body.matchTime,name:body.matchName,phone:body.matchPhone};
    if(Object.hasOwn(keys,body.field))keys[body.field]=body.value;
    const found=matches(rows,keys.time,keys.name,keys.phone);if(found?.length!==1)return false;
    const row=found[0],effect=task.effects?.find(e=>e.kind==='booking');
    if(body.field==='vehicles')return !!effect?.patch?.vehicles&&containsOperationValue(row.vehicles,effect.patch.vehicles);
    return String(row[body.field==='site'?'channel':body.field]??'')===String(body.value??'');
  }
  if(body.action==='moveNewToBookings'){
    const moved=matches(snapshot.dataB?.bookings,body.time,body.name,body.phone),remaining=matches(snapshot.dataN?.newBookings,body.time,body.name,body.phone);
    return moved?.length===1&&remaining?.length===0;
  }
  if(body.action==='deleteBookingRow'){
    const found=matches(body.sheet==='new'?snapshot.dataN?.newBookings:snapshot.dataB?.bookings,body.matchTime,body.matchName,body.matchPhone);
    return found?.length===0;
  }
  if(body.action==='setFleet'){
    const fleet=snapshot.dataFleet?.fleet?.[body.vehicle];
    return !!fleet&&['avail','remain'].every(key=>body[key]===undefined||Number(fleet[key])===Number(body[key]));
  }
  if(body.action==='markClaimSeen')return Array.isArray(snapshot.dataClaims?.claims)&&!snapshot.dataClaims.claims.some(c=>String(c.type)===String(body.type)&&String(c.orderNo)===String(body.orderNo));
  if(body.action==='saveOpMemos'){
    const normalize=items=>items.map(m=>({id:String(m.id),title:String(m.title||''),body:String(m.body||'')}));
    return Array.isArray(snapshot.dataMemos?.opMemos)&&JSON.stringify(normalize(snapshot.dataMemos.opMemos))===JSON.stringify(normalize(body.memos||[]));
  }
  if(body.action==='saveSmsConfig'){
    const data=snapshot.dataSms;if(!Array.isArray(data?.settings)||!Array.isArray(data?.memos))return false;
    const settings=items=>items.map(m=>({id:Number(m.id),name:String(m.name||''),body:String(m.body||'')}));
    const memos=items=>items.map(m=>({id:String(m.id),title:String(m.title||''),body:String(m.body||'')}));
    return JSON.stringify(settings(data.settings))===JSON.stringify(settings(body.settings||[]))&&JSON.stringify(memos(data.memos))===JSON.stringify(memos(body.memos||[]));
  }
  // SMS, additions and externally consequential work need a server receipt.
  // A local overlay, absent error, or an old sentSms marker is not that receipt.
  return false;
}
function scheduleOperationVerification(){
  if(OPS.verifyTimer||OPS.verification)return;
  OPS.verifyTimer=setTimeout(()=>{OPS.verifyTimer=null;verifyOperations().catch(()=>{});},5000);
}
async function verifyOperations(){
  if(OPS.verification)return OPS.verification;
  const pending=operationTasks().filter(t=>t.day===localDay()&&operationState(t)==='uncertain');
  if(!pending.length||navigator.onLine===false||_settingsApplying)return [];
  const scope=operationScope(),day=localDay(),readAt=Date.now(),actions=new Set();
  for(const task of pending){const body=task.steps[task.cursor];
    if(['setStatus','deleteStatus','migrateStatusKey'].includes(body.action))actions.add('getStatus');
    if(['updateBookingCell','deleteBookingRow'].includes(body.action))actions.add(body.sheet==='new'?'getNew':'getBookings');
    if(body.action==='moveNewToBookings'){actions.add('getBookings');actions.add('getNew');}
    const auxiliary={setFleet:'getFleet',markClaimSeen:'getClaims',saveOpMemos:'getOpMemos',saveSmsConfig:'getSmsConfig'}[body.action];
    if(auxiliary)actions.add(auxiliary);
  }
  if(!actions.size)return [];
  OPS.verification=(async()=>{
    const snapshot={scope,day,readAt};
    await Promise.allSettled([...actions].map(async action=>{
      const data=await gasGet(action,{}, {timeout:20000,fresh:true});
      if(action==='getStatus'&&isRecord(data.statusMap)&&isRecord(data.metaMap||{}))snapshot.dataS=data;
      if(action==='getBookings'&&Array.isArray(data.bookings))snapshot.dataB=data;
      if(action==='getNew'&&Array.isArray(data.newBookings))snapshot.dataN=data;
      if(action==='getFleet'&&isRecord(data.fleet))snapshot.dataFleet=data;
      if(action==='getClaims'&&Array.isArray(data.claims))snapshot.dataClaims=data;
      if(action==='getOpMemos'&&Array.isArray(data.opMemos))snapshot.dataMemos=data;
      if(action==='getSmsConfig'&&Array.isArray(data.settings)&&Array.isArray(data.memos))snapshot.dataSms=data;
    }));
    if(scope!==operationScope()||day!==localDay())return [];
    OPS.readback=snapshot;
    const result=await OPS.outbox.verifyPending();
    if(result.length)scheduleCore(1000);
    return result;
  })().finally(()=>{OPS.verification=null;if(operationTasks().some(t=>t.day===localDay()&&operationState(t)==='uncertain')){
    OPS.verifyTimer=setTimeout(()=>{OPS.verifyTimer=null;verifyOperations().catch(()=>{});},30000);
  }});
  return OPS.verification;
}
function reconcileOperations(){
  if(!OPS.raw||!OPS.outbox)return;
  const {dataB,dataN,dataS}=OPS.raw,rows=[...dataB.bookings,...dataN.newBookings];
  const exact=keys=>rows.find(r=>keys.includes(operationKey(r)));
  function reflected(e){
    if(e.kind==='booking'){
      const row=exact(e.keys);if(e.remove)return !row;if(!row)return false;
      const key=operationKey(row),meta=dataS.metaMap?.[key]||{},state=dataS.statusMap?.[key];
      return Object.entries(e.patch||{}).every(([k,v])=>k==='done'?(state===(v?'done':'wait')):k==='movedToWait'?(!v||dataB.bookings.includes(row)):k==='memo'?String(meta.memo||'')===String(v||''):k==='origTime'?String(meta.origTime||'')===String(v||''):k==='sentSMS'?Object.keys(v).every(n=>meta.sentSms?.[n]===v[n]):k==='site'?row.channel===v:k==='vehicles'?JSON.stringify(row.vehicles)===JSON.stringify(v):k==='totalQty'?Number(row.qty)===Number(v):row[k]===v);
    }
    if(e.kind==='walkin'){
      const meta=dataS.metaMap?.[e.key]||{},status=dataS.statusMap?.[e.key];
      return !!status && Object.entries(e.patch||{}).every(([k,v])=>k==='done'?status===(v?'done':'wait'):k==='sentSms'?Object.keys(v).every(n=>meta.sentSms?.[n]===v[n]):meta[k]===v);
    }
    if(e.kind==='walkin-delete')return !dataS.statusMap?.[e.key];
    if(e.kind==='sms'){const key=e.key||e.keys.find(k=>dataS.metaMap?.[k]?.sentSms?.[e.label]);return !!dataS.metaMap?.[key]?.sentSms?.[e.label];}
    if(e.kind==='order')return JSON.stringify(dataS.metaMap?.__order__wait?.orderKeys)===JSON.stringify(e.keys);
    return false;
  }
  // Retire an entity's confirmed history together. Removing only the newest
  // 'wait' would otherwise expose an older confirmed 'done' overlay again.
  const groups=new Map(),retire=new Set();
  for(const task of operationTasks().filter(t=>t.day===localDay()&&operationState(t)!=='cancelled')){
    if(!groups.has(task.entity))groups.set(task.entity,[]);groups.get(task.entity).push(task);
  }
  for(const tasks of groups.values()){
    if(tasks.some(t=>operationState(t)!=='confirmed'))continue;
    const folded=new Map();
    for(const task of tasks)for(const effect of task.effects||[]){
      const id=effect.kind==='sms'?'sms:'+effect.label:effect.kind;
      const previous=folded.get(id),next=cloneOperation(effect);
      if(previous&&['booking','walkin'].includes(effect.kind)){
        next.patch={...previous.patch,...effect.patch};
        for(const prop of ['sentSMS','sentSms'])if(previous.patch?.[prop]||effect.patch?.[prop])next.patch[prop]={...previous.patch?.[prop],...effect.patch?.[prop]};
        if(effect.keys)next.keys=[...new Set([...previous.keys,...effect.keys])];
      }
      folded.set(id,next);
    }
    if(folded.get('booking')?.remove){folded.delete('sms');for(const k of [...folded.keys()])if(k.startsWith('sms:'))folded.delete(k);}
    if(folded.has('walkin-delete')){folded.delete('walkin');for(const k of [...folded.keys()])if(k.startsWith('sms:'))folded.delete(k);}
    if(folded.size&&[...folded.values()].every(reflected))tasks.forEach(t=>retire.add(t.id));
  }
  OPS.outbox.reconcile(task=>retire.has(task.id)||(operationState(task)==='cancelled'&&(task.cursor===0||(task.effects||[]).filter(e=>e.kind==='sms').every(reflected)))).catch(()=>{});
}
const AUX_KINDS={getOpMemos:'opMemos',getSmsConfig:'smsConfig',getFleet:'fleet',getClaims:'claim'};
async function retireAuxiliary(kind,startedAt){
  if(!OPS.outbox)return;
  await OPS.outbox.reconcile(task=>operationState(task)==='confirmed' && Number(task.finishedAt||task.updatedAt)<=startedAt && task.effects?.length && task.effects.every(e=>e.kind===kind));
}
loadOpMemosFromGAS=async function(){
  const scope=operationScope(),startedAt=Date.now(),revision=_writeRevision;
  try{
    const data=await gasGet('getOpMemos');if(!Array.isArray(data.opMemos))throw invalidPayload();
    if(scope!==operationScope()||revision!==_writeRevision)return;
    await retireAuxiliary('opMemos',startedAt);if(scope!==operationScope()||revision!==_writeRevision)return;
    opMemos=data.opMemos.map(m=>({id:Number(m.id)||opMemoNextId++,title:String(m.title||''),body:String(m.body||'')}));
    opMemoNextId=Math.max(0,...opMemos.map(m=>m.id))+1;if(OPS.base)OPS.base.opMemos=cloneOperation(opMemos);applyOperationEffects();renderOpMemos();saveOperationCache();
  }catch(error){CORE.auxiliary.memos='메모 조회 지연';}
};
loadSmsConfigFromGAS=function(){
  if(_smsConfigRequest)return _smsConfigRequest;
  const scope=operationScope(),startedAt=Date.now(),revision=_smsEditRevision;
  _smsConfigRequest=(async()=>{
    try{
      const data=await gasGet('getSmsConfig');if(!Array.isArray(data.settings)||!Array.isArray(data.memos))throw invalidPayload();
      if(scope!==operationScope()||revision!==_smsEditRevision)return;
      await retireAuxiliary('smsConfig',startedAt);if(scope!==operationScope()||revision!==_smsEditRevision)return;
      for(const setting of data.settings){const target=smsSettings.find(x=>String(x.id)===String(setting.id));if(target){target.name=String(setting.name||target.name);target.body=String(setting.body??'');}}
      memos=data.memos.map(m=>({id:parseInt(String(m.id).replace('memo',''),10)||memoNextId++,title:String(m.title||''),body:String(m.body||'')}));
      memoNextId=Math.max(1000,...memos.map(m=>m.id))+1;if(OPS.base){OPS.base.memos=cloneOperation(memos);OPS.base.smsSettings=cloneOperation(smsSettings);}applyOperationEffects();syncSmsToMain();smsConfigLoaded=true;renderSmsPage();
    }catch(error){CORE.auxiliary.sms='문자 설정 조회 지연';smsConfigLoaded=false;}
    finally{_smsConfigRequest=null;}
  })();return _smsConfigRequest;
};
loadFleet=async function(){
  if(_fleetBusy||!canAutoRead())return;_fleetBusy=true;
  const scope=operationScope(),startedAt=Date.now(),revision=_writeRevision;
  try{
    const data=await gasGet('getFleet');
    if(!isRecord(data.fleet)||!['pa','o','ko'].every(k=>isRecord(data.fleet[k])&&['avail','remain'].every(f=>Number.isFinite(Number(data.fleet[k][f]))&&Number(data.fleet[k][f])>=0)))throw invalidPayload();
    if(scope!==operationScope()||revision!==_writeRevision)return;
    await retireAuxiliary('fleet',startedAt);if(scope!==operationScope()||revision!==_writeRevision)return;
    for(const vehicle of ['pa','o','ko'])for(const field of ['avail','remain'])document.getElementById(`fl-${vehicle}-${field==='remain'?'rem':field}`).value=data.fleet[vehicle][field];
    CORE.fleetLoaded=true;delete CORE.auxiliary.fleet;applyOperationEffects();saveSupportingCache();
  }catch(error){CORE.auxiliary.fleet='차량 현황 조회 지연';}finally{_fleetBusy=false;corePaint();}
};

function queueBookingEdit(b,time,name,phone,field,value,oldKey,newKey,metaPatch){
  const steps=[{action:'updateBookingCell',sheet:b.isNew&&!b.movedToWait?'new':'bookings',matchTime:time,matchName:name,matchPhone:phone,field,value}];
  if(oldKey!==newKey)steps.push({action:'migrateStatusKey',oldKey,newKey});
  if(metaPatch)steps.push({action:'setStatus',key:newKey,meta:metaPatch});
  const patch=field==='vehicles'?{vehicles:b.vehicles,totalQty:b.totalQty}:{[field]:b[field]};if(metaPatch)Object.assign(patch,metaPatch);
  enqueueOperation(steps,{entity:oldKey,label:'예약 내용 수정',effects:[bookingEffect(oldKey,patch,{keys:[newKey],row:cloneOperation(b)})]}).catch(()=>{});
}
moveToWait=function(id){
  if(!coreWritable())return;
  const b=[...bookings,...newBookings].find(x=>x.id===id);if(!b||b.movedToWait)return;
  const key=operationKey(b),steps=[{action:'setStatus',key,status:'wait'}];
  if(b.isNew)steps.push({action:'moveNewToBookings',time:b.time,name:b.name,phone:b.phone});
  enqueueOperation(steps,{entity:key,label:'신규 → 대기',effects:[bookingEffect(key,{movedToWait:true,done:false})]}).catch(()=>{});
};
markDone=function(id){
  if(!coreWritable())return;
  const b=[...bookings,...newBookings].find(x=>x.id===id);if(!b)return;
  const key=operationKey(b),done=!b.done;bulkSelected.delete(id);
  enqueueOperation([{action:'setStatus',key,status:done?'done':'wait'}],{entity:key,label:done?'완료 처리':'대기로 복귀',effects:[bookingEffect(key,{done,movedToWait:true})]}).catch(()=>{});
};
saveStatusToGAS=function(key,status,meta){
  const body={action:'setStatus',key};if(status!==undefined)body.status=status;if(meta!==undefined)body.meta=meta;
  return gasPost(body,{label:key==='__order__wait'?'대기 목록 순서 저장':'상태·비고 저장'}).catch(()=>({uncertain:true}));
};

changeTimeByDrag=function(b,time){
  if(!coreWritable())return;
  const old=operationKey(b),previous=b.time,draft=cloneOperation(b);if(!draft.origTime)draft.origTime=previous;draft.time=time;if(time===draft.origTime)draft.origTime='';
  try{queueBookingEdit(draft,previous,b.name,b.phone,'time',time,old,operationKey(draft),{origTime:draft.origTime||''});}catch(error){toast('시간을 저장하지 못했습니다.');}
};
addBookingDirectToGAS=async function(time,name,vehiclesStr,site,qty,phone){
  const key=`${time}|${name}|${phone}`,b=findOperationBooking([key]);
  try{return await enqueueOperation([{action:'addBookingDirect',time,name,vehiclesStr,site,qty,phone}],{entity:key,label:'예약 추가',effects:[bookingEffect(key,{}, {row:b,create:true})]});}catch(error){return {uncertain:true};}
};
deleteBookingFromDone=function(id){
  if(!coreWritable())return;
  const b=[...bookings,...newBookings].find(x=>x.id===id);if(!b||!confirm('이 예약을 구글시트에서도 삭제할까요?'))return;
  const key=operationKey(b);
  enqueueOperation([{action:'deleteStatus',key},{action:'deleteBookingRow',sheet:b.isNew&&!b.movedToWait?'new':'bookings',matchTime:b.time,matchName:b.name,matchPhone:b.phone}],{entity:key,label:'예약 삭제',effects:[bookingEffect(key,{}, {remove:true})]}).catch(()=>{});
};

const auxiliaryRefreshKinds=new Set();let auxiliaryRefreshTimer=null;
function scheduleAuxiliaryRefresh(effects){
  for(const e of effects)if(['opMemos','smsConfig','fleet','claim'].includes(e.kind))auxiliaryRefreshKinds.add(e.kind);
  if(!auxiliaryRefreshKinds.size||auxiliaryRefreshTimer)return;
  auxiliaryRefreshTimer=setTimeout(()=>{
    auxiliaryRefreshTimer=null;const kinds=[...auxiliaryRefreshKinds];auxiliaryRefreshKinds.clear();
    for(const kind of kinds)({opMemos:loadOpMemosFromGAS,smsConfig:loadSmsConfigFromGAS,fleet:loadFleet,claim:loadClaims})[kind]();
  },2000);
}
saveOpMemosToGAS=function(){
  return enqueueOperation([{action:'saveOpMemos',memos:opMemos.map(m=>({id:String(m.id),title:m.title,body:m.body}))}],{entity:'opMemos',label:'운영 메모 저장'}).catch(()=>({uncertain:true}));
};
saveSmsConfigToGAS=function(){
  _smsEditRevision++;
  return enqueueOperation([{action:'saveSmsConfig',settings:smsSettings.map(s=>({id:s.id,name:s.name,body:s.body})),memos:memos.map(m=>({id:'memo'+m.id,title:m.title,body:m.body}))}],{entity:'smsConfig',label:'문자·메모 설정 저장'}).then(()=>true,()=>false);
};
function safeLocalMutation(original){return function(...args){
  if(!coreWritable())return;
  const previous=cloneOperation({smsSettings,memos,opMemos,waitCustomOrder,bookings,newBookings,walkinList,doneOrder,walkinDoneOrder});
  try{return original.apply(this,args);}
  catch(error){
    ({memos,opMemos,waitCustomOrder,bookings,newBookings,walkinList,doneOrder,walkinDoneOrder}=previous);
    smsSettings.splice(0,smsSettings.length,...previous.smsSettings);syncSmsToMain();
    render();renderWalkinTbl();renderOpMemos();renderSmsPage();toast('저장하지 못했습니다. 입력 내용을 다시 확인해 주세요.');
  }
};}
for(const name of ['addOpMemo','deleteOpMemo','updateOpMemo','addMemo','deleteMemo','updateMemo','saveMemoNow','saveSms'])window[name]=safeLocalMutation(window[name]);
deleteWalkinFromDone=function(id){
  if(!coreWritable())return;const w=walkinList.find(x=>x.id===id);if(!w||!confirm('이 현장손님을 완료 목록에서 삭제할까요?'))return;
  const key=`walkin|${w.phone}|${w.time}`;
  try{enqueueOperation([{action:'deleteStatus',key}],{entity:key,label:'현장손님 삭제'}).catch(()=>{});}catch(error){toast('저장하지 못했습니다. 다시 확인해 주세요.');}
};

function smsOperationState(key,label){
  return OPS.smsStates.get(key+'::'+label)||'';
}
function sendQueuedSms(b,t,walkin){
  if(!coreWritable())return Promise.resolve(false);
  const key=walkin?`walkin|${b.phone}|${b.time}`:operationKey(b);
  if(smsOperationState(key,t.label))return Promise.resolve(false);
  if((walkin?b.sentSms:b.sentSMS)?.[t.label] && !confirm(`${t.title} 문자가 이미 발송된 표시가 있습니다. 다시 발송할까요?`))return Promise.resolve(false);
  const effects=[{kind:'sms',key:walkin?key:undefined,keys:walkin?undefined:[key],walkin:!!walkin,label:t.label}];
  return enqueueOperation([{action:'sendSms',phone:b.phone,settingId:Number(t.label)},{action:'setStatus',key,meta:{sentSms:{[t.label]:true}}}],{entity:key,label:`${walkin?'현장':'예약'} 문자 ${t.label}번`,effects}).then(()=>true,()=>false);
}
sendSMS=function(id,type){const b=[...bookings,...newBookings].find(x=>x.id===id),t=SMS.find(x=>x.id===type);return b&&t?sendQueuedSms(b,t,false):Promise.resolve(false);};
sendWalkinSmsRow=function(id,type){const w=walkinList.find(x=>x.id===id),t=SMS.find(x=>x.id===type);return w&&t?sendQueuedSms(w,t,true):Promise.resolve(false);};
bulkSendSms=function(type){const ids=[...bulkSelected];bulkSelected.clear();updateBulkBar();return Promise.all(ids.map(id=>sendSMS(id,type)));};
function operationSmsButton(b,s,walkin){
  const key=walkin?`walkin|${b.phone}|${b.time}`:operationKey(b),state=smsOperationState(key,s.label),sent=!!(walkin?b.sentSms:b.sentSMS)?.[s.label];
  const label=state==='sending'?'발송 중':state==='queued'?'발송 대기':state==='uncertain'?'결과 확인 필요':sent?'발송 완료':'미발송';
  const escape=text=>String(text||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return `<button class="sms-num ${s.cls}${sent?' sent':''}${['sending','queued'].includes(state)?' sending':''}${state==='uncertain'?' uncertain':''}" ${state?'disabled':''} title="${escape(s.title)} · ${label}" onclick="${walkin?'sendWalkinSmsRow':'sendSMS'}(${b.id},'${s.id}')">${s.label}${state?'<span class="sr-only"> '+label+'</span>':''}</button>`;
}
smsCell=function(b){
  const main=SMS.filter(s=>s.main).map(s=>operationSmsButton(b,s,false)).join(''),extra=SMS.filter(s=>!s.main).map(s=>operationSmsButton(b,s,false)).join('');
  return `<div class="sms-wrap"><div class="sms-main-btns">${main}</div><button class="sms-toggle" onclick="toggleExtra(${b.id})">${extraOpen[b.id]?'▲':'▼'}</button></div><div class="sms-extra-row${extraOpen[b.id]?' open':''}">${extra}</div>`;
};
const originalRenderWalkin=renderWalkinTbl,originalRenderDone=renderDoneTbl;
function enhanceWalkinSms(){
  for(const root of [document.getElementById('walkin-tbl'),document.getElementById('done-tbl')]){
    root?.querySelectorAll('.sms-num[onclick]').forEach(el=>{
      const match=el.getAttribute('onclick').match(/sendWalkinSmsRow\((\d+),'([^']+)'\)/);if(!match)return;
      const w=walkinList.find(x=>x.id===Number(match[1])),s=SMS.find(x=>x.id===match[2]);if(w&&s)el.outerHTML=operationSmsButton(w,s,true);
    });
  }
}
renderWalkinTbl=function(){originalRenderWalkin();enhanceWalkinSms();};
renderDoneTbl=function(list){originalRenderDone(list);enhanceWalkinSms();};

function claimHidden(c){return operationTasks().some(t=>isPendingOperation(t)&&(t.effects||[]).some(e=>e.kind==='claim'&&e.type===c.type&&e.orderNo===String(c.orderNo)));}
function paintClaims(){
  const root=document.getElementById('claim-banner');if(!root)return;
  const fragment=document.createDocumentFragment();
  for(const c of OPS.claims.filter(c=>!claimHidden(c))){
    const row=document.createElement('div');row.className='claim-row';
    const info=document.createElement('span');info.className='claim-info';info.textContent=[c.type,c.time,c.name,c.phone].filter(Boolean).join(' ');
    const button=document.createElement('button');button.className='claim-ok';button.textContent='확인';button.addEventListener('click',()=>markClaimSeen(c.type,String(c.orderNo)));
    row.append(info,button);fragment.append(row);
  }
  root.replaceChildren(fragment);root.style.display=root.childElementCount?'flex':'none';root.removeAttribute('inert');
}
loadClaims=async function(){
  const scope=operationScope(),startedAt=Date.now();
  try{const data=await gasGet('getClaims');if(!Array.isArray(data.claims))throw invalidPayload();if(scope!==operationScope())return;await retireAuxiliary('claim',startedAt);if(scope!==operationScope())return;OPS.claims=data.claims;delete CORE.auxiliary.claims;paintClaims();}
  catch(error){CORE.auxiliary.claims='알림 조회 지연';}
};
markClaimSeen=function(type,orderNo){return enqueueOperation([{action:'markClaimSeen',type,orderNo}],{entity:`claim:${type}:${orderNo}`,label:'취소·반품 알림 확인',effects:[{kind:'claim',type,orderNo:String(orderNo)}]}).catch(()=>{});};
let _balanceAt=0,_balancePromise=null;
const balanceValues=new Map();
function paintBalances(){
  const el=document.getElementById('balance-badges');if(!el)return;
  const fragment=document.createDocumentFragment();
  for(const [key,value] of balanceValues){
    const badge=document.createElement('span');badge.className='balance-badge';
    const stale=!!value.stale;badge.textContent=`${key==='getSolapiBalance'?'솔라피':'네이버광고'} 잔액 ${value.amount.toLocaleString()}원${stale?' · 이전 조회':''}`;
    badge.title=`마지막 확인 ${new Date(value.at).toLocaleString('ko-KR')}${stale?' · 현재 조회 지연':''}`;fragment.append(badge);
  }
  el.replaceChildren(fragment);
}
loadBalances=function(){
  if(_balancePromise)return _balancePromise;if(Date.now()-_balanceAt<300000)return Promise.resolve();
  const scope=operationScope();_balanceAt=Date.now();
  _balancePromise=Promise.allSettled(['getSolapiBalance','getNaverAdBalance'].map(async action=>{
    try{const data=await gasGet(action),amount=Number(action==='getSolapiBalance'?data.total:data.bizmoney);if(!Number.isFinite(amount))throw invalidPayload();
      if(scope!==operationScope())return;balanceValues.set(action,{amount:Math.floor(amount),at:Date.now(),stale:false});
    }catch(_){if(scope!==operationScope())return;const old=balanceValues.get(action);if(old)old.stale=true;CORE.auxiliary.balance='잔액 조회 지연';}
    paintBalances();saveSupportingCache();
  })).finally(()=>{_balancePromise=null;});return _balancePromise;
};
function supportingCacheKey(){return operationCacheKey()+':support';}
function saveSupportingCache(){
  try{const fleet={};for(const v of ['pa','o','ko']){fleet[v]={};for(const f of ['avail','rem']){const text=document.getElementById(`fl-${v}-${f}`)?.value;if(text!==''&&Number.isFinite(Number(text)))fleet[v][f]=Number(text);}}
    localStorage.setItem(supportingCacheKey(),JSON.stringify({balances:[...balanceValues],fleet}));
  }catch(_){}
}
function restoreSupportingCache(){
  balanceValues.clear();_balanceAt=0;
  try{const cache=JSON.parse(localStorage.getItem(supportingCacheKey())||'null');if(!cache)return;
    for(const [key,value] of cache.balances||[])if(['getSolapiBalance','getNaverAdBalance'].includes(key)&&Number.isFinite(value.amount)&&Number.isFinite(value.at))balanceValues.set(key,{...value,stale:true});
    for(const v of ['pa','o','ko'])for(const f of ['avail','rem'])if(Number.isFinite(cache.fleet?.[v]?.[f])){const el=document.getElementById(`fl-${v}-${f}`);el.value=cache.fleet[v][f];el.title='마지막 저장 값 · 새 조회 후 갱신';}
  }catch(_){}paintBalances();
}

function isArchivedOperationDisplay(task){
  // Keep uncertain SMS receipts visible even if the reservation left the sheet.
  return operationState(task)!=='sending'
    && !(operationState(task)==='uncertain' && task.steps[task.cursor||0]?.action==='sendSms')
    && (task.day!==localDay() || (!!OPS.raw && !operationTargetPresent(task)));
}
function paintOperationQueue(){
  const button=document.getElementById('operations-toggle'),list=document.getElementById('operations-list');if(!button||!list)return;
  const pending=operationTasks().filter(t=>!['confirmed','cancelled'].includes(operationState(t)));
  const archived=pending.filter(isArchivedOperationDisplay),tasks=pending.filter(t=>!isArchivedOperationDisplay(t));
  button.textContent=tasks.length?`저장 대기 ${tasks.length}`:'저장 대기';button.classList.toggle('has-pending',!!tasks.length);
  const fragment=document.createDocumentFragment();
  if(OPS.storageError){const p=document.createElement('p');p.textContent=OPS.storageError;p.className='operation-error';fragment.append(p);}
  if(OPS.diagnostics.lockSupported===false&&tasks.length){const p=document.createElement('p');p.textContent='이 브라우저는 안전한 단일 전송을 지원하지 않습니다. 최신 Chrome 또는 운영 플랫폼에서 사용해 주세요. 대기 작업은 보관돼 있습니다.';fragment.append(p);}
  const history=document.createElement('details');history.className='operation-history';
  const summary=document.createElement('summary');summary.textContent=`보관 기록 ${archived.length}건`;history.append(summary);
  const captions={queued:'연결 후 전송 대기',sending:'전송 중',uncertain:'처리 결과 확인 필요'};
  for(const task of [...tasks,...archived]){
    const archivedDisplay=isArchivedOperationDisplay(task);
    const row=document.createElement('div');row.className='operation-row';
    const label=document.createElement('strong');label.textContent=task.label||'저장 작업';
    const target=document.createElement('span');const effect=(task.effects||[]).find(e=>e.row||e.key||e.keys);const rowInfo=effect?.row;const parts=String(effect?.keys?.[0]||effect?.key||task.entity).split('|');
    target.textContent=taskTarget(task)==='__order__wait'?'목록 표시 순서':rowInfo?`${rowInfo.time} ${rowInfo.name} · ${String(rowInfo.phone).slice(-4)}`:parts[0]==='walkin'?`현장 ${parts[2]||''} · ${String(parts[1]).slice(-4)}`:parts.length===3?`${parts[0]} ${parts[1]} · ${parts[2].slice(-4)}`:String(task.entity).slice(0,65);
    const status=document.createElement('span');status.textContent=task.day!==localDay()?'이전 날짜 작업 · 자동 전송 안 함':OPS.raw&&!operationTargetPresent(task)?'현재 시트에 없는 예약 · 기록 보관 중, 자동 전송 안 함':captions[operationState(task)]||'확인 필요';row.append(label,target,status);
    if(!archivedDisplay && operationState(task)==='uncertain'){
      const currentStep=task.steps[task.cursor||0];const ack=document.createElement('button');ack.textContent=currentStep?.action==='sendSms'?'발송내역 확인 후 완료':'서버 반영 다시 확인';ack.onclick=()=>{
        if(currentStep?.action!=='sendSms'){ack.disabled=true;verifyOperations().finally(()=>paintOperationQueue());return;}
        const actionName=currentStep?.action==='sendSms'?'문자 발송':currentStep?.action==='setStatus'?'처리 상태 저장':currentStep?.action==='moveNewToBookings'?'신규 예약 이전':task.label;
        if(confirm(`${target.textContent} · ${actionName}\n구글시트 또는 문자 발송내역에서 이 단계가 처리된 것을 확인했나요? 확인하면 남은 단계가 이어서 처리됩니다.`))OPS.outbox.resolve(task.id,'confirmed').catch(()=>toast('확인 내용을 저장하지 못했습니다.'));
      };row.append(ack);
    }
    if(!archivedDisplay && operationState(task)==='queued'&&task.cursor===0){
      const cancel=document.createElement('button');cancel.textContent=operationState(task)==='queued'&&task.cursor===0?'대기 취소':'기록 정리';cancel.onclick=()=>{
        if(confirm(operationState(task)==='queued'&&task.cursor===0?'아직 전송하지 않은 작업을 취소할까요?':'구글시트·문자 발송내역에서 처리 결과를 확인한 후 기록을 정리해 주세요. 이미 전달된 작업을 취소하는 기능은 아닙니다. 결과를 확인했나요?')){OPS.outbox.resolve(task.id,'cancelled').then(()=>loadBookingsFromGAS({quiet:true})).catch(()=>toast('대기 기록을 저장하지 못했습니다.'));}
      };row.append(cancel);
    }
    (archivedDisplay?history:fragment).append(row);
  }
  if(!tasks.length&&!OPS.storageError){const empty=document.createElement('p');empty.textContent='대기 중인 작업이 없습니다.';fragment.append(empty);}
  if(archived.length)fragment.append(history);
  list.replaceChildren(fragment);
}
function installOperationUI(){
  const style=document.createElement('style');style.textContent=`#reservation-sync-status,#reservation-continuity-help,#sync-pill{display:none!important}.operations-panel{padding:14px;background:#fff;border:2px solid #275a39;margin:10px 14px}.operation-row{display:flex;gap:12px;align-items:center;padding:10px 0;flex-wrap:wrap;border-bottom:1px solid #ccd7cc}.operation-row button,#operations-toggle{font:inherit;font-weight:700;padding:8px 12px;border:1px solid #285c37;border-radius:6px;background:white;color:#174728;cursor:pointer}.operation-error{color:#a13215;font-weight:700}#operations-toggle.has-pending{background:#fff1d8}.sms-num.sending{animation:sms-pulse .8s infinite alternate!important}.sms-num.uncertain{outline:2px solid #a34415}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}@keyframes sms-pulse{from{opacity:1}to{opacity:.25}}`;
  document.head.append(style);
  const toggle=document.createElement('button');toggle.id='operations-toggle';toggle.type='button';toggle.textContent='저장 대기';toggle.setAttribute('aria-expanded','false');
  const panel=document.createElement('section');panel.id='operations-panel';panel.className='operations-panel';panel.hidden=true;
  const title=document.createElement('strong');title.textContent='이 화면에서 접수한 작업';
  const help=document.createElement('p');help.textContent='작업은 이 기기에 보관됩니다. 일반 저장은 서버 반영 여부를 자동 확인하며, 다른 고객의 업무는 계속 처리합니다. 문자 발송 결과만 불명확한 경우 발송내역 확인이 필요합니다.';
  const list=document.createElement('div');list.id='operations-list';panel.append(title,help,list);
  toggle.onclick=()=>{panel.hidden=!panel.hidden;toggle.setAttribute('aria-expanded',String(!panel.hidden));paintOperationQueue();};
  const header=document.getElementById('sync-pill')?.parentElement||document.body;header.append(toggle);header.after(panel);
  const config=document.querySelector('#page-config .cfg-wrap');if(config){const p=document.createElement('p');p.textContent='마지막 전체 예약 조회: ';const time=document.createElement('span');time.id='operation-last-read';p.append(time);config.prepend(p);}
}
function startReservationRuntime(){
  installOperationUI();OPS.started=true;OPS.modelDay=localDay();OPS.modelSource=operationScope();restoreOperationCache();restoreSupportingCache();if(!OPS.base)rememberCoreBase();createOperationOutbox();applyOperationEffects();setDate();render();renderWalkinTbl();renderOpMemos();corePaint();paintOperationQueue();
  window.addEventListener('online',()=>{loadBookingsFromGAS({quiet:true});verifyOperations().catch(()=>{});flushOperations().catch(()=>{});});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){operationsChanged();flushOperations();}});
  window.addEventListener('pagehide',saveOperationCache);
  setInterval(()=>{if(navigator.onLine!==false&&operationTasks().some(t=>t.day===localDay()&&operationState(t)==='queued'))flushOperations().catch(()=>{});},30000);
  Promise.resolve().then(()=>loadBookingsFromGAS({quiet:true}));
}
startReservationRuntime();
