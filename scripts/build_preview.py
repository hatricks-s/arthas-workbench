"""Build the offline design prototype, independently of the runnable gateway UI."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
FILES = ("index.html", "style.css", "app.js", "model.js", "fonts/DM-Sans.ttf", "fonts/OFL.txt")


def main():
    source = ROOT / "ui-prototype"
    output = ROOT / "docs" / "preview"
    for name in FILES:
        target = output / name
        print(f"Writing preview: {target.resolve()}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, target)
    # Retire the old fetch-interception adapter; the new model performs no I/O.
    legacy = output / "mock.js"
    if legacy.is_file():
        print(f"Removing obsolete preview adapter: {legacy.resolve()}")
        legacy.unlink()


if __name__ == "__main__":
    main()
