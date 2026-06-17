#!/usr/bin/env python3
"""
Import a hand-curated list of "best travel" PR contacts as FEATURED contacts
tagged Travel. For each input row:

  • Parse the "Name <email>" or "email" formats below.
  • Look the contact up by email first (exact, case-insensitive). If not found,
    fall back to a normalized-name match.
  • Hit → PATCH /contacts/:id to set featured=true and ensure Travel is in the
    existing tag list (merge, never replace).
  • Miss → POST /contacts to create with featured=true, tags=['Travel'], and
    a best-guess company derived from the email domain.

Run:
    python3 scripts/import_featured_travel_contacts.py --dry-run
    python3 scripts/import_featured_travel_contacts.py
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


WORKER = 'https://tmw.jake-ab7.workers.dev'
HTTP_PAUSE_S = 0.04

# Raw paste from the user. One entry per line; trailing commas tolerated. Both
# "Name <email>" and bare-email forms are accepted.
RAW_CONTACTS = """\
Anamaria Popovska <apopovska@quinn.pr>
Ashley Colon <acolon@quinn.pr>
aisling@rempublicrelations.com
alexis@theabbiagency.com
ali@jpublicrelations.com
Amanda Hackney <amanda@ldpr.com>
ang@wearerhc.com
Ashley Gold <ashley@gnazzogroup.com>
Ashley Yoo <ashley@kingandpartners.com>
Beata Dul <bdul@quinn.pr>
Billie Wyler <billie@thebuzzagency.net>
Bo Wood <bo@candrpr.com>
Britney Ouzts <bouzts@oandgpr.com>
bridgette@theabbiagency.com
Brielle Soifer <brielle@bacchus.agency>
Brigitte Ruiz <bruiz@carmaconnected.com>
Camille Muratore <cam@alchemy-agency.com>
Caroline Whelan <caroline.whelan@evins.com>
carli Brinkman <cb@carlipr.com>
Christina Marad <christina@alchemy-agency.com>
Christiana Tiches <ctiches@quinn.pr>
dani@theabbiagency.com
DaNaya Russell <danaya.russell@candrpr.com>
Daniela Perez <danielap@zapwater.com>
Danielle Rienas <danielle@ldpr.com>
Darcy Jusich <darcy.jusich@gmail.com>
Delfina Güemes <delfina@gnazzogroup.com>
Destiny Beck <destiny@winditupmedia.com>
Diana La Torre <dlatorre@krepspr.com>
Dominique Marek <dmarek@quinn.pr>
Emma Barber <ebarber@optimistconsulting.com>
Elissa Baum <ebaum@quinn.pr>
Elijah Harlow <elijah@dreamglobalconsultinggroup.com>
Elizabeth Kelley-Grace <elizabeth@thebuzzagency.net>
Ella Henry <ella.henry@candrpr.com>
Emma Kershenbaum <emmak@bacchus.agency>
Erica Badgley <erica@alchemy-agency.com>
Emmy Villiger <evilliger@quinn.pr>
Faveanny Leyva <fleyva@carmaconnected.com>
fmerksamer@optimistconsulting.com
fquinn@quinn.pr
Frannie Vena-Pedersen <fvenapedersen@optimistconsulting.com>
Gemma Kane <gemma@jpublicrelations.com>
gianna@thedanaagency.com
Hanna Lee <hanna@hannaleecommunications.com>
Jamie Tamkin <jtamkin@candrpr.com>
Jess Anderson <jessa@oxcommons.com>
Jesslyn Wade <jesslyn@alchemy-agency.com>
Jess Martino <jmartino@quinn.pr>
Julia Wagner <jwagner@quinn.pr>
Jordan Stern <jstern@carmaconnected.com>
Julia Palma <julia@gladstonemedia.ca>
Julie Singley <julie@alchemy-agency.com>
Kaeli Hearn <kaeli.hearn@candrpr.com>
Katherine Han <katherine@katherinehanpr.com>
Kathleen Lam <kathleenl@rockawaymore.com>
kathryn@theabbiagency.com
kcapiro@carmaconnected.com
Kara Dubin <kdubin@quinn.pr>
Kelly Gilbert <kelly@ldpr.com>
Kristin Berry <kristin@piperandcocreative.com>
Kristy Thai <kristy@ldpr.com>
Lachlan Spence <lachlan@re-agency.com>
Laura Bottke <laura@rempublicrelations.com>
Lorena Coleman <lorena@brndhouse.com>
Lindsey Poole <lpoole@ldpr.com>
Lauren Von Holten <lvh@wearerhc.com>
Marie Assante <marie@assantepr.com>
marisa.chiarello@magrinopr.com
Max Sanchez <max@gnazzogroup.com>
michelle.kelly@evins.com
mlebaca@theabbiagency.com
Morgan Rosen <morgan@bacchus.agency>
Natalie Moore <natalie@rempublicrelations.com>
Nick D'Annunzio <nick@taraink.com>
Nicki Goebel <nicki@bacchus.agency>
Nicole Casper <nicole@casprconsulting.com>
Nicole Paloux <nicole@red-balloon.net>
Toyin Lasisi <olasisi@carmaconnected.com>
Paige Callan <paige@ldpr.com>
Peyton Pose <peyton@bacchus.agency>
Paige Fleming <pfleming@ldpr.com>
Piper Gardiner <piper@ldpr.com>
Rachael Moss <rachael.moss@candrpr.com>
Ryan Mancini <ryan@carlipr.com>
Sally Shorr <sally@thebuzzagency.net>
samantha.malley@candrpr.com
Sami Perez <sami@alchemy-agency.com>
Skyler Baldwin <skyler.baldwin@candrpr.com>
Susie Dempsey <susie@starletpr.com>
Sydney Dixon <sydney@synergymia.com>
Sydney Cook-Cooper <sydneyc@zapwater.com>
Sydney Dixon <sydneymdixon@gmail.com>
taylor@theabbiagency.com
Tesh Parris <tesh.parris@candrpr.com>
Tony Figueroa <tony.figueroa@krepspr.com>
Elizabeth Rad <erad237@gmail.com>
Sydney Huberman <shuberman@quinn.pr>
Kait Nicholas <kait@oftmw.com>
Melissa@crave-pr.com
Brielle Soifer <brielle@bacchus.agency>
Amanda Ostrove Newman <amanda@rempublicrelations.com>
"""


def parse_line(line):
    """Returns (name, email) or None if line is blank/unparseable.
       Tolerates trailing commas, "Name <email>" syntax, or bare email."""
    s = line.strip().rstrip(',').strip()
    if not s:
        return None
    # "Name <email>"
    m = re.match(r'^(.*?)\s*<([^>]+)>\s*$', s)
    if m:
        name = m.group(1).strip()
        email = m.group(2).strip()
        if not email:
            return None
        if not name:
            name = derive_name_from_email(email)
        return (name, email)
    # Bare email
    if '@' in s and not re.search(r'\s', s):
        return (derive_name_from_email(s), s)
    return None


def derive_name_from_email(email):
    """email@domain → Title-Cased best guess (Jane.Doe → Jane Doe)."""
    local = email.split('@', 1)[0]
    parts = re.split(r'[._-]', local)
    return ' '.join(p.capitalize() for p in parts if p)


def derive_company_from_email(email):
    """Best-guess company from the email domain. PR agencies typically have
       their brand in the domain (quinn.pr, alchemy-agency.com, etc.), so a
       title-cased domain stem is good enough until a human edits it."""
    try:
        domain = email.split('@', 1)[1].lower()
    except IndexError:
        return None
    # Strip the public suffix bits we don't want in the name.
    domain = re.sub(r'\.(com|net|org|co|ca|io|me|us|pr|agency|consulting)$', '', domain)
    domain = re.sub(r'\.(com|net|org|co|ca|io|me|us)$', '', domain)
    # Now it's like "alchemy-agency" or "candrpr"
    parts = re.split(r'[-.]', domain)
    return ' '.join(p.capitalize() for p in parts if p)


def get_admin_token():
    r = subprocess.run(
        ['security', 'find-generic-password', '-s', 'tmw-admin-token', '-a', 'jakenicholas', '-w'],
        capture_output=True, text=True
    )
    tok = r.stdout.strip()
    if not tok:
        raise RuntimeError("No tmw-admin-token in keychain")
    return tok


TOKEN = None


def api(method, path, body=None, retries=2):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        WORKER + path, data=data, method=method,
        headers={
            'Authorization': f'Bearer {TOKEN}',
            'Content-Type': 'application/json',
            'User-Agent': 'tmw-featured-import/1.0',
        },
    )
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            txt = ''
            try: txt = e.read().decode('utf-8', errors='replace')
            except Exception: pass
            if e.code in (502, 503, 504) and attempt < retries:
                time.sleep(0.5 * (attempt + 1)); continue
            raise RuntimeError(f"HTTP {e.code} {method} {path}: {txt[:300]}")


def load_all_contacts():
    """Pull every contact and index by lowercase email + lowercase normalized
       name so the find-or-create dance is one lookup per row."""
    by_email = {}
    by_name = {}
    offset = 0
    while True:
        d = api('GET', f'/contacts?limit=100&offset={offset}')
        items = d.get('items', [])
        for c in items:
            email = (c.get('email') or '').strip().lower()
            if email:
                by_email[email] = c
            name = (c.get('name') or '').strip().lower()
            if name:
                # Keep the first one we see — duplicates land as separate keys
                # only when there's no email collision (we trust email more).
                by_name.setdefault(name, c)
        if not items or len(items) < 100:
            break
        offset += len(items)
    return by_email, by_name


def main():
    global TOKEN
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true', help='preview only')
    args = parser.parse_args()
    TOKEN = get_admin_token()

    # Parse the input list, dedup case-insensitively by email or name.
    raw_rows = []
    seen_keys = set()
    for line in RAW_CONTACTS.strip().splitlines():
        parsed = parse_line(line)
        if not parsed:
            continue
        name, email = parsed
        key = email.lower() if email else ('name:' + name.lower())
        if key in seen_keys:
            continue
        seen_keys.add(key)
        raw_rows.append((name, email))
    print(f'  Input rows: {len(raw_rows)} (deduped from {len(RAW_CONTACTS.strip().splitlines())})')

    print('Loading existing contacts...')
    by_email, by_name = load_all_contacts()
    print(f'  ✓ {len(by_email)} by email, {len(by_name)} by name')

    created = 0
    updated = 0
    untouched = 0  # already featured + already Travel-tagged
    for name, email in raw_rows:
        email_lc = (email or '').lower()
        # Email is authoritative when the input row has one — name collisions
        # are common (two "Sydney Dixon"s with different emails are different
        # people). Fall back to name match only for the bare-email/bare-name
        # rows where there's no email-on-input to compare against.
        if email_lc:
            existing = by_email.get(email_lc)
        else:
            existing = by_name.get(name.lower())
        if existing:
            tags = list(existing.get('tags') or [])
            had_travel = 'Travel' in tags
            had_featured = bool(existing.get('featured'))
            if not had_travel:
                tags.append('Travel')
            if had_travel and had_featured:
                untouched += 1
                continue
            payload = {'featured': True, 'tags': tags}
            label = f'UPDATE {existing["id"]:14s} {name[:30]:30s} -> tags={tags}, featured=true'
            if not had_featured and not had_travel: label = '✨ ' + label
            elif not had_featured: label = '★  ' + label
            elif not had_travel:   label = '🏷  ' + label
            print('  ' + label)
            if not args.dry_run:
                api('PATCH', '/contacts/' + urllib.parse.quote(existing['id']), payload)
                time.sleep(HTTP_PAUSE_S)
            updated += 1
        else:
            payload = {
                'name': name,
                'email': email or None,
                'company': derive_company_from_email(email) if email else None,
                'tags': ['Travel'],
                'featured': True,
            }
            print(f'  CREATE  {name[:30]:30s} <{email}>')
            if not args.dry_run:
                api('POST', '/contacts', payload)
                time.sleep(HTTP_PAUSE_S)
            created += 1

    print()
    print('── Summary ' + '─' * 50)
    print(f'  Created:           {created}')
    print(f'  Updated:           {updated}')
    print(f'  Already up-to-date: {untouched}')
    if args.dry_run:
        print('  (dry-run — no writes)')


if __name__ == '__main__':
    main()
