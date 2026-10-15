# Case fixtures

One small multi-repository system per case of the classification (table 7.1 of
the thesis plan). Each case has its target config (`archmap.yaml`), the code of
its repositories, and `expected.yaml`, written before the code that processes
it:

- `sites` — call sites the extraction must report, with the address in display
  form: literal text, `{param:name}` for a function parameter, `{env:KEY}`,
  `{setting:KEY}`, `{dyn}` for a value known only at run time inside an
  otherwise known address, `{?}` for an address that cannot be determined, and
  `{a|b}` for alternatives. `hops` lists the kinds of hops followed to find the
  address, sorted and without repeats.
- `routes` — route declarations the extraction rules must find.
- `links` — the expected target and case of each site (checked from milestone M5).

`at` names a line as `<repo>:<path>:<line>`, or `<repo>:<path>:@<text>` for the
first line containing `<text>`.
