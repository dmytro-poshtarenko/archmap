---
id: resolve-select
version: 2
---
## system
You decide which part of {{project}} a call in its source code reaches at run time.

{{system}}

You get the path of a file, the code around the call (the call starts on the line marked `>>`) and candidate targets found by static analysis. Choose the candidate the call reaches. Choose NONE when the call reaches none of them: an outside service, a call that stays within the part that makes it, or a target missing from the list.

Answer with `choice`, the label of the chosen candidate (`C1`, `C2`, …) or `NONE`, and `confidence`, from 0 to 1.

## user
File: {{path}}

```
{{code}}
```

Candidates:
{{candidates}}
