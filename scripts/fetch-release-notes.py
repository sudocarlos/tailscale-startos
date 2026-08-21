#!/usr/bin/env python3
"""fetch-release-notes.py - Generate release notes for a Tailscale bump.

Fetches https://tailscale.com/changelog, parses it into per-release bullet
groups, and emits plaintext notes covering every *client* release strictly
newer than <old_version> and up to <new_version>.

Usage:
  scripts/fetch-release-notes.py <old_version> <new_version>
  scripts/fetch-release-notes.py <old_version> <new_version> --write-ts <file>

With --write-ts, the script rewrites the `en_US` literal in <file> in place.
On any fetch/parse failure the script leaves <file> untouched and exits non-zero
so an automated bump workflow never blocks on changelog outages.

Sections included are limited to SECTIONS (All Platforms + Linux), the only
platforms relevant to this Linux server appliance.
"""
import argparse
import html
import re
import sys
import urllib.request

CHANGELOG_URL = "https://tailscale.com/changelog"
USER_AGENT = "tailscale-startos-bump/1.0 (+https://github.com/sudocarlos/tailscale-startos)"
TIMEOUT = 20
PRETTIER_PRINT_WIDTH = 80  # repo prettier config does not override printWidth

# changelog sections relevant to this Linux server appliance
SECTIONS = ("All Platforms", "Linux")
# the changelog tags client entries "Tailscale vX.Y.Z"; container entries
# "Tailscale container image vX.Y.Z". We track both.
CLIENT_PREFIX = "Tailscale v"
CONTAINER_PREFIX = "Tailscale container image v"


def parse_version(tag):
    """'v1.102.2' -> (1, 102, 2). Returns None if not a clean X.Y.Z."""
    m = re.match(r"^v?(\d+)\.(\d+)\.(\d+)$", tag)
    if not m:
        return None
    return tuple(int(x) for x in m.groups())


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read().decode("utf-8", errors="replace")


def textify(s):
    """Strip HTML tags while keeping link text and collapsing whitespace."""
    s = re.sub(r"<a\b[^>]*>(.*?)</a>", r"\1", s, flags=re.S)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def parse_entry(chunk):
    """Parse one changelog-entry chunk into (title, sections, container_note).

    sections: list of (header, [(change_type, bullet_text), ...])
    container_note: str or None (the <Note> body, for container image entries)
    """
    m = re.search(r"changelog-title[^>]*>([^<]+)</h3>", chunk)
    if not m:
        return None
    title = html.unescape(m.group(1)).strip()

    h = chunk.find("</header>")
    content = chunk[h:] if h >= 0 else chunk

    note = re.search(r"<Note>(.*?)</Note>", content, flags=re.S)
    note_text = textify(note.group(1)) if note else None

    # Split content into sections by h4/h5 headers; index 0 is the preamble.
    parts = re.split(r"(<h[45][^>]*>.*?</h[45]>)", content, flags=re.S)
    sections = []
    if parts[0]:
        preamble = [
            (t, textify(b))
            for t, b in re.findall(
                r'<li\s+data-change="([^"]+)">(.*?)</li>', parts[0], flags=re.S
            )
        ]
        if preamble:
            sections.append(("(intro)", preamble))
    for i in range(1, len(parts), 2):
        header = textify(parts[i])
        body = parts[i + 1] if i + 1 < len(parts) else ""
        bullets = [
            (t, textify(b))
            for t, b in re.findall(
                r'<li\s+data-change="([^"]+)">(.*?)</li>', body, flags=re.S
            )
        ]
        if bullets:
            sections.append((header, bullets))
    return title, sections, note_text


def iter_entries(raw):
    """Yield parsed entries from the raw changelog HTML."""
    for chunk in re.split(r'class="changelog-entry\s+scroll-mt-28"', raw)[1:]:
        entry = parse_entry(chunk)
        if entry:
            yield entry


