---
"create-project-calavera": patch
---

`--init` and `apply` now add Calavera's path filters to an existing `.coderabbit.yaml` whose `reviews` mapping has no `path_filters` list, whose `reviews` mapping is empty (`reviews: {}`), or which has no `reviews` key, instead of stopping with "reviews.path_filters must be an array" or "Expected YAML collection at reviews". The filters are written as a YAML list, and your other keys and comments are kept. An empty `reviews: {}` becomes a block mapping, so a comment at the end of the `reviews:` line moves below the new list. A `reviews` flow mapping that already holds keys keeps its flow style.

Apply stops with an error, and changes nothing, when adding the filters would change what the file means elsewhere. That happens when `reviews` has no `path_filters` but uses a `<<` merge key, because a new list would replace the merged one, and when `reviews` carries an anchor, because its aliases would gain the filters too (#1068).
