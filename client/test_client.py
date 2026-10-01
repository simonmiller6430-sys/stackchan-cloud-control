import importlib.util
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('client', Path(__file__).with_name('stackchan_client.py'))
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)

class ClientTests(unittest.TestCase):
    def test_poll_uses_get_without_request_body(self):
        requests = []
        def transport(req, timeout):
            requests.append(req)
            return io.BytesIO(b'{"status":"done","settled":true}')
        with patch.object(client.urllib.request, 'urlopen', transport):
            try:
                result = client.api('speak/1234abcd', method='GET')
            except TypeError as exc:
                self.fail(f'Polling API must accept GET: {exc}')
        self.assertTrue(result['settled'])
        self.assertEqual(requests[0].get_method(), 'GET')
        self.assertIsNone(requests[0].data)

    def test_photo_preserves_empty_post_and_binary_bytes(self):
        requests = []
        jpeg = b'\xff\xd8example\xff\xd9'
        def transport(req, timeout):
            requests.append(req)
            return io.BytesIO(jpeg)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)/'photo.jpg'
            with patch.object(client.urllib.request, 'urlopen', transport):
                client.cmd_photo(SimpleNamespace(output=str(output)))
            self.assertEqual(output.read_bytes(), jpeg)
        self.assertEqual(requests[0].get_method(), 'POST')
        self.assertIsNone(requests[0].data)
        self.assertIsNone(requests[0].get_header('Content-type'))

if __name__ == '__main__':
    unittest.main()
