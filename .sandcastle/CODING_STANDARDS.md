# Coding Standards

<!-- This file is loaded by the reviewer agent during code review via
     @.sandcastle/CODING_STANDARDS.md. Rules enforced by Biome's default config
     are listed here for human reference; Biome handles enforcement automatically. -->

## Style (enforced by Biome)

- Indentation: 2 spaces
- Quotes: single quotes (`'`)
- Semicolons: always
- Trailing commas: everywhere possible
- Arrow function parentheses: always
- Line width: 100 characters
- Template literals over string concatenation
- `node:` protocol for Node.js builtin imports

## Lint rules (enforced by Biome)

- `recommended`: all recommended Biome lint rules
- `suspicious/noExplicitAny`: warn (avoid `any`, use `unknown` or typed alternatives)
- `style/useConst`: error (prefer `const` over `let` when never reassigned)
- `style/noUnusedTemplateLiteral`: error

## Testing

- Every public function in helpers and phases must have at least one test
- Use `describe`/`it`/`expect` from vitest
- Test external behaviour, not implementation details

## Architecture

- Keep modules focused on a single responsibility
- Phases import from helpers and types; helpers import from types and config
- No cross-import cycles
- Accept logger as an argument, never import it globally
