// @ts-check
/** @type {WeakMap<Element,string>} */
const markupCache=new WeakMap();
/** @param {Node} node @returns {string|null} */
function nodeKey(node){
  if(!(node instanceof Element))return null;
  for(const name of ['id','data-channel-row','data-channel-members','data-channel-group','data-user-id','data-server-id','data-member-group']){
    const value=node.getAttribute(name);if(value!==null)return name+':'+value;
  }
  return null;
}
/** @param {Node} current @param {Node} next @returns {boolean} */
function compatible(current,next){return current.nodeType===next.nodeType && current.nodeName===next.nodeName && nodeKey(current)===nodeKey(next);}
/** @param {Node} current @param {Node} next @returns {void} */
function patchNode(current,next){
  if(current instanceof Element && next instanceof Element){
    for(const attribute of Array.from(current.attributes))if(!next.hasAttribute(attribute.name))current.removeAttribute(attribute.name);
    for(const attribute of Array.from(next.attributes))if(current.getAttribute(attribute.name)!==attribute.value)current.setAttribute(attribute.name,attribute.value);
    patchChildren(current,next);
  }else if(current.nodeValue!==next.nodeValue)current.nodeValue=next.nodeValue;
}
/** @param {Node} current @param {Node} next @returns {void} */
function patchChildren(current,next){
  const old=Array.from(current.childNodes),keyed=new Map(old.map(node=>[nodeKey(node),node]));
  const retained=new Set();let cursor=current.firstChild;
  for(const desired of Array.from(next.childNodes)){
    const key=nodeKey(desired);
    const candidate=key===null ? cursor : keyed.get(key);
    const node=candidate && !retained.has(candidate) && compatible(candidate,desired) ? candidate : desired.cloneNode(true);
    if(node!==cursor)current.insertBefore(node,cursor);
    if(node===candidate)patchNode(node,desired);
    retained.add(node);cursor=node.nextSibling;
  }
  for(const node of old)if(!retained.has(node))current.removeChild(node);
}
/** Update trusted, escaped list markup while retaining unchanged nodes and focus.
 * @param {Element} target @param {string} markup @returns {void} */
export function reconcileMarkup(target,markup){
  if(markupCache.get(target)===markup)return;
  const template=document.createElement('template');template.innerHTML=markup;
  patchChildren(target,template.content);markupCache.set(target,markup);
}