def collect_notes(raw, old_ver, new_ver):
    """Build the release-notes paragraph for client releases in
    (old_ver, new_ver], plus the container image note for new_ver."""
    old_v = parse_version(old_ver)
    new_v = parse_version(new_ver)
    if old_v is None or new_v is None:
        raise ValueError(f"unparseable versions: old={old_ver} new={new_ver}")

    client_entries = []  # (version_tuple, title, sections)
    container_note = None
    for title, sections, note_text in iter_entries(raw):
        if title.startswith(CONTAINER_PREFIX):
            v = parse_version(title[len(CONTAINER_PREFIX):].strip())
            if v == new_v:
                container_note = note_text
            continue
        if title.startswith(CLIENT_PREFIX):
            v = parse_version(title[len(CLIENT_PREFIX):].strip())
            if v is None:
                continue
            if old_v < v <= new_v:
                client_entries.append((v, title, sections))

    # newest first so the bumped version's own notes lead, followed by any
    # intermediate releases folded into this bump
    client_entries.sort(key=lambda e: e[0], reverse=True)

    lines = [f"Tailscale updated from v{old_ver} to v{new_ver}."]
    if container_note:
        lines.append("")
        lines.append(f"Container image: {container_note}")
    for v, title, sections in client_entries:
        tag = title[len(CLIENT_PREFIX):].strip()
        lines.append("")
        lines.append(f"{tag}:")
        for header, bullets in sections:
            if header not in SECTIONS:
                continue
            for ctype, text in bullets:
                # strip trailing periods, we add our own
                t = text.rstrip(".")
                lines.append(f"- [{ctype}] {t}.")
    return "\n".join(lines)


def ts_string_literal(text):
    """Render `text` as a TS string literal, preferring single quotes per
    prettier config (semi:false, singleQuote:true). Fall back to double quotes
    when the text contains an apostrophe, matching prettier's behavior."""
    escaped = text.replace("\\", "\\\\").replace("\n", "\\n")
    if "'" not in text:
        return "'" + escaped.replace("'", "\\'") + "'"
    escaped = escaped.replace('"', '\\"')
    return '"' + escaped + '"'


def write_ts(path, notes):
    """Rewrite the `en_US:` literal in `path` to `notes`.

    Matches a single literal or a string-concatenation chain
    ('seg' + 'seg' + ...) and replaces the whole value with one literal. The
    output matches prettier's wrapping rule (printWidth 80) exactly so no
    prettier run is needed: inline when it fits, else `en_US:` on its own line
    with the literal indented six spaces.
    """
    with open(path, encoding="utf-8") as f:
        content = f.read()

    literal = ts_string_literal(notes)

    # One TS string literal, single- or double-quoted.
    _q = r"'(?:\\.|[^'\\])*'"
    _dq = r'"(?:\\.|[^"\\])*"'
    head = "(?:" + _q + "|" + _dq + ")"  # group so (alt) repeats together
    value = head + r"(?:\s*\+\s*" + head + r")*"
    pattern = re.compile(r"(en_US:\s*)(" + value + r")", re.S)

    # The match consumes `en_US:` + whitespace + the literal(s) but not the
    # trailing comma, which is preserved. Normalise the prefix so output stays
    # prettier-stable: inline when it fits the print width, else its own line.
    inline = "    en_US: " + literal + ","
    if len(inline) <= PRETTIER_PRINT_WIDTH:
        replacement = "en_US: " + literal
    else:
        replacement = "en_US:\n      " + literal

    new_content, n = pattern.subn(
        lambda m: replacement, content, count=1
    )
    if n != 1:
        raise RuntimeError(f"could not locate en_US literal in {path}")

    # Drop the placeholder comment that bump-version.sh leaves above en_US:
    # now that real notes are in place.
    new_content = re.sub(
        r"^[ \t]*// TODO:[^\n]*\n(?=[ \t]*en_US:)", "", new_content, count=1, flags=re.M
    )

    with open(path, "w", encoding="utf-8") as f:
        f.write(new_content)


def main(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("old_version", help="previous pinned version, e.g. 1.98.10")
    p.add_argument("new_version", help="new pinned version, e.g. 1.102.2")
    p.add_argument("--write-ts", metavar="FILE", help="rewrite the en_US literal in FILE")
    args = p.parse_args(argv)

    try:
        raw = fetch(CHANGELOG_URL)
        notes = collect_notes(raw, args.old_version, args.new_version)
    except Exception as e:
        print(f"WARN: could not fetch/parse changelog: {e}", file=sys.stderr)
        print("      leaving release-notes placeholder for manual review.", file=sys.stderr)
        return 1

    # If parsing yielded nothing usable (no bullets and no container note), the
    # upstream markup likely changed. Treat as a soft failure so the workflow
    # keeps the placeholder for manual review instead of committing a header
    # with no content.
    if "\n- [" not in notes and "Container image:" not in notes:
        print(
            "WARN: no changelog entries found for the requested range; "
            "upstream markup may have changed.",
            file=sys.stderr,
        )
        print("      leaving release-notes placeholder for manual review.", file=sys.stderr)
        return 1

    if args.write_ts:
        try:
            write_ts(args.write_ts, notes)
            print(f"Wrote release notes to {args.write_ts}")
        except Exception as e:
            print(f"WARN: could not write {args.write_ts}: {e}", file=sys.stderr)
            return 1
    else:
        print(notes)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))