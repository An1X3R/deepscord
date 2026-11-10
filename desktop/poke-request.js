// @ts-check
'use strict';
/** @typedef {import('./poke-request.cjs').RequestState} NativeRequestState */
/** @typedef {import('./poke-request.cjs').PokeDecision} NativeDecision */
const requestBridge = /** @type {Window & {pokeRequest?:{onState:(callback:(state:NativeRequestState)=>void)=>void,decide:(value:NativeDecision)=>Promise<void>}}} */ (window).pokeRequest;
if (!requestBridge) throw new Error('Poke request preload bridge is missing');
const nativeRequestBridge = requestBridge;
const requestRoot = document.getElementById('requests');
const requestCount = document.getElementById('count');
const requestStatus = document.getElementById('status');
if (!requestRoot || !requestCount || !requestStatus) throw new Error('Poke request popup layout is missing');
const requestList = requestRoot;
const countLabel = requestCount;
const statusLabel = requestStatus;
let renderedSignature = '';
/** @param {NativeRequestState} state @returns {void} */
function renderRequests(state) {
  const signature = JSON.stringify(state);
  if (signature === renderedSignature) return;
  renderedSignature = signature;
  requestList.replaceChildren(); statusLabel.textContent = '';
  countLabel.textContent = String(state.requests.length);
  for (const request of state.requests) {
    const card = document.createElement('section'); card.className = 'request'; card.dataset.requestId = request.requestId;
    const heading = document.createElement('div'); heading.className = 'heading'; heading.textContent = '👆 屏幕指点申请';
    const name = document.createElement('div'); name.className = 'name'; name.textContent = request.name;
    const detail = document.createElement('p'); detail.className = 'detail'; detail.textContent = '希望在你的共享画面上指点';
    const actions = document.createElement('div'); actions.className = 'actions';
    const approve = document.createElement('button'); approve.className = 'accept'; approve.textContent = '接受'; approve.dataset.testid = 'poke-native-approve'; approve.disabled = !state.canApprove;
    const reject = document.createElement('button'); reject.textContent = '拒绝'; reject.dataset.testid = 'poke-native-reject';
    /** @param {NativeDecision} decision @returns {void} */
    function submit(decision) {
      approve.disabled = true; reject.disabled = true;
      nativeRequestBridge.decide(decision).catch((error) => {
        statusLabel.textContent = '申请已失效，请返回应用检查';
        console.error('Poke request decision failed', { message: error instanceof Error ? error.message : String(error), requestId: request.requestId });
      });
    }
    approve.addEventListener('click', () => submit({ sessionId: state.sessionId, userId: request.userId, requestId: request.requestId, approved: true }));
    reject.addEventListener('click', () => submit({ sessionId: state.sessionId, userId: request.userId, requestId: request.requestId, approved: false }));
    actions.append(reject, approve); card.append(heading, name, detail, actions); requestList.append(card);
  }
}
nativeRequestBridge.onState(renderRequests);
