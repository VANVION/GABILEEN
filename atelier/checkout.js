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

  async function request(method, body, orderId) {
    const response = await fetch(CHECKOUT_API + '/checkout/orders' + (orderId ? '?order=' + encodeURIComponent(orderId) : ''), {
      method,
      headers: {
        Authorization: 'tma ' + tg.initData,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'checkout_unavailable');
    return response.json();
  }

  function showError(error) {
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
        tg.openLink(button.dataset.paymentUrl);
      });
      status.textContent = '';
      if (current && ['pending', 'waiting_for_capture'].includes(current.status) && !document.hidden) {
        refreshTimer = setTimeout(refreshOrders, 10000);
      }
    } catch (error) {
      if (generation === ordersRequest) status.textContent = showError(error);
    } finally {
      if (generation === ordersRequest) $('checkoutRefresh').disabled = false;
    }
  }

  async function openOrders(id = null) {
    selectedOrder = id || rememberedOrder();
    ordersBox.classList.add('show');
    ordersBox.innerHTML = '<div class="ct-sheet checkout-sheet"><button class="ct-close" id="checkoutOrdersClose" aria-label="' +
      L('Закрыть', 'Close') + '">&#10005;</button><h2 class="ct-title">' + L('Мои заказы', 'My orders') +
      '</h2><div id="checkoutHistory"></div><p id="checkoutOrderFeedback" class="checkout-muted" aria-live="polite"></p>' +
      '<button class="cart-clear" id="checkoutRefresh">' + L('Обновить статус', 'Refresh status') + '</button></div>';
    const close = () => { ordersRequest++; clearTimeout(refreshTimer); ordersBox.classList.remove('show'); };
    $('checkoutOrdersClose').onclick = close;
    $('checkoutRefresh').onclick = refreshOrders;
    ordersBox.onclick = event => { if (event.target === ordersBox) close(); };
    await refreshOrders();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(refreshTimer);
    else if (ordersBox.classList.contains('show')) refreshOrders();
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
    return /^checkout-order-([a-f0-9-]{36})$/i.exec(checkoutStart())?.[1];
  }

  function testCheckoutActive() {
    return checkoutStart() === 'checkout-test' || Boolean(returnedOrder());
  }

  function renderEntry() {
    entry.hidden = !testCheckoutActive();
    entry.replaceChildren();
    if (entry.hidden) return;
    entry.innerHTML = '<button type="button" class="cart-clear" id="checkoutHistoryButton">' +
      L('Мои заказы', 'My orders') + '</button>';
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
