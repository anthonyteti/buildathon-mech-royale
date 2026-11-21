# buildathon-mech-royale

A TypeScript (Bun) bot for the Builders Buildathon Mech Royale track (`mechfight/1` protocol).

- `bot.ts`: entry point.
- `brain.ts`: the bot logic (zone-safe navigation, lead-aimed gun, laser/lightning/mortar use, loot, dodging, healing, upgrade picks).
- `map.ts`: 1 m column grid of the campus map for line of sight and obstacle probing.
- `nav.ts`: 2 m navigation grid with walk, climb and drop edges, and a time-sliced A* planner.
- `mechfight.ts`: the kit's protocol wrapper.
- `tools/check.sh`: runs the kit's `check.py` natively and against the linux/amd64 image in the match sandbox.
- `tools/replay.py`: feeds the recorded stream one observation at a time and prints the bot's actions.
- `tools/navsim.ts`: movement-only harness (approximate physics, real zone schedule) that runs the bot in-process to catch navigation failures.

Build: `docker build --platform linux/amd64 -t mech-bot .`
