# mini-complex

A small multi-repository system for the integration tests: a web client
(`web`), an Express API with mounted routers and a BullMQ producer (`api`), a
BullMQ worker that calls the API back (`worker`), and their deployment
(`infra`). `expected.yaml` holds the expected extraction output, written before
the extraction code; its conventions are those of `fixtures/cases/README.md`.
