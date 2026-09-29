'use strict';

const $ = (id) => document.getElementById(id);

/**
 * h('button.btn.btn--green', { title: 'Add', onclick: fn }, 'text', childNode)
 * Tag with optional .classes, then props (on* become listeners, `html` sets
 * innerHTML, `dataset` merges, anything else is set as a property or, for
 * names with a dash, as an attribute), then children.
 */
function h(spec, props, ...children) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'class') node.className += (node.className ? ' ' : '') + v;
    else if (k.includes('-')) node.setAttribute(k, v === true ? '' : v);
    else node[k] = v;
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** A button holding an icon, with a tooltip. */
function iconButton(cls, icon, title, onclick) {
  return h('button.' + cls, { type: 'button', title, 'aria-label': title, html: icon, onclick });
}

/** The icon beside a playlist's name: which kind of list it is. */
function listIcon(p) {
  if (p.isAll) return Icons.library;
  if (p.isFavourites) return Icons.star;
  return p.isSmart ? Icons.pulse : Icons.list;
}

/** True for boxes the user types into, where Space and arrows belong to the box. */
function isTypingTarget(node) {
  if (!node || !node.tagName) return false;
  if (node.isContentEditable) return true;
  const tag = node.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag !== 'input') return false;
  return !['checkbox', 'radio', 'range', 'button', 'submit', 'color', 'file'].includes(node.type);
}
