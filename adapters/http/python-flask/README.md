# HTTP-python-flask-03 bounded runtime certificate

`CERTIFICATE_2026-11-11.json` records one exact-version, exact-source run on Bob against
backend-skeleton `1b4a8e94dd48f3f67a4f9015ffbddb87490453fb`. It is a limited
conformance record, not a production support or release claim. The leaf remains
unregistered and its T19 review remains `NOT_REVIEWED`.

Reproduce with an isolated interpreter containing Flask 3.1.3 and the existing Node
toolchain, from the repository root:

```sh
python -B adapters/http/python-flask/runtime-cert.py
```

The check runs the framework-owned route-table oracle and real T06/T12 static
pipeline twice, requires the eight fixture results to match their pinned records,
then sends 15 in-process Flask `test_client` requests. It confirms the two
certified literal GET paths by route table, static projection, status and body.
Dynamic factories, imperative registration and mount-prefix mismatch remain
negative controls rather than silently becoming supported. The certificate pins
all relevant source hashes and the SHA-256 of the full JSON command output.

This does not test a bound HTTP server, deployment proxy, framework versions other
than 3.1.3, or general Flask route support. It does not certify middleware policy
extraction; the authenticated/unauthenticated requests are a boundary check only.
The separate `HTTP-python-flask-02` adapter/registration gap remains open.
