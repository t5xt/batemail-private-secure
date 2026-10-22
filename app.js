
(function () {
  'use strict';

  /* ---------- Helpers ---------- */

  var $ = function (selector, root) {
    return (root || document).querySelector(selector);
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function initials(value) {
    var name = String(value || '').trim();
    return name ? name.charAt(0).toUpperCase() : '?';
  }

  function on(selector, event, handler) {
    var node = $(selector);
    if (node) node.addEventListener(event, handler);
    return node;
  }

  // Treat offset-free server timestamps as UTC, then display in the browser timezone.
  function parseDate(value) {
    if (value === null || value === undefined || value === '') return NaN;
    if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
    var raw = String(value).trim();
    if (/^\d{10,13}$/.test(raw)) return raw.length === 10 ? Number(raw) * 1000 : Number(raw);
    var normalized = raw.replace(' ', 'T');
    if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(normalized)) normalized += 'Z';
    return Date.parse(normalized);
  }

  function localDate(value) {
    var millis = parseDate(value);
    return Number.isFinite(millis) ? new Date(millis) : null;
  }

  function fmt(value) {
    var date = localDate(value);
    if (!date) return 'Date unavailable';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function relativeTime(value) {
    var date = localDate(value);
    if (!date) return 'Time unavailable';
    var seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 10) return 'Just now';
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) {
      var hours = Math.floor(seconds / 3600);
      var minutes = Math.floor((seconds % 3600) / 60);
      return hours + 'h' + (minutes ? ' ' + minutes + 'm' : '') + ' ago';
    }
    if (seconds < 604800) return Math.floor(seconds / 86400) + 'd ago';
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
  }

  function liveTime(value, className) {
    var node = el('span', className, relativeTime(value));
    if (localDate(value)) {
      node.dataset.mailTimestamp = value;
      node.title = fmt(value);
    }
    return node;
  }

  setInterval(function () {
    document.querySelectorAll('[data-mail-timestamp]').forEach(function (node) {
      var value = node.dataset.mailTimestamp;
      node.textContent = relativeTime(value);
      node.title = fmt(value);
    });
  }, 1000);

  function showError(selector, message) {
    var node = $(selector);
    if (node) node.textContent = message || '';
  }

  function setHidden(selector, hidden) {
    var node = $(selector);
    if (node) node.hidden = hidden;
  }

  /* ---------- State ---------- */

  var token = null;
  var me = null;
  var mailbox = [];
  var view = 'inbox';
  var openId = null;
  var mailRequest = 0;
  var forumRequest = 0;
  var startRequest = 0;

  try {
    token = localStorage.getItem('bm_token');
  } catch (error) {
    console.warn('BateMail cannot access local storage:', error);
  }

  function setToken(value) {
    token = value;

    try {
      if (value) {
        localStorage.setItem('bm_token', value);
      } else {
        localStorage.removeItem('bm_token');
      }
    } catch (error) {
      console.warn('BateMail could not save the session:', error);
    }
  }

  /* ---------- API ---------- */

  async function api(path, body, anon) {
    var options = {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Accept: 'application/json'
      }
    };

    if (token && !anon) {
      options.headers.Authorization = 'Bearer ' + token;
    }

    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    var response;

    try {
      response = await fetch(
        'https://api.batemail.lol/api/' + path,
        Object.assign({ cache: 'no-store' }, options)
      );
    } catch (error) {
      throw new Error(
        'Cannot reach the BateMail server. Check your connection or try again later.'
      );
    }

    var result = {};

    try {
      result = await response.json();
    } catch (error) {
      // The server did not return JSON.
    }

    if (!response.ok) {
      var message =
        result && typeof result.error === 'string'
          ? result.error
          : 'Request failed (' + response.status + ').';

      var apiError = new Error(message);
      apiError.status = response.status;
      throw apiError;
    }

    return result;
  }

  /* ---------- Authentication tabs ---------- */

  function tab(which) {
    ['create', 'login'].forEach(function (name) {
      var form = $('#f-' + name);
      var button = $('#t-' + name);

      if (form) form.hidden = name !== which;

      if (button) {
        button.setAttribute(
          'aria-selected',
          String(name === which)
        );
      }
    });
  }

  on('#t-create', 'click', function () {
    tab('create');
  });

  on('#t-login', 'click', function () {
    tab('login');
  });

  /* ---------- Registration ---------- */

  on('#f-create', 'submit', async function (event) {
    event.preventDefault();

    showError('#c-err', '');

    var usernameNode = $('#c-user');
    var passwordNode = $('#c-pass');

    if (!usernameNode || !passwordNode) {
      showError('#c-err', 'Registration form is incomplete.');
      return;
    }

    var username = usernameNode.value.trim().toLowerCase();
    var password = passwordNode.value;

    if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
      showError(
        '#c-err',
        'Username: 3–30 letters, numbers, . - or _'
      );
      return;
    }

    if (password.length < 6) {
      showError(
        '#c-err',
        'Password must be at least 6 characters.'
      );
      return;
    }

    var submit = $('button[type="submit"]', $('#f-create'));
    if (submit) submit.disabled = true;

    try {
      var result = await api('register', {
        user: username,
        pass: password
      }, true);

      if (!result.token) {
        throw new Error('The server did not return a login token.');
      }

      setToken(result.token);
      passwordNode.value = '';

      await start();
    } catch (error) {
      showError('#c-err', error.message);
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  /* ---------- Login ---------- */

  on('#f-login', 'submit', async function (event) {
    event.preventDefault();

    showError('#l-err', '');

    var emailNode = $('#l-mail');
    var passwordNode = $('#l-pass');

    if (!emailNode || !passwordNode) {
      showError('#l-err', 'Login form is incomplete.');
      return;
    }

    var submit = $('button[type="submit"]', $('#f-login'));
    if (submit) submit.disabled = true;

    try {
      var result = await api('login', {
        email: emailNode.value.trim(),
        pass: passwordNode.value
      }, true);

      if (!result.token) {
        throw new Error('The server did not return a login token.');
      }

      setToken(result.token);
      passwordNode.value = '';

      await start();
    } catch (error) {
      showError('#l-err', error.message);
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  /* ---------- Mailbox ---------- */

  async function loadMail() {
    var request = ++mailRequest;
    var result = await api('mail');

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
  }

  async function start() {
    var request = ++startRequest;

    try {
      await loadMail();

      if (request !== startRequest) return;

      view = 'inbox';
      openId = null;

      setHidden('#auth', true);
      setHidden('#app', false);

      var meNode = $('#me');
      if (meNode) meNode.textContent = me || '';

      render();
    } catch (error) {
      if (request !== startRequest) return;
      throw error;
    }
  }

  function logoutUI() {
    startRequest++;
    mailRequest++;
    forumRequest++;

    setToken(null);

    me = null;
    mailbox = [];
    openId = null;
    view = 'inbox';

    setHidden('#app', true);
    setHidden('#auth', false);

    tab('login');
    showError('#l-err', '');
    showError('#c-err', '');
  }

  on('#out', 'click', async function (event) {
    var button = event.currentTarget;
    button.disabled = true;

    try {
      await api('logout', {});
    } catch (error) {
      console.warn('BateMail logout request failed:', error);
    } finally {
      logoutUI();
      button.disabled = false;
    }
  });

  /* ---------- Navigation ---------- */

  function go(nextView) {
    view = nextView;
    openId = null;
    render();
  }

  on('#n-inbox', 'click', function () {
    go('inbox');
  });

  on('#n-forum', 'click', function () {
    go('forum');
  });

  /* ---------- Refresh ---------- */

  var refreshButton = $('#refresh-mail');

  if (refreshButton) {
    refreshButton.addEventListener('click', async function () {
      if (refreshButton.disabled) return;

      refreshButton.disabled = true;
      refreshButton.classList.add('is-refreshing');

      try {
        await loadMail();

        if (openId !== null && !mailbox.some(function (message) {
          return String(message.id) === String(openId);
        })) {
          openId = null;
        }

        render();
        showRefreshStatus('Inbox updated · ' + mailbox.filter(function (m) { return m.folder === 'inbox'; }).length + ' messages');
      } catch (error) {
        console.error('BateMail refresh failed:', error);
        showRefreshError(error.message);
      } finally {
        refreshButton.classList.remove('is-refreshing');
        refreshButton.disabled = false;
        refreshButton.setAttribute('aria-label', 'Refresh mail');
        refreshButton.setAttribute('title', 'Refresh mail');
      }
    });
  }

  function showRefreshStatus(message) {
    var notice = $('#refresh-status');
    if (notice) {
      notice.textContent = message;
      notice.setAttribute('role', 'status');
    }
  }

  function showRefreshError(message) {
    showRefreshStatus('Refresh failed: ' + (message || 'Please try again.'));
  }

  /* ---------- Main rendering ---------- */

  function render() {
    var pane = $('#pane');
    if (!pane) {
      console.error('BateMail: missing #pane element in HTML.');
      return;
    }

    var count = $('#cnt');
    var unreadCount = mailbox.filter(function (message) {
      return message.folder === 'inbox' && !message.read;
    }).length;

    if (count) count.textContent = unreadCount || '';

    [
      ['inbox', '#n-inbox'],
      ['forum', '#n-forum']
    ].forEach(function (item) {
      var button = $(item[1]);

      if (button) {
        button.setAttribute(
          'aria-current',
          String(view === item[0])
        );
      }
    });

    pane.textContent = '';

    if (view === 'forum') {
      renderForum(pane);
    } else {
      renderInbox(pane);
    }
  }

  /* ---------- Inbox layout ---------- */

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
      inboxMessages.length +
        (inboxMessages.length === 1 ? ' message' : ' messages')
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
        openId = null;
      }

      inboxMessages.forEach(function (message) {
        listPanel.appendChild(renderMessageRow(message, selected));
      });

      if (selected) renderRead(readingPanel, selected);
      else renderEmptyReadingPane(readingPanel);
    }

    layout.append(listPanel, readingPanel);
    pane.appendChild(layout);
  }

  function renderMessageRow(message, selected) {
    var isSelected = selected &&
      String(selected.id) === String(message.id);

    var row = el(
      'button',
      'message-row' +
        (!message.read ? ' unread' : '') +
        (isSelected ? ' selected' : '')
    );

    row.type = 'button';
    row.setAttribute('aria-pressed', String(Boolean(isSelected)));

    var avatar = el('span', 'message-avatar', initials(message.from));
    var content = el('span', 'message-row-content');
    var topLine = el('span', 'message-row-top');
    var sender = el('span', 'message-sender', message.from);
    var time = liveTime(message.ts, 'message-time');
    var subject = el('span', 'message-subject', message.subject);
    var preview = el(
      'span',
      'message-preview',
      previewText(message.body)
    );

    topLine.append(sender, time);
    content.append(topLine, subject, preview);
    row.append(avatar, content);

    if (!message.read) {
      row.appendChild(el('span', 'unread-dot'));
    }

    row.addEventListener('click', function () {
      openId = message.id;

      if (!message.read) {
        message.read = true;
        render();

        api('read', { id: message.id }).catch(function (error) {
          console.warn('Could not mark message as read:', error);
        });
      } else {
        render();
      }
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

  /* ---------- Selected message ---------- */

  function renderRead(panel, message) {
    var header = el('div', 'reading-header');
    var title = el('h2', '', message.subject);
    var senderLine = el('div', 'reading-sender-line');

    var avatar = el('span', 'sender-avatar', initials(message.from));
    var senderDetails = el('div', 'sender-details');
    var sender = el('strong', '', message.from);
    var recipient = el('span', '', 'to ' + (message.to || me));
    var time = liveTime(message.ts, 'reading-time');

    senderDetails.append(sender, recipient);
    senderLine.append(avatar, senderDetails, time);
    header.append(title, senderLine);

    var bodyCard = el('div', 'email-body-card');
    var brand = el('div', 'email-brand');

    brand.append(
      el('span', 'email-brand-icon', '✉'),
      el('span', '', 'Message')
    );

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
    if (!box) {
      console.warn('BateMail: forum container is missing.');
      return;
    }

    var request = ++forumRequest;
    box.textContent = '';
    box.appendChild(el('div', 'empty', 'Loading forum…'));

    try {
      var result = await api('forum', undefined, true);

      if (request !== forumRequest) return;
      if (box.id === 'pane' && view !== 'forum') return;

      var posts = Array.isArray(result.posts) ? result.posts : [];
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

          await renderForum(box);
        } catch (problem) {
          error.textContent = problem.message;
        } finally {
          submit.disabled = false;
          submit.textContent = 'Post anonymously';
        }
      });

      wrap.appendChild(form);

      if (!posts.length) {
        wrap.appendChild(el(
          'div',
          'empty',
          'No posts yet. Start the conversation.'
        ));
      }

      posts.forEach(function (post) {
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
    } catch (error) {
      if (request !== forumRequest) return;
      if (box.id === 'pane' && view !== 'forum') return;

      box.textContent = '';
      box.appendChild(el(
        'div',
        'empty',
        'Could not load forum posts. ' + error.message
      ));

      var retry = el('button', 'ghost', 'Retry');
      retry.type = 'button';
      retry.onclick = function () {
        renderForum(box);
      };

      box.appendChild(retry);
    }
  }

  /* ---------- Landing-page forum ---------- */

  var forumLanding = $('#forum-landing');

  if (forumLanding) {
    renderForum(forumLanding);
  }

  /* ---------- Restore existing session ---------- */

  if (token) {
    start().catch(function (error) {
      console.error('BateMail startup failed:', error);

      // Only clear the session for authentication failures.
      if (error.status === 401 || error.status === 403) {
        logoutUI();
      } else {
        setHidden('#app', true);
        setHidden('#auth', false);
        showError(
          '#l-err',
          'Could not connect to your inbox. Please try again. ' +
            error.message
        );
        tab('login');
      }
    });
  } else {
    setHidden('#app', true);
    setHidden('#auth', false);
    tab('login');
  }
})();
