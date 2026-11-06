'use strict';

// Edit Song, in the Settings look: the names, and a trim of the song's file.
//
// The trim editor is the Add Songs one (trim.js: the slider and the
// waveform), with a preview of its own. The waveform is drawn from the file
// here when the song has one, else by the Flow Server; without either it can
// still be trimmed by the handles and the times, just without the picture.
// The preview plays what the player would (Store.audioSrc) and stops at the
// red handle.
//
// Save renames (library:editSong) and, when a handle moved, trims
// (library:trimSong): without a server the file here is cut and the uncut
// one goes to the Recycle Bin; with one the server cuts its file (now, or
// once it is connected) and a copy here is cut at once. A song another
// profile of the server uploaded only says who can trim it.

// Handles closer than this to either end count as not moved (media.js EDGE).
const TRIM_EDGE = 0.02;

/**
 * The ways to a library song's waveform peaks, the best first: where the
 * song's own file is cut (the desktop), from that file; where the server cuts
 * it (the phone), from the server's while it can be reached. Each a function
 * giving a promise; none when neither is there.
 */
function songPeakJobs(song, duration) {
  const st = Store.server;
  const online = st.on && st.state === 'online';
  const jobs = [];
  if (song.file) jobs.push(() => window.flow.peaks(song.file, duration));
  if (online) jobs.push(() => window.flow.serverSongPeaks(song.id));
  if (!Store.can('localTrim')) jobs.reverse();
  return jobs;
}

