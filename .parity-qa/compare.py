from pathlib import Path
import json
from PIL import Image, ImageChops

root = Path("homepage-parity/captures")
findings = []
for old in sorted(root.glob("*-accepted.png")):
    candidate = Path(str(old).replace("-accepted.png", "-refactor.png"))
    with Image.open(old).convert("RGB") as expected, Image.open(candidate).convert("RGB") as actual:
        if expected.size != actual.size:
            findings.append({"view": old.stem, "expectedSize": expected.size, "actualSize": actual.size})
            continue
        change = ImageChops.difference(expected, actual)
        mask = ImageChops.lighter(ImageChops.lighter(*change.split()[:2]), change.getchannel("B"))
        changed = sum(mask.histogram()[1:])
        findings.append({"view": old.stem, "size": expected.size, "changedPixels": changed, "bounds": mask.getbbox(), "maxDelta": mask.getextrema()[1]})
        if changed:
            change.save(root / old.name.replace("-accepted.png", "-diff.png"))
(root / "comparison.json").write_text(json.dumps(findings, indent=2))
print(json.dumps(findings, indent=2))
assert len(findings) == 6 and all(item.get("changedPixels") == 0 for item in findings), "Pixel comparison requires review"
