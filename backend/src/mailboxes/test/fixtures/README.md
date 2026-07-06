# Test fixtures

`test-cert.pem` / `test-key.pem` — a self-signed TLS certificate (CN=localhost,
10-year expiry) used **only** by the fake in-process IMAP/POP3 servers in
`fixtures.ts` for connector integration tests. Not used for anything sensitive
and safe to commit; regenerate with:

```
openssl req -x509 -newkey rsa:2048 -nodes -keyout test-key.pem -out test-cert.pem -days 3650 -subj "/CN=localhost"
```
