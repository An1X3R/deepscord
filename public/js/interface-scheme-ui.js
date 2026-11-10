// @ts-check
/** @typedef {import('./interface-scheme.js').InterfaceScheme} InterfaceScheme */
/** @typedef {import('./interface-scheme.js').InterfaceSelection} InterfaceSelection */
/** @typedef {{value:string,label:string,description:string}} Choice */
/** @typedef {{initialSelection:InterfaceSelection|null,initialPreset:'industrial'|'constructivist',listSchemes:()=>Promise<{directory:string,schemes:InterfaceScheme[]}>,openDirectory:()=>Promise<void>,preview:(selection:InterfaceSelection)=>void,save:(selection:InterfaceSelection)=>Promise<void>,reportError:(error:Error)=>void}} EditorOptions */

/** @template {keyof HTMLElementTagNameMap} T @param {T} tag @param {string} className @param {string} text @returns {HTMLElementTagNameMap[T]} */
function node(tag,className,text){const element=document.createElement(tag);element.className=className;element.textContent=text;return element;}
/** @param {string} id @param {string} className @param {string} text @returns {HTMLButtonElement} */
function button(id,className,text){const element=node('button',className,text);element.type='button';element.id=id;element.dataset.testid=id;return element;}

/** @param {{id:string,label:string,choices:Choice[],value:string,change:(value:string)=>void,footer:HTMLButtonElement|null,signal:AbortSignal}} options @returns {{element:HTMLElement,refresh:(choices:Choice[],value:string)=>void,close:()=>void}} */
function picker(options){
  const element=node('div','scheme-picker','');
  const trigger=button(options.id,'scheme-picker-trigger','');
  trigger.setAttribute('role','combobox');trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-label',options.label);trigger.setAttribute('aria-controls',options.id+'List');
  const caption=node('span','scheme-picker-caption','');const chevron=node('span','scheme-picker-chevron','⌄');chevron.setAttribute('aria-hidden','true');trigger.append(caption,chevron);
  const popup=node('div','scheme-picker-popup','');popup.hidden=true;popup.setAttribute('popover','manual');
  const list=node('div','scheme-picker-list','');list.id=options.id+'List';list.setAttribute('role','listbox');list.setAttribute('aria-label',options.label);popup.append(list);
  if(options.footer)popup.append(options.footer);
  element.append(trigger,popup);
  let choices=options.choices,value=options.value,active=0;
  /** @type {HTMLElement[]} */
  let rows=[];
  /** @returns {void} */
  function close(){if(popup.matches(':popover-open'))popup.hidePopover();popup.hidden=true;trigger.setAttribute('aria-expanded','false');trigger.removeAttribute('aria-activedescendant');}
  /** @returns {void} */
  function position(){const bounds=trigger.getBoundingClientRect();popup.style.left=bounds.left+'px';popup.style.width=bounds.width+'px';const below=window.innerHeight-bounds.bottom-12,above=bounds.top-12;const height=Math.min(340,Math.max(below,above));popup.style.maxHeight=height+'px';popup.style.top=(below>=Math.min(230,above)?bounds.bottom+5:Math.max(8,bounds.top-popup.scrollHeight-5))+'px';}
  /** @returns {void} */
  function highlight(){rows.forEach((row,index)=>{row.dataset.active=String(index===active);});const row=rows[active];if(row){trigger.setAttribute('aria-activedescendant',row.id);row.scrollIntoView({block:'nearest'});}}
  /** @returns {void} */
  function open(){if(trigger.disabled)return;popup.hidden=false;popup.showPopover();position();trigger.setAttribute('aria-expanded','true');active=Math.max(0,choices.findIndex(choice=>choice.value===value));highlight();}
  /** @param {string} selected @returns {void} */
  function choose(selected){options.change(selected);close();trigger.focus();}
  /** @param {Choice[]} next @param {string} selected @returns {void} */
  function refresh(next,selected){
    choices=next;value=selected;list.replaceChildren();rows=[];
    caption.textContent=choices.find(choice=>choice.value===value)?.label ?? '请选择界面方案';trigger.disabled=!choices.length && options.footer===null;
    if(!choices.length)list.append(node('p','scheme-picker-empty','目录中没有可用方案，请通过下方入口添加。'));
    for(const [index,choice] of choices.entries()){
      const row=node('div','scheme-picker-option','');row.id=options.id+'Option-'+index;row.dataset.testid=row.id;row.dataset.value=choice.value;row.setAttribute('role','option');row.setAttribute('aria-selected',String(choice.value===value));
      const copy=node('span','scheme-picker-copy','');copy.append(node('strong','',choice.label));if(choice.description)copy.append(node('small','',choice.description));
      const mark=node('span','scheme-picker-check',choice.value===value?'✓':'');mark.setAttribute('aria-hidden','true');row.append(copy,mark);rows.push(row);list.append(row);
      row.addEventListener('pointermove',()=>{active=index;highlight();},{signal:options.signal});row.addEventListener('pointerdown',event=>event.preventDefault(),{signal:options.signal});row.addEventListener('click',()=>choose(choice.value),{signal:options.signal});
    }
    if(!popup.hidden)highlight();
  }
  trigger.addEventListener('click',()=>{if(popup.hidden)open();else close();},{signal:options.signal});
  trigger.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      event.preventDefault();if(popup.hidden){open();if(event.key==='ArrowDown' || event.key==='ArrowUp')return;}
      if(!choices.length)return;
      active=event.key==='Home'?0:event.key==='End'?choices.length-1:(active+(event.key==='ArrowDown'?1:-1)+choices.length)%choices.length;highlight();
    }else if((event.key==='Enter' || event.key===' ') && !popup.hidden){event.preventDefault();const choice=choices[active];if(choice)choose(choice.value);}
  },{signal:options.signal});
  element.addEventListener('keydown',event=>{if(event.key==='Escape' && !popup.hidden){event.preventDefault();event.stopPropagation();close();trigger.focus();}},{signal:options.signal});
  document.addEventListener('pointerdown',event=>{if(event.target instanceof Node && !element.contains(event.target))close();},{signal:options.signal});
  element.addEventListener('focusout',event=>{if(!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget))close();},{signal:options.signal});
  window.addEventListener('resize',()=>{if(!popup.hidden)position();},{signal:options.signal});
  document.addEventListener('scroll',event=>{if(!popup.hidden && event.target instanceof Node && !popup.contains(event.target))position();},{signal:options.signal,capture:true});
  options.signal.addEventListener('abort',close,{once:true});
  refresh(choices,value);return {element,refresh,close};
}

