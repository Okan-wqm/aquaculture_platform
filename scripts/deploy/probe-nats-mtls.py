#!/usr/bin/env python3
"""Authenticate a deployment identity and prove the broker's loaded TLS leaf."""
import hashlib
import json
from pathlib import Path
import socket
import ssl
import sys

address, certificate_root = sys.argv[1:]
root = Path(certificate_root)
context = ssl.create_default_context(cafile=str(root / "nats/ca-cert.pem"))
context.load_cert_chain(
    str(root / "nats/clients/auth_service-cert.pem"),
    str(root / "nats/clients/auth_service-key.pem"),
)
expected_leaf = ssl.PEM_cert_to_DER_cert((root / "nats/nats-cert.pem").read_text())
with socket.create_connection((address, 4222), timeout=10) as connection:
    # NATS announces INFO before upgrading to TLS. Read exactly one line so
    # no buffered plaintext is accidentally consumed as part of the handshake.
    information = bytearray()
    while not information.endswith(b"\r\n"):
        value = connection.recv(1)
        if not value or len(information) >= 65536:
            raise SystemExit("NATS did not send a bounded INFO greeting")
        information.extend(value)
    if not information.startswith(b"INFO "):
        raise SystemExit("NATS INFO greeting is missing")
    document = json.loads(information[5:])
    if document.get("tls_required") is not True:
        raise SystemExit("NATS did not require TLS")
    with context.wrap_socket(connection, server_hostname="nats") as secure:
        if hashlib.sha256(secure.getpeercert(binary_form=True)).digest() != hashlib.sha256(expected_leaf).digest():
            raise SystemExit("NATS loaded leaf differs from the candidate configuration")
        connect = json.dumps({"verbose": False, "pedantic": False, "tls_required": True,
                              "name": "aqua-deploy-identity-probe", "lang": "python", "version": "1", "protocol": 1})
        secure.sendall(b"CONNECT " + connect.encode() + b"\r\nPING\r\n")
        response = bytearray()
        while len(response) < 65536:
            chunk = secure.recv(4096)
            if not chunk:
                break
            response.extend(chunk)
            if b"-ERR" in response:
                raise SystemExit("NATS rejected the deployment certificate identity")
            if b"PONG\r\n" in response:
                print("NATS loaded leaf and certificate identity verified.")
                break
            if b"PING\r\n" in response:
                secure.sendall(b"PONG\r\n")
        else:
            raise SystemExit("NATS identity probe response exceeded its bound")
        if b"PONG\r\n" not in response:
            raise SystemExit("NATS did not acknowledge the authenticated identity")
