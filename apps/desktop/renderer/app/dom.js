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
  // A box being typed in is kept over the redraw (4.5.4): see Typing.
  const typing = Typing.leaving(node);
  // All at once (a long list's rows one by one took many times as long).
  node.textContent = '';
  if (typing) Typing.restore(node, typing);
  return node;
}

/**
 * The box you type in, kept over redraws (4.5.4). Pages draw their parts
 * again whenever the library, the player or a download changes, and a box
 * being typed in (a playlist's new name, a song's names in Add Songs, a
 * search...) came back as it was first drawn: the letters typed gone, its
 * focus too, or all of it selected so the next letter replaced it. Now,
 * when a part holding the focused box is cleared, the same box drawn again
 * (found by its place: the rows' ids, else each element's kind and turn)
 * gets the text typed, the caret where it was and the focus back, once the
 * drawing is done. A box not drawn again (the editing ended) is let go.
 */
const Typing = {
  /** What is being typed inside `node`, about to be cleared; null when nothing is. */
  leaving(node) {
    const el = document.activeElement;
    if (!el || el === document.body || !isTypingTarget(el) || el.tagName === 'SELECT' || el.isContentEditable || !node.contains(el)) return null;
    let start = null;
    let end = null;
    let dir = 'none';
    try {
      start = el.selectionStart;
      end = el.selectionEnd;
      dir = el.selectionDirection || 'none';
    } catch {
      // A number box has no caret to read.
    }
    return { path: this._path(node, el), value: el.value, start, end, dir };
  },

  /** Once the part is drawn again: the same box gets what was typed back. */
  restore(node, typing) {
    let tries = 0;
    const put = () => {
      if (!node.isConnected) return;
      const el = this._find(node, typing.path);
      if (!el) {
        // Drawn a frame later, maybe; after that it is gone.
        if (tries++ < 1) requestAnimationFrame(put);
        return;
      }
      if (el.disabled || el.readOnly) return;
      // Something else took the focus meanwhile (a click): leave it there.
      const now = document.activeElement;
      if (now && now !== el && now !== document.body && !node.contains(now)) return;
      if (el.value !== typing.value) {
        el.value = typing.value;
        // Whatever the page keeps of it hears the text again.
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (document.activeElement !== el) el.focus({ preventScroll: true });
      if (typing.start !== null) {
        try {
          el.setSelectionRange(typing.start, typing.end, typing.dir);
        } catch {
          // A box without a caret.
        }
      }
    };
    queueMicrotask(put);
  },

  /** An element's name among its brothers: its id or row key, else its kind and its turn among those of its kind. */
  _key(el) {
    const id = this._idOf(el);
    if (id) return { id };
    const kind = this._kindOf(el);
    let turn = 0;
    for (let n = el.previousElementSibling; n; n = n.previousElementSibling) {
      if (!this._idOf(n) && this._kindOf(n) === kind) turn += 1;
    }
    return { kind, turn };
  },

  _idOf(el) {
    const d = el.dataset || {};
    const id = el.id || d.id || d.key || d.group || d.rowKey;
    return id ? String(id) : '';
  },

  _kindOf(el) {
    return `${el.tagName}.${el.classList[0] || ''}`;
  },

  _path(node, el) {
    const path = [];
    for (let n = el; n && n !== node; n = n.parentElement) path.unshift(this._key(n));
    return path;
  },

  _find(node, path) {
    let at = node;
    for (const step of path) {
      let found = null;
      let turn = 0;
      for (const child of at.children) {
        const id = this._idOf(child);
        if (step.id) {
          if (id === step.id) found = child;
        } else if (!id && this._kindOf(child) === step.kind) {
          if (turn === step.turn) found = child;
          turn += 1;
        }
        if (found) break;
      }
      if (!found) return null;
      at = found;
    }
    return isTypingTarget(at) ? at : null;
  },
};

/** Puts `fresh` where `old` was, a box being typed in kept as clear() does. */
function replaceNode(old, fresh) {
  const typing = Typing.leaving(old);
  old.replaceWith(fresh);
  if (typing) Typing.restore(fresh, typing);
  return fresh;
}

/** A button holding an icon, with a tooltip. */
function iconButton(cls, icon, title, onclick) {
  return h('button.' + cls, { type: 'button', title, 'aria-label': title, html: icon, onclick });
}

/**
 * The icon beside a playlist's name: which kind of list it is. `groupId`:
 * the group it shows in, where a group you follow counts its own follow (4.5.3).
 */
function listIcon(p, groupId = null) {
  if (p.isAll || p.isFrom) return Icons.library;
  if (p.isDevice) return Icons.download;
  // One you follow (4.5.1), or follow inside the followed group it shows in (4.5.3): the green followed icon.
  if (p.isShared && (Store.isFollowing(p.id) || (groupId && Store.isFollowingInGroup(groupId, p.id)))) return Icons.followed;
  // Yours, or another profile's shared with you (4.3).
  if (p.isFavourites || p.favourites) return Icons.star;
  return p.isSmart || p.isRuled ? Icons.pulse : Icons.list;
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
