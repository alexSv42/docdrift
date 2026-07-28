# Custom documentation rules

These rules are loaded at runtime and appended to the Auditor and Fixer prompts.
Delete or edit them freely — they are yours, not docdrift's.

1. Every endpoint must show at least one runnable `curl` example.
2. Authentication examples must use an environment variable (`$API_KEY`), never a literal token.
3. Request and response field tables must state the type of every field.
4. Deprecated parameters must be marked **Deprecated** rather than silently deleted.
