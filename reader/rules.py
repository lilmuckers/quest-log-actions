"""Turns the lines OCR found in a photo into the sidecar's `read` block: which of the ten kinds it
is, the facts in it, and whether to trust the result. Standard library only, and no network or
tokens: what comes in is untrusted text from a photo. Anything that doesn't add up is flagged for
an agent rather than saved as a confident read."""
import calendar
import datetime
import re

# Below this the words themselves are in doubt, whatever they seem to say.
MIN_OCR_CONFIDENCE = 0.85
ROUNDING = 0.02

KEYWORDS = {
    'receipt': (r'\bsub ?total\b', r'\bvisa\b', r'\bmastercard\b', r'\bcontactless\b', r'\bchange due\b', r'\bcash\b', r'\bthank you for\b', r'\btill\b', r'\breceipt\b', r'\btotal\b', r'\bvat\b'),
    'quote-invoice': (r'\bquotation\b', r'\bquote\b', r'\binvoice\b', r'\bestimate\b', r'\bvalid until\b', r'\bterms\b'),
    'letter-bill': (r'\bdear\b', r'\byours (sincerely|faithfully)\b', r'\bour ref\b', r'\byour ref\b', r'\baccount (number|no)\b', r'\bamount due\b', r'\bpay by\b', r'\bbill\b'),
    'booking': (r'\bbooking\b', r'\breservation\b', r'\bconfirmation\b', r'\btickets?\b', r'\bappointment\b', r'\bdoors\b', r'\bseats?\b', r'\bcheck.?in\b'),
    'product-label': (r'\bmodel\b', r'\bserial\b', r'\bs/n\b', r'\bwarranty\b', r'\brated\b', r'\b\d+ ?kw\b', r'\b\d+ ?v\b', r'\b\d+ ?hz\b'),
    'screenshot': (r'https?://', r'\bwww\.'),
    'page': (r'\bchapter \d+', r'\bpage \d+', r'^by [a-z]'),
    'plan-measure': (r'\bfloor plan\b', r'\b\d+(\.\d+)? ?(mm|cm)\b', r'\bwidth\b', r'\bheight\b'),
}
# What a kind needs before a read of it can be trusted.
REQUIRED = {
    'receipt': ('from', 'date', 'total'),
    'quote-invoice': ('from', 'date', 'total'),
    'letter-bill': ('from', 'date'),
    'booking': ('date',),
    'product-label': ('brand', 'model'),
    'screenshot': ('url',),
    'page': (),
    'plan-measure': ('dimensions',),
    'handwritten': (),
    'scene': ('caption',),
}
HEADINGS = re.compile(r'^(quotation|quote|invoice|estimate|receipt|tax invoice|booking confirmation|confirmation|chapter \d+)$', re.I)
NOT_AN_ITEM = re.compile(r'\b(total|sub ?total|vat|tax|gst|visa|mastercard|amex|debit|credit|cash|change|card|balance|due|contactless|paid|amount)\b', re.I)
MONEY = r'\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2}'
CARD_NUMBER = re.compile(r'(?<!\d)(?:\d[ -]?){13,19}(?!\d)')
MONTHS = {m.lower(): i for i, m in enumerate(calendar.month_name) if m}
MONTHS.update({m.lower(): i for i, m in enumerate(calendar.month_abbr) if m})
MONTH_NAME = '|'.join(sorted(MONTHS, key=len, reverse=True))


def to_rows(boxes, texts, scores):
    """Words OCR found apart, such as a label and its price, joined back into the rows they sit on.
    A box is four [x, y] corners."""
    found = []
    for box, text, score in zip(boxes, texts, scores):
        ys = [p[1] for p in box]
        found.append({'x': min(p[0] for p in box), 'top': min(ys), 'bottom': max(ys), 'text': text, 'score': score})
    found.sort(key=lambda b: (b['top'] + b['bottom']) / 2)
    rows = []
    for b in found:
        mid = (b['top'] + b['bottom']) / 2
        if rows and rows[-1]['top'] <= mid <= rows[-1]['bottom']:
            rows[-1]['parts'].append(b)
        else:
            rows.append({'top': b['top'], 'bottom': b['bottom'], 'parts': [b]})
    return [' '.join(p['text'] for p in sorted(r['parts'], key=lambda p: p['x'])) for r in rows]


