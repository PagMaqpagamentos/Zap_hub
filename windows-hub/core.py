"""Verification and local policy for the transparent Paratech launcher."""
import base64
import json
from datetime import datetime, timezone, timedelta
from cryptography.hazmat.primitives.serialization import load_pem_public_key

BRAZIL = timezone(timedelta(hours=-3))

def decode64(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))

def verify(token, public_key):
    encoded, signature = token.split(".")
    load_pem_public_key(public_key.encode()).verify(decode64(signature), encoded.encode())
    return json.loads(decode64(encoded))

def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()

def decide(lease, now):
    if now >= timestamp(lease["expiresAt"]):
        return "offline-expired"
    if lease.get("forced"):
        return "blocked"
    if lease.get("policy") == "released":
        return "released"
    if lease.get("trustUntil") and now < timestamp(lease["trustUntil"]):
        return "released"
    date = datetime.fromtimestamp(now, BRAZIL).date().isoformat()
    invoice = lease.get("invoice")
    if not invoice:
        return "ok"
    if date >= lease["blockDate"]:
        return "blocked"
    if date > invoice["due"]:
        return "overdue"
    if date >= lease["availableDate"]:
        return "available"
    return "ok"

def offline_release(token, key, hub_id, installation_id, nonce, now, used):
    value = verify(token, key)
    if (value.get("type") != "offline-release" or value.get("hubId") != hub_id
            or value.get("installationId") != installation_id or value.get("nonce") != nonce
            or nonce in used or now >= timestamp(value["expiresAt"])
            or timestamp(value["expiresAt"]) - timestamp(value["issuedAt"]) > 86400
            or timestamp(value["issuedAt"]) > now + 300):
        raise ValueError("Contrassenha inválida, expirada ou já utilizada.")
    return value
