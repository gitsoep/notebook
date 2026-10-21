(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    status: $('status'), today: $('today'), users: $('users'), count: $('count'),
    me: $('me'), meName: $('me-name'), meRole: $('me-role'), meAvatar: $('me-avatar'),
    openPassword: $('open-password'), logout: $('logout'), notifyToggle: $('notify-toggle'), openAdmin: $('open-admin'),
    page: $('page'), notes: $('notes'), empty: $('empty'),
    composer: $('composer'), text: $('text'), send: $('send'), counter: $('counter'), typing: $('typing'),
    login: $('login'), loginForm: $('login-form'), loginUsername: $('login-username'),
    loginPassword: $('login-password'), loginError: $('login-error'), loginNotice: $('login-notice'),
    loginSubmit: $('login-submit'),
    pwDialog: $('pw-dialog'), pwForm: $('pw-form'), pwSub: $('pw-sub'), pwUsername: $('pw-username'),
    pwCurrent: $('pw-current'), pwCurrentLabel: $('pw-current-label'), pwNew: $('pw-new'), pwConfirm: $('pw-confirm'),
    pwError: $('pw-error'), pwCancel: $('pw-cancel'), pwSubmit: $('pw-submit'),
    adminDialog: $('admin-dialog'), adminClose: $('admin-close'), adminError: $('admin-error'),
    createForm: $('create-form'), newUsername: $('new-username'), newPassword: $('new-password'),
    newRole: $('new-role'), createSubmit: $('create-submit'), userList: $('user-list'), userCount: $('user-count'),
    credential: $('credential'), credentialLabel: $('credential-label'), credentialValue: $('credential-value'),
    credentialCopy: $('credential-copy'),
    toast: $('toast'),
  };

  const INKS = ['#ff8a65', '#6aa8ff', '#4fd18b', '#ffc24b', '#b79bff', '#ff7ab8', '#3fd0d4', '#e6b07e', '#8f9cff', '#f5a25d'];
  const MAX = 2000;
  const CLOSE_REASONS = {
    'signed-out': 'You signed out.',
    'session-revoked': 'Your session ended. Please sign in again.',
    'password-changed': 'Your password was changed in another session. Please sign in again.',
    'password-reset': 'An admin reset your password. Sign in with the temporary password you were given.',
    'account-disabled': 'Your account has been disabled by an admin.',
    'account-removed': 'Your account has been removed by an admin.',
  };

  let me = null;
  let ws = null;
  let retry = 0;
  let retryTimer = null;
  let live = false;
  let lastNote = null;
  let lastTypingSent = 0;
  let knownUsers = new Set();
  let pwForced = false;
  const typers = new Map();

  els.today.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  // ---------- Helpers ----------

  function inkFor(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return INKS[h % INKS.length];
  }

  function initials(name) {
    const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
    const chars = parts.length > 1 ? [parts[0], parts[parts.length - 1]].map((p) => [...p][0]) : [...(parts[0] || '?')].slice(0, 2);
    return chars.join('').toUpperCase();
  }

  function setStatus(state, label) {
    els.status.className = 'status ' + (state ? 'is-' + state : '');
    els.status.querySelector('b').textContent = label;
  }

  let toastTimer;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('is-on'), 3200);
  }

  function showError(el, msg) {
    el.textContent = msg || '';
  }

  function setBusy(button, busy) {
    button.disabled = busy;
    button.classList.toggle('is-busy', busy);
  }

  async function api(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (method !== 'GET') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body || {});
    }
    let res;
    try {
      res = await fetch(url, opts);
    } catch {
      throw Object.assign(new Error('Can’t reach the server. Check your connection.'), { status: 0 });
    }
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { status: res.status });
    return data;
  }

  const fmtTime = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const fmtDate = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const dayKey = (ts) => new Date(ts).toDateString();

  function fmtDay(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yest = new Date();
    yest.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yest.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function fmtAgo(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    if (s < 60) return 'just now';
    if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
    if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
    if (s < 86400 * 30) return rtf.format(-Math.round(s / 86400), 'day');
    return fmtDate(ts);
  }

  // ---------- Notes ----------

  function setComposerEnabled(on) {
    els.text.disabled = !on;
    updateSendState();
  }

  function updateSendState() {
    const len = els.text.value.length;
    els.counter.textContent = `${len} / ${MAX}`;
    els.counter.classList.toggle('is-near', len > MAX * 0.9);
    els.send.disabled = els.text.disabled || !els.text.value.trim();
  }

  function autosize() {
    els.text.style.height = 'auto';
    els.text.style.height = Math.min(els.text.scrollHeight, 180) + 'px';
  }

  function toSafeExternalUrl(raw) {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      if (u.username || u.password) return null;
      return u.href;
    } catch {
      return null;
    }
  }

  function appendLinkified(parent, text) {
    const re = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const safeHref = toSafeExternalUrl(m[0]);
      if (safeHref) {
        const a = document.createElement('a');
        a.href = safeHref;
        a.textContent = m[0];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        parent.append(a);
      } else {
        parent.append(m[0]);
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  const isMine = (note) => !!me && (note.authorId ? note.authorId === me.id : note.author === me.username);

  function renderNote(note, animate = true) {
    if (!lastNote || dayKey(lastNote.ts) !== dayKey(note.ts)) {
      const day = document.createElement('li');
      day.className = 'day';
      day.textContent = fmtDay(note.ts);
      els.notes.append(day);
      lastNote = null;
    }

    const li = document.createElement('li');
    if (!animate) li.style.animation = 'none';

    if (note.system) {
      li.className = 'note note--system';
      li.textContent = `${note.text} · ${fmtTime(note.ts)}`;
    } else {
      const cont = lastNote && !lastNote.system && lastNote.author === note.author && note.ts - lastNote.ts < 3 * 60 * 1000;
      li.className = 'note' + (isMine(note) ? ' is-mine' : '') + (cont ? ' is-cont' : '');
      li.style.setProperty('--c', inkFor(note.author));

      const avatar = document.createElement('span');
      avatar.className = 'note__avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = initials(note.author);

      const content = document.createElement('div');
      content.className = 'note__content';

      const head = document.createElement('div');
      head.className = 'note__head';
      const author = document.createElement('span');
      author.className = 'note__author';
      author.textContent = note.author;
      const time = document.createElement('time');
      time.className = 'note__time';
      time.dateTime = new Date(note.ts).toISOString();
      time.textContent = fmtTime(note.ts);
      head.append(author, time);

      const body = document.createElement('p');
      body.className = 'note__body';
      appendLinkified(body, note.text);
      body.title = new Date(note.ts).toLocaleString();

      content.append(head, body);
      li.append(avatar, content);
    }

    els.notes.append(li);
    lastNote = note;
    els.empty.hidden = true;
  }

  function nearBottom() {
    const p = els.page;
    return p.scrollHeight - p.scrollTop - p.clientHeight < 120;
  }

  function scrollToBottom(smooth) {
    els.page.scrollTo({ top: els.page.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  function renderUsers(users) {
    els.users.replaceChildren(...users.map((u) => {
      const li = document.createElement('li');
      li.textContent = u;
      li.style.setProperty('--c', inkFor(u));
      if (me && u === me.username) li.classList.add('is-me');
      if (knownUsers.has(u)) li.style.animation = 'none';
      return li;
    }));
    knownUsers = new Set(users);
    els.count.textContent = users.length;
  }

  function renderTyping() {
    const now = Date.now();
    for (const [n, t] of typers) if (now - t > 3500) typers.delete(n);
    const names = [...typers.keys()];
    els.typing.textContent =
      names.length === 0 ? '' :
      names.length === 1 ? `${names[0]} is writing…` :
      names.length === 2 ? `${names[0]} and ${names[1]} are writing…` :
      'Several people are writing…';
  }
  setInterval(renderTyping, 1000);

  function clearChat() {
    els.notes.replaceChildren();
    els.users.replaceChildren();
    els.count.textContent = '0';
    knownUsers = new Set();
    typers.clear();
    renderTyping();
    lastNote = null;
    els.empty.hidden = false;
  }

  // ---------- Connection ----------

  function connect() {
    clearTimeout(retryTimer);
    live = true;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws`);
    ws = sock;
    setStatus('', 'connecting');

    sock.addEventListener('open', () => {
      retry = 0;
      setStatus('live', 'live');
    });

    sock.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      switch (msg.type) {
        case 'welcome':
          setMe(msg.user);
          els.notes.replaceChildren();
          lastNote = null;
          els.empty.hidden = msg.notes.length > 0;
          msg.notes.forEach((n) => renderNote(n, false));
          renderUsers(msg.users);
          setComposerEnabled(true);
          if (!document.querySelector('dialog[open]')) els.text.focus();
          requestAnimationFrame(() => scrollToBottom(false));
          break;
        case 'note': {
          const stick = nearBottom() || isMine(msg.note);
          if (msg.note.author) typers.delete(msg.note.author);
          renderTyping();
          renderNote(msg.note);
          if (stick) scrollToBottom(true);
          notifyNote(msg.note);
          break;
        }
        case 'presence':
          renderUsers(msg.users);
          break;
        case 'typing':
          if (!me || msg.name !== me.username) {
            typers.set(msg.name, Date.now());
            renderTyping();
          }
          break;
        case 'me':
          setMe(msg.user);
          break;
        case 'error':
          toast(msg.message);
          break;
      }
    });

    sock.addEventListener('close', async (ev) => {
      if (ws !== sock) return;
      ws = null;
      setComposerEnabled(false);
      if (!live) return;
      if (ev.code === 4001) {
        signedOut(CLOSE_REASONS[ev.reason] || CLOSE_REASONS['session-revoked']);
        return;
      }
      setStatus('down', 'reconnecting');
      // A rejected handshake looks like an ordinary close, so ask the API whether we're still signed in.
      try {
        const { user } = await api('GET', '/api/me');
        setMe(user);
        if (user.mustChangePassword) {
          live = false;
          openPasswordDialog(true);
          return;
        }
      } catch (err) {
        if (err.status === 401) {
          signedOut(CLOSE_REASONS['session-revoked']);
          return;
        }
      }
      if (!live) return;
      retryTimer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
    });
  }

  // ---------- Session ----------

  function setMe(user) {
    me = user;
    els.meName.textContent = user.username;
    els.meRole.textContent = user.role === 'admin' ? 'Admin' : 'Member';
    els.meRole.classList.toggle('is-admin', user.role === 'admin');
    els.meAvatar.textContent = initials(user.username);
    els.meAvatar.style.setProperty('--c', inkFor(user.username));
    els.me.hidden = false;
    els.openAdmin.hidden = user.role !== 'admin' || user.mustChangePassword;
    if (user.role !== 'admin' && els.adminDialog.open) els.adminDialog.close();
  }

  function showLogin(message) {
    els.loginNotice.textContent = message || '';
    els.loginNotice.hidden = !message;
    showError(els.loginError, '');
    els.login.classList.remove('is-hidden');
    setTimeout(() => (els.loginUsername.value ? els.loginPassword : els.loginUsername).focus(), 60);
  }

  function signedIn(user) {
    setMe(user);
    els.login.classList.add('is-hidden');
    if (user.mustChangePassword) {
      setStatus('', 'locked');
      openPasswordDialog(true);
      return;
    }
    connect();
  }

  function signedOut(message) {
    live = false;
    clearTimeout(retryTimer);
    if (ws) {
      const sock = ws;
      ws = null;
      sock.close();
    }
    me = null;
    pwForced = false;
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    els.me.hidden = true;
    els.openAdmin.hidden = true;
    clearChat();
    setComposerEnabled(false);
    setStatus('', 'signed out');
    showLogin(message);
  }

  async function logout() {
    live = false;
    try { await api('POST', '/api/logout'); } catch { /* sign out locally regardless */ }
    signedOut('');
  }

  els.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = els.loginUsername.value.trim();
    const password = els.loginPassword.value;
    if (!username || !password) {
      showError(els.loginError, 'Enter your username and password.');
      return;
    }
    setBusy(els.loginSubmit, true);
    try {
      const { user } = await api('POST', '/api/login', { username, password });
      els.loginPassword.value = '';
      showError(els.loginError, '');
      signedIn(user);
    } catch (err) {
      showError(els.loginError, err.message);
      els.loginPassword.select();
    } finally {
      setBusy(els.loginSubmit, false);
    }
  });

  els.logout.addEventListener('click', logout);

  // ---------- Desktop notifications ----------

  const NOTIFY_KEY = 'cn_notify';
  const canNotify = 'Notification' in window && window.isSecureContext;

  function notifyEnabled() {
    return canNotify && Notification.permission === 'granted' && localStorage.getItem(NOTIFY_KEY) === '1';
  }

  function renderNotifyToggle() {
    els.notifyToggle.hidden = !canNotify;
    const on = notifyEnabled();
    els.notifyToggle.textContent = on ? 'Alerts on' : 'Alerts off';
    els.notifyToggle.setAttribute('aria-pressed', String(on));
    els.notifyToggle.title = on
      ? 'Desktop notifications are on for new notes'
      : 'Get a desktop notification when someone writes a note';
  }

  els.notifyToggle.addEventListener('click', async () => {
    if (notifyEnabled()) {
      localStorage.setItem(NOTIFY_KEY, '0');
    } else {
      let permission = Notification.permission;
      if (permission === 'default') {
        try { permission = await Notification.requestPermission(); } catch { permission = 'denied'; }
      }
      if (permission === 'granted') {
        localStorage.setItem(NOTIFY_KEY, '1');
        toast('Desktop notifications enabled.');
      } else {
        toast('Notifications are blocked. Allow them for this site in your browser settings.');
      }
    }
    renderNotifyToggle();
  });

  function notifyNote(note) {
    if (!notifyEnabled() || note.system || isMine(note)) return;
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    const body = note.text.length > 180 ? note.text.slice(0, 177) + '…' : note.text;
    try {
      const n = new Notification(`${note.author} wrote a note`, { body, tag: `note-${note.id}` });
      n.addEventListener('click', () => {
        window.focus();
        scrollToBottom(true);
        n.close();
      });
    } catch { /* some platforms only allow notifications from a service worker */ }
  }

  renderNotifyToggle();

  // ---------- Change password ----------

  function openPasswordDialog(forced) {
    pwForced = forced;
    els.pwSub.textContent = forced
      ? 'You signed in with a temporary password. Choose your own to continue.'
      : 'Use at least 8 characters. Other devices will be signed out.';
    els.pwCurrentLabel.textContent = forced ? 'Temporary password' : 'Current password';
    els.pwCancel.textContent = forced ? 'Sign out' : 'Cancel';
    els.pwUsername.value = me ? me.username : '';
    els.pwForm.reset();
    els.pwUsername.value = me ? me.username : '';
    showError(els.pwError, '');
    if (!els.pwDialog.open) els.pwDialog.showModal();
    els.pwCurrent.focus();
  }

  els.pwDialog.addEventListener('cancel', (e) => {
    if (pwForced) e.preventDefault();
  });

  els.pwCancel.addEventListener('click', () => {
    if (pwForced) logout();
    else els.pwDialog.close();
  });

  els.openPassword.addEventListener('click', () => openPasswordDialog(!!(me && me.mustChangePassword)));

  els.pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = els.pwCurrent.value;
    const newPassword = els.pwNew.value;
    if (!currentPassword) return showError(els.pwError, 'Enter your current password.');
    if (newPassword.length < 8) return showError(els.pwError, 'New password needs at least 8 characters.');
    if (newPassword !== els.pwConfirm.value) return showError(els.pwError, 'The new passwords don’t match.');
    setBusy(els.pwSubmit, true);
    try {
      const { user } = await api('POST', '/api/me/password', { currentPassword, newPassword });
      const wasForced = pwForced;
      pwForced = false;
      els.pwForm.reset();
      els.pwDialog.close();
      setMe(user);
      toast('Password updated.');
      if (wasForced) connect();
    } catch (err) {
      if (err.status === 401) return signedOut(CLOSE_REASONS['session-revoked']);
      showError(els.pwError, err.message);
    } finally {
      setBusy(els.pwSubmit, false);
    }
  });

  // ---------- User management ----------

  function handleAdminError(err) {
    if (err.status === 401) return signedOut(CLOSE_REASONS['session-revoked']);
    showError(els.adminError, err.message);
  }

  async function loadUsers() {
    try {
      const { users } = await api('GET', '/api/users');
      els.userList.replaceChildren(...users.map(userRow));
      els.userCount.textContent = users.length;
    } catch (err) {
      handleAdminError(err);
    }
  }

  function showCredential(label, username, password) {
    els.credentialLabel.textContent = label;
    els.credentialValue.textContent = `username: ${username}\npassword: ${password}`;
    els.credential.hidden = false;
    els.credentialCopy.textContent = 'Copy';
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const range = document.createRange();
      range.selectNodeContents(els.credentialValue);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      try { return document.execCommand('copy'); } catch { return false; }
    }
  }

  els.credentialCopy.addEventListener('click', async () => {
    els.credentialCopy.textContent = (await copyText(els.credentialValue.textContent)) ? 'Copied' : 'Select & copy';
  });

  function badge(text, cls) {
    const b = document.createElement('span');
    b.className = 'badge' + (cls ? ' ' + cls : '');
    b.textContent = text;
    return b;
  }

  function actionButton(label, onClick, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.addEventListener('click', async () => {
      setBusy(b, true);
      showError(els.adminError, '');
      try {
        await onClick();
      } catch (err) {
        handleAdminError(err);
      } finally {
        setBusy(b, false);
      }
    });
    return b;
  }

  function userRow(u) {
    const isSelf = me && u.id === me.id;
    const li = document.createElement('li');
    li.className = 'user-row' + (u.disabled ? ' is-disabled' : '');
    li.style.setProperty('--c', inkFor(u.username));

    const avatar = document.createElement('span');
    avatar.className = 'note__avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = initials(u.username);

    const info = document.createElement('div');
    info.className = 'user-row__info';
    const line = document.createElement('div');
    line.className = 'user-row__name';
    const name = document.createElement('strong');
    name.textContent = u.username;
    line.append(name);
    if (isSelf) line.append(badge('You', 'badge--self'));
    line.append(badge(u.role === 'admin' ? 'Admin' : 'Member', u.role === 'admin' ? 'badge--admin' : ''));
    if (u.disabled) line.append(badge('Disabled', 'badge--off'));
    else if (u.mustChangePassword) line.append(badge('Temporary password', 'badge--warn'));

    const meta = document.createElement('div');
    meta.className = 'user-row__meta';
    meta.textContent =
      `Added ${fmtDate(u.createdAt)}${u.createdBy && u.createdBy !== 'system' ? ` by ${u.createdBy}` : ''} · ` +
      (u.lastLoginAt ? `last sign-in ${fmtAgo(u.lastLoginAt)}` : 'never signed in');
    info.append(line, meta);

    const actions = document.createElement('div');
    actions.className = 'user-row__actions';

    if (!isSelf) {
      const role = document.createElement('select');
      role.setAttribute('aria-label', `Role for ${u.username}`);
      for (const [value, label] of [['user', 'Member'], ['admin', 'Admin']]) {
        const opt = new Option(label, value, false, u.role === value);
        role.append(opt);
      }
      role.addEventListener('change', async () => {
        role.disabled = true;
        showError(els.adminError, '');
        try {
          await api('PATCH', `/api/users/${u.id}`, { role: role.value });
          toast(`${u.username} is now ${role.value === 'admin' ? 'an admin' : 'a member'}.`);
          await loadUsers();
        } catch (err) {
          role.value = u.role;
          role.disabled = false;
          handleAdminError(err);
        }
      });

      actions.append(
        role,
        actionButton('Reset password', async () => {
          if (!confirm(`Reset the password for ${u.username}? They will be signed out everywhere.`)) return;
          const { password } = await api('POST', `/api/users/${u.id}/reset-password`, {});
          showCredential(`New temporary password for ${u.username}`, u.username, password);
          await loadUsers();
        }),
        actionButton(u.disabled ? 'Enable' : 'Disable', async () => {
          if (!u.disabled && !confirm(`Disable ${u.username}? They will be signed out and can’t sign in until re-enabled.`)) return;
          await api('PATCH', `/api/users/${u.id}`, { disabled: !u.disabled });
          toast(`${u.username} ${u.disabled ? 'enabled' : 'disabled'}.`);
          await loadUsers();
        }),
        actionButton('Delete', async () => {
          if (!confirm(`Delete ${u.username}? Their notes stay in the notebook. This can’t be undone.`)) return;
          await api('DELETE', `/api/users/${u.id}`);
          toast(`${u.username} deleted.`);
          await loadUsers();
        }, 'ghost--danger'),
      );
    }

    li.append(avatar, info, actions);
    return li;
  }

  els.openAdmin.addEventListener('click', async () => {
    els.createForm.reset();
    els.credential.hidden = true;
    showError(els.adminError, '');
    els.adminDialog.showModal();
    els.newUsername.focus();
    await loadUsers();
  });

  els.adminClose.addEventListener('click', () => els.adminDialog.close());
  els.adminDialog.addEventListener('click', (e) => {
    if (e.target === els.adminDialog) els.adminDialog.close();
  });

  els.createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = els.newUsername.value.trim();
    if (!username) {
      showError(els.adminError, 'Enter a username.');
      els.newUsername.focus();
      return;
    }
    setBusy(els.createSubmit, true);
    showError(els.adminError, '');
    try {
      const body = { username, role: els.newRole.value };
      if (els.newPassword.value) body.password = els.newPassword.value;
      const { user, password } = await api('POST', '/api/users', body);
      showCredential(`Account created — share these details with ${user.username}`, user.username, password);
      els.createForm.reset();
      els.newUsername.focus();
      await loadUsers();
    } catch (err) {
      handleAdminError(err);
    } finally {
      setBusy(els.createSubmit, false);
    }
  });

  // ---------- Composer ----------

  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = els.text.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'note', text }));
    els.text.value = '';
    lastTypingSent = 0;
    autosize();
    updateSendState();
  });

  els.text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      els.composer.requestSubmit();
    }
  });

  els.text.addEventListener('input', () => {
    autosize();
    updateSendState();
    const now = Date.now();
    if (els.text.value && now - lastTypingSent > 2000 && ws && ws.readyState === WebSocket.OPEN) {
      lastTypingSent = now;
      ws.send(JSON.stringify({ type: 'typing' }));
    }
  });

  // ---------- Boot ----------

  (async () => {
    setStatus('', 'connecting');
    try {
      const { user } = await api('GET', '/api/me');
      signedIn(user);
    } catch (err) {
      setStatus('', 'signed out');
      showLogin(err.status === 401 ? '' : err.message);
    }
  })();
})();
