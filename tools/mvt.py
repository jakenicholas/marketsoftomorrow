"""Minimal Mapbox Vector Tile reader: enough to pull building polygons + height."""
import math, gzip

def _varint(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7f) << s
        if not (x & 0x80): return r, i
        s += 7

def _fields(b):
    i = 0
    while i < len(b):
        k, i = _varint(b, i)
        f, w = k >> 3, k & 7
        if w == 2:
            n, i = _varint(b, i); yield f, b[i:i+n]; i += n
        elif w == 0:
            v, i = _varint(b, i); yield f, v
        elif w == 5: yield f, b[i:i+4]; i += 4
        elif w == 1: yield f, b[i:i+8]; i += 8
        else: raise ValueError('wire %d' % w)

def _value(buf):
    import struct
    for f, p in _fields(buf):
        if f == 1: return p.decode('utf8', 'replace')
        if f == 2: return struct.unpack('<f', p)[0]
        if f == 3: return struct.unpack('<d', p)[0]
        if f in (4, 5): return p
        if f == 6: return (p >> 1) ^ -(p & 1)
        if f == 7: return bool(p)
    return None

def _geom(cmds):
    """decode command stream -> list of rings (in tile-local units)"""
    rings, cur, x, y, i = [], [], 0, 0, 0
    while i < len(cmds):
        h = cmds[i]; i += 1
        cmd, cnt = h & 7, h >> 3
        if cmd == 7:                       # ClosePath
            if cur: rings.append(cur); cur = []
            continue
        for _ in range(cnt):
            dx = cmds[i]; i += 1
            dy = cmds[i]; i += 1
            x += (dx >> 1) ^ -(dx & 1)
            y += (dy >> 1) ^ -(dy & 1)
            if cmd == 1 and cur:           # MoveTo starts a new ring
                rings.append(cur); cur = []
            cur.append((x, y))
    if cur: rings.append(cur)
    return rings

def _packed(buf):
    out, i = [], 0
    while i < len(buf):
        v, i = _varint(buf, i)
        out.append(v)
    return out

def read_layer(tile_bytes, want='building'):
    if tile_bytes[:2] == b'\x1f\x8b': tile_bytes = gzip.decompress(tile_bytes)
    for f, p in _fields(tile_bytes):
        if f != 3: continue
        name, keys, vals, extent, feats = None, [], [], 4096, []
        for lf, lp in _fields(p):
            if lf == 1: name = lp.decode('utf8', 'replace')
            elif lf == 3: keys.append(lp.decode('utf8', 'replace'))
            elif lf == 4: vals.append(_value(lp))
            elif lf == 5: extent = lp
            elif lf == 2: feats.append(lp)
        if name != want: continue
        out = []
        for fb in feats:
            tags, geo, gtype = [], None, 0
            for ff, fp in _fields(fb):
                if ff == 2: tags = _packed(fp)
                elif ff == 3: gtype = fp
                elif ff == 4: geo = _packed(fp)
            if gtype != 3 or not geo: continue
            props = {keys[tags[i]]: vals[tags[i+1]] for i in range(0, len(tags) - 1, 2)}
            out.append((props, _geom(geo), extent))
        return out
    return []

def to_lnglat(px, py, x, y, z, extent):
    n = 2 ** z
    lng = (x + px / extent) / n * 360.0 - 180.0
    yn = (y + py / extent) / n
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yn))))
    return lng, lat
