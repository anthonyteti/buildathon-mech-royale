/** Entry point: run the bot over stdin/stdout. */
import { run } from "./mechfight.ts"
import { makeBot } from "./brain.ts"

run((hello) => makeBot(hello))
