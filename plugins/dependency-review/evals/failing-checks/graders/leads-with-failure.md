---
type: regex
target: last_message
# The opening sentence, after an optional heading line, must carry the
# check-based verdict. A period inside a version such as 5.9.3 does not end it.
pattern: ^(?:#[^\n]*\n+)?(?:[^.!?\n]|[.!?](?=\S))*?(cannot be merged|can ?not be merged|should not be merged|not ready|fail)
flags: i
---
