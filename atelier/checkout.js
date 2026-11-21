(() => {
  if (!CHECKOUT_API || !tgAppLink('')) return;
  const entry = $('checkoutEntry');
  const ordersBox = $('checkoutOrders');
  let cartRequest = null;
  let ordersRequest = 0;

  async function request(method, body) {
    const response = await fetch(CHECKOUT_API + '/checkout/orders', {
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

  function statusLabel(status) {
    switch (status) {
      case 'succeeded': return L('Оплачено', 'Paid');
      case 'canceled': return L('Отменён', 'Canceled');
      case 'creating': return L('Создаётся', 'Being created');
      default: return L('Ожидает оплаты', 'Awaiting payment');
    }
  }

  function paymentLink(url) {
    return url ? '<p><a class="addcart-btn" href="' + esc(url) + '" target="_blank" rel="noopener">' +
      L('Перейти к оплате', 'Continue to payment') + '</a></p>' : '';
  }

  async function openOrders() {
    const generation = ++ordersRequest;
    ordersBox.classList.add('show');
    ordersBox.innerHTML = '<div class="ct-sheet"><button class="ct-close" id="checkoutOrdersClose" aria-label="' +
      L('Закрыть', 'Close') + '">&#10005;</button><div class="ct-title">' + L('МОИ ЗАКАЗЫ', 'MY ORDERS') +
      '</div><div id="checkoutHistory" aria-live="polite">' + L('Загружаем заказы…', 'Loading orders…') + '</div>' +
      '<button class="cart-clear" id="checkoutRefresh">' + L('Обновить статус', 'Refresh status') + '</button></div>';
    const close = () => { ordersRequest++; ordersBox.classList.remove('show'); };
    $('checkoutOrdersClose').onclick = close;
    $('checkoutRefresh').onclick = openOrders;
    ordersBox.onclick = event => { if (event.target === ordersBox) close(); };

    try {
      const orders = await request('GET');
      if (generation !== ordersRequest) return;
      $('checkoutHistory').innerHTML = orders.map(order =>
        '<article class="checkout-order"><b>' + esc(statusLabel(order.status)) + ' · ' +
        esc(fmtPrice(order.amount)) + '</b><p class="cart-hint">№ ' + esc(order.id) + '</p><ul>' +
        order.items.map(item => '<li>' + esc(item.name) + ' · ' + esc(item.size) + ' × ' + esc(item.qty) + '</li>').join('') +
        '</ul><p>' + L('Самовывоз: ', 'Pickup: ') + esc(order.pickupAddress) + '</p>' + paymentLink(order.paymentUrl) +
        '</article>').join('') || L('У вас пока нет заказов.', 'You have no orders yet.');
    } catch (error) {
      if (generation === ordersRequest) $('checkoutHistory').textContent = showError(error);
    }
  }

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
      if (order.paymentUrl) {
        try { tg.openLink(order.paymentUrl); } catch { /* The payment is also available under My Orders. */ }
      }
      await openOrders();
    } catch (error) {
      message.textContent = showError(error);
    } finally {
      cartRequest = null;
      button.disabled = false;
    }
  }

  function testCheckoutActive() {
    return inTelegram() && new URLSearchParams(tg.initData).get('start_param') === 'checkout-test';
  }

  function renderEntry() {
    entry.hidden = !testCheckoutActive();
    entry.replaceChildren();
    if (entry.hidden) return;
    entry.innerHTML = '<button type="button" class="cart-clear" id="checkoutHistoryButton">' +
      L('Мои заказы', 'My orders') + '</button>';
    $('checkoutHistoryButton').onclick = openOrders;
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
        '<button type="button" class="addcart-btn" id="checkoutPay">' + L('Оформить и оплатить', 'Place order and pay') +
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
