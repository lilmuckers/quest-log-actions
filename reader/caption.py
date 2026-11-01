"""Describes a photo with no words in it, with Florence-2. It runs the model's code from the
transformers package only, at a pinned revision, and holds no token."""
import json
import sys

import torch
from PIL import Image
from transformers import AutoProcessor, Florence2ForConditionalGeneration

from rules import read_caption

MODEL = 'florence-community/Florence-2-base'
REVISION = '00921df66db728a9ceb750f5eca43e5c203a2051'


def main(photo, out):
    processor = AutoProcessor.from_pretrained(MODEL, revision=REVISION)
    model = Florence2ForConditionalGeneration.from_pretrained(MODEL, revision=REVISION).eval()
    inputs = processor(text='<CAPTION>', images=Image.open(photo).convert('RGB'), return_tensors='pt')
    with torch.no_grad():
        ids = model.generate(**inputs, max_new_tokens=40, num_beams=1)
    result = {**read_caption(processor.batch_decode(ids, skip_special_tokens=True)[0]), 'model': 'florence-2-base'}
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
