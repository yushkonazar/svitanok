"""Compatibility entrypoint for the antimeridian-safe D3 map generator."""
import argparse
import shutil
import subprocess
from pathlib import Path
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path)
source = parser.parse_args().source
node = shutil.which('node')
if not node:
    raise SystemExit('Node.js is required for D3 geographic clipping.')
subprocess.run([node, str(Path(__file__).with_suffix('.mjs')), str(source)], check=True)
