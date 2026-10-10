import base64
import json
import unittest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from core import decide, verify, offline_release, timestamp

class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.key=Ed25519PrivateKey.generate()
        self.public=self.key.public_key().public_bytes(Encoding.PEM,PublicFormat.SubjectPublicKeyInfo).decode()
        self.lease={"hubId":"hub", "expiresAt":"2028-03-03T03:00:00Z", "policy":"auto", "forced":False,
                    "invoice":{"due":"2028-02-29"},"availableDate":"2028-02-24","blockDate":"2028-03-02"}
    def signed(self,payload):
        body=base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=")
        return body.decode()+"."+base64.urlsafe_b64encode(self.key.sign(body)).rstrip(b"=").decode()
    def test_dates_leap_year_and_expiry(self):
        for when,status in [("2028-02-23T12:00:00Z","ok"),("2028-02-24T12:00:00Z","available"),("2028-02-29T12:00:00Z","available"),("2028-03-01T12:00:00Z","overdue"),("2028-03-02T12:00:00Z","blocked"),("2028-03-03T12:00:00Z","offline-expired")]:
            self.assertEqual(decide(self.lease,timestamp(when)),status)
    def test_tamper_rejected(self):
        token=self.signed(self.lease)
        self.assertEqual(verify(token,self.public),self.lease)
        with self.assertRaises(Exception):verify("e30."+token.split(".")[1],self.public)
    def test_manual_block_overrides_trust(self):
        self.lease.update(forced=True,trustUntil="2028-03-03T03:00:00Z")
        self.assertEqual(decide(self.lease,timestamp("2028-03-01T12:00:00Z")),"blocked")
    def test_counter_bound_and_not_reusable(self):
        payload={"type":"offline-release","hubId":"hub","installationId":"pc","nonce":"nonce","issuedAt":"2028-03-01T12:00:00Z","expiresAt":"2028-03-02T12:00:00Z"}
        token=self.signed(payload);now=timestamp("2028-03-01T13:00:00Z")
        self.assertEqual(offline_release(token,self.public,"hub","pc","nonce",now,[]),payload)
        for hub,pc,nonce,used in [("other","pc","nonce",[]),("hub","other","nonce",[]),("hub","pc","bad",[]),("hub","pc","nonce",["nonce"])]:
            with self.assertRaises(ValueError):offline_release(token,self.public,hub,pc,nonce,now,used)

if __name__=="__main__":unittest.main()
