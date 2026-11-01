"""Reads one photo with RapidOCR (PaddleOCR's models on ONNX Runtime). It holds no token: the action
saves the result in a later step. Writes the result as JSON, or asks for a caption if no words were found."""
import json
import sys

from rapidocr import LangRec, ModelType, OCRVersion, RapidOCR

from rules import read_rows, to_rows

MODEL = 'paddleocr-en-v5'


def main(photo, out):
    ocr = RapidOCR(params={'Rec.lang_type': LangRec.EN, 'Rec.ocr_version': OCRVersion.PPOCRV5, 'Rec.model_type': ModelType.MOBILE})
    found = ocr(photo)
    if found.txts is None or not len(found.txts):
        result = {'caption': True}
    else:
        scores = [float(s) for s in found.scores]
        rows = to_rows([[list(map(float, p)) for p in box] for box in found.boxes], list(found.txts), scores)
        result = {**read_rows(rows, sum(scores) / len(scores)), 'model': MODEL}
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