/** The trim editor for one song: { el, hint, resetBtn, cut(), stop(), destroy() }. */
function songTrimEditor(song, { enabled = true } = {}) {
  const canvas = h('canvas.audio-canvas');
  const wavePlayhead = h('div.playhead.playhead--audio');
  const status = h('div.audio-status');
  const fill = h('div.trim-slider__fill');
  const trimPlayhead = h('div.playhead.playhead--trim');
  const startHandle = h('div.trim-slider__handle.trim-slider__handle--start', { title: T('common.trim.start') });
  const endHandle = h('div.trim-slider__handle.trim-slider__handle--end', { title: T('common.trim.end') });
  const sliderEl = h('div.trim-slider', h('div.trim-slider__track', fill), trimPlayhead, startHandle, endHandle);
  const startField = h('input.time-field', { type: 'text', spellcheck: false });
  const endField = h('input.time-field', { type: 'text', spellcheck: false });
  const playBtn = h('button.round-btn.round-btn--main', { type: 'button', title: T('common.play') });
  const timeText = h('span.time-readout', '0:00 / 0:00');
  const spanLabel = h('div.span-label');
  const hint = h('span.song-edit__hint', T('common.trim.hint'));
  const resetBtn = h('button.btn.btn--small', { type: 'button' }, T('common.trim.reset'));
  const el = h('div.song-trim' + (enabled ? '' : '.song-trim--off'),
    h('div.audio-canvas-wrap', canvas, wavePlayhead, status),
    sliderEl,
    h('div.trim-row',
      h('div.time-group', h('span.time-caption.time-caption--start', T('common.trim.start')), startField),
      h('div.preview-transport', playBtn, timeText),
      h('div.span-cell', spanLabel),
      h('div.time-group.time-group--end', h('span.time-caption.time-caption--end', T('common.trim.end')), endField)));

  let duration = song.duration || 0;
  let peaks = null;
  let segments = [];
  let raf = 0;
  let gone = false;
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.volume = Player.volume;
  const src = Store.audioSrc(song);
  if (src) audio.src = src;
  playBtn.disabled = !src;
  if (!src) playBtn.title = T(`songEdit.trim.notPlayable.${Store.hereKey}`);

  const slider = new TrimSlider(sliderEl, startHandle, endHandle, fill);
  addTrimNudges(slider, startField.parentNode, endField.parentNode);
  const setStatus = (text) => {
    status.textContent = text;
    status.hidden = !text;
  };

  const draw = () => {
    if (gone || !duration) return;
    drawWaveform(canvas, peaks, duration, slider.start, slider.end, segments);
    slider._reposition();
    drawPlayhead();
  };
  const drawPlayhead = () => {
    const t = audio.currentTime || 0;
    const m = sliderMetrics(canvas.clientWidth);
    wavePlayhead.style.left = `${m.inset + (t / (duration || 1)) * m.usable}px`;
    trimPlayhead.style.left = `${slider.valueToX(t)}px`;
    timeText.textContent = `${Util.fmtClock(t)} / ${Util.fmtClock(duration)}`;
  };
  const syncFields = () => {
    startField.value = Util.fmtPrecise(slider.start);
    endField.value = Util.fmtPrecise(slider.end);
    spanLabel.textContent = T('common.trim.selection', { selection: Util.fmtPrecise(slider.end - slider.start), total: Util.fmtPrecise(duration) });
  };
  const drawPlay = () => {
    playBtn.innerHTML = audio.paused ? Icons.play : Icons.pause;
  };

  const seek = (t) => {
    if (!src) return;
    audio.currentTime = Math.max(0, Math.min(duration, t));
    drawPlayhead();
  };
  const tick = () => {
    raf = 0;
    if (gone) return;
    // Play stops at the red handle, so the cut is heard as it will be saved.
    if (!audio.paused && audio.currentTime >= slider.end) {
      audio.pause();
      audio.currentTime = slider.end;
    }
    drawPlayhead();
    if (!audio.paused) raf = requestAnimationFrame(tick);
  };
  const stop = () => {
    if (!audio.paused) audio.pause();
  };

  AudioFocus.register('songEdit', stop);
  playBtn.onclick = () => {
    if (!src) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (audio.currentTime < slider.start || audio.currentTime >= slider.end - 0.05) audio.currentTime = slider.start;
    audio.play().catch(() => {});
  };
  audio.addEventListener('play', () => {
    AudioFocus.claim('songEdit');
    drawPlay();
    if (!raf) raf = requestAnimationFrame(tick);
  });
  audio.addEventListener('pause', drawPlay);
  audio.addEventListener('ended', drawPlay);
  const onVolume = (v) => {
    audio.volume = v;
  };
  Player.onVolume(onVolume);

  slider.onChange = (start, end, which) => {
    syncFields();
    draw();
    // Moving a handle while stopped moves the playhead with it (as on Add Songs).
    if (audio.paused) seek(which === 'start' ? start : Math.max(start, end - 3));
  };
  slider.onDragStateChange = (factor) => {
    if (factor === FINE_CTRL) hint.textContent = T('common.trim.fine100');
    else if (factor === FINE_SHIFT) hint.textContent = T('common.trim.fine10');
    else hint.textContent = T('common.trim.hint');
    hint.classList.toggle('hint--active', factor !== 1);
  };
  // A click or drag on the waveform or the track moves the playhead there.
  for (const node of [canvas, sliderEl]) {
    node.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('trim-slider__handle') || !src) return;
      node.setPointerCapture(e.pointerId);
      const at = (ev) => slider.xToValue(ev.clientX - node.getBoundingClientRect().left);
      seek(at(e));
      const move = (ev) => seek(at(ev));
      const up = () => {
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
        node.removeEventListener('pointercancel', up);
      };
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', up);
      node.addEventListener('pointercancel', up);
    });
  }
  const bindField = (field, isStart) => {
    const apply = () => {
      try {
        const v = Util.parsePrecise(field.value);
        if (isStart) slider.setStart(v);
        else slider.setEnd(v);
      } catch {
        // Unreadable: what the slider says goes back in.
      }
      syncFields();
    };
    field.addEventListener('change', apply);
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        apply();
        field.blur();
      }
    });
  };
  bindField(startField, true);
  bindField(endField, false);
  resetBtn.onclick = () => {
    slider.setRange(duration, 0, duration);
    syncFields();
    draw();
  };
  const onResize = () => draw();
  window.addEventListener('resize', onResize);

  const begin = () => {
    slider.setRange(duration, 0, duration);
    syncFields();
    requestAnimationFrame(draw);
  };

  // The song's length: the library's, else the audio's own.
  if (duration) begin();
  else {
    setStatus(T('common.readingSong'));
    audio.addEventListener('loadedmetadata', () => {
      if (gone || duration || !Number.isFinite(audio.duration)) return;
      duration = audio.duration;
      begin();
      loadPeaks();
    }, { once: true });
  }

  async function loadPeaks() {
    if (!duration) return;
    const jobs = songPeakJobs(song, duration);
    if (!jobs.length) {
      setStatus(T(`songEdit.trim.noWaveform.${Store.hereKey}`));
      return;
    }
    setStatus(T('common.drawingWaveform'));
    let got = null;
    for (const job of jobs) {
      try {
        got = await job();
        break;
      } catch {
        // The next way, if there is one.
      }
    }
    if (gone) return;
    peaks = got;
    setStatus(got ? '' : T('common.trim.waveformFailed'));
    draw();
  }
  if (duration) loadPeaks();

  // SponsorBlock's marked parts, as on Add Songs (Settings, Media Management).
  if (Store.settings.sponsorBlock && (song.sourceKey || song.sourceUrl)) {
    window.flow.sponsorSegments(song.sourceKey || '', song.sourceUrl || '').then((list) => {
      if (gone) return;
      segments = list.filter((x) => x.kind === 'sponsor' || (x.kind === 'intro' && Store.settings.sponsorBlockIntros));
      draw();
    }).catch(() => {});
  }
  drawPlay();

  return {
    el,
    hint,
    resetBtn,
    /** The trim to save ({ start, end }), or null when the handles are at the ends. */
    cut() {
      if (!enabled || !duration) return null;
      const start = slider.start > TRIM_EDGE ? slider.start : 0;
      const end = slider.end < duration - TRIM_EDGE ? slider.end : duration;
      return start || end < duration ? { start, end } : null;
    },
    stop,
    destroy() {
      gone = true;
      stop();
      cancelAnimationFrame(raf);
      audio.removeAttribute('src');
      audio.load();
      window.removeEventListener('resize', onResize);
      Player._volumeListeners = (Player._volumeListeners || []).filter((fn) => fn !== onVolume);
      AudioFocus.register('songEdit', () => {});
    },
  };
}