def classify(rows):
    """The kind with the most keyword rows, and whether anything pointed to it at all."""
    scores = {}
    for kind, patterns in KEYWORDS.items():
        scores[kind] = sum(1 for p in patterns if any(re.search(p, r, re.I) for r in rows))
    # A quote or a bill also has a total and VAT, so its own words outrank a receipt's.
    if scores['quote-invoice'] >= 1:
        scores['quote-invoice'] += 2
    if scores['letter-bill'] >= 2:
        scores['letter-bill'] += 2
    if scores['booking'] >= 2:
        scores['booking'] += 1
    kind = max(scores, key=lambda k: scores[k])
    if scores[kind]:
        return kind, True
    words = sum(len(r) for r in rows) / max(1, len(rows))
    return ('handwritten' if words < 28 else 'page'), False


def real_date(y, m, d):
    try:
        return datetime.date(y, m, d).isoformat()
    except ValueError:
        return None


def find_date(text):
    """The first date in the text, as YYYY-MM-DD. All-number dates are read day first, unless that's impossible."""
    m = re.search(r'\b(\d{4})-(\d{2})-(\d{2})\b', text)
    if m:
        return real_date(int(m[1]), int(m[2]), int(m[3]))
    m = re.search(rf'\b(\d{{1,2}})(?:st|nd|rd|th)?\s+({MONTH_NAME})\.?,?\s+(\d{{4}})\b', text, re.I)
    if m:
        return real_date(int(m[3]), MONTHS[m[2].lower()], int(m[1]))
    m = re.search(rf'\b({MONTH_NAME})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(\d{{4}})\b', text, re.I)
    if m:
        return real_date(int(m[3]), MONTHS[m[1].lower()], int(m[2]))
    m = re.search(r'(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\d/.-])', text)
    if m:
        year = int(m[3]) + (2000 if len(m[3]) == 2 else 0)
        first, second = int(m[1]), int(m[2])
        return real_date(year, second, first) or real_date(year, first, second)
    return None


def month_end(text):
    """The last day of an MM/YYYY month, for a date like "Warranty expires 01/2031"."""
    m = re.search(r'(?<![\d/])(\d{1,2})/(\d{4})(?![\d/])', text)
    if not m or not 1 <= int(m[1]) <= 12:
        return None
    return real_date(int(m[2]), int(m[1]), calendar.monthrange(int(m[2]), int(m[1]))[1])


def amounts(text):
    return [a.replace(',', '') for a in re.findall(MONEY, text)]


def labelled_amount(rows, pattern, skip=None):
    """The last amount on the first row matching `pattern`, or on the row after it if it has none."""
    for i, r in enumerate(rows):
        if re.search(pattern, r, re.I) and not (skip and re.search(skip, r, re.I)):
            found = amounts(r) or (amounts(rows[i + 1]) if i + 1 < len(rows) else [])
            if found:
                return found[-1]
    return None


def total_of(rows):
    for pattern in (r'\bgrand total\b', r'\btotal (due|to pay|payable)\b', r'\b(amount|balance) due\b', r'\btotal\b'):
        found = labelled_amount(rows, pattern, r'\bsub ?total\b')
        if found:
            return found
    return None


def line_items(rows):
    items = []
    for r in rows:
        found = amounts(r)
        if not found or NOT_AN_ITEM.search(r):
            continue
        name = re.sub(rf'[£€$]?\s*(?:{MONEY})\s*$', '', r).strip(' .:-')
        qty = re.match(r'^(\d+)\s*[x×]\s*(.+)$', name, re.I)
        if qty:
            items.append({'name': clip(qty[2], 120), 'qty': int(qty[1]), 'price': found[-1]})
        elif name:
            items.append({'name': clip(name, 120), 'price': found[-1]})
    return items[:100]


def clip(text, n):
    return text.strip()[:n].strip()


