/* The customer account page. Everything it shows comes from /api/account/*
   — see worker/accounts.js. Every value from the server goes into the page
   through textContent, never innerHTML, so a name or a stamp line with a "<"
   in it is just text. */
(function(){
  'use strict';

  var STATES = [['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['DC','District of Columbia'],['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],['IN','Indiana'],['IA','Iowa'],['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],['ME','Maine'],['MD','Maryland'],['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],['NY','New York'],['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],['OK','Oklahoma'],['OR','Oregon'],['PA','Pennsylvania'],['PR','Puerto Rico'],['RI','Rhode Island'],['SC','South Carolina'],['SD','South Dakota'],['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],['VI','U.S. Virgin Islands'],['VA','Virginia'],['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming']];

  var STATUS = {
    building: 'On the bench',
    shipped: 'Shipped',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
    refunded: 'Refunded',
    pending: 'Payment pending'
  };

  // How far along the tracker each status sits. Cancelled, refunded and
  // unpaid orders get no tracker at all.
  var STEPS = ['Ordered', 'On the bench', 'Shipped', 'Delivered'];
  var STEP_AT = { building: 1, shipped: 2, delivered: 3 };

  var TITLES = { signin: 'Sign In', create: 'Make an Account', code: 'Check Your Email', forgot: 'Reset Password', reset: 'Set a New Password' };
  var FORMS = ['signin', 'create', 'code', 'forgot', 'reset'];

  var $ = function(id){ return document.getElementById(id); };
  var state = { email: '', mode: 'signin', account: null, stripe: null, card: null, codesReady: 0 };

  function el(tag, cls, text){
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function show(id, on){ var n = $(id); if (n) n.hidden = !on; }

  function money(n){
    return '$' + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function niceDate(iso){
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
  }

  function api(path, body){
    var opts = { credentials: 'same-origin', headers: { accept: 'application/json' } };
    if (body !== undefined) {
      opts.method = 'POST';
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(data){
        data = data || {};
        data._status = res.status;
        if (!res.ok) {
          var err = new Error(data.error || 'Something went wrong. Try again.');
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  /* ---------------------------------------------------------- form helpers */

  function fillStates(){
    var selects = document.querySelectorAll('[data-states]');
    for (var i = 0; i < selects.length; i++) {
      var sel = selects[i];
      sel.appendChild(new Option('Pick one', ''));
      for (var j = 0; j < STATES.length; j++) sel.appendChild(new Option(STATES[j][1], STATES[j][0]));
    }
  }

  function clearErrors(form){
    var errs = form.querySelectorAll('[data-error]');
    for (var i = 0; i < errs.length; i++) errs[i].textContent = '';
    var bad = form.querySelectorAll('[aria-invalid]');
    for (var k = 0; k < bad.length; k++) bad[k].removeAttribute('aria-invalid');
  }

  function showError(form, err){
    var data = (err && err.data) || {};
    var field = data.field || 'form';
    var slot = form.querySelector('[data-error="' + field + '"]') || form.querySelector('[data-error="form"]') || form.querySelector('[data-error]');
    if (slot) slot.textContent = err.message;
    var input = form.querySelector('[name="' + field + '"]');
    if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
  }

  function busy(form, on){
    var btn = form.querySelector('.acct-submit');
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = 'Working…'; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
  }

  function value(form, name){
    var f = form.elements[name];
    return f ? String(f.value || '').trim() : '';
  }

  function detailsFrom(form){
    return {
      firstName: value(form, 'firstName'),
      lastName: value(form, 'lastName'),
      address: {
        line1: value(form, 'line1'), line2: value(form, 'line2'), city: value(form, 'city'),
        state: value(form, 'state'), zip: value(form, 'zip')
      },
      phone: value(form, 'phone'),
      birthdayEmails: !!(form.elements.birthdayEmails && form.elements.birthdayEmails.checked)
    };
  }

  /* -------------------------------------------------------------- signed out */

  function setTitle(key){ $('auth-title').textContent = TITLES[key]; }

  // Sign In and Make an Account are the two tabs. The other three are steps
  // off them, and hide the tabs while they are up.
  function showForm(name){
    if (name === 'signin' || name === 'create') state.mode = name;
    for (var i = 0; i < FORMS.length; i++) show('form-' + FORMS[i], FORMS[i] === name);
    var tabbed = name === 'signin' || name === 'create';
    document.querySelector('.acct-tabs').hidden = !tabbed;
    if (tabbed) {
      $('tab-signin').setAttribute('aria-selected', name === 'signin' ? 'true' : 'false');
      $('tab-create').setAttribute('aria-selected', name === 'create' ? 'true' : 'false');
    }
    setTitle(name);
    var form = $('form-' + name);
    if (form) clearErrors(form);
  }

  function setTab(tab){ showForm(tab); }

  function askForCode(email){
    state.email = email;
    $('code-email').textContent = email;
    showForm('code');
    $('code-input').value = '';
    $('code-input').focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function askForReset(email){
    state.email = email;
    $('reset-email').textContent = email;
    showForm('reset');
    $('rs-code').value = '';
    $('rs-password').value = '';
    $('rs-code').focus();
  }

  // After any sign-in: back to the checkout that sent them, or the account.
  function afterSignIn(){
    var next = new URLSearchParams(location.search).get('next') || '';
    // Only ever back to our own checkout page — never an outside address.
    if (/^\/pay\?/.test(next)) { location.replace(next); return; }
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    return load();
  }

  function signedOut(){
    show('acct-loading', false);
    show('acct-home', false);
    show('acct-auth', true);
    setTab(location.hash === '#create' ? 'create' : 'signin');
  }

  function wireAuth(){
    $('tab-signin').addEventListener('click', function(){ setTab('signin'); });
    $('tab-create').addEventListener('click', function(){ setTab('create'); });
    var gotos = document.querySelectorAll('[data-goto]');
    for (var g = 0; g < gotos.length; g++) {
      gotos[g].addEventListener('click', function(){
        var to = this.getAttribute('data-goto');
        if (to === 'forgot' && !$('fg-email').value) $('fg-email').value = $('si-email').value;
        showForm(to);
      });
    }

    // Show / Hide beside every password box.
    var shows = document.querySelectorAll('[data-show]');
    for (var sh = 0; sh < shows.length; sh++) {
      shows[sh].addEventListener('click', function(){
        var input = $(this.getAttribute('data-show'));
        var hidden = input.type === 'password';
        input.type = hidden ? 'text' : 'password';
        this.textContent = hidden ? 'Hide' : 'Show';
      });
    }

    // The latest a birthday can be and still be 18 today.
    var dob = $('cr-dob');
    var now = new Date();
    var max = new Date(now.getFullYear() - 18, now.getMonth(), now.getDate());
    dob.max = max.toISOString().slice(0, 10);
    dob.min = (now.getFullYear() - 110) + '-01-01';

    $('form-signin').addEventListener('submit', function(e){
      e.preventDefault();
      var form = e.target; clearErrors(form);
      busy(form, true);
      api('/api/account/signin', { email: value(form, 'email'), password: form.elements.password.value }).then(function(){
        form.elements.password.value = '';
        return afterSignIn();
      }).catch(function(err){ showError(form, err); }).then(function(){ busy(form, false); });
    });

    $('form-forgot').addEventListener('submit', function(e){
      e.preventDefault();
      var form = e.target; clearErrors(form);
      var email = value(form, 'email');
      busy(form, true);
      api('/api/account/code', { email: email }).then(function(d){
        askForReset(d.email || email);
      }).catch(function(err){ showError(form, err); }).then(function(){ busy(form, false); });
    });

    $('form-reset').addEventListener('submit', function(e){
      e.preventDefault();
      var form = e.target; clearErrors(form);
      busy(form, true);
      api('/api/account/reset', { email: state.email, code: value(form, 'code'), password: form.elements.password.value }).then(function(){
        form.elements.password.value = '';
        return afterSignIn();
      }).catch(function(err){
        showError(form, err);
        if (err.data && err.data.expired) $('rs-code').value = '';
      }).then(function(){ busy(form, false); });
    });

    $('reset-resend').addEventListener('click', function(){
      var form = $('form-reset'); clearErrors(form);
      api('/api/account/code', { email: state.email }).then(function(){
        form.querySelector('[data-error="code"]').textContent = 'A new code is on its way.';
      }).catch(function(err){ showError(form, err); });
    });

    $('form-create').addEventListener('submit', function(e){
      e.preventDefault();
      var form = e.target; clearErrors(form);
      var body = detailsFrom(form);
      body.email = value(form, 'email');
      body.dob = value(form, 'dob');
      body.password = form.elements.password.value;
      busy(form, true);
      api('/api/account/signup', body).then(function(d){
        askForCode(d.email || body.email);
      }).catch(function(err){ showError(form, err); }).then(function(){ busy(form, false); });
    });

    $('form-code').addEventListener('submit', function(e){
      e.preventDefault();
      var form = e.target; clearErrors(form);
      busy(form, true);
      api('/api/account/verify', { email: state.email, code: value(form, 'code') }).then(function(){
        $('cr-password').value = '';
        return afterSignIn();
      }).catch(function(err){
        showError(form, err);
        if (err.data && err.data.expired) $('code-input').value = '';
      }).then(function(){ busy(form, false); });
    });

    $('code-back').addEventListener('click', function(){ showForm('create'); });

    var codeBoxes = ['code-input', 'rs-code', 'pw-code'];
    for (var cb = 0; cb < codeBoxes.length; cb++) {
      $(codeBoxes[cb]).addEventListener('input', function(){
        this.value = this.value.replace(/\D/g, '').slice(0, 6);
      });
    }
  }

  /* --------------------------------------------------------------- signed in */

  function renderCodes(d){
    var box = $('acct-codes');
    box.textContent = '';
    var codes = d.coupons || [];
    show('acct-codes-block', codes.length > 0);
    var best = 0;
    state.codesReady = 0;
    for (var i = 0; i < codes.length; i++) {
      var c = codes[i];
      if (c.status === 'ready') { state.codesReady++; if (c.rate > best) best = c.rate; }

      var tag = el('div', 'acct-ticket' + (c.status === 'ready' ? '' : ' is-' + c.status));
      var rate = el('div', 'acct-ticket-rate');
      rate.appendChild(el('span', 'acct-ticket-pct', c.rate + '%'));
      rate.appendChild(el('span', 'acct-ticket-off', 'OFF'));
      tag.appendChild(rate);

      var body = el('div', 'acct-ticket-body');
      body.appendChild(el('p', 'acct-ticket-label', c.kind === 'birthday' ? 'Birthday · one order' : 'Sign-up · one order'));
      var row = el('p', 'acct-ticket-code');
      row.appendChild(el('code', null, c.code));
      if (c.status === 'ready') {
        var copy = el('button', 'acct-copy', 'Copy');
        copy.type = 'button';
        copy.setAttribute('data-code', c.code);
        copy.addEventListener('click', copyCode);
        row.appendChild(copy);
      }
      body.appendChild(row);
      body.appendChild(el('p', 'acct-ticket-note', c.status === 'used' ? 'Used. Thanks for the order.'
        : c.status === 'expired' ? 'Ran out ' + c.goodThrough + '.'
        : 'Good through ' + c.goodThrough + '.'));
      tag.appendChild(body);
      box.appendChild(tag);
    }

    var sale = $('acct-sale');
    if (d.sale && d.sale.live && best) {
      sale.textContent = d.sale.rate >= best
        ? 'The store sale (' + d.sale.rate + '% off) already beats your code right now. Hang on to the code for later.'
        : 'A store sale is on (' + d.sale.rate + '% off). Your ' + best + '% code beats it: type it in the cart, and when it asks "Use this discount instead?", tap Yes.';
      sale.hidden = false;
    } else {
      sale.hidden = true;
    }
    $('stat-codes').textContent = String(state.codesReady);
  }

  function copyCode(e){
    var btn = e.currentTarget;
    var code = btn.getAttribute('data-code');
    var done = function(){ btn.textContent = 'Copied'; setTimeout(function(){ btn.textContent = 'Copy'; }, 1800); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, function(){});
  }

  function steps(status){
    var at = STEP_AT[status];
    if (at === undefined) return null;
    var ol = el('ol', 'acct-steps');
    ol.setAttribute('aria-label', 'Order progress');
    for (var s = 0; s < STEPS.length; s++) {
      var cls = s < at ? 'is-done' : s === at ? (at === 3 ? 'is-done' : 'is-now') : '';
      var li = el('li', 'acct-step ' + cls, STEPS[s]);
      if (s === at) li.setAttribute('aria-current', 'step');
      ol.appendChild(li);
    }
    return ol;
  }

  function thumb(it){
    var img = el('img', 'acct-thumb');
    img.alt = '';
    img.loading = 'lazy';
    img.width = 68; img.height = 68;
    if (it.thumb) {
      img.src = it.thumb;
      img.addEventListener('error', function onErr(){
        img.removeEventListener('error', onErr);
        if (it.image && img.src.indexOf(it.image) === -1) img.src = it.image;
        else img.style.visibility = 'hidden';
      });
    } else {
      img.style.visibility = 'hidden';
    }
    return img;
  }

  function renderOrders(list){
    var box = $('acct-orders');
    box.textContent = '';
    $('stat-orders').textContent = String(list.length);
    $('stat-bench').textContent = String(list.filter(function(o){ return o.status === 'building'; }).length);

    if (!list.length) {
      var empty = el('div', 'acct-empty');
      empty.appendChild(el('p', null, 'No orders under this email yet. When you order, it shows up here with its tracking.'));
      var shop = el('a', 'btn btn-primary', 'Shop the Gear'); shop.href = '/shop';
      empty.appendChild(shop);
      box.appendChild(empty);
      return;
    }

    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      var card = el('article', 'acct-order');

      var head = el('header', 'acct-order-head');
      var who = el('div');
      who.appendChild(el('p', 'acct-order-inv', o.invoice || 'Order'));
      who.appendChild(el('span', 'acct-order-date', 'Ordered ' + niceDate(o.placedAt)));
      head.appendChild(who);
      head.appendChild(el('span', 'acct-pill acct-pill-' + o.status, STATUS[o.status] || o.status));
      card.appendChild(head);

      var track = steps(o.status);
      if (track) card.appendChild(track);

      var ul = el('ul', 'acct-items');
      for (var j = 0; j < o.items.length; j++) {
        var it = o.items[j];
        var li = el('li', 'acct-item');
        li.appendChild(thumb(it));
        var bodyEl = el('div');
        bodyEl.appendChild(el('p', 'acct-item-name', it.name + (it.quantity > 1 ? ' × ' + it.quantity : '')));
        if (it.options && it.options.length) {
          bodyEl.appendChild(el('p', 'acct-item-opts', it.options.map(function(op){ return op.name + ': ' + op.value; }).join(' · ')));
        }
        if (it.url) {
          var again = el('a', 'acct-item-again', 'Buy again');
          again.href = it.url;
          bodyEl.appendChild(again);
        }
        li.appendChild(bodyEl);
        li.appendChild(el('span', 'acct-item-price', money(it.total)));
        ul.appendChild(li);
      }
      card.appendChild(ul);

      var foot = el('footer', 'acct-order-foot');
      var note = el('p', 'acct-order-note');
      if (o.tracking) {
        note.appendChild(document.createTextNode('Tracking '));
        note.appendChild(el('strong', null, o.tracking.number));
      } else if (o.status === 'building') {
        note.textContent = o.leadTime
          ? 'Being built by hand. Lead time is ' + o.leadTime + ' from the order date. Tracking shows up here the day it ships.'
          : 'Being built by hand. Tracking shows up here the day it ships.';
      } else if (o.status === 'refunded') {
        note.textContent = 'Refunded to the card it was paid with.';
      }
      foot.appendChild(note);
      var right = el('div', 'acct-order-right');
      right.appendChild(el('p', 'acct-order-total', 'Total ' + money(o.total)));
      if (o.tracking) {
        var a = el('a', 'btn btn-primary acct-track-btn', 'Track Package');
        a.href = o.tracking.url; a.target = '_blank'; a.rel = 'noopener';
        right.appendChild(a);
      }
      foot.appendChild(right);
      card.appendChild(foot);
      box.appendChild(card);
    }
  }

  function loadOrders(){
    api('/api/account/orders').then(function(d){ renderOrders(d.orders || []); }).catch(function(err){
      var box = $('acct-orders'); box.textContent = '';
      box.appendChild(el('p', 'acct-soft', err.message));
    });
  }

  function brandName(b){
    return ({ visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay' })[String(b).toLowerCase()] || 'Card';
  }

  function renderCards(d){
    var box = $('acct-cards');
    box.textContent = '';
    var cards = d.cards || [];
    if (!cards.length) box.appendChild(el('p', 'acct-soft', 'No card on file yet. Save one and checkout takes the 3 digits on the back, nothing else.'));
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var cc = el('div', 'acct-cc');
      cc.appendChild(el('span', 'acct-cc-brand', brandName(c.brand)));
      cc.appendChild(el('span', 'acct-cc-num', '•••• •••• •••• ' + c.last4));
      var foot = el('div', 'acct-cc-foot');
      foot.appendChild(el('span', null, 'Expires ' + String(c.expMonth).padStart(2, '0') + '/' + String(c.expYear).slice(-2)));
      var rm = el('button', 'acct-link', 'Remove');
      rm.type = 'button';
      rm.setAttribute('data-id', c.id);
      rm.addEventListener('click', removeCard);
      foot.appendChild(rm);
      cc.appendChild(foot);
      box.appendChild(cc);
    }
    $('card-add').hidden = cards.length >= (d.max || 5);
    $('card-add').textContent = cards.length ? 'Add Another Card' : 'Add a Card';
  }

  function loadCards(){
    api('/api/account/cards').then(function(d){
      show('acct-cards-block', !!d.enabled);
      if (d.enabled) renderCards(d);
    }).catch(function(err){
      show('acct-cards-block', true);
      var box = $('acct-cards'); box.textContent = '';
      box.appendChild(el('p', 'acct-soft', err.message));
    });
  }

  function removeCard(e){
    var btn = e.currentTarget;
    if (!confirm('Take this card off your account?')) return;
    btn.disabled = true;
    api('/api/account/cards/remove', { id: btn.getAttribute('data-id') }).then(function(d){
      renderCards({ cards: d.cards });
    }).catch(function(err){ btn.disabled = false; alert(err.message); });
  }

  function loadStripe(){
    if (window.Stripe) return Promise.resolve();
    return new Promise(function(resolve, reject){
      var s = document.createElement('script');
      s.src = 'https://js.stripe.com/v3/';
      s.onload = resolve;
      s.onerror = function(){ reject(new Error('Could not load the card form. Check your connection.')); };
      document.head.appendChild(s);
    });
  }

  function openCardForm(){
    var form = $('form-card');
    var err = $('card-error');
    err.textContent = '';
    $('card-add').hidden = true;
    form.hidden = false;
    var save = $('card-save');
    save.disabled = true;
    api('/api/account/cards/setup', {}).then(function(d){
      state.setupSecret = d.clientSecret;
      return loadStripe().then(function(){
        if (!state.stripe) state.stripe = window.Stripe(d.publishableKey);
        if (!state.card) {
          state.card = state.stripe.elements().create('card', {
            style: { base: { fontSize: '17px', color: '#0F0F0F', fontFamily: 'Georgia, serif', '::placeholder': { color: '#6B6358' } } }
          });
          state.card.mount('#card-element');
          state.card.on('change', function(ev){ err.textContent = ev.error ? ev.error.message : ''; });
        }
        save.disabled = false;
      });
    }).catch(function(e){ err.textContent = e.message; });
  }

  function closeCardForm(){
    $('form-card').hidden = true;
    $('card-add').hidden = false;
  }

  function wireCards(){
    $('card-add').addEventListener('click', openCardForm);
    $('card-cancel').addEventListener('click', closeCardForm);
    $('form-card').addEventListener('submit', function(e){
      e.preventDefault();
      var form = e.target;
      var err = $('card-error');
      if (!state.stripe || !state.card || !state.setupSecret) return;
      busy(form, true);
      var name = state.account ? (state.account.firstName + ' ' + state.account.lastName) : '';
      state.stripe.confirmCardSetup(state.setupSecret, {
        payment_method: { card: state.card, billing_details: { name: name, email: state.account ? state.account.email : undefined } }
      }).then(function(r){
        if (r.error) throw new Error(r.error.message);
        state.setupSecret = '';
        state.card.clear();
        closeCardForm();
        loadCards();
      }).catch(function(e2){ err.textContent = e2.message; }).then(function(){ busy(form, false); });
    });
  }

  function renderDetails(a){
    var dl = $('acct-details');
    dl.textContent = '';
    var addr = a.address || {};
    var rows = [
      ['Name', a.firstName + ' ' + a.lastName],
      ['Email', a.email],
      ['Birthday', a.dob ? new Date(a.dob + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }) : ''],
      ['Ship to', [addr.line1, addr.line2, [addr.city, addr.state].filter(Boolean).join(', ') + ' ' + (addr.zip || '')].filter(function(x){ return x && x.trim(); }).join('\n')],
      ['Phone', a.phone || 'None'],
      ['Birthday email', a.birthdayEmails ? 'On' : 'Off']
    ];
    for (var i = 0; i < rows.length; i++) {
      var row = el('div');
      row.appendChild(el('dt', null, rows[i][0]));
      row.appendChild(el('dd', null, rows[i][1]));
      dl.appendChild(row);
    }
  }

  function fillDetailsForm(a){
    var f = $('form-details');
    var addr = a.address || {};
    f.elements.firstName.value = a.firstName || '';
    f.elements.lastName.value = a.lastName || '';
    f.elements.line1.value = addr.line1 || '';
    f.elements.line2.value = addr.line2 || '';
    f.elements.city.value = addr.city || '';
    f.elements.state.value = addr.state || '';
    f.elements.zip.value = addr.zip || '';
    f.elements.phone.value = a.phone || '';
    f.elements.birthdayEmails.checked = a.birthdayEmails !== false;
  }

  function editing(on){
    $('form-details').hidden = !on;
    $('acct-details').hidden = on;
    $('details-edit').hidden = on;
  }

  function wireDetails(){
    $('details-edit').addEventListener('click', function(){
      fillDetailsForm(state.account);
      clearErrors($('form-details'));
      editing(true);
    });
    $('details-cancel').addEventListener('click', function(){ editing(false); });
    $('form-details').addEventListener('submit', function(e){
      e.preventDefault();
      var form = e.target; clearErrors(form);
      busy(form, true);
      api('/api/account/update', detailsFrom(form)).then(function(d){
        state.account = d.account;
        renderDetails(d.account);
        $('acct-name').textContent = d.account.firstName + ' ' + d.account.lastName;
        editing(false);
      }).catch(function(err){ showError(form, err); }).then(function(){ busy(form, false); });
    });

    $('pw-change').addEventListener('click', function(){
      var btn = this;
      btn.disabled = true;
      api('/api/account/code', { email: state.account.email }).then(function(){
        $('pw-email').textContent = state.account.email;
        $('form-pw').hidden = false;
        btn.hidden = true;
        clearErrors($('form-pw'));
        $('pw-code').focus();
      }).catch(function(err){ alert(err.message); }).then(function(){ btn.disabled = false; });
    });
    $('pw-cancel').addEventListener('click', function(){
      $('form-pw').hidden = true;
      $('pw-change').hidden = false;
    });
    $('form-pw').addEventListener('submit', function(e){
      e.preventDefault();
      var form = e.target; clearErrors(form);
      busy(form, true);
      api('/api/account/reset', { email: state.account.email, code: value(form, 'code'), password: form.elements.password.value }).then(function(){
        form.reset();
        form.hidden = true;
        $('pw-change').hidden = false;
        $('pw-change').textContent = 'Saved. Change again';
      }).catch(function(err){ showError(form, err); }).then(function(){ busy(form, false); });
    });

    $('signout').addEventListener('click', function(){
      api('/api/account/signout', {}).then(function(){ location.replace('/account'); }, function(){ location.replace('/account'); });
    });

    $('delete-open').addEventListener('click', function(){
      $('form-delete').hidden = !$('form-delete').hidden;
    });
    $('form-delete').addEventListener('submit', function(e){
      e.preventDefault();
      var form = e.target; clearErrors(form);
      busy(form, true);
      api('/api/account/delete', { confirm: value(form, 'confirm') }).then(function(){
        location.replace('/');
      }).catch(function(err){ showError(form, err); busy(form, false); });
    });
  }

  function signedIn(d){
    var a = d.account;
    state.account = a;
    show('acct-loading', false);
    show('acct-auth', false);
    show('acct-home', true);
    $('acct-name').textContent = a.firstName + ' ' + a.lastName;
    var since = new Date(a.createdAt);
    $('acct-since').textContent = isNaN(since) ? '' : 'With the shop since ' + since.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/New_York' });
    renderCodes(d);
    renderDetails(a);
    loadOrders();
    if (d.cards && d.cards.enabled) loadCards();
    else show('acct-cards-block', false);
  }

  function load(){
    return api('/api/account/me').then(signedIn).catch(function(err){
      var data = err.data || {};
      if (data.off) {
        show('acct-loading', false);
        show('acct-off', true);
        return;
      }
      if (data._status === 401) { signedOut(); return; }
      var p = $('acct-loading');
      p.textContent = err.message;
      p.hidden = false;
    });
  }

  // Each part is wired on its own, and the account loads whatever happens to
  // them. One missing button must never leave the page saying "Loading" — on
  // Oct 18 2026 a cached copy of an older version of this file did exactly
  // that, against newer markup.
  [fillStates, wireAuth, wireCards, wireDetails].forEach(function(wire){
    try { wire(); } catch (err) { if (window.console) console.error('account page:', err); }
  });
  load();
})();
