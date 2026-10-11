const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const file = process.argv[2];
const html = fs.readFileSync(file, 'utf8');
const P = '<img src=x onerror="window.__pwned=(window.__pwned||[]).concat(1)">';
const hostile = {
  '/dashboard/summary': { orders: { total: P, today: P }, revenue: { total: 1 }, inventory: { low_stock: P }, shipping: { active_shipments: P } },
  '/api/orders/': [{ id: 1, customer_id: P, status: 'pending', items: [{ product_id: P, quantity: P }], total: 5, created_at: '2026-10-01T10:00:00Z' },
                   { id: 2, customer_id: '<script>window.__pwned=(window.__pwned||[]).concat(2)</script>', status: '"><img src=x onerror=window.__pwned=3>', items: [], total: 1, created_at: null }],
  '/api/inventory/products': [{ id: P, name: P, sku: P, price: 1, stock: P, reserved: 0, available: 5 }],
  '/dashboard/revenue': { total: 1, refunded: 0, net: 1 },
  '/api/payments/ledger': [{ payment_id: P, entry_type: P, debit: 1, credit: 0, description: P, created_at: null }],
  '/api/shipping/shipments': [{ id: P, order_id: P, carrier: P, tracking_number: P, status: P, recipient_name: P }],
  '/dashboard/shipping/overview': { by_status: { [P]: P }, by_carrier: { [P]: P }, avg_delivery_hours: 2 },
  '/api/notifications/history': [{ id: P, recipient: P, channel: P, template: P, status: P, created_at: null }],
};
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] }).catch(() => chromium.launch({ args: ['--no-sandbox'] }));
  const page = await browser.newPage();
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (u.pathname === '/auth/login') return route.fulfill({ contentType: 'application/json', body: '{"token":"t"}' });
    if (hostile[u.pathname]) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(hostile[u.pathname]) });
    return route.fulfill({ contentType: 'application/json', body: '{"status":"ok"}' });
  });
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://localhost:9999/');
  await page.waitForTimeout(1500);
  const pwned = await page.evaluate(() => window.__pwned || []);
  const imgs = await page.evaluate(() => document.querySelectorAll('img[src="x"]').length);
  const text = await page.evaluate(() => document.getElementById('orders-table').innerText);
  console.log(JSON.stringify({ pwned, injectedImgTags: imgs, pageErrors: errs.length, ordersTableText: text.slice(0, 120) }));
  await browser.close();
})();
