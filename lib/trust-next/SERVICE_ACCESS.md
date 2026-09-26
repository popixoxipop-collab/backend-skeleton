# Database and local-server trust requirements

This layer models service access without granting execution.

## database-read

Requires:
- one exact DB host/port;
- one opaque secret reference;
- no listen/process/device grants;
- no ambient environment.

The object declares `read_only_required:true`. Possessing a DB credential and being able to connect is **not** proof that the actual session/role/transaction is read-only. The runtime/evidence layer must prove the admitted path cannot mutate state for a read-only certification.

## database-write

This is deliberately a different service class. It sets:
- `mutation_approval_required:true`
- `destructive_ddl_allowed:false`
- production target denied by default.

A write-capable credential is never inferred from the read profile and a trust request does not authorize a business mutation.

## local-server

Listen permission is independent from outbound network permission.

Current T20 revision permits loopback listener endpoints only:
- 127.0.0.1
- [::1]
- localhost

`0.0.0.0`, `[::]`, LAN addresses and public host binds are rejected rather than silently treated as local.

A local server may separately declare exact outbound endpoints and secret references, for example a loopback UI that connects to one disposable database. The effective runner still must prove listener lifetime/cleanup and exact requested/effective policy identity.

No function in this module opens a socket or database connection.
