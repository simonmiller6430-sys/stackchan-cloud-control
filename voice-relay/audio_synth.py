"""Silent input audio: Chinese text -> 16 kHz / 60 ms Opus packets.

The robot never plays this; it only forwards it to its own cloud so xiaozhi's existing
STT/LLM/TTS turn produces the reply, which the robot speaks with its normal voice.
"""
from __future__ import annotations

import asyncio
import subprocess
import shutil
import tempfile
from pathlib import Path

import relay_protocol as proto

# A neutral input voice. The robot's reply voice is chosen by its own cloud, not here.
INPUT_VOICE = "zh-CN-XiaoxiaoNeural"
INPUT_RATE = "+20%"
SYNTH_TIMEOUT_S = 35
FFMPEG_TIMEOUT_S = 30

FFMPEG_ARGS = [
    "-hide_banner", "-loglevel", "error",
    "-af", "aresample=16000,apad=pad_len=6400",
    "-ar", "16000", "-ac", "1",
    "-c:a", "libopus", "-b:a", "24k", "-application", "voip",
    "-frame_duration", "60", "-f", "ogg", "pipe:1",
]


def ffmpeg_exe() -> str:
    installed = shutil.which('ffmpeg')
    if installed:
        return installed
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def _synthesize(text: str, voice: str, rate: str, pitch: str, speech: bool) -> list[bytes]:
    """Return Opus packets ready for cmd 5 upload."""
    import edge_tts

    with tempfile.TemporaryDirectory(prefix="stackchan-relay-") as folder:
        path = Path(folder) / "input.mp3"

        async def generate() -> None:
            await asyncio.wait_for(
                edge_tts.Communicate(text, voice, rate=rate, pitch=pitch).save(str(path)),
                SYNTH_TIMEOUT_S,
            )

        asyncio.run(generate())
        process = subprocess.run(
            [ffmpeg_exe(), "-i", str(path), *FFMPEG_ARGS],
            capture_output=True, timeout=FFMPEG_TIMEOUT_S,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if process.returncode:
            raise RuntimeError("输入音频转换失败")
        frames = proto.ogg_opus_packets(process.stdout)
        if len(frames) > proto.MAX_TOTAL_FRAMES:
            raise ValueError("too_long" if speech else "输入音频过长，请缩短消息")
        for frame in frames:
            if not 1 <= len(frame) <= proto.MAX_FRAME_BYTES:
                raise ValueError("输入音频帧大小异常")
        return frames


def synthesize(text: str) -> list[bytes]:
    return _synthesize(text, INPUT_VOICE, INPUT_RATE, "+0Hz", False)

def synthesize_speech(text: str, voice: str = "zh-CN-XiaoxiaoNeural") -> list[bytes]:
    return _synthesize(text, voice, "-5%", "+0Hz", True)
