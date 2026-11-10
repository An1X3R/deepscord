// @ts-check
(() => {
/** @typedef {{action:string}} ThemeAction */
/** @typedef {{serverName:string,channelName:string,connected:boolean,memberCount:number}} ThemeState */
/** @typedef {{on:((event:'action',callback:(event:ThemeAction)=>void)=>void)&((event:'state',callback:(state:ThemeState)=>void)=>void),setText:(id:string,text:string)=>void,setAttribute:(id:string,name:string,value:string|null)=>void,setVariable:(name:string,value:string)=>void,command:(name:'settings')=>void}} ThemeBridge */
  const theme = /** @type {ThemeBridge} */ (Reflect.get(globalThis,'deepscordTheme'));
  let compact = false;
  theme.on('state', state => {
    theme.setText('theme-industrial-server',state.serverName || '工程站');
    theme.setText('theme-industrial-channel',state.channelName || '等待频道');
    theme.setText('theme-industrial-status',state.connected ? '房间已连接' : '正在连接');
    theme.setText('theme-industrial-count',String(state.memberCount)+' 位成员');
  });
  theme.on('action', event => {
    if(event.action === 'settings') { theme.command('settings'); return; }
    if(event.action !== 'toggle-density') return;
    compact = !compact;
    theme.setAttribute('theme-industrial','data-density',compact ? 'compact' : 'comfortable');
    theme.setAttribute('theme-industrial-density','aria-pressed',String(compact));
    theme.setText('theme-industrial-density',compact ? '舒展排布' : '紧凑排布');
    theme.setVariable('--theme-workstation-density',compact ? '1' : '0');
  });
})();
