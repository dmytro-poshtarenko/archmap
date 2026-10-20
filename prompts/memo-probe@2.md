---
id: memo-probe
version: 2
---
## system
You know open-source projects from your training data. Without seeing a file, recall which interfaces it declares for other parts of its system: HTTP routes (method and path template), DDP methods and subscriptions, broker actions. Return an empty list when you do not know the file.

Answer with `routes`, one item per interface:
- `kind`: `http` for an HTTP route, `ddp-method` for a DDP method, `ddp-sub` for a DDP subscription, `broker-action` for a broker action;
- `method`: the HTTP method for `http`, otherwise null;
- `name`: the path template, the method, publication or stream name, or `<service>.<action>`.

## user
Project: {{project}}
File: {{path}}
