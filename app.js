
(function () {
'use strict';

var $ = function (s) { return document.querySelector(s); };

function el(t, c, x) {
  var e = document.createElement(t);
  if (c) e.className = c;
  if (x !== undefined) e.textContent = x;
  return e;
}

function fmt(t) {
  return new Date(t).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

var token = null, me = null, mailbox = [], view = 'inbox', openId = null;

try {
  token = localStorage.getItem('bm_token');
} catch (e) {}

function setToken(t) {
  token = t;
  try {
    if (t) localStorage.setItem('bm_token', t);
    else localStorage.removeItem('bm_token');
  } catch (e) {}
}

async function api(path, body, anon) {
  var o = {
    method: body === undefined ? 'GET' : 'POST',
    headers: {}
  };

  if (token && !anon) {
    o.headers.Authorization = 'Bearer ' + token;
  }

  if (body !== undefined) {
    o.headers['Content-Type'] = 'application/json';
    o.body = JSON.stringify(body);
  }

  var r = await fetch('https://api.batemail.lol/api/' + path, o);
  var j = {};

  try {
    j = await r.json();
  } catch (e) {}

  if (!r.ok) {
    var err = new Error(j.error || 'Something went wrong.');
    err.status = r.status;
    throw err;
  }

  return j;
}

/* ---------- auth ---------- */

function tab(w) {
  ['create', 'login'].forEach(function (n) {
    $('#f-' + n).hidden = n !== w;
    $('#t-' + n).setAttribute('aria-selected', n === w);
  });
}

$('#t-create').onclick = function () {
  tab('create');
};

$('#t-login').onclick = function () {
  tab('login');
};

$('#f-create').addEventListener('submit', async function (e) {
  e.preventDefault();

  var er = $('#c-err');
  er.textContent = '';

  var u = $('#c-user').value.trim().toLowerCase();
  var p = $('#c-pass').value;

  if (!/^[a-z0-9._-]{3,30}$/.test(u)) {
    er.textContent = 'Username: 3–30 letters, numbers, . - or _';
    return;
  }

  if (p.length < 6) {
    er.textContent = 'Password must be at least 6 characters.';
    return;
  }

  try {
    var j = await api('register', { user: u, pass: p });
    setToken(j.token);
    $('#c-pass').value = '';
    await start();
  } catch (x) {
    er.textContent = x.message;
  }
});

$('#f-login').addEventListener('submit', async function (e) {
  e.preventDefault();

  var er = $('#l-err');
  er.textContent = '';

  try {
    var j = await api('login', {
      email: $('#l-mail').value.trim(),
      pass: $('#l-pass').value
    });

    setToken(j.token);
    $('#l-pass').value = '';
    await start();
  } catch (x) {
    er.textContent = x.message;
  }
});

/* ---------- mailbox ---------- */

async function loadMail() {
  var j = await api('mail');
  me = j.email || '';

  mailbox = (Array.isArray(j.mail) ? j.mail : []).map(function (m) {
    var stamp = m.received_at || m.ts || m.created_at || '';

    return {
      id: m.id,
      from: m.sender || m.from || '',
      to: m.recipient || m.to || me,
      subject: m.subject || '',
      body: m.body || '',
      ts: stamp,
      read: Boolean(
        m.is_read !== undefined ? m.is_read : m.read
      ),
      folder: m.folder || 'inbox'
    };
  }).sort(function (a, b) {
    return new Date(String(b.ts).replace(' ', 'T') + 'Z') -
           new Date(String(a.ts).replace(' ', 'T') + 'Z');
  });

  console.log('BateMail DEBUG: emails loaded:', mailbox.length);
}

async function start() {
  await loadMail();

  view = 'inbox';
  openId = null;

  $('#auth').hidden = true;
  $('#app').hidden = false;
  $('#me').textContent = me;

  render();
}

function logoutUI() {
  setToken(null);
  me = null;
  mailbox = [];

  $('#app').hidden = true;
  $('#auth').hidden = false;

  tab('login');
}

$('#out').onclick = async function () {
  try {
    await api('logout', {});
  } catch (e) {}

  logoutUI();
};

/* ---------- navigation ---------- */

function go(v) {
  view = v;
  openId = null;
  render();
}

$('#n-inbox').onclick = function () {
  go('inbox');
};

$('#n-forum').onclick = function () {
  go('forum');
};

/* ---------- refresh mail button ---------- */

var refreshButton = $('#refresh-mail');

if (refreshButton) {
  refreshButton.onclick = async function () {
    if (refreshButton.disabled) return;

    refreshButton.disabled = true;
    refreshButton.textContent = 'Refreshing...';

    try {
      await loadMail();

      openId = null;
      view = 'inbox';

      render();

      refreshButton.textContent = '✓ Refreshed';
    } catch (e) {
      console.error('BateMail refresh failed:', e);
      refreshButton.textContent = 'Refresh failed';
    } finally {
      setTimeout(function () {
        refreshButton.disabled = false;
        refreshButton.textContent = '↻ Refresh Mail';
      }, 1500);
    }
  };
}

/* ---------- render inbox and navigation ---------- */

function render() {
  var unread = mailbox.filter(function (m) {
    return m.folder === 'inbox' && !m.read;
  }).length;

  $('#cnt').textContent = unread ? unread : '';

  [['inbox', '#n-inbox'], ['forum', '#n-forum']].forEach(function (p) {
    $(p[1]).setAttribute('aria-current', view === p[0]);
  });

  var pane = $('#pane');
  pane.textContent = '';

  if (view === 'forum') return renderForum(pane);

  if (openId) {
    var m = mailbox.filter(function (x) {
      return x.id === openId;
    })[0];

    if (m) return renderRead(pane, m);
  }

  var list = mailbox.filter(function (m) {
    return m.folder === 'inbox';
  });

  if (!list.length) {
    pane.appendChild(el('div', 'empty', 'No messages.'));
    return;
  }

  list.forEach(function (m) {
    var r = el('button', 'row' + (!m.read ? ' unread' : ''));

    r.appendChild(el('b', '', m.subject || '(no subject)'));
    r.appendChild(el('small', '', m.from + ' · ' + fmt(m.ts)));

    r.onclick = function () {
      openId = m.id;

      if (!m.read) {
        m.read = true;
        api('read', { id: m.id }).catch(function () {});
      }

      render();
    };

    pane.appendChild(r);
  });
}

function renderRead(pane, m) {
  var d = el('div', 'read');

  d.appendChild(el('h2', '', m.subject || '(no subject)'));

  d.appendChild(el(
    'p',
    'meta',
    'From ' + m.from + ' · To ' + m.to + ' · ' + fmt(m.ts)
  ));

  d.appendChild(el('p', 'body', m.body));

  var a = el('div', 'actions');
  var b = el('button', 'ghost', 'Back');

  b.onclick = function () {
    go('inbox');
  };

  a.appendChild(b);
  d.appendChild(a);
  pane.appendChild(d);
}

/* ---------- anonymous forum ---------- */

async function renderForum(box) {
  var list = [];

  try {
    var result = await api('forum', undefined, true);
    list = Array.isArray(result.posts) ? result.posts : [];
  } catch (e) {}

  if (box.id === 'pane' && view !== 'forum') return;

  box.textContent = '';

  var wrap = el('div', 'forum');
  var f = el('form', 'fpost');
  var t = el('input');
  var b = el('textarea');
  var er = el('p', 'err');
  var btn = el('button', 'btn', 'Post');

  t.placeholder = 'Title (optional)';
  t.maxLength = 80;
  t.setAttribute('aria-label', 'Title');

  b.placeholder = 'Say something. You’ll post as Anonymous.';
  b.maxLength = 500;
  b.setAttribute('aria-label', 'Post');

  btn.type = 'submit';
  er.setAttribute('role', 'alert');

  f.append(t, b, er, btn);

  f.addEventListener('submit', async function (e) {
    e.preventDefault();
    er.textContent = '';

    if (b.value.trim().length < 2) {
      er.textContent = 'Write something first.';
      return;
    }

    try {
      await api('forum', {
        title: t.value.trim(),
        body: b.value.trim()
      }, true);

      renderForum(box);
    } catch (x) {
      er.textContent = x.message;
    }
  });

  wrap.appendChild(f);

  if (!list.length) {
    wrap.appendChild(el(
      'div',
      'empty',
      'No posts yet. Start the conversation.'
    ));
  }

  list.forEach(function (p) {
    var d = el('article', 'fitem');

    if (p.title) {
      d.appendChild(el('h3', '', p.title));
    }

    d.appendChild(el('p', 'fbody', p.body));
    d.appendChild(el('small', '', p.name + ' · ' + fmt(p.ts)));

    wrap.appendChild(d);
  });

  box.appendChild(wrap);
}

/* ---------- start ---------- */

renderForum($('#forum-landing'));

if (token) {
  start().catch(function () {
    logoutUI();
    tab('create');
  });
}

})();
