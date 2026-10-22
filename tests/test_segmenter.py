import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from segmenter import SAMPLE_RATE, Segmenter  # noqa: E402


def tone(seconds, amp=0.3):
    t = np.arange(int(SAMPLE_RATE * seconds)) / SAMPLE_RATE
    return (amp * np.sin(2 * np.pi * 440 * t)).astype(np.float32)


def silence(seconds):
    return np.zeros(int(SAMPLE_RATE * seconds), dtype=np.float32)


def run(pcm, chunk=8000, **kw):
    seg = Segmenter(**kw)
    out = []
    for i in range(0, len(pcm), chunk):
        out.extend(seg.feed(pcm[i:i + chunk]))
    return out


def test_splits_on_squelch_gaps():
    pcm = np.concatenate([silence(1), tone(2), silence(1.5), tone(3), silence(1.5)])
    segs = run(pcm)
    assert len(segs) == 2
    assert 2.0 <= len(segs[0]) / SAMPLE_RATE <= 3.0
    assert 3.0 <= len(segs[1]) / SAMPLE_RATE <= 4.0


def test_short_clicks_are_dropped():
    pcm = np.concatenate([silence(1), tone(0.1), silence(2)])
    assert run(pcm) == []


def test_long_transmission_is_capped():
    segs = run(np.concatenate([tone(12), silence(1)]), max_s=5)
    assert len(segs) >= 2
    assert all(len(s) / SAMPLE_RATE <= 5.1 for s in segs)
