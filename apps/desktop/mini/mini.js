'use strict';

// The Mini Player's page (5.0). It plays nothing: Flow's window tells what it
// plays (window.mini.onState), and the buttons here go there as commands
// (window.mini.do). Between two states the time moves on by the clock.
// Started with the computer, it shows the song from last time until Flow's
// window is up (state.live); what is pressed meanwhile is kept for it.

(() => {
  const $ = (id) => document.getElementById(id);
  const root = $('mini');

  // { hasSong, songId, title, artist, cover, coverBig, list, playing, position, duration, at, volume, canVolume, live }
  let state = { hasSong: false };
  // The cogwheel's ticks: { eq, coverBg, locked, onTop, autostart, canAutostart }.
  let ticks = {};
  let dragTime = null;      // the place the timeline is being dragged to (s), else null
  let ticker = null;
  let coverShown = null;
  let backShown = '';
  // A volume set here is shown at once; Flow's own answer is taken again a moment later.
  let volumeSetAt = 0;

  // ---- drawing ----

  /** 3:07, or 1:02:07 from an hour on. */
  function clock(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor(s / 60) % 60;
    const two = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
  }

  /** Where the song is now: the place last told, moved on by the clock while it plays. */
  function position() {
    if (!state.hasSong) return 0;
    const moved = state.playing ? Math.max(0, Date.now() - (state.at || Date.now())) / 1000 : 0;
    const p = (Number(state.position) || 0) + moved;
    return state.duration > 0 ? Math.min(p, state.duration) : p;
  }

  function drawTime() {
    const d = Number(state.duration) || 0;
    const t = dragTime !== null ? dragTime : position();
    const frac = d > 0 ? Math.min(1, t / d) : 0;
    $('time').textContent = clock(t);
    $('length').textContent = clock(d);
    $('fill').style.width = `${frac * 100}%`;
    $('knob').style.left = `${frac * 100}%`;
  }

  function drawCover() {
    const src = state.hasSong ? state.cover || '' : '';
    if (src === coverShown) return;
    coverShown = src;
    const box = $('cover');
    const note = () => {
      box.innerHTML = Icons.library;
    };
    if (!src) {
      note();
      return;
    }
    const img = new Image();
    img.alt = '';
    // A cover that is gone (its file, or its server): the note.
    img.onerror = () => {
      if (coverShown === src) note();
    };
    img.src = src;
    box.replaceChildren(img);
  }

  /** Cover as background: the song's big cover (the small one until that is here) behind everything, once it has loaded. */
  function drawBackground() {
    const src = ticks.coverBg && state.hasSong ? state.coverBig || state.cover || '' : '';
    if (src === backShown) return;
    backShown = src;
    const bg = $('bg');
    const none = () => {
      bg.hidden = true;
      root.classList.remove('mini--cover-bg');
    };
    if (!src) {
      none();
      bg.removeAttribute('src');
      return;
    }
    // The one showing stays until the next has loaded; a cover that is gone: none.
    const next = new Image();
    next.onload = () => {
      if (backShown !== src) return;
      bg.src = src;
      bg.hidden = false;
      root.classList.add('mini--cover-bg');
    };
    next.onerror = () => {
      if (backShown === src) none();
    };
    next.src = src;
  }

  function drawVolume() {
    const v = Math.max(0, Math.min(1, Number(state.volume) || 0));
    $('btnVolume').hidden = state.canVolume === false;
    if (state.canVolume === false) closeVolume();
    $('btnVolume').innerHTML = v === 0 ? Icons.mute : (v < 0.5 ? Icons.volumeLow : Icons.volume);
    $('volSlider').value = String(Math.round(v * 100));
    $('volSlider').style.setProperty('--fill', `${v * 100}%`);
    $('volValue').textContent = `${Math.round(v * 100)}%`;
  }

  function draw() {
    const has = !!state.hasSong;
    root.classList.toggle('mini--empty', !has);
    $('title').textContent = has ? state.title || T('common.untitled') : T('common.nothingPlaying');
    $('title').title = has ? [state.title, state.artist].filter(Boolean).join(' - ') : '';
    $('artist').textContent = has ? state.artist || '' : '';
    drawCover();
    drawBackground();
    $('btnPlay').innerHTML = state.playing ? Icons.pause : Icons.play;
    $('btnPlay').title = state.playing ? T('common.pause') : T('common.play');
    for (const id of ['btnPrev', 'btnBack10', 'btnFwd10', 'btnNext']) $(id).disabled = !has;
    drawTime();
    drawVolume();
    clearInterval(ticker);
    ticker = has && state.playing ? setInterval(drawTime, 250) : null;
    // The equalizer follows what Flow's window plays (not a song only shown from last time).
    MiniEq.sounding(has && !!state.playing && state.live !== false);
  }

  function drawTicks() {
    root.classList.toggle('mini--locked', !!ticks.locked);
    const rows = [['tickEq', ticks.eq], ['tickCoverBg', ticks.coverBg], ['tickLocked', ticks.locked], ['tickOnTop', ticks.onTop], ['tickAutostart', ticks.autostart]];
    for (const [id, on] of rows) {
      $(id).setAttribute('aria-checked', String(!!on));
      $(id).querySelector('.mini__check').innerHTML = on ? Icons.check : '';
    }
    // Only where Flow can start with the computer (Windows, Linux).
    $('tickAutostart').hidden = ticks.canAutostart === false;
    drawBackground();
    MiniEq.show(!!ticks.eq);
  }

  function take(next) {
    const volume = Date.now() - volumeSetAt < 600 ? state.volume : undefined;
    state = next || { hasSong: false };
    if (volume !== undefined) state.volume = volume;
    draw();
  }

  // ---- the cogwheel's menu and the volume slider: one open at a time ----

  function popup() {
    root.classList.toggle('mini--popup', !$('menu').hidden || !$('volPop').hidden);
  }

  function closeMenu() {
    $('menu').hidden = true;
    $('menuError').hidden = true;
    $('btnSettings').setAttribute('aria-expanded', 'false');
    popup();
  }

  function closeVolume() {
    $('volPop').hidden = true;
    $('btnVolume').setAttribute('aria-expanded', 'false');
    popup();
  }

  function toggleMenu() {
    const open = $('menu').hidden;
    closeVolume();
    $('menu').hidden = !open;
    $('btnSettings').setAttribute('aria-expanded', String(open));
    popup();
  }

  function toggleVolume() {
    const open = $('volPop').hidden;
    closeMenu();
    $('volPop').hidden = !open;
    $('btnVolume').setAttribute('aria-expanded', String(open));
    popup();
    if (open) $('volSlider').focus();
  }

  async function tick(name) {
    $('menuError').hidden = true;
    const r = await window.mini.set(name, !ticks[name]);
    if (!r) return;
    ticks = r.ticks || ticks;
    drawTicks();
    if (r.error) {
      $('menuError').textContent = r.error;
      $('menuError').hidden = false;
    }
  }

  function setVolume(v) {
    const vol = Math.max(0, Math.min(1, v));
    state.volume = vol;
    volumeSetAt = Date.now();
    drawVolume();
    window.mini.do('volume', vol);
  }

  // ---- binding ----

  $('btnSettings').innerHTML = Icons.cog;
  $('btnClose').innerHTML = Icons.x;
  $('btnPrev').innerHTML = Icons.prev;
  $('btnNext').innerHTML = Icons.next;
  $('btnBack10').innerHTML = Icons.back10;
  $('btnFwd10').innerHTML = Icons.fwd10;

  $('btnClose').onclick = () => window.mini.close();
  $('btnOpenFlow').onclick = () => {
    closeMenu();
    closeVolume();
    window.mini.openFlow();
  };
  $('btnSettings').onclick = toggleMenu;
  $('btnVolume').onclick = toggleVolume;
  $('btnPrev').onclick = () => window.mini.do('prev');
  $('btnNext').onclick = () => window.mini.do('next');
  $('btnBack10').onclick = () => window.mini.do('back10');
  $('btnFwd10').onclick = () => window.mini.do('fwd10');
  $('btnPlay').onclick = () => {
    // Shown at once; Flow's window says how it is a moment later.
    if (state.hasSong && state.live !== false) {
      state = {
        ...state, position: position(), at: Date.now(), playing: !state.playing,
      };
      draw();
    }
    window.mini.do('toggle');
  };

  $('tickEq').onclick = () => tick('eq');
  $('tickCoverBg').onclick = () => tick('coverBg');
  $('tickLocked').onclick = () => tick('locked');
  $('tickOnTop').onclick = () => tick('onTop');
  $('tickAutostart').onclick = () => tick('autostart');
  $('itemOpenFlow').onclick = () => {
    closeMenu();
    window.mini.openFlow();
  };
  $('itemClose').onclick = () => window.mini.close();

  $('volSlider').addEventListener('input', () => setVolume(Number($('volSlider').value) / 100));
  // Scrolling over the volume nudges it, as in Flow's player bar.
  for (const el of [$('btnVolume'), $('volPop')]) {
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (state.canVolume !== false) setVolume((Number(state.volume) || 0) + (e.deltaY < 0 ? 0.05 : -0.05));
    }, { passive: false });
  }

  // The timeline: a click or a drag goes to that place.
  const track = $('track');
  const timeAt = (clientX) => {
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width))) * (Number(state.duration) || 0);
  };
  track.addEventListener('pointerdown', (e) => {
    if (!state.hasSong || !(state.duration > 0) || e.button !== 0) return;
    track.setPointerCapture(e.pointerId);
    track.classList.add('mini__track--dragging');
    dragTime = timeAt(e.clientX);
    drawTime();
    const move = (ev) => {
      dragTime = timeAt(ev.clientX);
      drawTime();
    };
    const up = (ev) => {
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', up);
      track.removeEventListener('pointercancel', up);
      track.classList.remove('mini__track--dragging');
      const to = timeAt(ev.clientX);
      dragTime = null;
      state = { ...state, position: to, at: Date.now() };
      drawTime();
      window.mini.do('seek', to);
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', up);
  });

  // The edges and corners: held and dragged, the widget is resized. The window's size is the main
  // process's to set (by where the mouse is); here only that an edge is held and that it moves.
  for (const grip of document.querySelectorAll('.mini__grip')) {
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || ticks.locked) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      window.mini.resize('start', grip.dataset.edge);
      const end = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', end);
        grip.removeEventListener('pointercancel', end);
        grip.removeEventListener('lostpointercapture', end);
        window.mini.resize('end');
      };
      // A move without the button held: its release was missed, the drag is over.
      const move = (ev) => {
        if (ev.buttons & 1) window.mini.resize('move');
        else end();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
      grip.addEventListener('lostpointercapture', end);
    });
  }

  // A click beside the menu or the slider closes it; so do Escape and the window losing the focus.
  document.addEventListener('pointerdown', (e) => {
    if (!$('menu').hidden && !e.target.closest('#menu, #btnSettings')) closeMenu();
    if (!$('volPop').hidden && !e.target.closest('#volPop, #btnVolume')) closeVolume();
  });
  window.addEventListener('blur', () => {
    closeMenu();
    closeVolume();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenu();
      closeVolume();
    } else if (e.code === 'Space' && !e.target.closest('button, input')) {
      e.preventDefault();
      $('btnPlay').click();
    }
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  window.mini.onState(take);
  window.mini.onLevels((levels) => MiniEq.take(levels));
  window.mini.onLook((look) => MiniEq.look(look));
  window.mini.hello().then((hello) => {
    if (!hello) return;
    MiniEq.look(hello.look);
    ticks = hello.ticks || {};
    drawTicks();
    take(hello.state);
  });
  draw();
  drawTicks();
})();