/** @param {EditorOptions} options @returns {{element:HTMLElement,dispose:()=>void}} */
export function createInterfaceSchemeEditor(options){
  const controller=new AbortController(),signal=controller.signal;
  let optionController=new AbortController();
  let disposed=false,loading=false,refreshPending=false,saving=false,available=false,libraryIssue=false;
  /** @type {InterfaceScheme[]} */
  let schemes=[];
  /** @type {InterfaceSelection|null} */
  let selection=options.initialSelection?structuredClone(options.initialSelection):null;
  const element=node('form','customization-form scheme-editor','');element.id='customizationThemeForm';
  const heading=node('label','scheme-selector-label','界面方案');heading.htmlFor='customizationInterfacePreset';
  const directory=button('customizationSchemeDirectory','scheme-directory','+ 安装界面方案');
  const selector=picker({id:'customizationInterfacePreset',label:'界面方案',choices:[],value:'',change:selectScheme,footer:directory,signal});
  const description=node('p','customization-description scheme-description','正在读取界面方案…');
  const fields=node('div','scheme-options','');fields.id='customizationSchemeOptions';
  const actions=node('div','customization-actions','');const save=button('customizationThemeSave','btn primary','保存界面方案');save.type='submit';save.disabled=true;actions.append(save);
  const status=node('p','customization-status','');status.id='customizationSchemeStatus';status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.hidden=true;
  element.append(heading,selector.element,description,fields,actions,status);
  /** @param {Error} error @returns {void} */
  function report(error){if(disposed)return;status.textContent=error.message;status.dataset.state='error';status.setAttribute('role','alert');status.hidden=false;options.reportError(error);}
  /** @returns {Choice[]} */
  function schemeChoices(){return schemes.map(scheme=>({value:scheme.id,label:scheme.name,description:scheme.description}));}
  /** @param {string} id @param {string|number|boolean} value @returns {void} */
  function update(id,value){if(!selection)return;selection={scheme:selection.scheme,values:{...selection.values,[id]:value}};status.hidden=true;options.preview(structuredClone(selection));}
  /** @returns {void} */
  function renderOptions(){
    optionController.abort();optionController=new AbortController();fields.replaceChildren();
    const current=selection;if(!current)return;
    description.textContent=current.scheme.description;
    for(const option of current.scheme.options){
      const id='customizationSchemeOption-'+option.id;
      const row=node('div','scheme-option-field','');const label=node('label','customization-field','');label.htmlFor=id;label.append(node('span','',option.label));
      const value=current.values[option.id] ?? option.default;
      if(option.type==='select'){
        const control=picker({id,label:option.label,choices:option.choices.map(choice=>({value:choice.value,label:choice.label,description:''})),value:String(value),change:next=>{update(option.id,next);control.refresh(option.choices.map(choice=>({value:choice.value,label:choice.label,description:''})),next);},footer:null,signal:optionController.signal});
        row.append(label,control.element);
      }else if(option.type==='range'){
        const control=node('input','scheme-range','');control.id=id;control.dataset.testid=id;control.type='range';control.min=String(option.min);control.max=String(option.max);control.step=String(option.step);control.value=String(value);
        const output=node('output','scheme-range-value',String(value)+option.unit);output.htmlFor=id;control.addEventListener('input',()=>{output.value=control.value+option.unit;update(option.id,Number(control.value));},{signal:optionController.signal});label.append(control);row.append(label,output);
      }else{
        const control=node('input','scheme-toggle','');control.id=id;control.dataset.testid=id;control.type='checkbox';control.checked=value===true;control.addEventListener('change',()=>update(option.id,control.checked),{signal:optionController.signal});label.prepend(control);row.append(label);
      }
      fields.append(row);
    }
    if(!current.scheme.options.length)fields.append(node('p','customization-description scheme-no-options','此方案没有开放可调参数。'));
  }
  /** @param {string} id @returns {void} */
  function selectScheme(id){
    const scheme=schemes.find(entry=>entry.id===id);if(!scheme){report(new Error('界面方案不存在：'+id));return;}
    selection={scheme,values:Object.fromEntries(scheme.options.map(option=>[option.id,option.default]))};available=true;save.disabled=saving;status.hidden=true;
    selector.refresh(schemeChoices(),id);renderOptions();options.preview(structuredClone(selection));
  }
  /** @returns {Promise<void>} */
  async function refreshLibrary(){
    if(disposed)return;if(loading){refreshPending=true;return;}loading=true;
    try{
      const library=await options.listSchemes();if(disposed)return;schemes=library.schemes;directory.title=library.directory;
      if(!selection){const nearest=schemes.find(scheme=>scheme.interfaceProfile.preset===options.initialPreset) ?? schemes[0];if(!nearest)throw new Error('界面方案目录为空，请在目录中添加有效的方案文件。');selectScheme(nearest.id);}
      else{
        available=schemes.some(scheme=>scheme.id===selection?.scheme.id);selector.refresh(schemeChoices(),selection.scheme.id);renderOptions();
        if(!available)throw new Error('当前界面方案已从目录移除：'+selection.scheme.name+'。请选择其他方案后保存。');
      }
      save.disabled=!available || saving;
      if(libraryIssue){status.hidden=true;libraryIssue=false;}
    }catch(error){available=false;libraryIssue=true;save.disabled=true;report(error instanceof Error?error:new Error(String(error)));}
    finally{loading=false;if(refreshPending){refreshPending=false;void refreshLibrary();}}
  }
  directory.addEventListener('click',()=>{
    selector.close();directory.disabled=true;
    void options.openDirectory().then(()=>{if(disposed)return;status.textContent='资源管理器已打开，安装界面方案后返回即可选择。';status.dataset.state='saved';status.setAttribute('role','status');status.hidden=false;}).catch(error=>report(error instanceof Error?error:new Error(String(error)))).finally(()=>{directory.disabled=false;});
  },{signal});
  element.addEventListener('submit',event=>{
    event.preventDefault();if(!selection || saving || !available)return;
    const snapshot=structuredClone(selection);saving=true;save.disabled=true;
    void options.save(snapshot).then(()=>{if(disposed)return;status.textContent='界面方案已保存到本机。';status.dataset.state='saved';status.setAttribute('role','status');status.hidden=false;}).catch(error=>report(error instanceof Error?error:new Error(String(error)))).finally(()=>{saving=false;save.disabled=!available;});
  },{signal});
  window.addEventListener('focus',()=>{void refreshLibrary();},{signal});
  void refreshLibrary();
  return {element,dispose:()=>{disposed=true;controller.abort();optionController.abort();selector.close();}};
}
