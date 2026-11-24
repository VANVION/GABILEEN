(() => {
  if (!CHECKOUT_API || !tgAppLink('')) return;
  const entry = $('checkoutEntry');
  const ordersBox = $('checkoutOrders');
  let cartRequest = null;
  let ordersRequest = 0;
  let selectedOrder = null;
  let handledReturn = false;
  let refreshTimer;
  function rememberedOrder() {
    try { return sessionStorage.getItem('gabileen_last_order'); } catch { return null; }
  }
  function rememberOrder(id) {
    try { sessionStorage.setItem('gabileen_last_order', id); } catch {}
  }

  const webQuery = new URLSearchParams(location.search);
  const browserTest = () => !inTelegram() && webQuery.get('checkout') === 'test';

  const phoneTest = () => browserTest() && webQuery.get('login') === 'phone';
  const publicPhone = () => !inTelegram() && !browserTest();
  const phoneAccount = () => phoneTest() || publicPhone();
  const phoneSessionKey = () => publicPhone() ? 'gabileen_public_phone_session' : 'gabileen_phone_session';

  function phoneSession() {
    try { return localStorage.getItem(phoneSessionKey()); } catch { return null; }
  }

  function orderAuthorization() {
    if (phoneAccount()) {
      const token = phoneSession();
      if (!token) throw new Error('phone_session');
      return 'phone ' + token;
    }
    return browserTest() ? guestAuthorization() : 'tma ' + tg.initData;
  }

  function browserKey(storageKey) {
    let key = localStorage.getItem(storageKey);
    if (!/^[a-f0-9]{64}$/.test(key || '')) {
      key = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(storageKey, key);
    }
    return key;
  }

  function phoneRequesterAuthorization() {
    if (!publicPhone()) return guestAuthorization();
    try { return 'phone-web ' + browserKey('gabileen_public_phone_key'); }
    catch { throw new Error('guest_storage'); }
  }

  function guestAuthorization() {
    try {
      const key = browserKey('gabileen_guest_checkout_key');
      const code = sessionStorage.getItem('gabileen_guest_test_code') ||
        prompt(L('Введите код доступа к тестовой оплате', 'Enter the test checkout access code'))?.trim();
      if (!/^[0-9a-f]{32,64}$/.test(code || '')) throw new Error('guest_test_code');
      sessionStorage.setItem('gabileen_guest_test_code', code);
      return 'guest ' + key + '.' + code;
    } catch (error) {
      if (error.message === 'guest_test_code') throw error;
      throw new Error('guest_storage');
    }
  }

  async function request(method, body, orderId, path = '/checkout/orders', authorization = orderAuthorization()) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;
    let result;
    try {
      try {
        response = await fetch(CHECKOUT_API + path + (orderId ? '?order=' + encodeURIComponent(orderId) : ''), {
          method, credentials: 'omit',
          headers: { Authorization: authorization, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch {
        throw new Error(controller.signal.aborted ? 'checkout_timeout' : 'checkout_network');
      }
      try {
        result = await response.json();
      } catch {
        throw new Error('checkout_http_' + response.status);
      }
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      if (result?.error === 'guest_test_code') sessionStorage.removeItem('gabileen_guest_test_code');
      const error = new Error(result?.error || 'checkout_http_' + response.status);
      error.retryAfter = result?.retry_after;
      throw error;
    }
    return result;
  }

  function showError(error) {
    if (error.message === 'checkout_timeout') return L('Сервер оплаты не ответил за 15 секунд.', 'The payment server did not respond within 15 seconds.');
    if (error.message === 'checkout_network') return L('Браузер не смог подключиться к pay.gabileen.ru.', 'The browser could not connect to pay.gabileen.ru.');
    if (/^checkout_http_\d{3}$/.test(error.message)) return L('Сервер оплаты вернул HTTP ', 'Payment server returned HTTP ') + error.message.slice(-3) + '.';
    if (error.message === 'payment_provider') return L('ЮKassa не подтвердила запрос. Попробуйте обновить статус.', 'YooKassa did not confirm the request. Try refreshing the status.');
    if (error.message === 'checkout_response') return L('Получен неожиданный ответ сервера заказов.', 'Unexpected response from the order server.');
    if (error.message === 'phone_number') return L('Введите номер с кодом страны, например +79991234567.', 'Enter a phone number with its country code.');
    if (error.message === 'phone_code') return L('Код не подошёл. Проверьте код из Telegram.', 'Check the code from Telegram.');
    if (error.message === 'phone_expired') return L('Код истёк. Запросите новый.', 'The code expired. Request a new one.');
    if (error.message === 'phone_limit') {
      if (!Number.isFinite(error.retryAfter) || error.retryAfter <= 0) {
        return L('Слишком много запросов. Попробуйте позже.', 'Too many requests. Try again later.');
      }
      const minutes = Math.ceil(error.retryAfter / 60);
      const delay = error.retryAfter < 60 ? error.retryAfter + L(' сек.', ' sec.') : minutes + L(' мин.', ' min.');
      return L('Новый код можно запросить через ', 'You can request a new code in ') + delay;
    }
    if (error.message === 'phone_gateway') return L('Telegram не подтвердил запрос. Проверьте номер и попробуйте позже.', 'Telegram could not process the request. Check your number and try again later.');
    if (error.message === 'phone_disabled') return L('Вход по телефону пока недоступен.', 'Phone sign-in is temporarily unavailable.');
    if (error.message === 'phone_session') return L('Войдите по телефону ещё раз.', 'Sign in with your phone again.');
    if (error.message === 'guest_test_code') return L('Введите действующий код тестовой оплаты и повторите попытку.', 'Enter a valid checkout test code and try again.');
    if (error.message === 'guest_disabled') return L('Тестовая оплата на сайте ещё не включена на сервере.', 'Website test checkout has not been enabled on the server.');
    if (error.message === 'guest_storage') return L('Разрешите сохранение данных сайта и повторите попытку.', 'Allow site storage and try again.');
    if (error.message === 'telegram_session') return L('Откройте магазин в Telegram заново.', 'Reopen the shop in Telegram.');
    if (error.message === 'cart') return L('Проверьте размеры и количество в корзине. Максимум 5 единиц на позицию.', 'Check sizes and quantities. Up to 5 units per item.');
    if (error.message === 'receipt_configuration') return L('Для теста нужно настроить ставку НДС на сервере.', 'Set the VAT code on the server before testing.');
    if (error.message === 'test_payment_required') return L('Для проверки нужен тестовый магазин ЮKassa.', 'Use a YooKassa test shop.');
    if (error.message === 'receipt_email') return L('Укажите email для чека.', 'Enter an email for the receipt.');
    if (error.message === 'receipt_retry') return L('Для повтора укажите тот же email, что и в первой попытке.', 'Use the same email as on your first attempt.');
    if (error.message === 'payment_review') return L('Статус платежа нужно уточнить у менеджера.', 'Ask the manager to check your payment status.');
    return L('Не удалось связаться с сервисом оплаты. Попробуйте ещё раз.', 'Could not reach the payment service. Please try again.');
  }

  function statusInfo(status) {
    switch (status) {
      case 'succeeded': return ['paid', L('Оплачено', 'Paid'), L('ЮKassa подтвердила оплату. Заказ на самовывоз.', 'YooKassa confirmed the payment. This order is for pickup.')];
      case 'canceled': return ['closed', L('Отменён', 'Cancelled'), L('Платёж отменён.', 'The payment was cancelled.')];
      case 'creating': return ['closed', L('Не оформлен', 'Incomplete'), L('Платёж для этой попытки не подтверждён.', 'No payment has been confirmed for this attempt.')];
      case 'waiting_for_capture': return ['pending', L('Оплата проверяется', 'Verifying payment'), L('Ждём подтверждения ЮKassa.', 'Waiting for confirmation from YooKassa.')];
      default: return ['pending', L('Ожидает оплаты', 'Awaiting payment'), L('Если вы уже оплатили, подождите подтверждения ЮKassa или обновите статус.', 'If you have paid, wait for confirmation or refresh the status.')];
    }
  }

  function orderCard(order, current) {
    const [style, label, note] = statusInfo(order.status);
    const lines = order.items.map(item => {
      const variant = prodById(item.id);
      const color = variant && colorList(variant.colors)[0];
      const details = [item.id, color && PALETTE[color]?.[LANG], L('Размер ', 'Size ') + item.size, item.qty + L(' шт.', ' pcs')].filter(Boolean);
      return '<li><strong>' + esc(item.name) + '</strong><span>' + esc(details.join(' · ')) + '</span></li>';
    }).join('');
    const date = new Date(order.createdAt);
    const dateText = Number.isFinite(date.getTime()) ? date.toLocaleString('ru-RU', {dateStyle:'medium', timeStyle:'short', timeZone:'Europe/Moscow'}) : '';
    return '<article class="checkout-order' + (current ? ' checkout-order-current' : '') + '">' +
      '<div class="checkout-order-top"><h3>' + L('Заказ № ', 'Order #') + esc(order.id.slice(0, 8).toUpperCase()) +
      '</h3><span class="checkout-badge checkout-' + style + '">' + esc(label) + '</span></div>' +
      (dateText ? '<p class="checkout-muted">' + esc(dateText) + ' МСК</p>' : '') +
      '<p>' + esc(note) + '</p><ul class="checkout-lines">' + lines + '</ul>' +
      '<p class="checkout-order-top"><span>' + L('Сумма заказа', 'Order total') + '</span><strong>' + esc(fmtPrice(order.amount)) + '</strong></p>' +
      (order.status !== 'creating' && order.status !== 'canceled' ?
        '<p class="checkout-muted">' + L('Самовывоз: ', 'Pickup: ') + esc(order.pickupAddress) + '</p>' : '') +
      (order.paymentUrl ? '<button type="button" class="addcart-btn checkout-payment" data-payment-url="' + esc(order.paymentUrl) + '" data-order-id="' + esc(order.id) + '">' +
        L('Перейти к оплате в ЮKassa', 'Continue to YooKassa') + '</button>' : '') + '</article>';
  }

  async function refreshOrders() {
    const generation = ++ordersRequest;
    clearTimeout(refreshTimer);
    const history = $('checkoutHistory');
    const status = $('checkoutOrderFeedback');
    $('checkoutRefresh').disabled = true;
    status.textContent = L('Проверяем статус…', 'Checking status…');
    try {
      const orders = await request('GET', undefined, selectedOrder);
      if (generation !== ordersRequest) return;
      if (!Array.isArray(orders)) throw new Error('checkout_response');
      const visible = orders.filter(order => order.status !== 'creating');
      const current = visible.find(order => order.id === selectedOrder) || visible[0];
      const earlier = visible.filter(order => order !== current);
      const incomplete = orders.filter(order => order.status === 'creating');
      history.innerHTML = (current ? orderCard(current, true) : '<p>' + L('Оформленных заказов пока нет.', 'No completed checkouts yet.') + '</p>') +
        (earlier.length ? '<h3 class="checkout-earlier">' + L('Предыдущие заказы', 'Previous orders') + '</h3>' + earlier.map(order => orderCard(order, false)).join('') : '') +
        (incomplete.length ? '<details class="checkout-earlier"><summary>' + L('Незавершённые попытки', 'Incomplete attempts') + ' (' + incomplete.length + ')</summary>' +
          incomplete.map(order => orderCard(order, false)).join('') + '</details>' : '');
      history.querySelectorAll('[data-payment-url]').forEach(button => button.onclick = () => {
        selectedOrder = button.dataset.orderId;
        rememberOrder(selectedOrder);
        if (browserTest()) location.assign(button.dataset.paymentUrl);
        else tg.openLink(button.dataset.paymentUrl);
      });
      status.textContent = '';
      if (current && ['pending', 'waiting_for_capture'].includes(current.status) && !document.hidden) {
        refreshTimer = setTimeout(refreshOrders, 10000);
      }
    } catch (error) {
      if (generation === ordersRequest) {
        if (phoneAccount() && error.message === 'phone_session') {
          localStorage.removeItem(phoneSessionKey());
          showPhoneLogin(selectedOrder);
          return;
        }
        status.textContent = showError(error) + (selectedOrder ?
          L(' Заказ № ', ' Order #') + selectedOrder.slice(0, 8).toUpperCase() +
          L('. Если вы уже оплатили, не повторяйте платёж.', '. If you have already paid, do not pay again.') : '');
      }
    } finally {
      if (generation === ordersRequest) $('checkoutRefresh').disabled = false;
    }
  }

  function russianPhoneDigits(value) {
    if (value.trim().startsWith('+') && !value.trim().startsWith('+7')) return '';
    const digits = value.replace(/\D/g, '');
    if (digits.length === 11 && /^[78]/.test(digits)) return digits.slice(1);
    return digits;
  }

  function formatRussianPhone(digits) {
    if (!digits) return '';
    const area = '(' + digits.slice(0, 3);
    if (digits.length < 4) return area;
    const groups = [digits.slice(3, 6), digits.slice(6, 8), digits.slice(8, 10)].filter(Boolean);
    return area + ') ' + groups.join('-');
  }

  function formatPhoneInput(input) {
    const original = input.value;
    const digits = russianPhoneDigits(original);
    if (digits.length > 10 || (original.trim().startsWith('+') && !digits)) return;
    const raw = original.replace(/\D/g, '');
    const caret = input.selectionStart ?? original.length;
    const before = original.slice(0, caret).replace(/\D/g, '').length;
    const includedPrefix = raw.length === 11 && /^[78]/.test(raw);
    const digitTarget = Math.min(digits.length, Math.max(0, before - Number(includedPrefix)));
    const formatted = formatRussianPhone(digits);
    if (formatted === original) return;
    input.value = formatted;
    if (caret === original.length) return;
    let index = 0;
    let seen = 0;
    while (index < formatted.length && seen < digitTarget) {
      if (/\d/.test(formatted[index++])) seen++;
    }
    input.setSelectionRange(index, index);
  }

  function showPhoneLogin(orderId) {
    ordersRequest++;
    clearTimeout(refreshTimer);
    ordersBox.classList.add('show');
    ordersBox.innerHTML = '<div class="ct-sheet checkout-sheet"><button class="ct-close" id="phoneLoginClose" type="button" aria-label="' +
      L('Закрыть', 'Close') + '">&#10005;</button><h2 class="ct-title">' + L('Вход по телефону', 'Sign in with your phone') +
      '</h2><form id="phoneLoginForm"><label for="phoneInput">' + L('Номер телефона', 'Phone number') +
      '</label><div id="phoneLoginField" class="checkout-phone-field"><span id="phoneCountryCode" aria-hidden="true">+7</span>' +
      '<input class="cart-field" id="phoneInput" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="(999) 123-45-67" aria-describedby="phoneLoginHint" required></div>' +
      '<p id="phoneLoginHint">' + L('Отправим одноразовый код в Telegram на этот номер.', 'We will send a one-time code to Telegram for this number.') +
      '</p><button class="addcart-btn" id="phoneLoginSubmit">' + L('Получить код', 'Get code') +
      '</button> <button class="cart-clear" id="phoneLoginReset" type="button" hidden>' + L('Изменить номер', 'Change number') +
      '</button><p id="phoneLoginFeedback" class="checkout-muted" aria-live="polite"></p></form></div>';
    const close = () => { ordersBox.replaceChildren(); ordersBox.classList.remove('show'); };
    $('phoneLoginClose').onclick = close;
    ordersBox.onclick = event => { if (event.target === ordersBox) close(); };
    const form = $('phoneLoginForm');
    const input = $('phoneInput');
    const button = $('phoneLoginSubmit');
    const feedback = $('phoneLoginFeedback');
    let challenge;
    input.oninput = () => { if (!challenge) formatPhoneInput(input); };
    input.onbeforeinput = event => {
      if (challenge || event.inputType !== 'deleteContentBackward' || input.selectionStart !== input.selectionEnd) return;
      const cursor = input.selectionStart;
      const left = input.value.slice(0, cursor);
      const match = /\d[^\d]+$/.exec(left);
      if (match) input.setSelectionRange(match.index, cursor);
    };
    $('phoneLoginReset').onclick = () => showPhoneLogin(orderId);
    form.onsubmit = async event => {
      event.preventDefault();
      if (button.disabled) return;
      button.disabled = true;
      feedback.textContent = '';
      try {
        if (challenge) {
          const result = await request('POST', { challenge, code: input.value.trim() }, null, '/checkout/phone/verify', phoneRequesterAuthorization());
          if (!form.isConnected) return;
          try { localStorage.setItem(phoneSessionKey(), result.token); } catch { throw new Error('guest_storage'); }
          renderEntry();
          openOrders(orderId);
        } else {
          const digits = russianPhoneDigits(input.value);
          if (digits.length !== 10) {
            feedback.textContent = L('Введите 10 цифр номера после +7.', 'Enter 10 digits after +7.');
            input.focus();
            return;
          }
          const phone = '+7' + digits;
          const result = await request('POST', { phone }, null, '/checkout/phone/start', phoneRequesterAuthorization());
          if (!form.isConnected) return;
          challenge = result.challenge;
          $('phoneCountryCode').hidden = true;
          $('phoneLoginField').classList.remove('checkout-phone-field');
          input.type = 'text';
          input.inputMode = 'numeric';
          input.autocomplete = 'one-time-code';
          input.maxLength = 6;
          input.value = '';
          input.placeholder = '123456';
          form.querySelector('label').textContent = L('Код из Telegram', 'Telegram code');
          $('phoneLoginHint').textContent = L('Введите шесть цифр. Код действует две минуты.', 'Enter six digits. The code expires in two minutes.');
          $('phoneLoginReset').hidden = false;
          button.textContent = L('Войти', 'Sign in');
          input.focus();
        }
      } catch (error) {
        if (form.isConnected) feedback.textContent = showError(error);
      } finally {
        button.disabled = false;
      }
    };
  }

  async function openOrders(id = null) {
    selectedOrder = id || rememberedOrder();
    if (phoneAccount() && !phoneSession()) return showPhoneLogin(selectedOrder);
    ordersBox.classList.add('show');
    ordersBox.innerHTML = '<div class="ct-sheet checkout-sheet"><button class="ct-close" id="checkoutOrdersClose" aria-label="' +
      L('Закрыть', 'Close') + '">&#10005;</button><h2 class="ct-title">' + L('Мои заказы', 'My orders') +
      '</h2><div id="checkoutHistory"></div><p id="checkoutOrderFeedback" class="checkout-muted" aria-live="polite"></p>' +
      '<button class="cart-clear" id="checkoutRefresh">' + L('Обновить статус', 'Refresh status') + '</button>' +
      (phoneAccount() ? ' <button class="cart-clear" id="checkoutLogout" type="button">' + L('Выйти', 'Sign out') + '</button>' : '') + '</div>';
    const close = () => { ordersRequest++; clearTimeout(refreshTimer); ordersBox.classList.remove('show'); };
    $('checkoutOrdersClose').onclick = close;
    $('checkoutRefresh').onclick = refreshOrders;
    const logout = $('checkoutLogout');
    if (logout) logout.onclick = async () => {
      logout.disabled = true;
      try {
        await request('POST', {}, null, '/checkout/phone/logout');
        localStorage.removeItem(phoneSessionKey());
        renderEntry();
        showPhoneLogin(null);
      } catch (error) {
        if (logout.isConnected) $('checkoutOrderFeedback').textContent = showError(error);
      } finally {
        logout.disabled = false;
      }
    };
    ordersBox.onclick = event => { if (event.target === ordersBox) close(); };
    await refreshOrders();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(refreshTimer);
    else if (ordersBox.classList.contains('show') && $('checkoutRefresh')) refreshOrders();
  });

  function getCheckoutKey(cart) {
    const snapshot = JSON.stringify(cart);
    try {
      const saved = JSON.parse(localStorage.getItem('gabileen_pending_checkout') || 'null');
      if (saved?.snapshot === snapshot && /^[a-f0-9-]{36}$/i.test(saved.key)) return saved.key;
    } catch {}
    const key = crypto.randomUUID();
    try { localStorage.setItem('gabileen_pending_checkout', JSON.stringify({ snapshot, key })); } catch {}
    return key;
  }

  async function pay() {
    const button = $('checkoutPay');
    if (!button || cartRequest) return;
    if (phoneTest() && !phoneSession()) {
      closeCart();
      showPhoneLogin(null);
      return;
    }
    const receiptEmail = $('checkoutReceiptEmail');
    if (!receiptEmail.reportValidity()) return;
    const cart = CART.map(({ id, size, qty }) => ({ id, size, qty }));
    const checkoutKey = getCheckoutKey(cart);
    const message = $('checkoutStatus');
    button.disabled = true;
    message.textContent = L('Создаём заказ…', 'Creating order…');
    cartRequest = request('POST', { checkoutKey, cart, receiptEmail: receiptEmail.value.trim() });
    try {
      const order = await cartRequest;
      if (order.status === 'canceled') {
        try { localStorage.removeItem('gabileen_pending_checkout'); } catch {}
        message.textContent = L('Платёж отменён. Можно повторить оформление.', 'Payment was cancelled. You can try again.');
        return;
      }
      if (JSON.stringify(CART.map(({ id, size, qty }) => ({ id, size, qty }))) === JSON.stringify(cart)) {
        CART = [];
        saveCart();
        renderCartFab();
      }
      try { localStorage.removeItem('gabileen_pending_checkout'); } catch {}
      closeCart();
      rememberOrder(order.id);
      await openOrders(order.id);
    } catch (error) {
      message.textContent = showError(error);
    } finally {
      cartRequest = null;
      button.disabled = false;
    }
  }

  function checkoutStart() {
    return inTelegram() ? new URLSearchParams(tg.initData).get('start_param') || '' : '';
  }

  function returnedOrder() {
    const browserOrder = browserTest() ? webQuery.get('order') : null;
    if (/^[a-f0-9-]{36}$/i.test(browserOrder || '')) return browserOrder;
    return /^checkout-order-([a-f0-9-]{36})$/i.exec(checkoutStart())?.[1];
  }

  function testCheckoutActive() {
    return browserTest() || checkoutStart() === 'checkout-test' || Boolean(returnedOrder());
  }

  function renderEntry() {
    entry.hidden = !testCheckoutActive() && !publicPhone();
    entry.replaceChildren();
    if (entry.hidden) return;
    entry.innerHTML = '<button type="button" class="checkout-history-button" id="checkoutHistoryButton">' +
      (publicPhone() && !phoneSession() ? L('Войти по телефону', 'Sign in with your phone') : L('Мои заказы', 'My orders')) + '</button>';
    $('checkoutHistoryButton').onclick = () => openOrders();
    const id = returnedOrder();
    if (id && !handledReturn) {
      handledReturn = true;
      rememberOrder(id);
      openOrders(id);
    }
  }

  window.gabileenCheckout = {
    active: testCheckoutActive,
    renderEntry,
    cartHTML() {
      return '<div class="cart-total"><span>' + L('ИТОГО', 'TOTAL') + '</span><b>' + fmtPrice(cartSum()) +
        '</b></div><p>' + L('Получение: самовывоз. Адрес покажем в заказе.', 'Pickup address is shown in the order.') +
        '</p><p>' + L('Тестовый заказ. Реального списания не будет.', 'Test order. No real charge.') +
        '</p><label for="checkoutReceiptEmail">' + L('Email для чека', 'Email for the receipt') + '</label>' +
        '<input id="checkoutReceiptEmail" class="cart-field" type="email" autocomplete="email" required maxlength="254">' +
        '<p class="cart-hint">' + L('Email передаётся ЮKassa для отправки чека.', 'YooKassa uses your email to send the receipt.') +
        ' <a href="offer.html" target="_blank" rel="noopener">' + L('Условия продажи', 'Terms of sale') + '</a></p>' +
        '<button type="button" class="addcart-btn" id="checkoutPay">' + L('Создать заказ', 'Create order') +
        '</button><div id="checkoutStatus" aria-live="polite"></div>';
    },
    bindCart() {
      const button = $('checkoutPay');
      if (button) {
        button.disabled = Boolean(cartRequest);
        button.onclick = pay;
      }
    },
  };

  const originalRender = render;
  render = function () { originalRender(); renderEntry(); };
  renderEntry();
})();
