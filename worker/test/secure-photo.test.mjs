import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv,createHash } from 'node:crypto';
import * as protocol from '../src/protocol.mjs';
function seal(id,body){
 const header=Buffer.from('01'+id+'00000000','hex'),nonce=Buffer.alloc(12,7);
 const cipher=createCipheriv('aes-256-gcm',createHash('sha256').update('test-secret').digest(),nonce);
 cipher.setAAD(Buffer.concat([Buffer.from('stackchan-photo-v1'),header]));
 return Buffer.concat([header,nonce,cipher.update(body),cipher.final(),cipher.getAuthTag()]);
}
test('secure photo decrypts compatible AES-GCM envelope and rejects wrong request',async()=>{
 assert.equal(typeof protocol.openPhotoPacket,'function');
 const data=seal('01020304',Buffer.from([1,1,64,0,240]));
 assert.deepEqual([...await protocol.openPhotoPacket(data,'01020304','test-secret')],[1,1,64,0,240]);
 await assert.rejects(protocol.openPhotoPacket(data,'05060708','test-secret'));
});
test('secure photo rejects tampering and key mismatch',async()=>{
 assert.equal(typeof protocol.openPhotoPacket,'function');
 const data=seal('01020304',Buffer.from([2,0,0,255,216,255]));
 data[data.length-1]^=1;
 await assert.rejects(protocol.openPhotoPacket(data,'01020304','test-secret'));
 await assert.rejects(protocol.openPhotoPacket(seal('01020304',Buffer.from([3,0,0,0,1])),'01020304','wrong'));
});
