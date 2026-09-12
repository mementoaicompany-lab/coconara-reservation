'use strict';
// Shared by the website and the desktop reservation page. No network requests.
(function(global){
  const WAIT_SLOTS=Object.freeze(['8시','9시','10시','11시','12시','1시','2시','3시','4시','5시','6시']);
  const slotIndex=new Map(WAIT_SLOTS.map((label,index)=>[label,index]));
  const WIDTH_KEY='coconara_column_widths_v1';
  function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
  const defaults={select:34,action:64,time:112,name:142,vehicles:106,channel:90,phone:160,sms:110,amount:94,memo:160,delete:58};
  const labels={select:'선택',action:'완료',time:'시간',name:'이름',vehicles:'차량',channel:'채널',phone:'연락처',sms:'문자',amount:'금액',memo:'비고',delete:'삭제'};
  let widths={};
  try{const saved=JSON.parse(global.localStorage.getItem(WIDTH_KEY)||'{}');for(const key of Object.keys(defaults)){if(Number.isFinite(saved[key]))widths[key]=Math.max(34,Math.min(1200,Math.round(saved[key])));}}catch(_error){}
  const width=key=>widths[key]||defaults[key]||100;
  function storeWidths(){try{global.localStorage.setItem(WIDTH_KEY,JSON.stringify(widths));}catch(_error){}}
  function slotRank(time){return slotIndex.has(String(time).trim())?slotIndex.get(String(time).trim()):WAIT_SLOTS.length;}
  function sortWaitRows(list,customOrder=[]){
    const order=new Map(customOrder.map((id,index)=>[id,index]));
    return list.slice().sort((a,b)=>{
      const byTime=slotRank(a.time)-slotRank(b.time);
      if(byTime) return byTime;
      // Extra labels stay in one final group; user ordering cannot move a row
      // across the fixed time slots.
      const ai=order.has(a.id)?order.get(a.id):Infinity;
      const bi=order.has(b.id)?order.get(b.id):Infinity;
      if(ai!==bi) return ai-bi;
      return 0;
    });
  }
  function groupWaitRows(list){
    const groups=WAIT_SLOTS.map(time=>({time,rows:[],fixed:true}));
    const other={time:'그외',rows:[],fixed:false};
    for(const row of list){const rank=slotRank(row.time);(rank<groups.length?groups[rank]:other).rows.push(row);}
    if(other.rows.length)groups.push(other);
    return groups;
  }
  function bindInlineEditor(input,handlers){
    let composing=false,compositionEnding=false,finished=false,pendingBlur=false,timer=null;
    const clear=()=>{if(timer!==null){global.clearTimeout(timer);timer=null;}};
    const finish=()=>{
      clear();
      if(finished||composing||!pendingBlur)return;
      finished=true;
      handlers.save();
    };
    const afterInput=()=>{clear();timer=global.setTimeout(finish,0);};
    input.addEventListener('compositionstart',()=>{composing=true;compositionEnding=false;});
    input.addEventListener('compositionend',()=>{
      composing=false;compositionEnding=true;
      // Some macOS IMEs dispatch the committing Enter after compositionend.
      // Let that event finish before accepting a separate save keypress.
      global.setTimeout(()=>{compositionEnding=false;},0);
      if(pendingBlur)afterInput();
    });
    input.addEventListener('blur',()=>{pendingBlur=true;afterInput();});
    input.addEventListener('keydown',event=>{
      if(finished||composing||compositionEnding||event.isComposing||event.keyCode===229)return;
      if(event.key==='Enter'){
        event.preventDefault();
        input.blur();
      }else if(event.key==='Escape'){
        event.preventDefault();finished=true;clear();input.blur();
        if(handlers.cancel)handlers.cancel();
      }
    });
    return {cancel(){if(finished)return;finished=true;clear();input.blur();if(handlers.cancel)handlers.cancel();}};
  }
  function keysFor(table){
    return [...table.querySelectorAll('thead th')].map(th=>{
      const text=th.textContent.trim();
      if(th.querySelector('input[type=checkbox]'))return 'select';
      if(['완료','대기','복귀'].includes(text))return 'action';
      return ({시간:'time',이름:'name',구분:'name',차량:'vehicles',채널:'channel',연락처:'phone',문자:'sms',금액:'amount',메모:'memo',비고:'memo',삭제:'delete'})[text]||null;
    });
  }
  function applyWidths(table){
    const cols=[...table.querySelectorAll(':scope > colgroup > col')];
    let total=0;
    for(const col of cols){const value=width(col.dataset.columnKey);col.style.width=value+'px';total+=value;}
    table.style.width=total+'px';table.style.minWidth=total+'px';
    for(const handle of table.querySelectorAll('.column-resize-handle'))handle.setAttribute('aria-valuenow',String(width(handle.dataset.columnKey)));
  }
  function resizeColumn(key,value){
    widths[key]=Math.max(34,Math.min(1200,Math.round(value)));
    global.document.querySelectorAll('table.resizable-booking-table').forEach(applyWidths);
  }
  function enhanceTables(container){
    if(!container||!['active-tbl','new-tbl','done-tbl','walkin-tbl'].includes(container.id))return;
    for(const table of container.querySelectorAll('table')){
      if(table.dataset.columnsReady==='true')continue;
      const keys=keysFor(table);
      if(!keys.length||keys.some(key=>!key))continue;
      table.dataset.columnsReady='true';table.classList.add('resizable-booking-table');
      const colgroup=global.document.createElement('colgroup');
      for(const key of keys){const col=global.document.createElement('col');col.dataset.columnKey=key;colgroup.appendChild(col);}
      table.insertBefore(colgroup,table.firstChild);
      [...table.querySelectorAll('thead th')].forEach((th,index)=>{
        const key=keys[index];
        const handle=global.document.createElement('span');
        handle.className='column-resize-handle';handle.dataset.columnKey=key;
        handle.setAttribute('role','separator');handle.setAttribute('tabindex','0');
        handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-label',labels[key]+' 열 너비 조절');
        handle.setAttribute('aria-valuemin','34');handle.setAttribute('aria-valuemax','1200');
        handle.title='끌어서 너비 조절 · 두 번 클릭하면 기본 너비';
        handle.addEventListener('pointerdown',event=>{
          if(event.button!==0)return;
          event.preventDefault();event.stopPropagation();
          const start=event.clientX,initial=width(key),pointerId=event.pointerId;
          global.document.body.classList.add('resizing-columns');
          try{handle.setPointerCapture(pointerId);}catch(_error){}
          const move=e=>{if(e.pointerId!==pointerId)return;resizeColumn(key,initial+e.clientX-start);};
          const end=e=>{
            if(e.pointerId!==pointerId)return;
            global.document.removeEventListener('pointermove',move);global.document.removeEventListener('pointerup',end);global.document.removeEventListener('pointercancel',end);
            global.document.body.classList.remove('resizing-columns');storeWidths();
            try{handle.releasePointerCapture(pointerId);}catch(_error){}
          };
          global.document.addEventListener('pointermove',move);global.document.addEventListener('pointerup',end);global.document.addEventListener('pointercancel',end);
        });
        handle.addEventListener('click',event=>event.stopPropagation());
        handle.addEventListener('dblclick',event=>{event.preventDefault();event.stopPropagation();resizeColumn(key,defaults[key]);storeWidths();});
        handle.addEventListener('keydown',event=>{
          if(!['ArrowLeft','ArrowRight','Home'].includes(event.key))return;
          event.preventDefault();event.stopPropagation();
          resizeColumn(key,event.key==='Home'?defaults[key]:width(key)+(event.key==='ArrowRight'?10:-10));storeWidths();
        });
        th.appendChild(handle);
      });
      applyWidths(table);
    }
  }
  global.CoconaraUI=Object.freeze({WAIT_SLOTS,sortWaitRows,groupWaitRows,bindInlineEditor,enhanceTables,escapeHtml});
})(window);
