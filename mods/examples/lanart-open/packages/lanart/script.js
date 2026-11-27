// @ts-check
(() => {
  /** @typedef {{action:string}} ThemeAction */
  /** @typedef {{serverName:string,channelName:string,connected:boolean,memberCount:number}} ThemeState */
  /** @typedef {{on:((event:'action',callback:(event:ThemeAction)=>void)=>void)&((event:'state',callback:(state:ThemeState)=>void)=>void),setText:(id:string,text:string)=>void,setAttribute:(id:string,name:string,value:string|null)=>void,setVariable:(name:string,value:string)=>void,animate:(id:string,keyframes:Record<string,string|number>[],options:{duration:number,iterations:number,easing:string})=>void,command:(name:'settings')=>void}} ThemeBridge */

  const theme = /** @type {ThemeBridge} */ (Reflect.get(globalThis, 'deepscordTheme'));

  /** @type {Record<'day'|'night', Record<string, string>>} */
  const PALETTES = {
    day: {
      '--bg': '#f1f3f2',
      '--bg-side': '#e4ecf8',
      '--bg-rail': '#111820',
      '--bg-elev': '#ffffff',
      '--bg-elev2': '#e4e8e9',
      '--bg-input': '#ffffff',
      '--text': '#111820',
      '--text-2': '#475463',
      '--text-3': '#647280',
      '--accent': '#245dcc',
      '--accent-2': '#3474e8',
      '--accent-ink': '#ffffff',
      '--accent-soft': '#245dcc17',
      '--accent-glow': '#245dcc2e',
      '--accent-border': '#245dcc59',
      '--hover': '#245dcc12',
      '--hover-2': '#245dcc21',
      '--line': '#c7cdd0',
      '--line-2': '#7d8991',
      '--danger': '#c6383d',
      '--danger-text': '#b42328',
      '--danger-soft': '#c6383d1a',
      '--green': '#1f7a54',
      '--green-soft': '#1f7a541a',
      '--warn': '#b86e14',
      '--radius': '0px'
    },
    night: {
      '--bg': '#0d1014',
      '--bg-side': '#14171d',
      '--bg-rail': '#090b0e',
      '--bg-elev': '#1b1e24',
      '--bg-elev2': '#252930',
      '--bg-input': '#15181e',
      '--text': '#ece9e3',
      '--text-2': '#b4b3af',
      '--text-3': '#85868a',
      '--accent': '#e34549',
      '--accent-2': '#ff5d5d',
      '--accent-ink': '#ece9e3',
      '--accent-soft': '#e345491f',
      '--accent-glow': '#e3454933',
      '--accent-border': '#e3454966',
      '--hover': '#f2b35d14',
      '--hover-2': '#f2b35d24',
      '--line': '#2c3038',
      '--line-2': '#454950',
      '--green': '#4cc38a',
      '--green-soft': '#4cc38a22',
      '--danger': '#e34549',
      '--danger-text': '#ff8b8e',
      '--danger-soft': '#e3454924',
      '--warn': '#f2b35d',
      '--radius': '8px'
    }
  };

  /** @type {'day'|'night'} */
  let artMode = 'night';
  let compact = false;
  let directoryOpen = false;
  let previousChannel = '';
  let previousServer = '';
  applyMode(artMode, false);

  /** @param {'day'|'night'} nextMode @param {boolean} animated @returns {void} */
  function applyMode(nextMode, animated) {
    artMode = nextMode;
    const isNight = nextMode === 'night';
    const tokens = PALETTES[nextMode];
    for (const [key, value] of Object.entries(tokens)) {
      theme.setVariable(key, value);
    }
    theme.setAttribute('theme-lanart', 'data-art-mode', nextMode);
    theme.setAttribute('theme-lanart-mode-toggle', 'aria-pressed', String(isNight));
    theme.setText(
      'theme-lanart-mode-toggle',
      isNight ? '🌙 轨道 ORBIT ⇄ ☀️ 测绘' : '☀️ 测绘 ATLAS ⇄ 🌙 轨道'
    );
    theme.setText(
      'theme-lanart-mode-label',
      isNight ? 'ORBITAL OBSERVATORY // 轨道观测台' : 'SURVEY ATLAS // 大地测绘地图册'
    );
    theme.setText(
      'theme-lanart-altimeter',
      isNight ? 'ORB // 799,000 km · ANIMA-01' : 'ALT // 00,325 m · SECTOR 04'
    );
    theme.setText(
      'theme-lanart-coords',
      isNight ? '[ ORB / 0.42 · 16° // RNG 292 ]' : '[ 39.90°N, 116.40°E // SECTOR 04 ]'
    );

    if (!animated) return;

    // Single-Anchor Satellite Launch (Day -> Night) / Landing (Night -> Day) Choreography
    theme.animate(
      'theme-lanart-reveal-disc',
      isNight
        ? [
            { opacity: 0.9, transform: 'scale(4.2)', offset: 0 },
            { opacity: 0.75, transform: 'scale(1.1)', offset: 0.55 },
            { opacity: 0, transform: 'scale(0.18)', offset: 1 }
          ]
        : [
            { opacity: 0.9, transform: 'scale(0.18)', offset: 0 },
            { opacity: 0.7, transform: 'scale(2.4)', offset: 0.52 },
            { opacity: 0, transform: 'scale(5.2)', offset: 1 }
          ],
      { duration: 640, iterations: 1, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
    );

    const activePlate = isNight ? 'theme-lanart-plate-night' : 'theme-lanart-plate-day';
    theme.animate(
      activePlate,
      isNight
        ? [
            { opacity: 0, transform: 'scale(1.06)', offset: 0 },
            { opacity: 1, transform: 'scale(1)', offset: 1 }
          ]
        : [
            { opacity: 0, transform: 'translateY(8px) scale(0.97)', offset: 0 },
            { opacity: 1, transform: 'translateY(0) scale(1)', offset: 1 }
          ],
      { duration: 620, iterations: 1, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
    );

    theme.animate(
      'theme-lanart-altimeter',
      [
        { opacity: 0.35, transform: 'scale(1.32)', offset: 0 },
        { opacity: 1, transform: 'scale(1.08)', offset: 0.45 },
        { opacity: 1, transform: 'scale(1)', offset: 1 }
      ],
      { duration: 480, iterations: 1, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
    );
  }

  theme.on('state', state => {
    const nextServer = state.serverName || 'Lanart';
    const nextChannel = state.channelName || '等待频道';
    theme.setText('theme-lanart-server', nextServer);
    theme.setText('theme-lanart-channel', nextChannel);
    theme.setText('theme-lanart-status', state.connected ? 'SIGNAL LOCKED' : 'CONNECTING');
    theme.setText('theme-lanart-count', String(state.memberCount) + ' 人在场');

    if (nextServer !== previousServer) {
      previousServer = nextServer;
      theme.animate(
        'theme-lanart-server',
        [
          { opacity: 0.4, transform: 'translateX(-10px)' },
          { opacity: 1, transform: 'translateX(0)' }
        ],
        { duration: 240, iterations: 1, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
      );
    }
    if (nextChannel !== previousChannel) {
      previousChannel = nextChannel;
      theme.animate(
        'theme-lanart-channel',
        [
          { opacity: 0.3, transform: 'translateY(6px)' },
          { opacity: 1, transform: 'translateY(0)' }
        ],
        { duration: 220, iterations: 1, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
      );
    }
  });

  theme.on('action', event => {
    if (event.action === 'settings') {
      theme.command('settings');
      return;
    }
    if (event.action === 'toggle-mode') {
      applyMode(artMode === 'night' ? 'day' : 'night', true);
      return;
    }
    if (event.action === 'toggle-directory') {
      directoryOpen = !directoryOpen;
      theme.setAttribute('theme-lanart', 'data-directory', directoryOpen ? 'open' : 'closed');
      theme.setAttribute('theme-lanart-directory', 'aria-expanded', String(directoryOpen));
      theme.setText('theme-lanart-directory', directoryOpen ? '收起索引' : '目录索引');
      return;
    }
    if (event.action === 'toggle-density') {
      compact = !compact;
      theme.setAttribute('theme-lanart', 'data-density', compact ? 'compact' : 'comfortable');
      theme.setAttribute('theme-lanart-density', 'aria-pressed', String(compact));
      theme.setText('theme-lanart-density', compact ? '标准视图' : '紧凑视图');
    }
  });
})();
