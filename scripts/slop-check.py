#!/usr/bin/env python3
"""
Slop linter for Heath's job-application writing. Scans the PROSE in a file
(HTML cover letter, CV, markdown answer, or plain text) for anti-slop
violations and paragraph-opener problems. Exit code 1 if any violation is
found, so it can gate rendering/output. Usage: slop-check.py <file> [<file>...]

What it flags (mechanical, high-confidence):
  - em dash (—) anywhere in prose
  - en dash (–) in prose that is not a numeric range (1997–1999 is fine)
  - "rather than", "instead of", "X, not Y" and similar X-not-Y disguises
  - intensifiers / slop words (robust, seamless, leverage, delve, wildly, ...)
  - a paragraph that opens with a bare past-tense verb and no subject
    ("Held the program...", "Built 16 microservices...", "Ran the org...")
"""
import sys, re, html

STYLE = re.compile(r'<style.*?</style>', re.S | re.I)
HEADT = re.compile(r'<title.*?</title>', re.S | re.I)
COMMENT = re.compile(r'<!--.*?-->', re.S)
PARA  = re.compile(r'<p[^>]*>(.*?)</p>', re.S | re.I)
TAG   = re.compile(r'<[^>]+>')

INTENSIFIERS = re.compile(r'\b(robust|seamless|seamlessly|leverage|leveraging|delve|delved|wildly|deeply|cutting[- ]edge|unlock|unlocking|supercharge|game[- ]?chang\w*|effortless\w*|vibrant|stunning|elevate|elevating|myriad|plethora|tapestry|realm|landscape|pivotal|underscore\w*|crucial|garner\w*|foster\w*|testament|nestled|showcas\w+|groundbreaking|additionally|moreover|furthermore)\b', re.I)
XNOTY = re.compile(r'\b(rather than|instead of)\b|,\s*not\s+\w|\bnot\s+\w+\s+but\b|\bnot\s+just\b|\bnot\s+only\b', re.I)
COPULA = re.compile(r'\b(serves?|stands?|acts?)\s+as\b', re.I)
PARTICIPLE = re.compile(r',\s*(highlighting|underscoring|showcasing|reflecting|emphasi[sz]ing|demonstrating|illustrating|contributing|cementing|solidifying)\b', re.I)
SIGNIF = re.compile(r'\b(a testament to|enduring legacy|marks?\s+a\s+turning\s+point|stands?\s+as\s+a\b|cements?\s+its\b)', re.I)
# bare past-tense / imperative verb openers common in CV-speak
OPENERS = re.compile(r'^(Held|Built|Ran|Led|Made|Drove|Grew|Won|Kept|Took|Shipped|Designed|Created|Owned|Delivered|Launched|Managed|Founded|Coached|Processed|Migrated|Rebuilt|Ran|Build|Own|Design|Deploy|Ship)\b')

def paragraphs(text, is_html):
    if is_html:
        body = HEADT.sub(' ', STYLE.sub(' ', COMMENT.sub(' ', text)))
        return [html.unescape(TAG.sub('', m.group(1))).strip() for m in PARA.finditer(body)] or \
               [html.unescape(TAG.sub('', body))]
    # markdown/plain: split on blank lines, drop headings/list markers/table rows
    out = []
    for block in re.split(r'\n\s*\n', text):
        b = block.strip()
        if not b or b.startswith(('#', '|', '-', '*', '>', '`')):
            continue
        out.append(b)
    return out

def check(path):
    raw = open(path, encoding='utf-8', errors='replace').read()
    is_html = path.lower().endswith(('.html', '.htm'))
    viol = []
    for p in paragraphs(raw, is_html):
        if not p:
            continue
        if '—' in p:
            viol.append(('EM DASH (—)', p[:90]))
        for m in re.finditer(r'–', p):
            i = m.start()
            around = p[max(0,i-1):i+2]
            if not re.match(r'\d.\d', around):  # allow numeric ranges
                viol.append(('EN DASH (–) in prose', p[max(0,i-25):i+25]))
        for m in INTENSIFIERS.finditer(p):
            viol.append((f'INTENSIFIER "{m.group(0)}"', p[max(0,m.start()-20):m.start()+30]))
        for m in XNOTY.finditer(p):
            viol.append((f'X-NOT-Y "{m.group(0).strip()}"', p[max(0,m.start()-20):m.start()+35]))
        for m in COPULA.finditer(p):
            viol.append((f'COPULA AVOIDANCE "{m.group(0)}" (use is/are)', p[max(0,m.start()-20):m.start()+30]))
        for m in PARTICIPLE.finditer(p):
            viol.append((f'PARTICIPLE SIGNIFICANCE TAIL "{m.group(1)}"', p[max(0,m.start()-25):m.start()+30]))
        for m in SIGNIF.finditer(p):
            viol.append((f'SIGNIFICANCE INFLATION "{m.group(0).strip()}"', p[max(0,m.start()-15):m.start()+30]))
        for m in re.finditer(r'\bno\s+\w+,\s*no\s+\w+', p, re.I):
            viol.append(('"no X, no Y" parallelism', p[max(0,m.start()-10):m.start()+45]))
        for m in re.finditer(r'\bgrains?\b', p, re.I):
            viol.append(('BANNED LEXICON "grains" (say "a skill paired with an evaluator and a grader")', p[max(0,m.start()-25):m.start()+20]))
        for m in re.finditer(r'\b(solo|single-handed(?:ly)?|by myself|lone[- ]?(?:wolf|builder))\b', p, re.I):
            viol.append((f'LONE-BUILDER FRAMING "{m.group(0)}" (never say Heath built/shipped/ran anything solo or alone; drop it, keep "end to end" if scope matters)', p[max(0,m.start()-25):m.start()+20]))
        for m in re.finditer(r'[a-zA-Z]:\s+\S', p):
            viol.append(('RHETORICAL COLON in prose (rework as two sentences or a comma)', p[max(0,m.start()-30):m.start()+25]))
        # paragraph-opener: first sentence starts with a bare verb
        first = p.lstrip()
        if OPENERS.match(first):
            viol.append(('PARAGRAPH OPENS WITH BARE VERB (add a subject, e.g. "I ...")', first[:80]))
    return viol

def main():
    files = sys.argv[1:]
    if not files:
        print('usage: slop-check.py <file>...'); return 2
    bad = 0
    for f in files:
        v = check(f)
        if v:
            bad += 1
            print(f'\n✗ {f}')
            for kind, ctx in v:
                print(f'    {kind}: …{ctx.strip()}…')
        else:
            print(f'✓ {f}')
    if bad:
        print(f'\n{bad} file(s) with slop. Fix before rendering/sending.')
        return 1
    print('\nAll clean.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
