"""Stage the public web application for a Pages deployment."""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import shutil

from workspace import PUBLIC, ROOT

FRONTEND = tuple(name for name in PUBLIC if name.endswith(('.js', '.mjs', '.css')))
LEGACY_ENTRY = """// Reload a cached HTML page from before versioned assets were introduced.
const freshPage = new URL(location.href);
const alreadyRefreshed = freshPage.searchParams.has("refresh");
freshPage.searchParams.set("refresh", Date.now());
if (!alreadyRefreshed) {
  location.replace(freshPage.href);
} else {
  const link = document.createElement("a");
  link.href = freshPage.href;
  link.textContent = "Reload the latest version";
  document.getElementById("loading")?.replaceChildren(link);
}
"""


def stage(destination: Path) -> None:
    app = ROOT / 'web/dist'
    target = destination.resolve()
    if destination.exists() or destination.is_symlink() or target.is_relative_to(app.resolve()):
        raise ValueError('Choose a new destination outside the build outputs.')

    app_paths = [app / name for name in PUBLIC]
    if app.is_symlink() or any(path.is_symlink() or not path.is_file()
                               or not path.resolve().is_relative_to(app.resolve()) for path in app_paths):
        raise ValueError('The web build is missing public files or contains a symlink.')

    frontend = {name: (app / name).read_bytes() for name in FRONTEND}
    digest = hashlib.sha256()
    for name, raw in frontend.items():
        digest.update(name.encode('utf-8') + b'\0' + hashlib.sha256(raw).digest())
    bundle = f'assets/{digest.hexdigest()[:20]}'
    html = (app / 'index.html').read_text(encoding='utf-8')
    for original, versioned in (
        ('import("./app.js")', f'import("./{bundle}/app.js")'),
        ('href="./styles.css"', f'href="./{bundle}/styles.css"'),
    ):
        if html.count(original) != 1:
            raise ValueError(f'Expected one frontend entry in the showcase HTML: {original}')
        html = html.replace(original, versioned)

    destination.mkdir(parents=True, exist_ok=False)
    for name, source in zip(PUBLIC, app_paths, strict=True):
        if name in {'index.html', 'app.js'}:
            continue
        output = destination / name
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, output)
    (destination / 'index.html').write_text(html, encoding='utf-8')
    (destination / 'app.js').write_text(LEGACY_ENTRY, encoding='utf-8')
    (destination / bundle).mkdir(parents=True)
    for name, raw in frontend.items():
        (destination / bundle / name).write_bytes(raw)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    try:
        stage(args.destination)
    except (OSError, ValueError) as exc:
        parser.exit(1, f'ERROR: {exc}\n')


if __name__ == '__main__':
    main()