def first_row(rows):
    for r in rows:
        if not HEADINGS.match(r.strip()) and re.search(r'[A-Za-z]{2}', r) and not find_date(r):
            return r
    return None


def reference(rows):
    for r in rows:
        m = re.search(r'\b(?:(?:our|your|booking|order|account|quote|invoice)\s+)?(?:ref(?:erence)?|no|number)\b\s*[:.#]?\s*([A-Z0-9][A-Z0-9/-]{2,})', r, re.I)
        if m and re.search(r'\d', m[1]) and not re.search(r'\bvat\b|\bserial\b', r, re.I):
            return clip(m[1], 80)
    return None


def due_on(rows):
    for r in rows:
        if re.search(r'\b(valid until|pay by|due (date|by|on)|payment due|expires?|expiry|act by|by)\b', r, re.I):
            found = find_date(r) or month_end(r)
            if found:
                return found
    return None


def dated(rows):
    """The first date in the rows that isn't the due date's own row."""
    for r in rows:
        if re.search(r'\b(valid until|pay by|due|expires?|expiry)\b', r, re.I):
            continue
        found = find_date(r)
        if found:
            return found
    return None


def after(pattern, rows, n):
    for r in rows:
        m = re.search(pattern, r, re.I)
        if m:
            return clip(m[1], n)
    return None


def money_fields(rows):
    joined = ' '.join(rows)
    currency = 'GBP' if re.search(r'£|\bGBP\b', joined) else 'EUR' if re.search(r'€|\bEUR\b', joined) else 'USD' if re.search(r'\$|\bUSD\b', joined) else None
    tax = labelled_amount(rows, r'\b(vat|tax|gst)\b', r'\b(vat|tax|gst)\s*(no|number|reg)\b')
    return {'total': total_of(rows), 'tax': tax, 'currency': currency, 'items': line_items(rows) or None}


def extract(kind, rows):
    """Facts for a kind, with what's missing left out."""
    due = due_on(rows)
    f = {}
    if kind in ('receipt', 'quote-invoice', 'letter-bill'):
        f.update(money_fields(rows))
        f.update({'from': first_row(rows) and clip(first_row(rows), 120), 'date': dated(rows), 'reference': reference(rows)})
        if kind != 'receipt':
            f['dueOn'] = due
        if kind == 'letter-bill':
            f.pop('items')
            f.pop('tax')
    if kind == 'receipt':
        m = re.search(r'\b(visa|mastercard|amex|american express|maestro|cash|apple pay|google pay)\b', ' '.join(rows), re.I)
        f['paymentMethod'] = m and m[1].title()
    if kind == 'booking':
        rest = [r for r in rows if not HEADINGS.match(r.strip()) and not re.search(r'\bbooking\b', r, re.I)]
        times = re.search(r'\b([01]?\d|2[0-3]):([0-5]\d)\b', ' '.join(rows))
        f.update({'date': dated(rows), 'time': times and f'{int(times[1]):02d}:{times[2]}', 'where': first_row(rest) and clip(first_row(rest), 120), 'reference': reference(rows)})
    if kind == 'product-label':
        spec = next((r for r in rows if re.search(r'\b\d+ ?(kw|w|v|hz|ml|l|kg)\b', r, re.I)), None)
        f.update({
            'brand': first_row(rows) and clip(first_row(rows), 80),
            'model': after(r'\bmodel(?: no| number)?\b\s*[:.]?\s*(.+)', rows, 80),
            'serial': after(r'\b(?:serial(?: no| number)?|s/n)\b\s*[:.]?\s*(.+)', rows, 80),
            'spec': spec and clip(spec, 200),
            'dueOn': due,
        })
    if kind == 'screenshot':
        url = re.search(r'https?://[^\s|]+', ' '.join(rows))
        f['url'] = url and url[0][:2048]
        host = re.match(r'https?://(?:www\.)?([^/]+)', url[0]) if url else None
        f['source'] = host and clip(host[1], 200)
    if kind == 'page':
        f['from'] = after(r'^by\s+(.+)$', rows, 120)
    if kind == 'plan-measure':
        dims = []
        for r in rows:
            for m in re.finditer(r'(?:([A-Za-z][A-Za-z ]*?)\s+)?(\d+(?:\.\d+)?)\s?(mm|cm|m|ft|in)\b', r):
                dims.append({**({'label': clip(m[1], 80)} if m[1] else {}), 'value': float(m[2]) if '.' in m[2] else int(m[2]), 'unit': m[3]})
        f['dimensions'] = dims[:50] or None
    return {k: v for k, v in f.items() if v}


