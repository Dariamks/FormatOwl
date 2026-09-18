"""Prefetch the pinned, redistributable PDF layout models. Not run during a user job."""
import json,os
from pathlib import Path
from huggingface_hub import snapshot_download

root=Path(__file__).resolve().parents[1]
manifest=json.loads((root/'apps/worker/python/document-models.json').read_text())
destination=Path(os.environ.get('DOCLING_ARTIFACTS_PATH',root/'.data/docling-models'))
for model in manifest['models']:
    snapshot_download(model['repo'],revision=model['revision'],local_dir=destination/model['repo'].replace('/','--'),allow_patterns=model['patterns'],max_workers=2)
    print('Ready:',model['repo'],model['revision'])
