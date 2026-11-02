#!/usr/bin/env python3
"""Собирает отдельную страницу для каждой модели (p/<артикул>.html) и sitemap.xml.

Зачем: у каждой модели своя ссылка с превью (фото, название, цена) для мессенджеров
и поисковиков. Сама страница сразу открывает карточку в основном каталоге.
Запускается автоматически при публикации сайта (.github/workflows/pages.yml).
Вручную: python3 tools/build_pages.py
"""
import html, json, os, re, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.environ.get('SITE_URL', 'https://vanvion.github.io/GABILEEN').rstrip('/')

products = json.load(open(os.path.join(ROOT, 'data/products.json'), encoding='utf-8'))
index_html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
colors_ru = dict(re.findall(r"^\s*(\w+): \{ hex: '#[0-9a-fA-F]{6}', ru: '([^']+)'", index_html, re.M))

def price_text(n):
    return '{:,}'.format(int(n)).replace(',', ' ') + ' ₽'

def cap(s):
    return s[:1].upper() + s[1:].lower() if s else s

os.makedirs(os.path.join(ROOT, 'p'), exist_ok=True)
urls = [SITE + '/']
for p in products:
    pid = p['id']
    model = (p.get('model') or '').strip()
    color = colors_ru.get((p.get('colors') or '').split(',')[0].strip(), '')
    price = int(re.sub(r'\D', '', str(p.get('price') or 0)) or 0)
    title = 'Пиджак ' + model + (' — ' + cap(color) if color else '') + ' | GABILEEN'
    parts = []
    if color: parts.append('Цвет: ' + color.lower())
    if p.get('comp_ru'): parts.append('состав: ' + p['comp_ru'].lower())
    if p.get('sizes'): parts.append('размеры ' + p['sizes'])
    desc = (price_text(price) + '. ' if price else '') + ', '.join(parts) + '. Примерка с выездом — бесплатно при покупке. Доставка по Москве и России.'
    img = SITE + '/' + p['image'] if p.get('image') else SITE + '/og-image.jpg'
    page = SITE + '/p/' + pid + '.html'
    ld = {
        '@context': 'https://schema.org', '@type': 'Product',
        'name': 'Пиджак ' + model + (' ' + cap(color) if color else ''),
        'sku': pid, 'brand': {'@type': 'Brand', 'name': 'GABILEEN'},
        'image': [img] + ([SITE + '/' + p['image2']] if p.get('image2') else []),
        'description': desc,
        'offers': {'@type': 'Offer', 'priceCurrency': 'RUB', 'price': price, 'availability': 'https://schema.org/InStock', 'url': page}
    }
    e = html.escape
    out = f'''<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}">
<link rel="canonical" href="{e(page)}">
<meta property="og:type" content="product">
<meta property="og:site_name" content="GABILEEN">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(desc)}">
<meta property="og:url" content="{e(page)}">
<meta property="og:image" content="{e(img)}">
<meta property="og:locale" content="ru_RU">
<meta property="product:price:amount" content="{price}">
<meta property="product:price:currency" content="RUB">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{e(title)}">
<meta name="twitter:description" content="{e(desc)}">
<meta name="twitter:image" content="{e(img)}">
<link rel="icon" type="image/png" href="../favicon.png?v=1">
<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>
<script>location.replace('../#p=' + {json.dumps(pid)});</script>
<style>body{{font-family:'Futura PT Book',Futura,'Century Gothic',sans-serif;background:#f5f5f3;color:#1a1814;margin:0;padding:24px;text-align:center}}img{{max-width:420px;width:100%;height:auto}}a{{color:#1a1814}}</style>
</head>
<body>
<p style="letter-spacing:.22em;font-size:22px">GABILEEN</p>
<h1 style="font-weight:400;font-size:20px">{e(title.replace(' | GABILEEN', ''))}</h1>
<img src="../{e(p.get('image') or 'og-image.jpg')}" alt="{e(title)}">
<p>{e(desc)}</p>
<p><a href="../#p={e(pid)}">Открыть в магазине GABILEEN</a></p>
</body>
</html>
'''
    open(os.path.join(ROOT, 'p', pid + '.html'), 'w', encoding='utf-8').write(out)
    urls.append(page)

today = datetime.date.today().isoformat()
sm = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
for u in urls:
    sm.append('  <url><loc>' + html.escape(u) + '</loc><lastmod>' + today + '</lastmod></url>')
sm.append('</urlset>')
open(os.path.join(ROOT, 'sitemap.xml'), 'w', encoding='utf-8').write('\n'.join(sm) + '\n')
open(os.path.join(ROOT, 'robots.txt'), 'w').write('User-agent: *\nAllow: /\n\nSitemap: ' + SITE + '/sitemap.xml\n')
print('pages:', len(products), 'site:', SITE)