def adds_up(fields):
    """Whether the items, tax and total agree. A misread digit usually shows up here."""
    if not fields.get('items') or not fields.get('total'):
        return True
    prices = [i['price'] for i in fields['items'] if 'price' in i]
    total, tax = float(fields['total']), float(fields.get('tax', 0))
    items = sum(float(p) for p in prices)
    return any(abs(items - want) <= ROUNDING for want in (total, total - tax))


def naming(kind, fields, rows):
    """A title and one-line summary, written from the facts alone."""
    who, money = fields.get('from'), fields.get('total')
    cost = money and f'{money} {fields["currency"]}' if money and fields.get('currency') else money
    if kind == 'receipt':
        return who and f'{who} receipt', ', '.join(filter(None, [who, cost]))
    if kind == 'quote-invoice':
        word = 'invoice' if re.search(r'\binvoice\b', ' '.join(rows), re.I) else 'quote'
        return who and f'{who} {word}', ', '.join(filter(None, [who, word, cost]))
    if kind == 'letter-bill':
        return who and f'Letter from {who}', ', '.join(filter(None, [who, cost]))
    if kind == 'booking':
        return fields.get('where') and f'{fields["where"]} booking', ', '.join(filter(None, [fields.get('where'), fields.get('date'), fields.get('time')]))
    if kind == 'product-label':
        name = ' '.join(filter(None, [fields.get('brand'), fields.get('model')]))
        return name or None, name
    if kind == 'screenshot':
        return fields.get('source') and f'Screenshot of {fields["source"]}', fields.get('source') or ''
    if kind == 'scene':
        caption = fields.get('caption', '').rstrip('.')
        return caption[:80] or None, caption
    first = first_row(rows)
    return first and clip(first, 80), first and clip(first, 280)


def read_rows(rows, confidence):
    """What was read from a photo's rows, and whether it needs an agent: { flag, why, read }."""
    kind, sure = classify(rows)
    fields = extract(kind, rows)
    missing = [k for k in REQUIRED[kind] if k not in fields]
    why = None
    if confidence < MIN_OCR_CONFIDENCE:
        why = f'the words are unclear ({confidence:.2f})'
    elif not sure:
        why = 'it could be several kinds of thing'
    elif missing:
        why = f'{kind} without {", ".join(missing)}'
    elif not adds_up(fields):
        why = 'the amounts do not add up'
    title, summary = naming(kind, fields, rows)
    text = CARD_NUMBER.sub('[number removed]', '\n'.join(rows)).strip()
    read = {'kind': kind, 'confidence': 'low' if why else 'high', 'text': text[:20000]}
    if summary:
        read['summary'] = clip(summary, 280)
    if fields:
        read['fields'] = fields
    if title:
        read['title'] = clip(title, 80)
    if fields.get('date') and kind in ('receipt', 'quote-invoice', 'letter-bill'):
        read['takenOn'] = fields['date']
    read['tags'] = [kind]
    return {'flag': bool(why), 'why': why, 'read': read}


def read_caption(caption):
    """A photo with no words in it, from its caption. Reasonable, but only a description."""
    caption = clip(caption, 280)
    if not caption:
        return {'flag': True, 'why': 'nothing to read and no caption', 'read': {'kind': 'scene', 'confidence': 'low'}}
    fields = {'caption': caption}
    title, summary = naming('scene', fields, [])
    return {'flag': False, 'why': None, 'read': {'kind': 'scene', 'confidence': 'medium', 'summary': summary, 'fields': fields, 'title': clip(title, 80), 'tags': ['scene']}}
