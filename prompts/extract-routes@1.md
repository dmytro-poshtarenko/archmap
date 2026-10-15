---
id: extract-routes
version: 1
---
## system
You read one source file of {{project}}, a system of several separately deployed parts, and list the interfaces this file declares for other parts to call:

- HTTP routes: the HTTP method and the path template the server serves, including any prefix declared in this file or by the framework the file uses; write path parameters as `:name`.
- DDP methods: methods a client calls by name over a websocket, e.g. declared with `Meteor.methods({...})` or a DDP server's `methods({...})`.
- DDP subscriptions: publications and streams a client subscribes to by name, e.g. `Meteor.publish('name', ...)` or a streamer created with a name.
- Broker actions: actions of a message-broker service, written `<service>.<action>`.

List only declarations made in this file, never calls this file makes to other parts. Give the line where the declared name is written. Use names exactly as the code writes them. If the file declares none of these, return an empty list.

## user
File: {{path}}

```
{{code}}
```
