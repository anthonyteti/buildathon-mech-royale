# buildathon-mech-royale

A TypeScript (Bun) bot for the Builders Buildathon Mech Royale track (`mechfight/1` protocol).

- `bot.ts`: the bot (zone-safe movement, lead-aimed gun, laser/lightning/mortar use, loot, dodging, upgrade picks).
- `map.ts`: 1 m column grid of the campus map for line-of-sight and obstacle probing.
- `mechfight.ts`: the kit's protocol wrapper.
- `tools/check.sh`: runs the kit's `check.py` natively and against the linux/amd64 image in the match sandbox.
- `tools/replay.py`: feeds the recorded stream one observation at a time and prints the bot's actions.

Build: `docker build --platform linux/amd64 -t mech-bot .`
