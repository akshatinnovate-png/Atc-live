"""Split a continuous radio stream into individual transmissions.

ATC frequencies are squelched: between calls the scanner feed is near
silence, and each transmission is a burst of speech. A simple energy gate
is enough to cut the stream into one chunk per radio call, which is what
we want to transcribe (and what reads naturally as a chat line).
"""

import numpy as np

SAMPLE_RATE = 16000
FRAME = 480  # 30 ms


class Segmenter:
    def __init__(self, threshold_db=-40.0, hang_ms=700, min_ms=400, max_s=25.0):
        self.threshold = 10 ** (threshold_db / 20)
        self.hang_frames = hang_ms // 30
        self.min_samples = SAMPLE_RATE * min_ms // 1000
        self.max_samples = int(SAMPLE_RATE * max_s)
        self._pending = np.zeros(0, dtype=np.float32)
        self._voice = []
        self._voiced_len = 0
        self._quiet = 0

    def feed(self, pcm):
        """Feed float32 mono 16 kHz samples; yield finished transmissions."""
        self._pending = np.concatenate([self._pending, pcm])
        n = len(self._pending) // FRAME
        frames = self._pending[: n * FRAME].reshape(n, FRAME)
        self._pending = self._pending[n * FRAME:]
        for frame in frames:
            loud = np.sqrt(np.mean(frame * frame)) >= self.threshold
            if loud:
                self._voice.append(frame)
                self._voiced_len += FRAME
                self._quiet = 0
            elif self._voice:
                self._voice.append(frame)
                self._quiet += 1
                if self._quiet >= self.hang_frames:
                    seg = self._finish()
                    if seg is not None:
                        yield seg
            if self._voice and len(self._voice) * FRAME >= self.max_samples:
                seg = self._finish()
                if seg is not None:
                    yield seg

    def _finish(self):
        voice, voiced = self._voice, self._voiced_len
        self._voice, self._voiced_len, self._quiet = [], 0, 0
        if voiced < self.min_samples:
            return None
        return np.concatenate(voice)
