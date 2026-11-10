'use strict';

// Add Songs: paste a link (or several, or a song's name), and it is
// downloaded, trimmed, named and saved. Every link is a batch of import.js
// (a playlist with its checklist, a song as a batch of one song); files from
// the computer ("Open local File(s)" / "Open local Folder") too. Words
// instead of a link (a song's name) are searched for (songSearch.js), and
// the upload picked comes back here as its link.
//
// A link goes through the Client queue (clientQueue.js): at once when this
// computer downloads nothing else, else at its turn (runEntry), with the
// "Auto-accept songs lookup" and "Automate 'Finish all'" as they are at
// its turn (entry.auto, kept up to date while it waits or is read): no questions, and saved as it came.
//
// This holds the trim editor, which opens in the frame of the song being
// trimmed (openEmbedded): the waveform across the whole width, the trim
// slider below it and a preview player, so the cut can be heard before it
// is saved. The progress frame under the link box (LWClipper's title / bar +
// Cancel / status line) is the search's, and shows what failed.
//
//   phase: idle -> ready (the editor open in a frame) -> idle

const AddPage = {
  phase: 'idle',
  probed: null,      // what yt-dlp said about the link
  media: null,       // { path, duration, ext, summary } of the cached song
  peaks: null,
  // SponsorBlock's marked parts of a YouTube song ([{ start, end, kind }]),
  // coloured in the waveform while the settings ask for them.
  segments: [],
  _source: null,     // { key, url } of the song in the editor, for those
  // The lyrics of the song in the editor (4.0, newLyrics): a playlist's
  // song's are its frame's (import.js), shown here while it is open.
  lyrics: null,
  _lyricsChain: null,
  slider: null,
  _stopAt: null,     // the preview stops here (the end handle), or null
  _raf: 0,
  _scrubbing: false,

  init() {
    this.audio = $('previewAudio');
    // Kept by reference: inside an import frame the editor is briefly out of
    // the document whenever the frames are redrawn, and $('editor') is null then.
    this.editorEl = $('editor');
    AudioFocus.register('preview', () => this.audio.pause());

    // Without yt-dlp in the tools folder it is greyed out and opens the legal note.
    $('downloadBtn').onclick = () => (DownloadsHelp.here ? this.startDownload() : DownloadsHelp.open());
    $('downloadsHelpBtn').onclick = () => DownloadsHelp.open();
    $('linkInput').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // Where songs cannot be downloaded here (the phone, no yt-dlp), the server downloads.
      if (DownloadsHelp.here) this.startDownload();
      else if (!$('serverDownloadBtn').hidden) $('serverDownloadBtn').click();
    });
    this._initAutoRow();
    $('openFilesBtn').onclick = () => this.openLocal(false);
    $('openFolderBtn').onclick = () => this.openLocal(true);
    this.drawLocalPick();
    // The progress frame is the search's (a batch has its own).
    $('progCancel').onclick = () => {
      if (SongSearch.busy) SongSearch.cancel();
    };
    window.flow.onDownloadProgress((p) => ImportPanel.songProgress(p));

    Store.onSettings((patch) => {
      if ('sponsorBlock' in patch || 'sponsorBlockIntros' in patch) this._loadSegments();
    });

    this._initEditor();

    // The phone's Share > Flow.
    if (window.flow.onShare) window.flow.onShare((s) => this.shared(s));
  },

  /** opts.shared: opened for a shared link (no keyboard brought up). */
  show(opts = {}) {
    if (this.phase === 'idle' && !opts.shared) {
      setTimeout(() => $('linkInput').focus(), 0);
    }
    // A download on the server may have moved on (or been started elsewhere).
    if (ServerImport.available) ServerImport.poll();
    // The canvas had no size while the page was hidden.
    requestAnimationFrame(() => this._redraw());
  },

  /**
   * A link shared to Flow (the phone's Share; { url, text }): Add Songs opens
   * with it in the box, and the server downloads it as soon as it can.
   */
  shared({ url, text }) {
    if (!url) {
      toast(text ? T('add.share.noLink') : T('add.share.nothing'), 'error');
      return;
    }
    Nav.show('add', { shared: true });
    $('linkInput').value = url;
    ServerImport.startShared(url);
  },

  get editorReady() {
    return this.phase === 'ready' && !!this.media;
  },

  /** How downloads are converted, from Settings > Media Management. */
  downloadOptions() {
    const s = Store.settings;
    return { alwaysMp3: !!s.alwaysMp3, quality: Number(s.mp3Quality), keepMp3: s.keepMp3 !== false };
  },

  // ---- downloading ----

  /**
   * Download for the link in the box. Words instead of a link (a song's
   * name) are searched for first (songSearch.js); the upload picked there
   * comes back here as `pick` ({ url, title }), downloaded as that one song.
   */
  async startDownload(pick = null) {
    const url = pick ? pick.url : $('linkInput').value.trim();
    if (!url) {
      if (ClientQueue.busy) toast(T('common.emptyBox'), 'error');
      else this._showError(T('common.emptyBox'));
      $('linkInput').focus();
      return;
    }
    // Several links pasted at once ("a, b, c"): read as one list.
    const many = !pick && this.isLinkList(url);
    if (!pick && !many && this.isSearch(url)) {
      SongSearch.open(url, 'client');
      return;
    }
    // The link an Update put into the box (any other link: no Update).
    const updating = !pick && ImportPanel.updating && url === ImportPanel.updating.url ? ImportPanel.updating : null;
    let kind = pick ? 'song' : (updating || many ? 'list' : this._linkKind(url));
    if (kind === 'ask') {
      kind = await this._askSongOrList(url);
      if (!kind) return;
    }
    // Started or queued: the box is free for the next one.
    $('linkInput').value = '';
    ClientQueue.offer({
      url, kind, title: pick ? pick.title || '' : '', updating, auto: this.autoNow(),
    });
  },

  /**
   * "Auto-accept songs lookup" and "Automate 'Finish all'" as they are
   * now (Settings › Media Management, or the boxes under the link box): a
   * link queued keeps them.
   */
  autoNow() {
    const s = Store.settings;
    const complete = !!s.autoComplete;
    return { complete, finish: complete && !!s.autoFinish };
  },

  /** The boxes under the link box: the settings themselves, switched here too. */
  _initAutoRow() {
    const main = $('autoCompleteBox');
    const sub = $('autoFinishBox');
    const draw = () => {
      main.checked = !!Store.settings.autoComplete;
      sub.checked = !!Store.settings.autoFinish;
      // Always there, greyed out (and not counted, autoNow) while the box above is unticked.
      sub.disabled = !main.checked;
      $('autoFinishLabel').classList.toggle('auto-row__sub--off', !main.checked);
    };
    main.addEventListener('change', () => Store.saveSettings({ autoComplete: main.checked }));
    sub.addEventListener('change', () => Store.saveSettings({ autoFinish: sub.checked }));
    Store.onSettings((patch) => {
      if (!('autoComplete' in patch || 'autoFinish' in patch)) return;
      draw();
      ClientQueue.followAuto(this.autoNow());
    });
    draw();
  },

  /**
   * A link's turn (ClientQueue): its batch (import.js), read and downloaded
   * as it always was, with entry.auto deciding what is asked. Resolves once
   * the batch has its checklist or is downloaded (or done, or given up).
   */
  async runEntry(entry) {
    const opts = { auto: entry.auto || { complete: false, finish: false }, updating: entry.updating || null };
    if (entry.update) {
      const { playlist, listing, server } = entry.update;
      const p = Store.playlist(playlist.id);
      if (p) ImportPanel.openUpdate(p, listing, server);
      return;
    }
    if (entry.local) {
      await ImportPanel.openLocal(entry.local);
      return;
    }
    if (entry.picks) {
      await ImportPanel.openPicked(entry.name, entry.picks, opts);
      return;
    }
    if (entry.kind === 'list') {
      // Playlists get their checklist; a link that turns out to be one song
      // comes back as that song, already read.
      const probed = await ImportPanel.open(entry.url, opts);
      if (probed) await ImportPanel.openSong(entry.url, { ...opts, probed });
      return;
    }
    await ImportPanel.openSong(entry.url, opts);
  },

  /**
   * A playlist's Update through a Flow Server that cannot read a link without
   * downloading it (no "downloadCheck", playlistUpdate.js): its batch here,
   * the songs the playlist has gained downloaded into it, the ones in the
   * library already added to it.
   */
  async updatePlaylist(p) {
    const url = p && p.source && p.source.url;
    if (!url || !ServerImport.available) return;
    Nav.show('add');
    await ServerImport._create({ url, kind: 'list' }, { id: p.id, name: p.name, url });
  },

  /**
   * Several uploads picked from a search's results ("Download Selected",
   * "Download All"; one alone goes to startDownload): downloaded here one
   * after another, as an import's frames (ImportPanel.openPicked).
   */
  async startPicked(picks, name) {
    $('linkInput').value = '';
    ClientQueue.offer({
      url: '', kind: 'list', picks, name, auto: this.autoNow(),
    });
  },

  // ---- local files ----

  /** "Open local File(s)" / "Open local Folder": the picked ones are a batch, at their turn (Client queue). */
  async openLocal(folder) {
    let picked;
    try {
      picked = folder ? await window.flow.pickLocalFolder() : await window.flow.pickLocalFiles();
    } catch (err) {
      this._showError(err.message);
      return;
    }
    if (!picked || !picked.length) return;
    $('progressPanel').hidden = true;
    $('progTitle').textContent = '';
    ClientQueue.offer({ url: '', kind: 'local', local: picked });
  },

  /** The "or" and the local buttons (never in the web player). */
  drawLocalPick() {
    $('localPick').hidden = !Store.can('localFiles');
  },

  /**
   * Words typed instead of a link: anything with a space in it, or one word
   * that names no web host ("Numb", not "youtu.be/abc"). The same test as
   * @flow/core/songSearch isSearch, which the server and the search use.
   */
  isSearch(text) {
    const t = String(text || '').trim();
    if (!t || t.includes('://') || /^spotify:/i.test(t)) return false;
    if (/\s/.test(t)) return true;
    let host;
    try {
      host = new URL(`https://${t}`).hostname;
    } catch {
      return true;
    }
    return !/\.[a-z]{2,}$/i.test(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  },

  /**
   * Several links pasted at once, split at the commas, spaces around them
   * ignored: the links of any site, each once, when the box holds two or
   * more, else [the text]. The same as @flow/core/text splitLinks, which
   * reads them.
   */
  splitLinks(text) {
    const raw = String(text || '').trim();
    if (!raw.includes(',')) return raw ? [raw] : [];
    const linkish = /^(?:spotify:\S+|[a-z][a-z0-9+.-]*:\/\/\S+|[^\s/:,]+\.[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?)$/i;
    const parts = [...new Set(raw.split(',').map((p) => p.trim()).filter(Boolean))];
    return parts.length > 1 && parts.every((p) => linkish.test(p)) ? parts : [raw];
  },

  isLinkList(text) {
    return this.splitLinks(text).length > 1;
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
        title: T('add.songOrPlaylist.title'),
        className: 'modal--small',
        body: [h('p.modal__text', mix
          ? T('add.songOrPlaylist.mix')
          : T('add.songOrPlaylist.playlist'))],
        buttons: [
          { label: T('common.cancel') },
          { label: mix ? T('add.songOrPlaylist.importMix') : T('add.songOrPlaylist.wholePlaylist'), onClick: () => { answer = 'list'; } },
          { label: T('add.songOrPlaylist.songOnly'), kind: 'primary', onClick: () => { answer = 'song'; } },
        ],
        onClose: () => resolve(answer),
      });
    });
  },

  async _confirmDuplicateSource(song, text = 'add.known.link') {
    const ok = await confirmDialog({
      title: T('add.known.title'),
      message: T(text, { song: Util.songLine(song) }),
      confirmLabel: T('add.known.link.confirm'),
    });
    return !!ok;
  },

  /** busy: a spinner after the title, for a wait that reports nothing back. */
  _progress({ title, frac, status, cancel = true, busy = false }) {
    $('progressPanel').hidden = false;
    $('progError').hidden = true;
    $('progTitle').textContent = title || '';
    $('progTitle').classList.toggle('prog-title--busy', busy);
    const bar = $('progBar');
    bar.hidden = false;
    if (frac === null || frac === undefined) bar.removeAttribute('value');
    else bar.value = frac;
    $('progCancel').hidden = !cancel;
    $('progStatus').textContent = status || '';
  },

  /** A task's failure that says it was cancelled. */
  isCancelled(err) {
    return !!(err && (err.cancelled || /^Cancelled\.?$/.test(err.message) || err.message === T('common.cancelled')));
  },

  /** In the progress frame: what failed (`title`) and why. */
  showFailure(title, err) {
    // The search's own line stays while it runs: a toast then.
    if (SongSearch.busy) {
      toast(err ? err.message : T('common.wentWrong'), 'error');
      return;
    }
    this._progress({ title, frac: null, status: '', cancel: false });
    this._failed(err);
  },

  _failed(err) {
    $('progBar').hidden = true;
    $('progCancel').hidden = true;
    $('progTitle').classList.remove('prog-title--busy');
    if (this.isCancelled(err)) {
      $('progStatus').textContent = T('common.cancelled');
      $('progError').hidden = true;
    } else {
      $('progStatus').textContent = T('common.downloadFailed');
      this._showError(err ? err.message : T('common.wentWrong'));
    }
  },

  _showError(message) {
    $('progressPanel').hidden = false;
    $('progTitle').classList.remove('prog-title--busy');
    if (!SongSearch.busy && !$('progTitle').textContent) {
      $('progBar').hidden = true;
      $('progCancel').hidden = true;
    }
    $('progError').textContent = message;
    $('progError').hidden = false;
  },

  /** The editor's phase: 'ready' while it is open in a song's frame, else 'idle'. */
  _setPhase(phase) {
    this.phase = phase;
    this.editorEl.hidden = phase !== 'ready';
  },

  // ---- the editor ----

  _initEditor() {
    this.slider = new TrimSlider($('trimSlider'), $('startHandle'), $('endHandle'), $('trimFill'));
    addTrimNudges(this.slider, $('startField').parentNode, $('endField').parentNode);
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
      if (factor === FINE_CTRL) hint.textContent = T('common.trim.fine100');
      else if (factor === FINE_SHIFT) hint.textContent = T('common.trim.fine10');
      else hint.textContent = T('common.trim.hint');
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
    // Renamed: its lyrics looked up again under the new names (not once written by hand).
    for (const id of ['edArtist', 'edTitle']) {
      $(id).addEventListener('change', () => {
        if (this.lyrics && this.media) this.lookLyrics(this.lyrics, this._names(), this.media.duration);
      });
    }

    // The volume under the selection's length is the player's own: moving
    // either moves both, and the preview plays as loud as the music would.
    // Kept by reference, like the editor (see init).
    this.volSlider = $('prevVolSlider');
    this.volBtn = $('prevVolBtn');
    this.volSlider.addEventListener('input', () => Player.setVolume(Number(this.volSlider.value) / 100));
    this.volBtn.onclick = () => Player.toggleMute();
    $('prevVolWrap').addEventListener('wheel', (e) => {
      e.preventDefault();
      Player.setVolume(Player.volume + (e.deltaY < 0 ? 0.05 : -0.05));
    }, { passive: false });
    Player.onVolume((v) => this._drawVolume(v));
    this._drawVolume(Player.volume);

    $('previewPlay').onclick = () => this.togglePreview();
    this._drawPreviewButton();
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
  openEmbedded(host, {
    media, meta, title, start, end, artistFromChannel, sourceKey = '', sourceUrl = '', lyrics = null,
  }) {
    this._stopPreview(true);
    this.embedded = true;
    this.lyrics = lyrics;
    host.prepend(this.editorEl);
    this.media = media;
    this.probed = { title, guess: { ...meta, artistFromChannel } };
    this._source = { key: sourceKey, url: sourceUrl };
    this._openEditor({ start, end });
  },

  /** Closes the embedded editor: { start, end, meta } as it was left. */
  closeEmbedded() {
    if (!this.embedded) return null;
    // Back to its own place on the page first (hidden): its boxes are only
    // found by id while it is in the document.
    $('editorHome').appendChild(this.editorEl);
    const result = this.media ? {
      start: this.slider.start,
      end: this.slider.end,
      meta: {
        artist: $('edArtist').value.trim(),
        title: $('edTitle').value.trim(),
        mix: $('edMix').value.trim(),
        album: $('edAlbum').value.trim(),
        genre: $('edGenre').value.trim(),
        subGenre: $('edSubGenre').value.trim(),
      },
    } : null;
    this._stopPreview(true);
    this.media = null;
    this.probed = null;
    this.peaks = null;
    this.segments = [];
    this._source = null;
    this.lyrics = null;
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
    $('edAlbum').value = guess.album || '';
    $('edGenre').value = guess.genre || '';
    $('edSubGenre').value = guess.subGenre || '';
    $('edError').textContent = '';
    this._drawLyrics();
    // Its cover, found right after the download (the note until then). In a
    // playlist's frame the frame shows it.
    const withCover = !this.embedded && !!m.path;
    $('edCover').closest('.meta-grid').classList.toggle('meta-grid--cover', withCover);
    if (withCover) {
      const box = Covers.pendingEl(m.path, 'editor');
      box.id = 'edCover';
      $('edCover').replaceWith(box);
    }
    $('edCover').hidden = !withCover;
    // A file of the phone's own is saved whole: no cut without ffmpeg (caps.localTrim).
    const whole = !!m.local && !Store.can('localTrim');
    this.editorEl.classList.toggle('editor--whole', whole);
    this.slider.setRange(m.duration, start || 0, end === null || end === undefined ? m.duration : end);
    this._syncFields();
    if (!this.embedded) this._source = this.probed ? { key: this.probed.key, url: this.probed.url } : null;
    this.segments = [];
    this._loadSegments();
    // A song downloaded by the server is streamed from there (m.src).
    this.audio.src = m.src ? m.src() : Util.fileUrl(m.path);
    this.audio.currentTime = 0;
    this._drawVolume(Player.volume);
    this._drawPreviewButton();
    this._setPhase('ready');
    this.peaks = null;
    if (whole) return;
    $('waveStatus').hidden = false;
    $('waveStatus').textContent = T('common.drawingWaveform');
    requestAnimationFrame(() => this._redraw());
    try {
      // Kept with the song: the lyrics editor's waveform waits for the same one.
      m.peaksRun = m.peaks ? m.peaks() : window.flow.peaks(m.path, m.duration);
      const peaks = await m.peaksRun;
      if (this.media !== m) return;
      this.peaks = peaks;
      $('waveStatus').hidden = true;
    } catch (err) {
      if (this.media !== m) return;
      $('waveStatus').textContent = T('common.trim.waveformFailed');
    }
    this._redraw();
  },

  // ---- its lyrics (4.0) ----

  /** The artist, title and mix in the boxes. */
  _names() {
    return {
      artist: $('edArtist').value.trim(), title: $('edTitle').value.trim(), mix: $('edMix').value.trim(),
    };
  },

  /**
   * A downloaded song's lyrics, before it is saved: { state ('looking',
   * 'found', 'none', 'error'), data, own (lines written here, or null), key
   * (the names looked up), onChange }. Null where they cannot be looked up
   * here (the phone, for now).
   */
  newLyrics(onChange = null) {
    if (!window.flow.lookupLyrics) return null;
    return {
      state: 'looking', data: null, own: null, key: '', error: '', onChange,
    };
  },

  /**
   * Looks up `entry`'s lyrics by `meta`'s artist and title, for a file
   * `duration` seconds long; one lookup after another (a playlist's songs
   * come quickly). Not again for the same names, nor once written by hand.
   */
  lookLyrics(entry, meta, duration) {
    if (!entry || entry.own) return;
    const key = `${String(meta.artist || '').toLowerCase()}|${String(meta.title || '').toLowerCase()}`;
    if (key === entry.key && entry.state !== 'error') return;
    entry.key = key;
    entry.state = 'looking';
    this._lyricsChanged(entry);
    this._lyricsChain = (this._lyricsChain || Promise.resolve()).then(async () => {
      if (entry.key !== key || entry.own) return;
      let data = null;
      let error = '';
      try {
        if (meta.title) data = await window.flow.lookupLyrics({ artist: meta.artist, title: meta.title, duration });
      } catch (err) {
        error = (err && err.message) || T('add.lyrics.lookupFailed');
      }
      if (entry.key !== key || entry.own) return;
      const words = !!(data && data.found && (data.synced || String(data.plain || '').trim()));
      entry.state = error ? 'error' : (words ? 'found' : 'none');
      entry.data = words ? data : null;
      entry.error = error;
      this._lyricsChanged(entry);
    });
  },

  _lyricsChanged(entry) {
    if (entry === this.lyrics) this._drawLyrics();
    if (entry.onChange) entry.onChange();
  },

  /** The editor's lyrics row: what was found, Show, and Edit Lyrics or Add Lyrics. */
  _drawLyrics() {
    const box = clear(this.editorEl.querySelector('#edLyrics'));
    const e = this.lyrics;
    if (!e || !this.media) return;
    const duration = this.media.duration;
    const btn = (label, onclick, kind = '') => h(`button.btn.btn--small${kind}`, { type: 'button', onclick }, label);
    const heading = () => LyricsEdit.heading(this._names());
    // The editor plays the whole downloaded file, as the preview does.
    const m = this.media;
    const player = {
      src: m.src ? m.src() : Util.fileUrl(m.path),
      duration,
      peaks: () => (m === this.media && this.peaks) || m.peaksRun || (m.peaks ? m.peaks() : window.flow.peaks(m.path, m.duration)),
    };
    // Written by hand: kept with the song; none (null) gives it the looked-up ones again.
    const onSave = (lines) => {
      const data = lines ? LyricsEdit.toData(lines) : null;
      if (!data) {
        e.own = null;
        e.key = '';
        this.lookLyrics(e, this._names(), duration);
        return;
      }
      e.own = lines;
      e.data = data;
      e.state = 'found';
      this._lyricsChanged(e);
    };
    if (e.state === 'looking') {
      box.append(h('span.ed-lyrics__label', LyricsEdit.spinner(), T('common.lookingForLyrics')));
      return;
    }
    const found = e.state === 'found';
    box.append(LyricsEdit.badge(found));
    if (found) {
      box.append(h('span.ed-lyrics__label', e.own ? T('add.lyrics.yours') : T('add.lyrics.found')),
        btn(T('common.show'), () => LyricsEdit.show({ title: heading(), data: e.data, duration })));
    } else if (e.state === 'error') {
      box.append(h('span.ed-lyrics__label', e.error), btn(T('common.tryAgain'), () => this.lookLyrics(e, this._names(), duration)));
    } else {
      box.append(h('span.ed-lyrics__label', T('common.noLyricsFound')));
    }
    if (!LyricsEdit.available) return;
    // For LRCLIB: the names in the boxes now, and the downloaded file's length (the lines are on it).
    const song = () => ({ ...this._names(), album: $('edAlbum').value.trim(), duration });
    if (found) {
      box.append(btn(T('common.editLyrics'), () => LyricsEdit.edit({
        title: heading(), data: e.data, duration, onSave, player, song,
      }), '.btn--light-green'));
    } else {
      box.append(btn(T('common.addLyrics'), () => LyricsEdit.add({
        title: heading(), onSave, player, song,
      }), '.btn--light-green'));
    }
  },

  /** SponsorBlock's parts of the song in the editor, as the settings want them. */
  async _loadSegments() {
    const m = this.media;
    const src = this._source;
    const s = Store.settings;
    let list = [];
    if (m && src && s.sponsorBlock) {
      try {
        list = await window.flow.sponsorSegments(src.key || '', src.url || '');
      } catch {
        list = [];
      }
      if (this.media !== m) return;
    }
    this.segments = list.filter((x) => x.kind === 'sponsor' || (x.kind === 'intro' && Store.settings.sponsorBlockIntros));
    this._redraw();
  },

  _syncFields() {
    const s = this.slider;
    $('startField').value = Util.fmtPrecise(s.start);
    $('endField').value = Util.fmtPrecise(s.end);
    const total = this.media ? this.media.duration : 0;
    $('spanLabel').textContent = T('common.trim.selection', { selection: Util.fmtPrecise(s.end - s.start), total: Util.fmtPrecise(total) });
  },

  _redraw() {
    if (!this.media || this.editorEl.hidden) return;
    drawWaveform($('waveCanvas'), this.peaks, this.media.duration, this.slider.start, this.slider.end, this.segments);
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

  _drawVolume(v) {
    this.audio.volume = v;
    this.volSlider.value = String(Math.round(v * 100));
    this.volSlider.style.setProperty('--fill', (v * 100) + '%');
    this.volBtn.innerHTML = v === 0 ? Icons.mute : (v < 0.5 ? Icons.volumeLow : Icons.volume);
    this.volBtn.title = v === 0 ? T('common.unmute') : T('common.mute');
  },

  _drawPreviewButton() {
    const playing = !this.audio.paused;
    $('previewPlay').innerHTML = playing ? Icons.pause : Icons.play;
    const action = playing ? T('common.pause') : T('common.play');
    $('previewPlay').title = Store.can('keyboard') ? T('common.spaceKeyHint', { action }) : action;
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
};
