// @ts-check
(() => {
/** @typedef {{action:string}} ThemeAction */
/** @typedef {{serverName:string,channelName:string,connected:boolean,memberCount:number}} ThemeState */
/** @typedef {{on:((event:'action',callback:(event:ThemeAction)=>void)=>void)&((event:'state',callback:(state:ThemeState)=>void)=>void),setText:(id:string,text:string)=>void,setAttribute:(id:string,name:string,value:string|null)=>void,setVariable:(name:string,value:string)=>void,animate:(id:string,keyframes:Record<string,string|number>[],options:{duration:number,iterations:number,easing:string})=>void,command:(name:'settings')=>void}} ThemeBridge */
  const theme = /** @type {ThemeBridge} */ (Reflect.get(globalThis, 'deepscordTheme'));
  let compact = false;
  let directoryOpen = false;
  let previousChannel = '';
  let previousServer = '';
  theme.on('state', state => {
    const nextServer = state.serverName || '构成报刊';
    const nextChannel = state.channelName || '等待频道';
    theme.setText('theme-constructivist-server', nextServer);
    theme.setText('theme-constructivist-channel', nextChannel);
    theme.setText('theme-constructivist-status', state.connected ? '此刻已连接' : '正在连接');
    theme.setText('theme-constructivist-count', String(state.memberCount) + ' 人在场');
    if (nextServer !== previousServer) {
      previousServer = nextServer;
      // M01 / Red Wedge Cleave: 40ms Otkaz recoil -> Posil wedge drive -> Tochka dead-stop
      theme.animate('theme-constructivist-wedge', [
        { transform: 'translateX(4px) scale(0.96)', opacity: 0.9, offset: 0 },
        { transform: 'translateX(6px) scale(0.94)', opacity: 0.9, offset: 0.15 },
        { transform: 'translateX(-16px) scale(1.06)', opacity: 1, offset: 0.22 },
        { transform: 'translateX(2px) scale(1.01)', opacity: 1, offset: 0.78 },
        { transform: 'translateX(0) scale(1)', opacity: 1, offset: 1 }
      ], { duration: 260, iterations: 1, easing: 'cubic-bezier(.08,.98,.2,1)' });
    }
    if (nextChannel !== previousChannel) {
      previousChannel = nextChannel;
      // M02 / Hammer Strike & 3px Orthogonal Shake
      theme.animate('theme-constructivist-channel', [
        { opacity: 0.6, transform: 'translateX(4px) scale(1.12)', offset: 0 },
        { opacity: 0.9, transform: 'translateX(-12px) scale(1.04)', offset: 0.18 },
        { opacity: 1, transform: 'translateX(2px) scale(1)', offset: 0.76 },
        { opacity: 1, transform: 'translateX(0) scale(1)', offset: 1 }
      ], { duration: 220, iterations: 1, easing: 'cubic-bezier(.08,.98,.2,1)' });
    }
  });
  theme.on('action', event => {
    if (event.action === 'settings') { theme.command('settings'); return; }
    if (event.action === 'toggle-directory') {
      directoryOpen = !directoryOpen;
      theme.setAttribute('theme-constructivist', 'data-directory', directoryOpen ? 'open' : 'closed');
      theme.setAttribute('theme-constructivist-directory', 'aria-expanded', String(directoryOpen));
      theme.setText('theme-constructivist-directory', directoryOpen ? '收起目录' : '展开目录');
      return;
    }
    if (event.action !== 'toggle-density') return;
    compact = !compact;
    theme.setAttribute('theme-constructivist', 'data-density', compact ? 'compact' : 'comfortable');
    theme.setAttribute('theme-constructivist-density', 'aria-pressed', String(compact));
    theme.setText('theme-constructivist-density', compact ? '标准排印' : '紧凑排印');
  });
})();
