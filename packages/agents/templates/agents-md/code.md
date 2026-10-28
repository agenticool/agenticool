## Code and comments

- Match the surrounding code. Add no single-use helper and no check, option, or parameter that no acceptance criterion or caller needs, and keep comments short: explain why, never restate the next line.
- Every doc, README, guide, spec, agent instruction, and code comment describes the current state: what exists and how to set it up and run it, never a log of problems and fixes or a timeline. Change history belongs in PR bodies and commit messages. A code comment may keep prior context only to explain an established regression the code must not reintroduce.
