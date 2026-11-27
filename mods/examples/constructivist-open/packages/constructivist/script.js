// @ts-check
(() => {
  /** @typedef {{action:string}} ThemeAction */
  /** @typedef {{serverName:string,channelName:string,connected:boolean,memberCount:number}} ThemeState */
  /** @typedef {'settings'|'toggleMic'|'toggleDeafen'|'serverMenu'|'toggleMembers'} ThemeCommand */
  /** @typedef {{on:((event:'action',callback:(event:ThemeAction)=>void)=>void)&((event:'state',callback:(state:ThemeState)=>void)=>void),setText:(id:string,text:string)=>void,setAttribute:(id:string,name:string,value:string|null)=>void,setVariable:(name:string,value:string)=>void,animate:(id:string,keyframes:Record<string,string|number>[],options:{duration:number,iterations:number,easing:string})=>void,command:(name:ThemeCommand)=>void}} ThemeBridge */
  const theme = /** @type {ThemeBridge} */ (Reflect.get(globalThis, 'deepscordTheme'));
  let compact = false;
  let printMaterial = true;
  let directoryOpen = false;
  let previousChannel = '';
  let previousServer = '';

  theme.on('state', state => {
    const nextServer = state.serverName || '构成报刊';
    const nextChannel = state.channelName || '等待频道';
    theme.setText('theme-constructivist-server', nextServer);
    theme.setAttribute('theme-constructivist-server', 'aria-label', nextServer);
    theme.setText('theme-constructivist-channel', nextChannel);
    theme.setText('theme-constructivist-status', state.connected ? 'ONLINE · 已连接' : 'SYNC · 连接中');
    theme.setAttribute('theme-constructivist-status', 'data-connected', state.connected ? 'true' : 'false');
    theme.setText('theme-constructivist-count', String(state.memberCount) + ' 人在场');

    if (nextServer !== previousServer) {
      previousServer = nextServer;
      // Meyerhold 3-beat Red Wedge Cleave: 40ms recoil -> sharp drive -> dead stop
      theme.animate('theme-constructivist-wedge', [
        { transform: 'translateX(4px) scale(0.97)', opacity: 0.92, offset: 0 },
        { transform: 'translateX(6px) scale(0.95)', opacity: 0.92, offset: 0.15 },
        { transform: 'translateX(-14px) scale(1.04)', opacity: 1, offset: 0.24 },
        { transform: 'translateX(2px) scale(1.005)', opacity: 1, offset: 0.78 },
        { transform: 'translateX(0) scale(1)', opacity: 1, offset: 1 }
      ], { duration: 260, iterations: 1, easing: 'cubic-bezier(0.08, 0.98, 0.2, 1)' });
    }

    if (nextChannel !== previousChannel) {
      previousChannel = nextChannel;
      // Hammer Stamp on channel kicker + auto-close mobile drawer on switch
      theme.animate('theme-constructivist-kicker', [
        { transform: 'translateX(3px)', opacity: 0.75, offset: 0 },
        { transform: 'translateX(-10px)', opacity: 1, offset: 0.18 },
        { transform: 'translateX(2px)', opacity: 1, offset: 0.72 },
        { transform: 'translateX(0)', opacity: 1, offset: 1 }
      ], { duration: 210, iterations: 1, easing: 'cubic-bezier(0.08, 0.98, 0.2, 1)' });
      if (directoryOpen) {
        directoryOpen = false;
        theme.setAttribute('theme-constructivist', 'data-directory', 'closed');
        theme.setAttribute('theme-constructivist-directory', 'aria-expanded', 'false');
        theme.setText('theme-constructivist-directory', '目录');
      }
    }
  });

  theme.on('action', event => {
    if (event.action === 'settings') { theme.command('settings'); return; }
    if (event.action === 'server-menu') { theme.command('serverMenu'); return; }
    if (event.action === 'toggle-members') { theme.command('toggleMembers'); return; }
    if (event.action === 'toggle-mic') { theme.command('toggleMic'); return; }
    if (event.action === 'toggle-deafen') { theme.command('toggleDeafen'); return; }
    if (event.action === 'toggle-directory') {
      directoryOpen = !directoryOpen;
      theme.setAttribute('theme-constructivist', 'data-directory', directoryOpen ? 'open' : 'closed');
      theme.setAttribute('theme-constructivist-directory', 'aria-expanded', String(directoryOpen));
      theme.setText('theme-constructivist-directory', directoryOpen ? '收起' : '目录');
      return;
    }
    if (event.action === 'toggle-material') {
      printMaterial = !printMaterial;
      theme.setAttribute('theme-constructivist', 'data-material', printMaterial ? 'print' : 'flat');
      theme.setAttribute('theme-constructivist-material', 'aria-pressed', String(printMaterial));
      theme.setText('theme-constructivist-material', printMaterial ? '纸墨版' : '平涂版');
      return;
    }
    if (event.action === 'toggle-density') {
      compact = !compact;
      theme.setAttribute('theme-constructivist', 'data-density', compact ? 'compact' : 'comfortable');
      theme.setAttribute('theme-constructivist-density', 'aria-pressed', String(compact));
      theme.setText('theme-constructivist-density', compact ? '标准排印' : '紧凑排印');
    }
  });
})();
