"""Generate an ignored, per-device control key before building the firmware."""
import secrets
from pathlib import Path

header = Path(__file__).resolve().parents[1]/'main/boards/m5stack-core-s3/device_control_secret.h'
with header.open('x', encoding='utf-8') as output:
    output.write('#pragma once\n#define STACKCHAN_DEVICE_CONTROL_SECRET_HEX "'+secrets.token_hex(32)+'"\n')
print('Created device_control_secret.h. Keep it private and reuse the exact string in Worker and relay secrets.')
