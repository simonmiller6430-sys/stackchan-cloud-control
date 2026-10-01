import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import audio_synth


class RuntimeTests(unittest.TestCase):
    def test_uses_installed_ffmpeg_on_linux_arm(self):
        with patch('shutil.which', return_value='/usr/bin/ffmpeg'):
            self.assertEqual(audio_synth.ffmpeg_exe(), '/usr/bin/ffmpeg')


if __name__ == '__main__':
    unittest.main()
