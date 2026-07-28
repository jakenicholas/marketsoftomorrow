#!/usr/bin/env python3
"""
travel_links.py — mint per-recipient private links for a /travel itinerary.

The /travel detail pages are a SAFETY surface: exact hotels, nights and transit
times are never published. They are released only to a signed, per-recipient
link. Identity is ASSIGNED by the link (not typed in by the visitor), so it
can't be faked, and every open is logged for attribution + leak detection.

Usage
  # one recipient
  python3 scripts/travel_links.py --slug california --to "Jane Doe <jane@agency.com>"

  # the whole PR list (one recipient per line), written as CSV for a mail merge
  python3 scripts/travel_links.py --slug california --file pr-contacts.txt --csv links.csv

  # a link that opens EVERY trip (slug '*'), valid 90 days
  python3 scripts/travel_links.py --slug '*' --file pr-contacts.txt --days 90

Auth: needs the worker admin token.
  export TMW_ADMIN_TOKEN=...      (or pass --token)
"""
import argparse, csv, json, os, sys, urllib.request

WORKER = 'https://tmw.jake-ab7.workers.dev'


def mint(token, slug, recipients, days):
    req = urllib.request.Request(
        WORKER + '/travel-invites',
        data=json.dumps({'slug': slug, 'to': recipients, 'days': days}).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--slug', default='*', help="trip slug (california, europe) or '*' for all")
    p.add_argument('--to', action='append', default=[], help='a recipient (repeatable)')
    p.add_argument('--file', help='file with one recipient per line')
    p.add_argument('--days', type=int, default=120, help='link lifetime in days (default 120)')
    p.add_argument('--csv', help='write recipient,link CSV here')
    p.add_argument('--token', default=os.environ.get('TMW_ADMIN_TOKEN', ''))
    a = p.parse_args()

    if not a.token:
        sys.exit('Set TMW_ADMIN_TOKEN (or pass --token).')

    recipients = list(a.to)
    if a.file:
        with open(a.file, encoding='utf-8') as f:
            recipients += [ln.strip() for ln in f if ln.strip()]
    if not recipients:
        sys.exit('No recipients. Use --to or --file.')

    res = mint(a.token, a.slug, recipients, a.days)
    links = res.get('links', [])

    if a.csv:
        with open(a.csv, 'w', newline='', encoding='utf-8') as f:
            w = csv.writer(f)
            w.writerow(['recipient', 'link'])
            for l in links:
                w.writerow([l['to'], l['url']])
        print(f"{len(links)} links → {a.csv}")
    else:
        for l in links:
            print(f"{l['to']}\t{l['url']}")

    print(f"\nTrip: {res.get('slug')} · {len(links)} links · valid {a.days} days", file=sys.stderr)
    print("Each link is attributable: opens are logged by recipient, so a forwarded "
          "link shows up as one name opening from many places.", file=sys.stderr)


if __name__ == '__main__':
    main()
