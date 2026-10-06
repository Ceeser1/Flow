'use strict';

// Keyboard: Space plays / pauses, Left and Right skip 10 seconds, whenever no
// text box has the focus; with the visualizer open, Up and Down switch to the
// one before or after it. On Add Songs with a song in the editor they drive
// the preview; everywhere else the player. Media keys go through the media
// session in player.js, so they are not handled here as well.

const Keys = {
  init() {
    window.addEventListener('keydown', (e) => this._down(e), true);
    // A focused button would also take Space as a click on release.
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && !isTypingTarget(e.target) && (!Modal.top() || (Visualizer.shown && !Modal.top().el.closest('.modal-backdrop--over')))) e.preventDefault();
    }, true);
  },

  _target() {
    if (Nav.page === 'add' && AddPage.editorReady) {
      return { toggle: () => AddPage.togglePreview(), skip: (d) => AddPage.skipPreview(d) };
    }
    return { toggle: () => Player.toggle(), skip: (d) => Player.skip(d) };
  },

  _down(e) {
    // The full-screen visualizer: Escape closes a popup opened over it from
    // the player bar first, then only it (and, should the window have left
    // full screen on that press already, nothing else). The player keys work
    // even over the popup it was opened from.
    const over = Modal.top() && Modal.top().el.closest('.modal-backdrop--over') ? Modal.top() : null;
    if (e.key === 'Escape' && !over && (Visualizer.shown || Visualizer.justClosed())) {
      e.preventDefault();
      Visualizer.close();
      return;
    }
    const top = Visualizer.shown ? over : Modal.top();
    if (e.key === 'Escape' && top) {
      e.preventDefault();
      top.close();
      return;
    }
    if (top) return;

    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      Nav.show('search');
      return;
    }
    if (isTypingTarget(e.target)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) this._target().toggle();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this._target().skip(-10);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      this._target().skip(10);
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && Visualizer.shown) {
      e.preventDefault();
      Visualizer.step(e.key === 'ArrowDown' ? 1 : -1);
    }
  },
};
