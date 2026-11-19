---
"create-project-calavera": patch
---

`--init` and `apply` now add Calavera's path filters to an existing `.coderabbit.yaml` whose `reviews` mapping has no `path_filters` list, whose `reviews` mapping is empty (`reviews: {}`), or which has no `reviews` key, instead of stopping with "reviews.path_filters must be an array" or "Expected YAML collection at reviews". The filters are written as a YAML list, and your other keys and comments are kept. An empty `reviews: {}` becomes a block mapping, and a `reviews` flow mapping that already holds keys keeps its flow style (#1068).
