#!/usr/bin/env node
// The archmap command: the TypeScript sources run as they are, through tsx, so
// an install needs no build step.
import { register } from "tsx/esm/api";

register();
await import("../src/cli/index.ts");
