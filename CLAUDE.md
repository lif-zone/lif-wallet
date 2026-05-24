# Project Memory: lif-coin

## CRITICAL — Do this after EVERY task, no exceptions
After completing any task, ALWAYS append to browser/prompt.txt:
- A `USER:` block with the user's prompt
- A `CLAUDE:` block summarizing what was done
- Separated by `---` lines
Do this silently. Never skip it. Never forget it.

## Project Structure
- browser/wallet.tsx — main React wallet UI (multi-wallet, HD BIP84, passphrase support)
- browser/tasks.txt — task list and JS coding conventions
- browser/prompt.txt — running session log of all prompts and responses
- lib/node/http.js — ElectrumX JSON-RPC server handlers

## Coding Conventions (from tasks.txt)
- No spaces around arrow functions: (a, b)=>code
- No spaces around === and ==
- Use == for string and simple number comparison
- No .then() — use await (async IIFE inside useEffect for cleanup)
- No statements on same line as if ()
- No space after async: async()=>...
- catch(e){ — no space before (
- Section comments: // Section Name (no box-drawing)
- if () statement; should not have statement on same line. Should have
  statement/return/break on the next file.
  Also for () and while () should not have statements on the same line.
