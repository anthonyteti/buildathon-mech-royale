FROM oven/bun:1.4.4-slim
WORKDIR /bot
COPY package.json mechfight.ts map.ts nav.ts brain.ts bot.ts ./
ENTRYPOINT ["bun", "/bot/bot.ts"]