/**
 * Edit Song: Artist, Title, Album, Mix, Genre and Info, its lyrics, and the trim. Saves
 * itself; resolves true when something was saved. An album left empty is
 * the title.
 */
function editSongDialog(song, heading = T('songEdit.title')) {
  return new Promise((resolve) => {
    const field = (name, value, placeholder = '') => h('input.input.settings__input.song-edit__input', {
      type: 'text', value: value || '', name, maxLength: 150, spellcheck: false, placeholder,
    });
    const artist = field('artist', song.artist);
    const title = field('title', song.title);
    const mix = field('mix', song.mix, T('common.mixPlaceholder'));
    const album = field('album', song.album, T('common.albumPlaceholder'));
    const genre = field('genre', song.genre, T('songEdit.field.genre.placeholder'));
    const subGenre = field('subGenre', song.subGenre, T('common.infoPlaceholder'));
    const row = (label, input) => h('label.settings__row',
      h('div.settings__left', h('div.settings__label.settings__label--plain', label)),
      h('div.settings__right', input));

    // With a server, the server cuts its file: one too old for that (or
    // without ffmpeg) cannot. Not connected, the trim waits for it.
    const st = Store.server;
    const serverCannot = st.on && st.state === 'online' && !st.trim;
    // Only the profile that uploaded a song trims it (the server refuses the
    // others; the Default / Shared is one too); one without an uploader, or
    // whose uploader is gone, anyone.
    const owner = st.on && song.addedBy ? Store.profileName(song.addedBy) : '';
    const othersSong = !!owner && song.addedBy !== Store.uploaderId();
    // The phone cuts no file itself: without a server, no trim there.
    const trim = !othersSong && (Store.can('localTrim') || st.on) ? songTrimEditor(song, { enabled: !serverCannot }) : null;
    let note;
    if (othersSong) note = T('songEdit.trim.note.onlyOwner', { profile: owner });
    else if (!trim) note = T('songEdit.trim.note.phoneNeedsServer');
    else if (serverCannot) note = T('common.serverCannotTrim');
    else if (st.on && st.state === 'online') note = T('songEdit.trim.note.serverCuts');
    else if (st.on) note = T('songEdit.trim.note.serverCutsLater');
    else note = T('songEdit.trim.note.recycleBin');
    const error = h('div.form-error');
    let saved = false;
    let modal = null;

    // Lyrics: what the song has, Edit Lyrics (Add Lyrics without words) and
    // Show in Song Details, which closes this for Song Details.
    const lyricsInfo = h('span.song-edit__lyrics');
    const lyricsButtons = h('div.song-edit__lyrics-btns');
    const lyricsRow = window.flow.lyrics ? h('div.settings__row',
      h('div.settings__left', h('div.settings__label.settings__label--plain', T('common.lyrics'))),
      h('div.settings__right.song-edit__lyrics-right', lyricsInfo, lyricsButtons)) : null;
    const show = h('button.btn.btn--small', {
      type: 'button',
      title: T('songEdit.lyrics.showInDetails.tooltip'),
      onclick: () => {
        modal.close();
        SongDetails.open(song.id);
      },
    }, T('songEdit.lyrics.showInDetails'));
    const drawLyrics = (state, data = null, err = '') => {
      clear(lyricsInfo);
      clear(lyricsButtons);
      if (state === 'loading') lyricsInfo.append(LyricsEdit.spinner(), T('common.lookingForLyrics'));
      else if (state === 'error') lyricsInfo.append(err);
      else lyricsInfo.append(LyricsEdit.summary(data));
      if (state === 'ready' && LyricsEdit.available) {
        lyricsButtons.appendChild(h('button.btn.btn--small.btn--light-green', {
          type: 'button', onclick: () => LyricsEdit.openFor(song, data, loadLyrics),
        }, LyricsEdit.hasWords(data) ? T('common.editLyrics') : T('common.addLyrics')));
      }
      lyricsButtons.appendChild(show);
    };
    const loadLyrics = async () => {
      drawLyrics('loading');
      try {
        drawLyrics('ready', await window.flow.lyrics(song.id));
      } catch (err) {
        drawLyrics('error', null, (err && err.message) || T('common.lyricsNotFetched'));
      }
    };
    if (lyricsRow) loadLyrics();

    const save = async () => {
      error.textContent = '';
      const meta = {
        artist: artist.value.trim(),
        title: title.value.trim(),
        mix: mix.value.trim(),
        album: album.value.trim(),
        genre: genre.value.trim(),
        subGenre: subGenre.value.trim(),
      };
      if (!meta.title) {
        error.textContent = T('common.enterTitle');
        return false;
      }
      const renamed = meta.artist !== song.artist || meta.title !== song.title || meta.mix !== song.mix
        || meta.album !== (song.album || '') || meta.genre !== (song.genre || '') || meta.subGenre !== (song.subGenre || '');
      const cut = trim && trim.cut();
      if (!renamed && !cut) return true;
      if (trim) trim.stop();
      const token = Player.release(song.id);
      try {
        if (renamed) await window.flow.editSong(song.id, meta);
        if (cut) await window.flow.trimSong(song.id, cut.start, cut.end);
      } catch (err) {
        error.textContent = (err && err.message) || String(err);
        Player.resume(token);
        return false;
      }
      saved = true;
      Player.resume(token);
      if (cut) toast(T('songEdit.trim.done', { song: meta.title, duration: Util.fmtClock(cut.end - cut.start) }), 'success');
      return true;
    };

    modal = Modal.open({
      title: heading,
      className: 'modal--settings.modal--song-edit',
      focus: 'input[name="title"]',
      body: [h('div.settings.song-edit',
        h('h3.settings__section.settings__section--static', T('common.song')),
        row(T('common.artist'), artist),
        row(T('common.title'), title),
        row(T('common.album'), album),
        row(T('common.mix'), mix),
        row(T('common.genre'), genre),
        row(T('common.info'), subGenre),
        lyricsRow,
        trim && h('h3.settings__section.settings__section--static.song-edit__trim-head', h('span', T('common.trim')), trim.hint, trim.resetBtn),
        othersSong && h('h3.settings__section.settings__section--static', T('common.trim')),
        trim && trim.el,
        h('div.settings__desc.song-edit__note', note),
        error)],
      buttons: [
        { label: T('common.cancel') },
        { label: T('common.save'), kind: 'primary', onClick: save },
      ],
      onClose: () => {
        if (trim) trim.destroy();
        resolve(saved);
      },
    });
    for (const f of [artist, title, album, mix, genre, subGenre]) {
      f.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') modal.el.querySelector('.btn--primary').click();
      });
    }
  });
}
