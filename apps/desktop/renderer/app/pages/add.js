'use strict';

// Add Songs: paste a link, download, trim, name, pick playlists, Finish.
// A link to a whole playlist (or a Spotify list) goes to import.js instead,
// which shows a checklist and imports untrimmed. Files from the computer
// ("Open local File(s)" / "Open local Folder") go there too, straight to the
// trimming step.
//
//   idle -> probing -> downloading -> ready -> (saving) -> idle
//
// The progress frame under the link box (LWClipper's title / bar + Cancel /
// status line) follows every step. Once the song is ready the trim editor
// appears: the waveform across the whole width, the trim slider below it and
// a preview player, so the cut can be heard before it is saved.

const AddPage = {
  phase: 'idle',
  probed: null,      // what yt-dlp said about the link
  media: null,       // { path, duration, ext, summary } of the cached song
  peaks: null,
  slider: null,
  playlistIds: [],
  _stopAt: null,     // the preview stops here (the end handle), or null
  _raf: 0,
  _scrubbing: false,

  init() {
    this.audio = $('previewAudio');
    // Kept by reference: inside an import frame the editor is briefly out of
    // the document whenever the frames are redrawn, and $('editor') is null then.
    this.editorEl = $('editor');
    AudioFocus.register('preview', () => this.audio.pause());

    $('downloadBtn').onclick = () => this.startDownload();
    $('linkInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.startDownload();
    });
    $('openFilesBtn').onclick = () => this.openLocal(false);
    $('openFolderBtn').onclick = () => this.openLocal(true);
    $('progCancel').onclick = () => (ImportPanel.busy ? ImportPanel.cancel() : window.yplayer.cancelDownload());
    window.yplayer.onDownloadProgress((p) => this._onProgress(p));

    // The checklist's size estimate follows the MP3 settings.
    Store.onSettings((patch) => {
      if (('alwaysMp3' in patch || 'mp3Quality' in patch) && ImportPanel.state === 'review') ImportPanel._drawCount();
    });

    this._initEditor();

    $('addToPlaylistBtn').onclick = () => this.choosePlaylists();
    $('finishBtn').onclick = () => (ImportPanel.ownsFooter ? ImportPanel.finishAll() : this.finish());
  },

  show() {
    if (this.phase === 'idle') {
      setTimeout(() => $('linkInput').focus(), 0);
    }
    // The canvas had no size while the page was hidden.
    requestAnimationFrame(() => this._redraw());
  },

  get editorReady() {
    return this.phase === 'ready' && !!this.media;
  },

  /** How downloads are converted, from Settings > Downloads. */
  downloadOptions() {
    const s = Store.settings;
    return { alwaysMp3: !!s.alwaysMp3, quality: Number(s.mp3Quality), keepMp3: s.keepMp3 !== false };
  },

  // ---- downloading ----

  async startDownload() {
    if (this.phase === 'probing' || this.phase === 'downloading' || this.phase === 'saving') return;
    const url = $('linkInput').value.trim();
    if (!url) {
      this._showError('Paste a link into the box first.');
      $('linkInput').focus();
      return;
    }
    if (this.editorReady) {
      const ok = await confirmDialog({
        title: 'Discard current song?',
        message: 'The song in the editor has not been saved yet. Download the new link and discard it?',
        confirmLabel: 'Discard',
        danger: true,
      });
      if (!ok) return;
    }
    if (ImportPanel.busy) {
      this._showError('A playlist import is still open. Finish it ("Finish all") or cancel it first.');
      return;
    }
    // A new link replaces a checklist that was never started.
    if (ImportPanel.state === 'review') ImportPanel.close();
    this._discard();
    $('progressPanel').hidden = true;

    let kind = this._linkKind(url);
    if (kind === 'ask') {
      kind = await this._askSongOrList(url);
      if (!kind) return;
    }

    let probed = null;
    let warned = false;
    if (kind === 'list') {
      // Playlists get their checklist; a link that turns out to be one song
      // comes back as that song, already read.
      probed = await ImportPanel.open(url);
      if (!probed) return;
    } else {
      // A link that is plainly the same (the same YouTube video, the same page).
      try {
        const dup = await window.yplayer.findBySource(url, null);
        if (dup) {
          if (!await this._confirmDuplicateSource(dup)) return;
          warned = true;
        }
      } catch {
        // Checking is a courtesy; carry on without it.
      }
      this._setPhase('probing');
      this._progress({ title: 'Reading link...', frac: null, status: url });
      try {
        probed = await window.yplayer.probe(url);
      } catch (err) {
        this._failed(err);
        return;
      }
    }

    // The same song under a different link (youtu.be vs youtube.com/shorts).
    if (!warned && probed.key) {
      try {
        const dup = await window.yplayer.findBySource(null, probed.key);
        if (dup && !await this._confirmDuplicateSource(dup)) {
          this._setPhase('idle');
          $('progressPanel').hidden = true;
          return;
        }
      } catch {
        // As above.
      }
    }

    this.probed = probed;
    this._setPhase('downloading');
    this._progress({ title: probed.title, frac: null, status: 'Starting download...' });
    let media;
    try {
      media = await window.yplayer.download(probed, this.downloadOptions());
    } catch (err) {
      this._failed(err);
      return;
    }
    this.media = media;
    this._progress({ title: probed.title, frac: 1, status: media.summary, cancel: false });
    this._openEditor();
  },

  // ---- local files ----

  /** "Open local File(s)" / "Open local Folder": the picked ones go to import.js. */
  async openLocal(folder) {
    if (this.phase !== 'idle' || ImportPanel.state !== 'idle') return;
    let picked;
    try {
      picked = folder ? await window.yplayer.pickLocalFolder() : await window.yplayer.pickLocalFiles();
    } catch (err) {
      this._showError(err.message);
      return;
    }
    if (!picked || this.phase !== 'idle' || ImportPanel.state !== 'idle') return;
    $('progressPanel').hidden = true;
    $('progTitle').textContent = '';
    await ImportPanel.openLocal(picked);
  },

  /** The "or" and the local buttons, only while nothing else is open. */
  drawLocalPick() {
    const importing = typeof ImportPanel !== 'undefined' && ImportPanel.state !== 'idle';
    $('localPick').hidden = this.phase !== 'idle' || importing;
  },

  /**
   * 'song' for a link that can only be one song, 'ask' for a song inside a
   * playlist (YouTube's watch?v=...&list=...), 'list' for everything else:
   * reading it says whether it is a list or one song.
   */
  _linkKind(text) {
    const t = text.trim();
    if (/^spotify:|spotify\.com\//i.test(t)) return 'list';
    let u;
    try {
      u = new URL(/^[a-z]+:\/\//i.test(t) ? t : 'https://' + t);
    } catch {
      return 'song';
    }
    const host = u.hostname.replace(/^(www|m|music)\./i, '').toLowerCase();
    const list = u.searchParams.get('list');
    if (host === 'youtu.be') return list ? 'ask' : 'song';
    if (host === 'youtube.com') {
      if (u.pathname === '/watch') return list ? 'ask' : 'song';
      if (u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/live/')) return 'song';
    }
    return 'list';
  },

  /** A song that is part of a playlist: that song, or the whole list? */
  _askSongOrList(url) {
    let list = '';
    try {
      list = new URL(/^[a-z]+:\/\//i.test(url) ? url : 'https://' + url).searchParams.get('list') || '';
    } catch {
      // Asked anyway.
    }
    const mix = /^RD/.test(list);
    return new Promise((resolve) => {
      let answer = null;
      Modal.open({
        title: 'Song or playlist?',
        className: 'modal--small',
        body: [h('p.modal__text', mix
          ? 'This song was opened from a YouTube Mix. A Mix is made up for you and never ends; importing it lists its first 50 songs.'
          : 'This link is a song inside a playlist. Download just this song, or import the whole playlist?')],
        buttons: [
          { label: 'Cancel' },
          { label: mix ? 'Import the Mix' : 'Whole playlist', onClick: () => { answer = 'list'; } },
          { label: 'This song only', kind: 'primary', onClick: () => { answer = 'song'; } },
        ],
        onClose: () => resolve(answer),
      });
    });
  },

  async _confirmDuplicateSource(song) {
    const ok = await confirmDialog({
      title: 'Already in your library',
      message: `This link is already in your library as "${Util.songLine(song)}". Download it anyway?`,
      confirmLabel: 'Download anyway',
    });
    return !!ok;
  },

  _onProgress({ stage, frac, text }) {
    if (this.phase !== 'downloading') return;
    this._progress({ title: this.probed ? this.probed.title : '', frac, status: text, stage });
  },

  _progress({ title, frac, status, cancel = true }) {
    $('progressPanel').hidden = false;
    $('progError').hidden = true;
    $('progTitle').textContent = title || '';
    const bar = $('progBar');
    bar.hidden = false;
    if (frac === null || frac === undefined) bar.removeAttribute('value');
    else bar.value = frac;
    $('progCancel').hidden = !cancel;
    $('progStatus').textContent = status || '';
  },

  _failed(err) {
    const cancelled = err && (err.cancelled || /^Cancelled\.?$/.test(err.message));
    this._setPhase('idle');
    $('progBar').hidden = true;
    $('progCancel').hidden = true;
    if (cancelled) {
      $('progStatus').textContent = 'Cancelled.';
      $('progError').hidden = true;
    } else {
      $('progStatus').textContent = 'Download failed.';
      this._showError(err ? err.message : 'Something went wrong.');
    }
  },

  _showError(message) {
    $('progressPanel').hidden = false;
    if (this.phase === 'idle' && !$('progTitle').textContent) {
      $('progBar').hidden = true;
      $('progCancel').hidden = true;
    }
    $('progError').textContent = message;
    $('progError').hidden = false;
  },

  _setPhase(phase) {
    this.phase = phase;
    const busy = phase === 'probing' || phase === 'downloading' || phase === 'saving';
    const importing = typeof ImportPanel !== 'undefined' && ImportPanel.busy;
    $('downloadBtn').disabled = busy || importing;
    $('linkInput').disabled = phase === 'probing' || phase === 'downloading' || importing;
    const ready = phase === 'ready' || phase === 'saving';
    this.editorEl.hidden = !ready;
    this.drawLocalPick();
    // A playlist import has the footer to itself ("Finish all").
    if (importing || (typeof ImportPanel !== 'undefined' && ImportPanel.ownsFooter)) return;
    $('addFooter').hidden = !ready;
    $('finishBtn').disabled = phase === 'saving';
    $('addToPlaylistBtn').disabled = phase === 'saving';
    $('finishBtn').textContent = phase === 'saving' ? 'Saving...' : 'Finish';
  },

  /** Throws away the cached download and empties the editor. */
  _discard() {
    if (this.embedded) this.closeEmbedded();
    this._stopPreview(true);
    if (this.media) window.yplayer.discardDownload(this.media.path).catch(() => {});
    this.media = null;
    this.probed = null;
    this.peaks = null;
    this.playlistIds = [];
    this._drawPlaylistButton();
    this._setPhase('idle');
    $('progTitle').textContent = '';
    $('progError').hidden = true;
  },

  // ---- the editor ----

  _initEditor() {
    this.slider = new TrimSlider($('trimSlider'), $('startHandle'), $('endHandle'), $('trimFill'));
    this.slider.onChange = (start, end, which) => {
      this._syncFields();
      this._redraw();
      // Moving a handle while stopped moves the playhead with it, so Play
      // lets you hear the new start, or the last seconds before the new end.
      if (this.audio.paused && this.media) {
        const t = which === 'start' ? start : Math.max(start, end - 3);
        this._seek(t);
      }
    };
    this.slider.onDragStateChange = (factor) => {
      const hint = $('trimHint');
      if (factor === FINE_CTRL) hint.textContent = 'Fine: 100x';
      else if (factor === FINE_SHIFT) hint.textContent = 'Fine: 10x';
      else hint.textContent = 'Hold Shift while dragging for 10x finer control, Ctrl for 100x';
      hint.classList.toggle('hint--active', factor !== 1);
    };

    // Clicking or dragging on the waveform or the slider's track moves the
    // playhead there.
    const scrubOn = (node) => {
      node.addEventListener('pointerdown', (e) => {
        if (!this.media || e.target.classList.contains('trim-slider__handle')) return;
        node.setPointerCapture(e.pointerId);
        this._scrubbing = true;
        const at = (ev) => {
          const r = node.getBoundingClientRect();
          return this.slider.xToValue(ev.clientX - r.left);
        };
        this._seek(at(e));
        const move = (ev) => this._seek(at(ev));
        const up = () => {
          this._scrubbing = false;
          node.removeEventListener('pointermove', move);
          node.removeEventListener('pointerup', up);
          node.removeEventListener('pointercancel', up);
        };
        node.addEventListener('pointermove', move);
        node.addEventListener('pointerup', up);
        node.addEventListener('pointercancel', up);
      });
    };
    scrubOn($('waveCanvas'));
    scrubOn($('trimSlider'));

    const bindField = (field, isStart) => {
      const apply = () => {
        if (!this.media) return;
        try {
          const v = Util.parsePrecise(field.value);
          if (isStart) this.slider.setStart(v);
          else this.slider.setEnd(v);
        } catch {
          // Unreadable: put back what the slider says.
        }
        this._syncFields();
      };
      field.addEventListener('change', apply);
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          apply();
          field.blur();
        }
        if (e.key === 'Escape') {
          e.stopPropagation();
          this._syncFields();
          field.blur();
        }
      });
    };
    bindField($('startField'), true);
    bindField($('endField'), false);
    $('resetTrimBtn').onclick = () => {
      if (!this.media) return;
      this.slider.setRange(this.media.duration, 0, this.media.duration);
      this._syncFields();
      this._redraw();
    };

    // The hint is about the suggestion; once the box is typed in it has done its job.
    $('edArtist').addEventListener('input', () => {
      $('edArtistHint').hidden = true;
    });

    $('previewPlay').onclick = () => this.togglePreview();
    this.audio.addEventListener('play', () => {
      AudioFocus.claim('preview');
      this._drawPreviewButton();
      this._tick();
    });
    this.audio.addEventListener('pause', () => this._drawPreviewButton());
    this.audio.addEventListener('ended', () => this._drawPreviewButton());
    this.audio.addEventListener('timeupdate', () => {
      if (this.audio.paused) this._drawPlayhead();
    });

    window.addEventListener('resize', () => this._redraw());
  },

  // ---- the editor inside an imported song's frame (import.js) ----

  /**
   * Opens the editor in `host` for a song of a playlist import. Its cached
   * file belongs to the import, which also keeps the cut and names: read them
   * back with closeEmbedded().
   */
  openEmbedded(host, { media, meta, title, start, end, artistFromChannel }) {
    this._stopPreview(true);
    this.embedded = true;
    host.prepend(this.editorEl);
    this.media = media;
    this.probed = { title, guess: { ...meta, artistFromChannel } };
    this._openEditor({ start, end });
  },

  /** Closes the embedded editor: { start, end, meta } as it was left. */
  closeEmbedded() {
    if (!this.embedded) return null;
    // Back to its own place on the page first (hidden below): its boxes are
    // only found by id while it is in the document.
    $('importPanel').after(this.editorEl);
    const result = this.media ? {
      start: this.slider.start,
      end: this.slider.end,
      meta: { artist: $('edArtist').value.trim(), title: $('edTitle').value.trim(), mix: $('edMix').value.trim() },
    } : null;
    this._stopPreview(true);
    this.media = null;
    this.probed = null;
    this.peaks = null;
    this.embedded = false;
    this._setPhase('idle');
    return result;
  },

  async _openEditor({ start = 0, end = null } = {}) {
    const m = this.media;
    const guess = (this.probed && this.probed.guess) || {};
    $('edArtist').value = guess.artist || '';
    $('edArtistHint').hidden = !(guess.artistFromChannel && guess.artist);
    $('edTitle').value = guess.title || (this.probed ? this.probed.title : '');
    $('edMix').value = guess.mix || '';
    $('edError').textContent = '';
    this.slider.setRange(m.duration, start || 0, end === null || end === undefined ? m.duration : end);
    this._syncFields();
    this.audio.src = Util.fileUrl(m.path);
    this.audio.currentTime = 0;
    this._drawPreviewButton();
    this._setPhase('ready');
    this.peaks = null;
    $('waveStatus').hidden = false;
    $('waveStatus').textContent = 'Drawing waveform...';
    requestAnimationFrame(() => this._redraw());
    try {
      const peaks = await window.yplayer.peaks(m.path, m.duration);
      if (this.media !== m) return;
      this.peaks = peaks;
      $('waveStatus').hidden = true;
    } catch (err) {
      if (this.media !== m) return;
      $('waveStatus').textContent = 'Could not draw the waveform, but the song can still be trimmed.';
    }
    this._redraw();
  },

  _syncFields() {
    const s = this.slider;
    $('startField').value = Util.fmtPrecise(s.start);
    $('endField').value = Util.fmtPrecise(s.end);
    const total = this.media ? this.media.duration : 0;
    $('spanLabel').textContent = `Selection: ${Util.fmtPrecise(s.end - s.start)}   of   ${Util.fmtPrecise(total)}`;
  },

  _redraw() {
    if (!this.media || this.editorEl.hidden) return;
    drawWaveform($('waveCanvas'), this.peaks, this.media.duration, this.slider.start, this.slider.end);
    this.slider._reposition();
    this._drawPlayhead();
  },

  _drawPlayhead() {
    if (!this.media) return;
    const t = this.audio.currentTime || 0;
    // Both lines use the slider's mapping, so they sit over the same second.
    const waveX = sliderMetrics($('waveCanvas').clientWidth).inset
      + (t / this.media.duration) * sliderMetrics($('waveCanvas').clientWidth).usable;
    $('wavePlayhead').style.left = waveX + 'px';
    $('trimPlayhead').style.left = this.slider.valueToX(t) + 'px';
    $('previewTime').textContent = `${Util.fmtClock(t)} / ${Util.fmtClock(this.media.duration)}`;
  },

  _drawPreviewButton() {
    const playing = !this.audio.paused;
    $('previewPlay').innerHTML = playing ? Icons.pause : Icons.play;
    $('previewPlay').title = playing ? 'Pause (Space)' : 'Play (Space)';
  },

  // ---- the preview ----

  togglePreview() {
    if (!this.editorReady) return;
    if (!this.audio.paused) {
      this.audio.pause();
      return;
    }
    const a = this.audio;
    const { start, end } = this.slider;
    // At the end of the selection or the file: start the selection over.
    if (a.currentTime >= end - 0.05 && a.currentTime <= end + 0.05) a.currentTime = start;
    if (a.currentTime >= this.media.duration - 0.05) a.currentTime = start;
    // Playing up to the end handle stops there. Playing from past it (to
    // listen to the part being cut) carries on to the end of the file.
    this._stopAt = a.currentTime < end ? end : null;
    a.play().catch(() => this._drawPreviewButton());
  },

  _tick() {
    cancelAnimationFrame(this._raf);
    const step = () => {
      if (this.audio.paused) {
        this._drawPlayhead();
        return;
      }
      if (this._stopAt !== null && this.audio.currentTime >= this._stopAt) {
        this.audio.pause();
        this.audio.currentTime = this._stopAt;
      }
      this._drawPlayhead();
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  },

  _seek(t) {
    if (!this.media) return;
    const v = Math.max(0, Math.min(this.media.duration, t));
    this.audio.currentTime = v;
    if (!this.audio.paused) this._stopAt = v < this.slider.end ? this.slider.end : null;
    this._drawPlayhead();
  },

  skipPreview(delta) {
    if (!this.editorReady) return;
    this._seek((this.audio.currentTime || 0) + delta);
  },

  _stopPreview(unload) {
    this.audio.pause();
    cancelAnimationFrame(this._raf);
    if (unload) {
      this.audio.removeAttribute('src');
      this.audio.load();
    }
  },

  // ---- playlists and saving ----

  async choosePlaylists() {
    const chosen = await pickPlaylists({
      subtitle: [$('edTitle').value, $('edArtist').value].filter(Boolean).join(' - '),
      selectedIds: this.playlistIds,
    });
    if (chosen === null) return;
    this.playlistIds = chosen;
    this._drawPlaylistButton();
  },

  _drawPlaylistButton() {
    const names = this.playlistIds.map((id) => Store.playlist(id)).filter(Boolean).map((p) => p.name);
    this.playlistIds = this.playlistIds.filter((id) => Store.playlist(id));
    $('addToPlaylistBtn').innerHTML = Icons.plus + `<span>Add to Playlist${names.length ? ` (${names.length})` : ''}</span>`;
    $('addToPlaylistBtn').title = names.length ? names.join(', ') : 'Choose playlists for this song';
    $('addPlaylistNames').textContent = names.length ? names.join(', ') : '';
  },

  async finish() {
    if (!this.editorReady) return;
    const meta = {
      artist: $('edArtist').value.trim(),
      title: $('edTitle').value.trim(),
      mix: $('edMix').value.trim(),
    };
    if (!meta.title) {
      $('edError').textContent = 'Please enter a title.';
      $('edTitle').focus();
      return;
    }
    $('edError').textContent = '';
    try {
      const dup = await window.yplayer.findByMeta(meta);
      if (dup) {
        const ok = await confirmDialog({
          title: 'Already in your library',
          message: `"${Util.songLine(dup)}" is already in your library. Save this one as well?`,
          confirmLabel: 'Save anyway',
        });
        if (!ok) return;
      }
    } catch {
      // Checking is a courtesy.
    }

    const m = this.media;
    const job = {
      cachePath: m.path,
      start: this.slider.start,
      end: this.slider.end,
      duration: m.duration,
      ...meta,
      sourceUrl: this.probed ? this.probed.url : '',
      sourceKey: this.probed ? this.probed.key : '',
      playlistIds: this.playlistIds,
    };
    // Let go of the cached file: it is read by ffmpeg and then deleted.
    const position = this.audio.currentTime;
    this._stopPreview(true);
    this._setPhase('saving');
    try {
      const song = await window.yplayer.finishSong(job);
      toast(`Saved "${Util.songLine(song)}"`, 'success');
      this.media = null;
      this._discard();
      $('linkInput').value = '';
      $('progressPanel').hidden = true;
      $('linkInput').focus();
    } catch (err) {
      toast(err.message, 'error');
      this._setPhase('ready');
      this.audio.src = Util.fileUrl(m.path);
      this.audio.currentTime = position;
      this._redraw();
    }
  },
};
