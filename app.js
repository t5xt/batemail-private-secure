```javascript
(function () {
'use strict';

var $ = function (s) {
  return document.querySelector(s);
};

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmt(value) {
  if (!value) return 'Date unavailable';

  var date = new Date(value);

  if (Number.isNaN(date.getTime())) return 'Date unavailable';

  return date.toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

function relativeTime(value) {
  if (!value) return '';

  var date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  var seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));

  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  if (seconds < 604800) return Math.floor(seconds / 86400) + 'd ago';

  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric'
  });
}

function initials(value) {
  var name = String(value || '?').trim();
  return (name.charAt(0) || '?').toUpperCase();
}

function parseDate(value) {
  var s = String(value || '').trim();

  if (!s) return 0;

  // Treat timezone-less server timestamps as UTC.
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    s = s.replace(' ', 'T') + 'Z';
  }

  var number = Date.parse(s);
  return Number.isNaN(number) ? 0 : number;
}

var token = null;
var me = null;
var mailbox = [];
var view = 'inbox';
var openId = null;
var mailRequest = 0;
var forumRequest = 0;

try {
  token = localStorage.getItem('bm_token');
} catch (e) {}

function setToken(value) {
  token = value;

  try {
    if (value) {
      localStorage.setItem('bm_token', value);
    } else {
      localStorage.removeItem('bm_token');
    }
  } catch (e) {}
}

/* ---------- API ---------- */

async function api(path, body, anon) {
  var options = {
    method: body === undefined ? 'GET' : 'POST',
    headers: {}
  };

  if (token && !anon) {
    options.headers.Authorization = 'Bearer ' + token;
  }

  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  var response = await fetch(
    'https://api.batemail.lol/api/' + path,
    options
  );

  var result = {};

  try {
    result = await response.json();
  } catch (e) {}

  if (!response.ok) {
    var error = new Error(result.error || 'Something went wrong.');
    error.status = response.status;
    throw error;
  }

  return result;
}

/* ---------- Authentication ---------- */

function tab(which) {
  ['create', 'login'].forEach(function (name) {
    $('#f-' + name).hidden = name !== which;
    $('#t-' + name).setAttribute(
      'aria-selected',
      String(name === which)
    );
  });
}

$('#t-create').onclick = function () {
  tab('create');
};

$('#t-login').onclick = function () {
  tab('login');
};

$('#f-create').addEventListener('submit', async function (event) {
  event.preventDefault();

  var errorBox = $('#c-err');
  errorBox.textContent = '';

  var username = $('#c-user').value.trim().toLowerCase();
  var password = $('#c-pass').value;

  if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
    errorBox.textContent =
      'Username: 3–30 letters, numbers, . - or _';
    return;
  }

  if (password.length < 6) {
    errorBox.textContent =
      'Password must be at least 6 characters.';
    return;
  }

  try {
    var result = await api('register', {
      user: username,
      pass: password
    });

    setToken(result.token);
    $('#c-pass').value = '';

    await start();
  } catch (error) {
    errorBox.textContent = error.message;
  }
});

$('#f-login').addEventListener('submit', async function (event) {
  event.preventDefault();

  var errorBox = $('#l-err');
  errorBox.textContent = '';

  try {
    var result = await api('login', {
      email: $('#l-mail').value.trim(),
      pass: $('#l-pass').value
    });

    setToken(result.token);
    $('#l-pass').value = '';

    await start();
  } catch (error) {
    errorBox.textContent = error.message;
  }
});

/* ---------- Mailbox data ---------- */

async function loadMail() {
  var request = ++mailRequest;
  var result = await api('mail');

  // Ignore an older response if a newer refresh has started.
  if (request !== mailRequest) return;

  me = result.email || '';

  mailbox = (Array.isArray(result.mail) ? result.mail : [])
    .map(function (message) {
      var timestamp =
        message.received_at ||
        message.ts ||
        message.created_at ||
        '';

      return {
        id: message.id,
        from: message.sender || message.from || 'Unknown sender',
        to: message.recipient || message.to || me,
        subject: message.subject || '(no subject)',
        body: message.body || '',
        ts: timestamp,
        read: Boolean(
          message.is_read !== undefined
            ? message.is_read
            : message.read
        ),
        folder: message.folder || 'inbox'
      };
    })
    .sort(function (a, b) {
      return parseDate(b.ts) - parseDate(a.ts);
    });

  console.log('BateMail: emails loaded:', mailbox.length);
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
  openId = null;
  view = 'inbox';

  $('#app').hidden = true;
  $('#auth').hidden = false;

  tab('login');
}

$('#out').onclick = async function () {
  var button = $('#out');
  button.disabled = true;

  try {
    await api('logout', {});
  } catch (error) {
    console.warn('BateMail logout request failed:', error);
  } finally {
    logoutUI();
    button.disabled = false;
  }
};

/* ---------- Navigation ---------- */

function go(nextView) {
  view = nextView;

  if (nextView !== 'inbox') {
    openId = null;
  }

  render();
}

$('#n-inbox').onclick = function () {
  go('inbox');
};

$('#n-forum').onclick = function () {
  go('forum');
};

/* ---------- Animated refresh ---------- */

var refreshButton = $('#refresh-mail');

if (refreshButton) {
  refreshButton.addEventListener('click', async function () {
    if (refreshButton.disabled) return;

    refreshButton.disabled = true;
    refreshButton.classList.add('is-refreshing');
    refreshButton.setAttribute('aria-label', 'Refreshing mail');
    refreshButton.setAttribute('title', 'Refreshing mail');

    try {
      await loadMail();

      // Keep the selected email open if it still exists.
      if (openId !== null && !mailbox.some(function (message) {
        return String(message.id) === String(openId);
      })) {
        openId = null;
      }

      render();
    } catch (error) {
      console.error('BateMail refresh failed:', error);
      showRefreshError(error.message);
    } finally {
      window.setTimeout(function () {
        refreshButton.classList.remove('is-refreshing');
        refreshButton.disabled = false;
        refreshButton.setAttribute('aria-label', 'Refresh mail');
        refreshButton.setAttribute('title', 'Refresh mail');
      }, 450);
    }
  });
}

function showRefreshError(message) {
  var pane = $('#pane');
  if (!pane || view !== 'inbox') return;

  var notice = el('p', 'refresh-error',
    'Could not refresh mail. ' + (message || 'Please try again.')
  );

  notice.setAttribute('role', 'status');
  pane.prepend(notice);

  window.setTimeout(function () {
    if (notice.parentNode) notice.remove();
  }, 5000);
}

/* ---------- Main rendering ---------- */

function render() {
  var unreadCount = mailbox.filter(function (message) {
    return message.folder === 'inbox' && !message.read;
  }).length;

  $('#cnt').textContent = unreadCount || '';

  [
    ['inbox', '#n-inbox'],
    ['forum', '#n-forum']
  ].forEach(function (item) {
    $(item[1]).setAttribute(
      'aria-current',
      String(view === item[0])
    );
  });

  var pane = $('#pane');
  pane.textContent = '';

  if (view === 'forum') {
    renderForum(pane);
    return;
  }

  renderInbox(pane);
}

/* ---------- Three-panel inbox ---------- */

function renderInbox(pane) {
  var layout = el('div', 'mail-layout');
  var listPanel = el('section', 'message-list');
  var readingPanel = el('section', 'message-reading');

  listPanel.setAttribute('aria-label', 'Inbox messages');
  readingPanel.setAttribute('aria-label', 'Selected email');

  var inboxMessages = mailbox.filter(function (message) {
    return message.folder === 'inbox';
  });

  var listHeader = el('div', 'message-list-header');
  var headerText = el('div', 'message-list-heading');

  headerText.appendChild(el('h1', '', 'Inbox'));
  headerText.appendChild(el(
    'p',
    '',
    inboxMessages.length + (
      inboxMessages.length === 1 ? ' message' : ' messages'
    )
  ));

  listHeader.appendChild(headerText);
  listPanel.appendChild(listHeader);

  if (!inboxMessages.length) {
    listPanel.appendChild(
      el('div', 'empty', 'No messages yet. Your inbox is ready.')
    );

    renderEmptyReadingPane(readingPanel);
  } else {
    var selected = inboxMessages.find(function (message) {
      return openId !== null &&
        String(message.id) === String(openId);
    });

    if (!selected) {
      selected = inboxMessages[0];
      openId = selected.id;
    }

    inboxMessages.forEach(function (message) {
      listPanel.appendChild(
        renderMessageRow(message, selected)
      );
    });

    renderRead(readingPanel, selected);
  }

  layout.appendChild(listPanel);
  layout.appendChild(readingPanel);
  pane.appendChild(layout);
}

function renderMessageRow(message, selected) {
  var row = el(
    'button',
    'message-row' +
      (!message.read ? ' unread' : '') +
      (
        selected &&
        String(selected.id) === String(message.id)
          ? ' selected'
          : ''
      )
  );

  row.type = 'button';
  row.setAttribute(
    'aria-pressed',
    String(
      selected &&
      String(selected.id) === String(message.id)
    )
  );

  var avatar = el('span', 'message-avatar', initials(message.from));
  var content = el('span', 'message-row-content');
  var topLine = el('span', 'message-row-top');
  var sender = el('span', 'message-sender', message.from);
  var time = el('span', 'message-time', relativeTime(message.ts));
  var subject = el('span', 'message-subject', message.subject);
  var preview = el('span', 'message-preview', previewText(message.body));

  topLine.append(sender, time);
  content.append(topLine, subject, preview);
  row.append(avatar, content);

  if (!message.read) {
    row.appendChild(el('span', 'unread-dot'));
  }

  row.addEventListener('click', function () {
    openId = message.id;

    if (!message.read) {
      // Update the interface immediately.
      message.read = true;
      render();

      // Keep the server's existing read endpoint.
      api('read', { id: message.id }).catch(function (error) {
        console.warn('BateMail could not mark email as read:', error);
      });

      return;
    }

    render();
  });

  return row;
}

function previewText(body) {
  var text = String(body || '').replace(/\s+/g, ' ').trim();

  if (!text) return 'No message preview available.';
  if (text.length > 100) return text.slice(0, 100) + '…';

  return text;
}

function renderEmptyReadingPane(panel) {
  var empty = el('div', 'reading-empty');

  empty.appendChild(el('div', 'reading-empty-icon', '✉'));
  empty.appendChild(el('h2', '', 'Your inbox, at a glance'));
  empty.appendChild(el(
    'p',
    '',
    'When you receive a message, select it to read it here.'
  ));

  panel.appendChild(empty);
}

/* ---------- Selected email ---------- */

function renderRead(panel, message) {
  var header = el('div', 'reading-header');
  var title = el('h2', '', message.subject);
  var senderLine = el('div', 'reading-sender-line');

  var avatar = el('span', 'sender-avatar', initials(message.from));
  var senderDetails = el('div', 'sender-details');
  var sender = el('strong', '', message.from);
  var recipient = el('span', '', 'to ' + (message.to || me));
  var time = el('span', 'reading-time', relativeTime(message.ts));

  senderDetails.append(sender, recipient);
  senderLine.append(avatar, senderDetails, time);
  header.append(title, senderLine);

  var bodyCard = el('div', 'email-body-card');
  var brand = el('div', 'email-brand');
  var logo = el('span', 'email-brand-icon', '✉');
  var brandName = el('span', '', 'Message');

  brand.append(logo, brandName);

  var body = el('div', 'email-body-text');
  body.textContent = message.body || '(This email has no text body.)';

  bodyCard.append(brand, body);

  var details = el('div', 'email-details');
  details.appendChild(el('div', '', 'From: ' + message.from));
  details.appendChild(el('div', '', 'To: ' + (message.to || me)));
  details.appendChild(el('div', '', 'Received: ' + fmt(message.ts)));

  var actions = el('div', 'reading-actions');
  var back = el('button', 'ghost', '← Back to inbox');

  back.type = 'button';
  back.onclick = function () {
    openId = null;
    render();
  };

  actions.appendChild(back);

  panel.append(header, bodyCard, details, actions);
}

/* ---------- Anonymous forum ---------- */

async function renderForum(box) {
  var request = ++forumRequest;
  box.textContent = '';

  var loading = el('div', 'empty', 'Loading forum…');
  box.appendChild(loading);

  var list = [];

  try {
    var result = await api('forum', undefined, true);
    list = Array.isArray(result.posts) ? result.posts : [];
  } catch (error) {
    if (request !== forumRequest || view !== 'forum') return;

    box.textContent = '';
    box.appendChild(el(
      'div',
      'empty',
      'Could not load forum posts. Please try again.'
    ));

    var retry = el('button', 'ghost', 'Retry');
    retry.type = 'button';
    retry.onclick = function () {
      renderForum(box);
    };
    box.appendChild(retry);
    return;
  }

  if (request !== forumRequest) return;

  if (box.id === 'pane' && view !== 'forum') return;

  box.textContent = '';

  var wrap = el('div', 'forum');
  var form = el('form', 'fpost');
  var titleInput = el('input');
  var bodyInput = el('textarea');
  var error = el('p', 'err');
  var submit = el('button', 'btn', 'Post anonymously');

  titleInput.placeholder = 'Title (optional)';
  titleInput.maxLength = 80;
  titleInput.setAttribute('aria-label', 'Title');

  bodyInput.placeholder = 'Say something. You’ll post as Anonymous.';
  bodyInput.maxLength = 500;
  bodyInput.setAttribute('aria-label', 'Post');
  bodyInput.rows = 4;

  submit.type = 'submit';
  error.setAttribute('role', 'alert');

  form.append(titleInput, bodyInput, error, submit);

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    error.textContent = '';

    var bodyText = bodyInput.value.trim();

    if (bodyText.length < 2) {
      error.textContent = 'Write something first.';
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Posting…';

    try {
      await api('forum', {
        title: titleInput.value.trim(),
        body: bodyText
      }, true);

      renderForum(box);
    } catch (problem) {
      error.textContent = problem.message;
    } finally {
      submit.disabled = false;
      submit.textContent = 'Post anonymously';
    }
  });

  wrap.appendChild(form);

  if (!list.length) {
    wrap.appendChild(el(
      'div',
      'empty',
      'No posts yet. Start the conversation.'
    ));
  }

  list.forEach(function (post) {
    var item = el('article', 'fitem');

    if (post.title) {
      item.appendChild(el('h3', '', post.title));
    }

    item.appendChild(el('p', 'fbody', post.body || ''));
    item.appendChild(el(
      'small',
      '',
      (post.name || 'Anonymous') + ' · ' + fmt(post.ts)
    ));

    wrap.appendChild(item);
  });

  box.appendChild(wrap);
}

/* ---------- Public forum on the landing page ---------- */

renderForum($('#forum-landing'));

if (token) {
  start().catch(function (error) {
    console.error('BateMail startup failed:', error);
    logoutUI();
    tab('login');
  });
}

})();
```
